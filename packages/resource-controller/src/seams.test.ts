import {
  adapterId,
  resourceId,
  taskId,
  type NexarTask,
  type QuotaObservation,
  type ResourceDescriptor,
  type RoutingHistory,
  type RoutingInput,
  type RoutingPolicy,
} from '@nexar/contracts';
import { InMemoryResourceRegistry } from '@nexar/resource-registry';
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_TASK_KIND_RULES,
  DeterministicRoutingPolicy,
  ResourceController,
  estimateTaskSize,
  laneRoleOf,
  type HistorySource,
  type QuotaSource,
} from './index.js';

const NOW = new Date('2026-03-01T12:00:00.000Z');

function descriptor(id: string): ResourceDescriptor {
  return {
    id: resourceId(id),
    displayName: id,
    kind: { type: 'model', provider: 'acme', model: id, access: 'api' },
    capabilities: ['coding', 'repo-editing'],
    runtime: { adapter: adapterId('test'), locality: 'remote' },
    auth: { mode: 'none' },
    cost: { model: 'free' },
    dataLocality: 'third-party',
  };
}

function task(overrides: Partial<NexarTask> = {}): NexarTask {
  return {
    id: taskId('task-1'),
    kind: 'coding',
    input: { prompt: 'x'.repeat(41), systemPrompt: 'abc' },
    requirements: { capabilities: [], requestedMaxOutputTokens: 300 },
    origin: { source: 'test' },
    createdAt: NOW.toISOString(),
    ...overrides,
  };
}

/** Records the input it receives, then delegates to the deterministic policy. */
class RecordingPolicy implements RoutingPolicy {
  readonly name = 'recording';
  readonly version = '1';
  readonly configId = 'cfg123';
  inputs: RoutingInput[] = [];
  private readonly inner = new DeterministicRoutingPolicy({ taskKinds: DEFAULT_TASK_KIND_RULES });
  evaluate(input: RoutingInput) {
    this.inputs.push(input);
    return this.inner.evaluate(input);
  }
}

const observation: QuotaObservation = {
  unit: 'requests',
  limit: 10,
  used: 4,
  remaining: 6,
  window: 'daily',
  observedAt: NOW.toISOString(),
  provenance: { limit: 'owner-declared', usage: 'nexar-accounting' },
};

const history: RoutingHistory = {
  windowStart: '2026-02-01T12:00:00.000Z',
  windowEnd: NOW.toISOString(),
  executions: {},
  lanes: {},
  skipped: 0,
};

function setup(sources: { quota?: QuotaSource; history?: HistorySource } = {}) {
  const registry = new InMemoryResourceRegistry({ clock: () => NOW });
  registry.register(descriptor('a'));
  registry.register(descriptor('b'));
  const policy = new RecordingPolicy();
  const controller = new ResourceController({
    registry,
    policy,
    clock: () => NOW,
    ...(sources.quota === undefined ? {} : { quotaSource: sources.quota }),
    ...(sources.history === undefined ? {} : { historySource: sources.history }),
  });
  return { controller, policy };
}

describe('controller seams (ADR-020 §2)', () => {
  it('passes size facts, the clock and the lane role, never the prompt', async () => {
    const { controller, policy } = setup();
    await controller.route(task({ metadata: { role: 'review', lane: 'review' } }));
    const input = policy.inputs[0];
    expect(input?.facts).toEqual({
      now: NOW.toISOString(),
      size: {
        estimatedInputTokens: 11,
        attachmentCount: 0,
        documentCount: 0,
        requestedMaxOutputTokens: 300,
        basis: 'chars/4@1',
      },
      laneRole: 'review',
    });
    expect(JSON.stringify(input)).not.toContain('xxxx');
  });

  it('merges quota observations into candidate state and stamps the config id', async () => {
    const quota: QuotaSource = {
      observe: () => Promise.resolve(new Map([[resourceId('a'), [observation]]])),
    };
    const { controller, policy } = setup({
      quota,
      history: { read: () => Promise.resolve(history) },
    });
    const decision = await controller.route(task());
    const a = policy.inputs[0]?.candidates.find((c) => c.descriptor.id === 'a');
    const b = policy.inputs[0]?.candidates.find((c) => c.descriptor.id === 'b');
    expect(a?.state.quotas).toEqual([observation]);
    expect(b?.state.quotas).toBeUndefined();
    expect(policy.inputs[0]?.history).toBe(history);
    expect(decision.policy).toEqual({ name: 'recording', version: '1', configId: 'cfg123' });
  });

  it('treats failing quota and history sources as unknown, not as a routing failure', async () => {
    const { controller, policy } = setup({
      quota: { observe: () => Promise.reject(new Error('boom')) },
      history: { read: () => Promise.reject(new Error('boom')) },
    });
    const decision = await controller.route(task());
    expect(decision.outcome).toBe('selected');
    expect(policy.inputs[0]?.history).toBeUndefined();
    expect(policy.inputs[0]?.candidates.every((c) => c.state.quotas === undefined)).toBe(true);
  });
});

describe('estimateTaskSize and laneRoleOf', () => {
  it('counts characters/4 and attachments', () => {
    const size = estimateTaskSize(
      task({
        input: {
          prompt: 'abcd',
          attachments: [
            { uri: 'file:///a', mediaType: 'text/plain' },
            { uri: 'file:///b', mediaType: 'text/plain' },
          ],
        },
        requirements: { capabilities: [] },
      }),
    );
    expect(size).toEqual({
      estimatedInputTokens: 1,
      attachmentCount: 2,
      documentCount: 2,
      basis: 'chars/4@1',
    });
  });

  it('accepts only known lane roles', () => {
    expect(laneRoleOf(task({ metadata: { role: 'feature' } }))).toBe('feature');
    expect(laneRoleOf(task({ metadata: { role: 'admin' } }))).toBeUndefined();
    expect(laneRoleOf(task({ metadata: { role: 3 } }))).toBeUndefined();
    expect(laneRoleOf(task())).toBeUndefined();
  });
});
