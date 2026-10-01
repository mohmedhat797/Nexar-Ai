import { describe, expect, it } from 'vitest';
import {
  adapterId,
  NexarError,
  type ExecutionAdapter,
  type ExecutionResult,
  type QuotaObservation,
} from '@nexar/contracts';
import { InMemoryTelemetrySink, noopLogger } from '@nexar/telemetry';
import { EchoExecutionAdapter, echoResource } from '@nexar/integration-echo';
import { parseConfig } from './config.js';
import { createNexar } from './create-nexar.js';
import { Nexar } from './engine.js';

const NOW = new Date('2026-10-01T12:00:00.000Z');

const config = parseConfig(
  {
    version: 1,
    resources: [echoResource()],
    routing: { policy: 'deterministic', defaultResourceId: 'local-echo' },
  },
  'test',
);

const observation = (extra: Partial<QuotaObservation> = {}): QuotaObservation => ({
  unit: 'percent',
  limit: 100,
  used: 40,
  remaining: 60,
  observedAt: NOW.toISOString(),
  provenance: { limit: 'vendor-reported', usage: 'vendor-reported' },
  label: 'x',
  ...extra,
});

/** Echo, with whatever the test needs added to its result or turned into a failure. */
function adapterWith(options: {
  observations?: readonly unknown[];
  fail?: NexarError;
}): ExecutionAdapter {
  const echo = new EchoExecutionAdapter();
  return {
    id: adapterId('echo'),
    displayName: 'quota-test',
    supports: (r) => echo.supports(r),
    probe: () => echo.probe(),
    execute: async (request, context): Promise<ExecutionResult> => {
      if (options.fail !== undefined) throw options.fail;
      const result = await echo.execute(request, context);
      return {
        ...result,
        ...(options.observations === undefined
          ? {}
          : { quotaObservations: options.observations as readonly QuotaObservation[] }),
      };
    },
  };
}

function setup(adapter: ExecutionAdapter, quotaExhaustedHoldMs?: number) {
  const { registry, controller, adapters } = createNexar(config, { adapters: [adapter] });
  const sink = new InMemoryTelemetrySink();
  const nexar = new Nexar({
    registry,
    router: controller,
    adapters,
    telemetry: sink,
    logger: noopLogger,
    clock: () => NOW,
    ...(quotaExhaustedHoldMs === undefined ? {} : { quotaExhaustedHoldMs }),
  });
  const quota = () => sink.events.flatMap((e) => (e.type === 'quota.observed' ? [e] : []));
  return { nexar, sink, quota };
}

