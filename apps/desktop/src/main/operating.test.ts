import {
  adapterId,
  resourceId,
  type ExecutionAdapter,
  type ResourceDescriptor,
} from '@nexar/contracts';
import { createNexar, parseConfig } from '@nexar/core';
import { EchoExecutionAdapter, echoResource } from '@nexar/integration-echo';
import { InMemoryTelemetrySink } from '@nexar/telemetry';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionDto, SubmitTurnResult } from '../shared/api.js';
import { CHANNELS } from '../shared/channels.js';
import { createBridge } from './bridge.js';
import { addProject, createHarness, type Harness } from './test-harness.js';

let h: Harness;
let projectId: string;
beforeEach(async () => {
  h = await createHarness();
  projectId = await addProject(h);
});
afterEach(async () => h.cleanup());

function resource(
  adapter: string,
  kind: 'agent' | 'model' | 'tool-runtime' = 'agent',
): ResourceDescriptor {
  return echoResource({
    id: resourceId(`test-${adapter}`),
    kind:
      kind === 'agent'
        ? { type: 'agent', agent: adapter, interface: 'cli' }
        : kind === 'tool-runtime'
          ? { type: 'tool-runtime', tool: adapter, interface: 'cli' }
          : { type: 'model', provider: 'test', model: adapter, access: 'local' },
    runtime: { adapter: adapterId(adapter), locality: 'local' },
  });
}

async function runDirect(resources: ResourceDescriptor[], preferredResourceIds?: string[]) {
  const calls = vi.fn();
  // Every non-echo adapter is an offline spy: a regression never launches a CLI or paid provider.
  const adapters: ExecutionAdapter[] = [new EchoExecutionAdapter()];
  for (const id of new Set(resources.map((r) => r.runtime.adapter))) {
    if (id === adapterId('echo')) continue;
    adapters.push({
      id,
      displayName: 'Offline direct-boundary spy',
      supports: (r) => r.runtime.adapter === id,
      probe: () =>
        Promise.resolve({
          availability: 'available',
          auth: 'not-required',
          observedAt: new Date().toISOString(),
        }),
      execute: async (request, context) => {
        calls(request.resource.id);
        return new EchoExecutionAdapter().execute(request, context);
      },
    });
  }
  const composition = h.engine.composition();
  const sink = new InMemoryTelemetrySink();
  const runtime = createNexar(
    parseConfig(
      {
        version: 1,
        resources,
        routing: { policy: 'resource-intelligence', defaultResourceId: resources[0]?.id },
      },
      'test',
    ),
    { adapters, projects: composition.runtime.projects, telemetry: sink },
  );
  const bridge = createBridge({
    ...h.deps,
    engine: { ...h.engine, composition: () => ({ ...composition, runtime }) },
  });
  const created = await bridge.invoke(
    CHANNELS.sessionsCreate,
    { projectId, mode: 'cowork' },
    () => undefined,
  );
  if (!created.ok) throw new Error('session fixture failed');
  const session = created.value as SessionDto;
  const submitted = await bridge.invoke(
    CHANNELS.sessionsSubmitTurn,
    {
      sessionId: session.id,
      submissionKey: 'a'.repeat(32),
      text: 'Draft a short summary',
      kind: 'documentation',
      ...(preferredResourceIds === undefined ? {} : { preferredResourceIds }),
    },
    () => undefined,
  );
  expect(submitted.ok).toBe(true);
  const turnId = (submitted.ok ? (submitted.value as SubmitTurnResult) : undefined)?.turn.id;
  await expect
    .poll(
      async () => (await h.sessionStore.get(session.id))?.turns.find((t) => t.id === turnId)?.state,
      { timeout: 15_000 },
    )
    .toMatch(/succeeded|failed/);
  const turn = (await h.sessionStore.get(session.id))?.turns.find((t) => t.id === turnId);
  return { turn, calls, sink };
}

describe('bounded Desktop direct session fallback', () => {
  it.each(['deepseek-harness', 'claude-code', 'codex', 'antigravity', 'delegate-skills'])(
    'excludes %s even when NRC would prefer it by default',
    async (adapter) => {
      const { turn, calls } = await runDirect([resource(adapter), echoResource()]);
      expect(turn).toMatchObject({
        state: 'succeeded',
        lane: { effectiveLane: 'direct', fallbackReason: 'dsh-unavailable' },
        tasks: [{ resourceId: 'local-echo' }],
      });
      expect(calls).not.toHaveBeenCalled();
    },
  );

  it.each(['deepseek-harness', 'custom-agent'])(
    'fails explicitly when the owner prefers forbidden %s',
    async (adapter) => {
      const forbidden = resource(adapter);
      const { turn, calls } = await runDirect([forbidden, echoResource()], [forbidden.id]);
      expect(turn).toMatchObject({
        state: 'failed',
        outcome: {
          error: {
            code: 'POLICY_REJECTED',
            message: 'Direct turns require a bounded model resource',
          },
        },
      });
      expect(calls).not.toHaveBeenCalled();
    },
  );

  it.each(['model', 'tool-runtime'] as const)(
    'rejects an unreviewed adapter labeled %s',
    async (kind) => {
      const { turn, calls } = await runDirect([resource('custom', kind)]);
      expect(turn).toMatchObject({
        state: 'failed',
        outcome: { error: { code: 'NO_ELIGIBLE_RESOURCE' } },
      });
      expect(calls).not.toHaveBeenCalled();
    },
  );

  it('fails safely when only an agent resource exists', async () => {
    const { turn, calls } = await runDirect([resource('deepseek-harness')]);
    expect(turn).toMatchObject({
      state: 'failed',
      outcome: { error: { code: 'NO_ELIGIBLE_RESOURCE' } },
    });
    expect(calls).not.toHaveBeenCalled();
  });

  it('honors a bounded pi model preference and accounts its one execution once', async () => {
    const pi = resource('pi', 'model');
    const { turn, calls, sink } = await runDirect([echoResource(), pi], [pi.id]);
    expect(turn).toMatchObject({ state: 'succeeded', tasks: [{ resourceId: pi.id }] });
    expect(calls).toHaveBeenCalledExactlyOnceWith(pi.id);
    expect(sink.events.filter((event) => event.type === 'execution.finished')).toHaveLength(1);
  });
});
