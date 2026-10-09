import { describe, expect, it, vi } from 'vitest';
import {
  NexarError,
  measured,
  type ControlLineage,
  type ControlResourcePolicy,
  type ControlTurnRequest,
  type Logger,
  type ModelTurnPort,
  type ModelTurnPortRequest,
  type NexarErrorCode,
  type ResourceSnapshot,
} from '@nexar/contracts';
import { ControlModelGateway, type ControlEvent } from './gateway.js';
import { NOW, routingPolicy, snap } from './fixtures.js';

const SENTINEL = 'SENTINEL-prompt-and-args';
const lineage: ControlLineage = {
  rootSessionId: 's1',
  turnId: 't1',
  correlationId: 'c1',
  depth: 0,
};
const auto: ControlResourcePolicy = { mode: 'auto', fallback: 'auto' };

const silent: Logger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  child: () => silent,
};

type PortResult = Awaited<ReturnType<ModelTurnPort['turn']>>;
const ok = (text = 'hi', extras?: Record<string, unknown>): PortResult => ({
  text,
  toolCalls: [],
  finishReason: 'stop',
  usage: { inputTokens: measured(3), outputTokens: measured(1) },
  ...(extras === undefined ? {} : { extras }),
});

const fail = (code: NexarErrorCode): NexarError => new NexarError(code, 'boom');

function setup(
  handlers: Record<string, (r: ModelTurnPortRequest) => Promise<PortResult> | PortResult>,
  options: { retries?: number; candidates?: ResourceSnapshot[] } = {},
) {
  const events: ControlEvent[] = [];
  const calls: { resource: string; request: ModelTurnPortRequest }[] = [];
  let n = 0;
  const gateway = new ControlModelGateway({
    ports: (d) => {
      const handler = handlers[d.id];
      if (handler === undefined) return undefined;
      return {
        turn: (request) => {
          calls.push({ resource: d.id, request });
          return Promise.resolve(handler(request));
        },
      };
    },
    candidates: () =>
      options.candidates ??
      Object.keys(handlers)
        .sort()
        .map((id) => snap(id)),
    policy: routingPolicy(),
    clock: () => NOW,
    newId: () => `dec-${String(++n)}`,
    logger: silent,
    onEvent: (e) => events.push(e),
    ...(options.retries === undefined ? {} : { retries: options.retries }),
  });
  const request = (
    decisionId: string,
    patch: Partial<ControlTurnRequest> = {},
  ): ControlTurnRequest => ({
    lineage,
    engine: 'dsh',
    controlDecisionId: decisionId,
    messages: [{ role: 'user', content: SENTINEL }],
    ...patch,
  });
  return { gateway, events, calls, request };
}

const signal = (): AbortSignal => new AbortController().signal;

async function rejection(p: Promise<unknown>): Promise<NexarError> {
  try {
    await p;
  } catch (e) {
    return e as NexarError;
  }
  throw new Error('expected rejection');
}