describe('engine quota signals', () => {
  it('emits one quota.observed per valid result observation, after execution.finished', async () => {
    const { nexar, sink, quota } = setup(
      adapterWith({
        observations: [
          observation({ label: 'a' }),
          observation({ label: 'b', used: 90, remaining: 10 }),
        ],
      }),
    );
    await nexar.run(nexar.createTask({ kind: 'general', prompt: 'x' }));
    expect(quota().map((e) => e.observation.label)).toEqual(['a', 'b']);
    expect(quota()[0]).toMatchObject({ resourceId: 'local-echo', at: NOW.toISOString() });
    expect(sink.events.map((e) => e.type)).toEqual([
      'route.decided',
      'execution.started',
      'execution.finished',
      'quota.observed',
      'quota.observed',
    ]);
  });

  it('drops malformed observations', async () => {
    const { nexar, quota } = setup(
      adapterWith({
        observations: [
          observation({ label: 'ok' }),
          { ...observation(), unit: 'bananas' },
          { ...observation(), used: Number.POSITIVE_INFINITY },
          { ...observation(), observedAt: 'yesterday-ish' },
          { ...observation(), provenance: 'vendor' },
          null,
        ],
      }),
    );
    await nexar.run(nexar.createTask({ kind: 'general', prompt: 'x' }));
    expect(quota().map((e) => e.observation.label)).toEqual(['ok']);
  });

  it('emits nothing when the adapter reports no observations', async () => {
    const { nexar, quota } = setup(adapterWith({}));
    await nexar.run(nexar.createTask({ kind: 'general', prompt: 'x' }));
    expect(quota()).toEqual([]);
  });

  it('records QUOTA_EXHAUSTED with the reported future reset time', async () => {
    const resetsAt = '2026-10-01T15:30:00.000Z';
    const { nexar, quota } = setup(
      adapterWith({ fail: new NexarError('QUOTA_EXHAUSTED', 'out', { details: { resetsAt } }) }),
    );
    await expect(
      nexar.run(nexar.createTask({ kind: 'general', prompt: 'x' })),
    ).rejects.toMatchObject({ code: 'QUOTA_EXHAUSTED' });
    expect(quota()).toHaveLength(1);
    expect(quota()[0]?.observation).toEqual({
      unit: 'percent',
      limit: 100,
      used: 100,
      remaining: 0,
      resetsAt,
      observedAt: NOW.toISOString(),
      provenance: { limit: 'vendor-reported', usage: 'vendor-reported' },
      label: 'exhausted-signal',
    });
  });

  it.each([
    ['no resetsAt', undefined],
    ['a past resetsAt', { resetsAt: '2026-10-01T11:00:00.000Z' }],
    ['an invalid resetsAt', { resetsAt: 'tomorrow' }],
    ['a non-string resetsAt', { resetsAt: 12345 }],
  ])('holds for the default hour with %s', async (_name, details) => {
    const { nexar, quota } = setup(
      adapterWith({
        fail: new NexarError('QUOTA_EXHAUSTED', 'out', details === undefined ? {} : { details }),
      }),
    );
    await expect(nexar.run(nexar.createTask({ kind: 'general', prompt: 'x' }))).rejects.toThrow();
    expect(quota()[0]?.observation.resetsAt).toBe('2026-10-01T13:00:00.000Z');
  });

  it('honours quotaExhaustedHoldMs', async () => {
    const { nexar, quota } = setup(
      adapterWith({ fail: new NexarError('QUOTA_EXHAUSTED', 'out') }),
      5 * 60 * 1000,
    );
    await expect(nexar.run(nexar.createTask({ kind: 'general', prompt: 'x' }))).rejects.toThrow();
    expect(quota()[0]?.observation.resetsAt).toBe('2026-10-01T12:05:00.000Z');
  });

  it('records no quota signal for other failures', async () => {
    const { nexar, quota } = setup(adapterWith({ fail: new NexarError('PROVIDER_ERROR', 'x') }));
    await expect(nexar.run(nexar.createTask({ kind: 'general', prompt: 'x' }))).rejects.toThrow();
    expect(quota()).toEqual([]);
  });

  it('takes the hold from config via createNexar', async () => {
    const custom = parseConfig(
      {
        version: 1,
        resources: [echoResource()],
        routing: {
          policy: 'deterministic',
          defaultResourceId: 'local-echo',
          resourceIntelligence: { quota: { exhaustedHoldMs: 120_000 } },
        },
      },
      'test',
    );
    const sink = new InMemoryTelemetrySink();
    const { nexar } = createNexar(custom, {
      adapters: [adapterWith({ fail: new NexarError('QUOTA_EXHAUSTED', 'out') })],
      telemetry: sink,
    });
    const before = Date.now();
    await expect(nexar.run(nexar.createTask({ kind: 'general', prompt: 'x' }))).rejects.toThrow();
    const signal = sink.events.find((e) => e.type === 'quota.observed');
    const resetsAt = Date.parse(
      signal?.type === 'quota.observed' ? (signal.observation.resetsAt ?? '') : '',
    );
    expect(resetsAt - before).toBeGreaterThanOrEqual(119_000);
    expect(resetsAt - before).toBeLessThan(125_000);
  });
});
