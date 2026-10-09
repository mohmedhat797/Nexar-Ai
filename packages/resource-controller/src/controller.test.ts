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
  type QuotaObservation,
  type RoutingHistory,
  type RoutingInput,
  type RoutingPolicy,
  type StrategyLedger,
  type WorkGraph,
  type WorkUnit,
} from '@nexar/contracts';
import { InMemoryResourceRegistry } from '@nexar/resource-registry';
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_TASK_KIND_RULES,
  DeterministicRoutingPolicy,
  ResourceController,
  type FallbackRoutingPolicy,
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

describe('ResourceController.planStrategy', () => {
  const history: RoutingHistory = {
    windowStart: '2026-02-01T00:00:00.000Z',
    windowEnd: NOW.toISOString(),
    executions: {},
    lanes: {},
    skipped: 0,
  };
  const quota: QuotaObservation = {
    unit: 'requests',
    remaining: 5,
    observedAt: NOW.toISOString(),
    provenance: {},
  };
  const graph: WorkGraph = {
    graphId: 'g1',
    units: [
      {
        unitId: 'a',
        task: { id: taskId('g1:a'), kind: 'coding', requirements: { capabilities: ['coding'] } },
      },
      {
        unitId: 'b',
        task: { id: taskId('g1:b'), kind: 'coding', requirements: { capabilities: ['coding'] } },
        dependsOn: ['a'],
      },
    ],
  };

  function spying(base: RoutingPolicy) {
    const inputs: RoutingInput[] = [];
    const policy: RoutingPolicy = {
      name: base.name,
      version: base.version,
      evaluate: (input) => {
        inputs.push(input);
        return base.evaluate(input);
      },
    };
    return { policy, inputs };
  }

  function build(policy: RoutingPolicy) {
    const registry = new InMemoryResourceRegistry({ clock: () => NOW });
    add(registry, 'one');
    add(registry, 'two');
    const controller = new ResourceController({
      registry,
      policy,
      clock: () => NOW,
      quotaSource: { observe: (ids) => Promise.resolve(new Map(ids.map((id) => [id, [quota]]))) },
      historySource: { read: () => Promise.resolve(history) },
    });
    return controller;
  }

  it('reads the same snapshot, quota and history as route() and is deterministic', async () => {
    const { policy, inputs } = spying(
      new DeterministicRoutingPolicy({ taskKinds: DEFAULT_TASK_KIND_RULES }),
    );
    const controller = build(policy);
    await controller.route(task());
    const routed = inputs.splice(0);
    const first = await controller.planStrategy(graph);
    const second = await controller.planStrategy(graph);

    expect(second).toEqual(first);
    expect(first.policy).toMatchObject({ name: 'strategy', version: '1' });
    expect(first.policy.base).toEqual({ name: 'deterministic', version: '1' });
    expect(first.units.map((u) => u.unitId)).toEqual(['a', 'b']);
    expect(first.units.every((u) => u.decision.outcome === 'selected')).toBe(true);
    const planned = inputs[0];
    expect(planned?.candidates).toEqual(routed[0]?.candidates);
    expect(planned?.candidates.every((c) => c.state.quotas?.[0] === quota)).toBe(true);
    expect(planned?.history).toBe(history);
    expect(planned?.facts?.now).toBe(NOW.toISOString());
  });

  it('plans with the deterministic fallback and stamps it when the policy throws', async () => {
    const base = new DeterministicRoutingPolicy({ taskKinds: DEFAULT_TASK_KIND_RULES });
    const policy: FallbackRoutingPolicy = {
      name: 'resource-intelligence',
      version: '1',
      configId: 'cfg',
      evaluate: () => {
        throw new Error('boom');
      },
      evaluateFallback: (input) => base.evaluate(input),
    };
    const strategy = await build(policy).planStrategy(graph);

    expect(strategy.policy.base).toEqual({
      name: 'deterministic',
      version: '1',
      configId: 'cfg',
      fallback: { from: 'resource-intelligence@1', reason: 'INTERNAL_ERROR' },
    });
    expect(strategy.units.every((u) => u.decision.outcome === 'selected')).toBe(true);
  });

  it('fails closed when a policy without a fallback throws', async () => {
    const policy: RoutingPolicy = {
      name: 'broken',
      version: '1',
      evaluate: () => {
        throw new Error('boom');
      },
    };
    await expect(build(policy).planStrategy(graph)).rejects.toThrow('boom');
  });
});