describe('ControlModelGateway', () => {
  it('previews the resource begin would pin, without side effects', () => {
    const { gateway, events } = setup({ a: () => ok(), b: () => ok() });
    const pinned: ControlResourcePolicy = { mode: 'pinned', resourceId: 'b', fallback: 'none' };
    expect(gateway.preview('dsh', pinned)).toEqual({ resourceId: 'b' });
    expect(gateway.preview('dsh', undefined)?.resourceId).toBe(
      gateway.begin('dsh', auto, lineage).resourceId,
    );
    // Only the explicit `begin` recorded and emitted a decision.
    expect(events.map((e) => e.type)).toEqual(['control.decided']);
  });

  it('previews nothing when no resource qualifies or the policy is unusable', () => {
    const { gateway, events } = setup({ a: () => ok() });
    expect(
      gateway.preview('dsh', { mode: 'pinned', resourceId: 'zz', fallback: 'none' }),
    ).toBeUndefined();
    expect(gateway.preview('dsh', { mode: 'pinned', fallback: 'auto' })).toBeUndefined();
    const empty = setup({}, { candidates: [] });
    expect(empty.gateway.preview('dsh', auto)).toBeUndefined();
    expect(events).toEqual([]);
  });
  it('pins the same resource across turns and stamps resourceId', async () => {
    const { gateway, calls, request } = setup({ a: () => ok(), b: () => ok() });
    const d = gateway.begin('dsh', auto, lineage);
    const r1 = await gateway.turn(request(d.controlDecisionId), signal());
    const r2 = await gateway.turn(request(d.controlDecisionId), signal());
    expect(r1.resourceId).toBe(d.resourceId);
    expect(r2.resourceId).toBe(d.resourceId);
    expect(new Set(calls.map((c) => c.resource))).toEqual(new Set([d.resourceId]));
  });

  it('retries the same resource then fails with control-resource-failed', async () => {
    const { gateway, calls, events, request } = setup(
      {
        a: () => {
          throw fail('PROVIDER_ERROR');
        },
        b: () => ok(),
      },
      { retries: 1 },
    );
    const d = gateway.begin('dsh', { mode: 'pinned', resourceId: 'a', fallback: 'auto' }, lineage);
    const e = await rejection(gateway.turn(request(d.controlDecisionId), signal()));
    expect(e.code).toBe('PROVIDER_ERROR');
    expect(e.details?.reason).toBe('control-resource-failed');
    expect(calls.map((c) => c.resource)).toEqual(['a', 'a']);
    expect(events.map((x) => x.type)).toEqual([
      'control.decided',
      'control.retry',
      'control.failed',
    ]);
  });

  it('recovers when a retry succeeds', async () => {
    let n = 0;
    const { gateway, calls, request } = setup({
      a: () => (++n === 1 ? Promise.reject(fail('QUOTA_EXHAUSTED')) : ok('later')),
    });
    const d = gateway.begin('dsh', auto, lineage);
    const r = await gateway.turn(request(d.controlDecisionId), signal());
    expect(r.text).toBe('later');
    expect(calls).toHaveLength(2);
  });

  it('does not retry non-retryable failures', async () => {
    const { gateway, calls, request } = setup({
      a: () => {
        throw fail('AUTH_REQUIRED');
      },
    });
    const d = gateway.begin('dsh', auto, lineage);
    const e = await rejection(gateway.turn(request(d.controlDecisionId), signal()));
    expect(e.code).toBe('AUTH_REQUIRED');
    expect(calls).toHaveLength(1);
  });

  it('restart moves to the next eligible resource, never to a failed one', async () => {
    const { gateway, request } = setup(
      {
        a: () => {
          throw fail('PROVIDER_ERROR');
        },
        b: () => {
          throw fail('PROVIDER_ERROR');
        },
        c: () => ok('from-c'),
      },
      { retries: 0 },
    );
    let d = gateway.begin('dsh', auto, lineage);
    const tried = new Set<string>();
    for (let i = 0; i < 2; i++) {
      tried.add(d.resourceId);
      await rejection(gateway.turn(request(d.controlDecisionId), signal()));
      d = gateway.restart(d.controlDecisionId);
      expect(tried.has(d.resourceId)).toBe(false);
    }
    expect(d.resourceId).toBe('c');
    expect((await gateway.turn(request(d.controlDecisionId), signal())).text).toBe('from-c');
  });

  it('restart fails when no resource is left and is refused with fallback none', async () => {
    const one = setup(
      {
        a: () => {
          throw fail('PROVIDER_ERROR');
        },
      },
      { retries: 0 },
    );
    const d = one.gateway.begin('dsh', auto, lineage);
    await rejection(one.gateway.turn(one.request(d.controlDecisionId), signal()));
    expect(() => one.gateway.restart(d.controlDecisionId)).toThrow(/No eligible/);

    const none = setup({ a: () => ok(), b: () => ok() });
    const p = none.gateway.begin(
      'dsh',
      { mode: 'pinned', resourceId: 'a', fallback: 'none' },
      lineage,
    );
    expect(() => none.gateway.restart(p.controlDecisionId)).toThrow(/does not allow a restart/);
  });

  it('restart ends the old decision and records control.restart', async () => {
    const { gateway, events, request } = setup({ a: () => ok(), b: () => ok() });
    const d = gateway.begin('dsh', auto, lineage);
    const next = gateway.restart(d.controlDecisionId);
    expect(next.controlDecisionId).not.toBe(d.controlDecisionId);
    expect(events.at(-1)).toMatchObject({
      type: 'control.restart',
      previousDecisionId: d.controlDecisionId,
    });
    await expect(gateway.turn(request(d.controlDecisionId), signal())).rejects.toMatchObject({
      code: 'VALIDATION_ERROR',
    });
  });

  it('forwards extras only on the decision that issued them', async () => {
    const seen: unknown[] = [];
    const { gateway, request } = setup({
      a: (r) => {
        seen.push(r.messages.map((m) => m.extras));
        return ok('x', { sig: 'private' });
      },
      b: (r) => {
        seen.push(r.messages.map((m) => m.extras));
        return ok('y', { sig: 'other' });
      },
    });
    const d1 = gateway.begin('dsh', { mode: 'pinned', resourceId: 'a', fallback: 'auto' }, lineage);
    const r1 = await gateway.turn(request(d1.controlDecisionId), signal());
    expect(r1.extras).toEqual({ sig: 'private' });
    const history = [
      { role: 'user' as const, content: 'q' },
      { role: 'assistant' as const, content: 'x', extras: r1.extras as Record<string, unknown> },
      { role: 'user' as const, content: 'q2' },
    ];
    await gateway.turn(request(d1.controlDecisionId, { messages: history }), signal());
    expect(seen[1]).toEqual([undefined, { sig: 'private' }, undefined]);

    // A different decision never sees them, even if the engine replays the old history.
    const d2 = gateway.begin('dsh', { mode: 'pinned', resourceId: 'b', fallback: 'auto' }, lineage);
    await gateway.turn(request(d2.controlDecisionId, { messages: history }), signal());
    expect(seen[2]).toEqual([undefined, undefined, undefined]);
  });

  it('rejects unknown, ended, mismatched-engine and mismatched-lineage decisions', async () => {
    const { gateway, request } = setup({ a: () => ok() });
    await expect(gateway.turn(request('nope'), signal())).rejects.toMatchObject({
      code: 'VALIDATION_ERROR',
    });
    const d = gateway.begin('dsh', auto, lineage);
    await expect(
      gateway.turn(
        // A retired engine id (persisted data only): never a match.
        request(d.controlDecisionId, { engine: 'openworker' as unknown as 'dsh' }),
        signal(),
      ),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    await expect(
      gateway.turn(
        request(d.controlDecisionId, { lineage: { ...lineage, rootSessionId: 'other' } }),
        signal(),
      ),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    gateway.end(d.controlDecisionId);
    await expect(gateway.turn(request(d.controlDecisionId), signal())).rejects.toMatchObject({
      code: 'VALIDATION_ERROR',
    });
  });

  it('validates request bounds before calling the port', async () => {
    const { gateway, calls, request } = setup({ a: () => ok() });
    const d = gateway.begin('dsh', auto, lineage);
    await expect(
      gateway.turn(
        request(d.controlDecisionId, { tools: [{ name: 'bad name', parameters: {} }] }),
        signal(),
      ),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    expect(calls).toHaveLength(0);
  });

  it('propagates cancellation to the port and does not retry', async () => {
    const controller = new AbortController();
    const { gateway, calls, request } = setup({
      a: (r) =>
        new Promise((_, reject) => {
          r.signal.addEventListener('abort', () => reject(new Error('aborted')));
        }),
    });
    const d = gateway.begin('dsh', auto, lineage);
    const pending = rejection(gateway.turn(request(d.controlDecisionId), controller.signal));
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    controller.abort();
    expect((await pending).code).toBe('EXECUTION_CANCELLED');
    expect(calls).toHaveLength(1);
  });

  it('rejects a turn on an already-aborted signal without calling the port', async () => {
    const { gateway, calls, request } = setup({ a: () => ok() });
    const d = gateway.begin('dsh', auto, lineage);
    const controller = new AbortController();
    controller.abort();
    expect(
      (await rejection(gateway.turn(request(d.controlDecisionId), controller.signal))).code,
    ).toBe('EXECUTION_CANCELLED');
    expect(calls).toHaveLength(0);
  });

  it('events and logs carry ids and codes, never message content', async () => {
    const logged: unknown[] = [];
    const logger: Logger = { ...silent, info: (m, f) => logged.push([m, f]) };
    const events: ControlEvent[] = [];
    let n = 0;
    const gateway = new ControlModelGateway({
      ports: () => ({ turn: () => Promise.reject(fail('PROVIDER_ERROR')) }),
      candidates: () => [snap('a')],
      policy: routingPolicy(),
      clock: () => NOW,
      newId: () => `dec-${String(++n)}`,
      logger,
      onEvent: (e) => events.push(e),
    });
    const d = gateway.begin('dsh', auto, lineage);
    await rejection(
      gateway.turn(
        {
          lineage,
          engine: 'dsh',
          controlDecisionId: d.controlDecisionId,
          messages: [
            { role: 'user', content: SENTINEL },
            {
              role: 'assistant',
              toolCalls: [{ id: 'c1', name: 'run', arguments: { secret: SENTINEL } }],
            },
          ],
        },
        signal(),
      ),
    );
    expect(events.length).toBeGreaterThan(2);
    expect(JSON.stringify(events)).not.toContain(SENTINEL);
    expect(JSON.stringify(logged)).not.toContain(SENTINEL);
  });

  it('fails when the pinned resource has no port', async () => {
    const { gateway, request } = setup(
      { a: () => ok() },
      { candidates: [snap('a'), snap('noport')] },
    );
    const d = gateway.begin(
      'dsh',
      { mode: 'pinned', resourceId: 'noport', fallback: 'auto' },
      lineage,
    );
    expect(d.resourceId).toBe('noport');
    await expect(gateway.turn(request(d.controlDecisionId), signal())).rejects.toMatchObject({
      code: 'RESOURCE_UNAVAILABLE',
    });
  });
});
