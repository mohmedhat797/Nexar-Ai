import {
  adapterId,
  isNexarError,
  resourceId,
  taskId,
  type CandidateAssessment,
  type NexarError,
  type NexarTask,
  type ResourceDescriptor,
  type ResourceState,
  type RoutingPolicy,
} from '@nexar/contracts';
import { InMemoryResourceRegistry } from '@nexar/resource-registry';
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_TASK_KIND_RULES,
  DeterministicRoutingPolicy,
  ResourceController,
  explainRouteDecision,
  requireSelected,
} from './index.js';

const NOW = new Date('2026-03-01T12:00:00.000Z');

function descriptor(id: string, overrides: Partial<ResourceDescriptor> = {}): ResourceDescriptor {
  return {
    id: resourceId(id),
    displayName: id,
    kind: { type: 'model', provider: 'acme', model: id, access: 'api' },
    capabilities: ['coding', 'repo-editing'],
    runtime: { adapter: adapterId('test'), locality: 'remote' },
    auth: { mode: 'none' },
    cost: { model: 'free' },
    dataLocality: 'third-party',
    ...overrides,
  };
}

const available: ResourceState = {
  availability: 'available',
  auth: 'authenticated',
  observedAt: '2026-01-01T00:00:00.000Z',
};

function task(overrides: Partial<NexarTask> = {}): NexarTask {
  return {
    id: taskId('task-1'),
    kind: 'coding',
    input: { prompt: 'do it' },
    requirements: { capabilities: [] },
    origin: { source: 'test' },
    createdAt: NOW.toISOString(),
    ...overrides,
  };
}

function setup(policy?: RoutingPolicy, refresh = false) {
  const registry = new InMemoryResourceRegistry({ clock: () => NOW });
  const controller = new ResourceController({
    registry,
    policy: policy ?? new DeterministicRoutingPolicy({ taskKinds: DEFAULT_TASK_KIND_RULES }),
    clock: () => NOW,
    refreshBeforeRouting: refresh,
  });
  return { registry, controller };
}

function add(
  registry: InMemoryResourceRegistry,
  id: string,
  d: Partial<ResourceDescriptor> = {},
  s: Partial<ResourceState> = {},
) {
  registry.register(descriptor(id, d));
  registry.setState(resourceId(id), { ...available, ...s });
}

function caught(fn: () => unknown): NexarError {
  try {
    fn();
  } catch (e) {
    if (isNexarError(e)) return e;
    throw e;
  }
  throw new Error('expected throw');
}

describe('ResourceController.route', () => {
  it('partitions into selected, alternatives and rejected', async () => {
    const { registry, controller } = setup();
    add(registry, 'claude-code');
    add(registry, 'pi-sonnet');
    add(registry, 'deepseek-api', { capabilities: ['coding'] });
    const decision = await controller.route(
      task({ requirements: { capabilities: [], preferredResourceIds: [resourceId('pi-sonnet')] } }),
    );
    if (decision.outcome !== 'selected') throw new Error('expected selected');
    expect(decision.selected.resourceId).toBe('pi-sonnet');
    expect(decision.alternatives.map((a) => a.resourceId)).toEqual(['claude-code']);
    expect(decision.rejected.map((a) => a.resourceId)).toEqual(['deepseek-api']);
    expect(decision.taskId).toBe('task-1');
    expect(decision.policy).toEqual({ name: 'deterministic', version: '1' });
    expect(decision.decidedAt).toBe(NOW.toISOString());
  });

  it('returns no-eligible-resource as an outcome, not an error', async () => {
    const { registry, controller } = setup();
    add(registry, 'a', {}, { availability: 'unavailable' });
    const decision = await controller.route(task());
    expect(decision.outcome).toBe('no-eligible-resource');
    expect(decision.rejected).toHaveLength(1);
  });

  it('handles an empty registry', async () => {
    const decision = await setup().controller.route(task());
    expect(decision.outcome).toBe('no-eligible-resource');
    expect(decision.rejected).toEqual([]);
  });

  it('does not probe unless refreshBeforeRouting is set', async () => {
    let probed = 0;
    const probe = () => {
      probed++;
      return Promise.resolve(available);
    };
    const off = setup();
    off.registry.register(descriptor('a'), { probe });
    expect((await off.controller.route(task())).outcome).toBe('selected'); // unknown state is eligible
    expect(probed).toBe(0);

    const on = setup(undefined, true);
    on.registry.register(descriptor('a'), { probe });
    await on.controller.route(task());
    expect(probed).toBe(1);
  });

  it('refreshes state before routing when configured', async () => {
    const { registry, controller } = setup(undefined, true);
    registry.register(descriptor('a'), {
      probe: () => Promise.resolve({ ...available, availability: 'unavailable' }),
    });
    expect((await controller.route(task())).outcome).toBe('no-eligible-resource');
  });

  it('throws INTERNAL_ERROR when the policy skips a candidate', async () => {
    const stub: RoutingPolicy = { name: 'bad', version: '0', evaluate: () => [] };
    const { registry, controller } = setup(stub);
    add(registry, 'a');
    await expect(controller.route(task())).rejects.toMatchObject({ code: 'INTERNAL_ERROR' });
  });

  it('throws INTERNAL_ERROR on duplicate or foreign assessments', async () => {
    const assessment = (id: string): CandidateAssessment => ({
      resourceId: resourceId(id),
      eligible: true,
      score: 1,
      reasons: [],
    });
    const { registry, controller } = setup({
      name: 'bad',
      version: '0',
      evaluate: () => [assessment('a'), assessment('a')],
    });
    add(registry, 'a');
    add(registry, 'b');
    await expect(controller.route(task())).rejects.toMatchObject({ code: 'INTERNAL_ERROR' });

    const foreign = setup({
      name: 'bad',
      version: '0',
      evaluate: () => [assessment('zzz')],
    });
    add(foreign.registry, 'a');
    await expect(foreign.controller.route(task())).rejects.toMatchObject({
      code: 'INTERNAL_ERROR',
    });
  });

  it('works with a custom stub policy (replaceability)', async () => {
    const stub: RoutingPolicy = {
      name: 'stub',
      version: '9',
      evaluate: ({ candidates }) =>
        [...candidates].reverse().map((c, i) => ({
          resourceId: c.descriptor.id,
          eligible: true,
          score: 10 - i,
          reasons: [{ code: 'stub.pick', message: 'stubbed', effect: 'supports' as const }],
        })),
    };
    const { registry, controller } = setup(stub);
    add(registry, 'first');
    add(registry, 'second');
    const decision = requireSelected(await controller.route(task()));
    expect(decision.selected.resourceId).toBe('second');
    expect(decision.alternatives.map((a) => a.resourceId)).toEqual(['first']);
    expect(decision.policy).toEqual({ name: 'stub', version: '9' });
  });
});