describe('ResourceController.allocate', () => {
  const quota: QuotaObservation = {
    unit: 'requests',
    remaining: 5,
    observedAt: NOW.toISOString(),
    provenance: {},
  };
  const unit = (id: string): WorkUnit => ({
    unitId: id,
    task: { id: taskId(`g:${id}`), kind: 'coding', requirements: { capabilities: ['coding'] } },
  });
  const ledger: StrategyLedger = {
    graphId: 'g',
    allocations: [],
    spentUsd: 0,
    reviewDiversity: 'preferred',
  };

  function build(policy: RoutingPolicy) {
    const registry = new InMemoryResourceRegistry({ clock: () => NOW });
    add(registry, 'one');
    add(registry, 'two');
    return new ResourceController({
      registry,
      policy,
      clock: () => NOW,
      quotaSource: { observe: (ids) => Promise.resolve(new Map(ids.map((id) => [id, [quota]]))) },
    });
  }

  it('reads the same candidates as route(), advances the ledger and is deterministic', async () => {
    const inputs: RoutingInput[] = [];
    const base = new DeterministicRoutingPolicy({ taskKinds: DEFAULT_TASK_KIND_RULES });
    const policy: RoutingPolicy = {
      name: base.name,
      version: base.version,
      evaluate: (input) => {
        inputs.push(input);
        return base.evaluate(input);
      },
    };
    const controller = build(policy);
    await controller.route(task());
    const routed = inputs.splice(0);
    const first = await controller.allocate(ledger, unit('a'));
    const second = await controller.allocate(ledger, unit('a'));

    expect(second).toEqual(first);
    expect(inputs[0]?.candidates).toEqual(routed[0]?.candidates);
    expect(first.decision.outcome).toBe('selected');
    expect(first.decision.policy).toMatchObject({ name: 'strategy', version: '1' });
    expect(first.ledger.allocations.map((a) => a.unitId)).toEqual(['a']);
    expect(ledger.allocations).toEqual([]);

    // The balance factor moves the next unit to the other resource.
    const next = await controller.allocate(first.ledger, unit('b'));
    expect(next.ledger.allocations.map((a) => a.unitId)).toEqual(['a', 'b']);
    expect(next.ledger.allocations[1]?.resourceId).not.toBe(
      first.ledger.allocations[0]?.resourceId,
    );
  });

  it('uses the deterministic fallback and stamps it when the policy throws', async () => {
    const base = new DeterministicRoutingPolicy({ taskKinds: DEFAULT_TASK_KIND_RULES });
    const policy: FallbackRoutingPolicy = {
      name: 'resource-intelligence',
      version: '1',
      configId: 'cfg',
      evaluate: () => {
        throw new Error('boom');
      },
      evaluateFallback: (input) => base.evaluate(input),
    };
    const { decision } = await build(policy).allocate(ledger, unit('a'));
    expect(decision.outcome).toBe('selected');
    expect(decision.policy.fallback).toEqual({
      from: 'resource-intelligence@1',
      reason: 'INTERNAL_ERROR',
    });
  });

  it('fails closed when a policy without a fallback throws', async () => {
    const policy: RoutingPolicy = {
      name: 'broken',
      version: '1',
      evaluate: () => {
        throw new Error('boom');
      },
    };
    await expect(build(policy).allocate(ledger, unit('a'))).rejects.toThrow('boom');
  });
});