describe('requireSelected', () => {
  it('returns selected decisions unchanged', async () => {
    const { registry, controller } = setup();
    add(registry, 'a');
    const decision = await controller.route(task());
    expect(requireSelected(decision)).toBe(decision);
  });

  it('throws NO_ELIGIBLE_RESOURCE with details', async () => {
    const { registry, controller } = setup();
    add(registry, 'a', { capabilities: [] });
    const decision = await controller.route(task());
    const err = caught(() => requireSelected(decision));
    expect(err.code).toBe('NO_ELIGIBLE_RESOURCE');
    expect(err.details).toEqual({
      taskId: 'task-1',
      rejected: [{ resourceId: 'a', reasonCodes: ['capability.missing'] }],
    });
  });
});

describe('explainRouteDecision', () => {
  async function selectedDecision() {
    const { registry, controller } = setup();
    add(registry, 'claude-code');
    add(registry, 'pi-sonnet');
    add(registry, 'deepseek-api', { capabilities: ['coding'] });
    return controller.route(
      task({
        requirements: { capabilities: [], preferredResourceIds: [resourceId('claude-code')] },
      }),
    );
  }

  it('explains a selection', async () => {
    const text = explainRouteDecision(await selectedDecision());
    expect(text).toContain('Selected resource: claude-code (score 1020, policy deterministic@1)');
    expect(text).toContain('Reasons:');
    expect(text).toContain('  + capability.match: has coding, repo-editing');
    expect(text).toContain('  + preference.task: preferred by the task');
    expect(text).toContain('  + state.available: resource is available');
    expect(text).toContain('Alternatives: pi-sonnet (20)');
    expect(text).toContain('Rejected:');
    expect(text).toContain('  - deepseek-api: capability.missing: lacks repo-editing');
  });

  it('omits rejected on request', async () => {
    const text = explainRouteDecision(await selectedDecision(), { includeRejected: false });
    expect(text).not.toContain('Rejected:');
    expect(text).not.toContain('deepseek-api');
  });

  it('marks neutral reasons with a middle dot', async () => {
    const { registry, controller } = setup();
    add(registry, 'a', {}, { availability: 'degraded' });
    const text = explainRouteDecision(await controller.route(task()));
    expect(text).toContain('  · state.degraded: resource is degraded');
  });

  it('explains no eligible resource', async () => {
    const { registry, controller } = setup();
    add(registry, 'a', { capabilities: [] });
    const text = explainRouteDecision(await controller.route(task()));
    expect(text).toContain('No eligible resource for task task-1');
    expect(text).toContain('  - a: capability.missing: lacks coding, repo-editing');
    expect(text).not.toContain('Selected resource');
  });
});
