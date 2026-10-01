import {
  NexarError,
  adapterId,
  resourceId,
  taskId,
  type CandidateAssessment,
  type LogFields,
  type Logger,
  type NexarTask,
  type ResourceDescriptor,
  type RoutingPolicy,
} from '@nexar/contracts';
import { InMemoryResourceRegistry } from '@nexar/resource-registry';
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_RESOURCE_INTELLIGENCE_SETTINGS,
  DEFAULT_TASK_KIND_RULES,
  ResourceController,
  ResourceIntelligencePolicy,
  explainRouteDecision,
  explainRouteDecisionDetailed,
  isFallbackRoutingPolicy,
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

const task: NexarTask = {
  id: taskId('task-1'),
  kind: 'coding',
  input: { prompt: 'SECRET PROMPT TEXT' },
  requirements: { capabilities: [] },
  origin: { source: 'test' },
  createdAt: NOW.toISOString(),
};

function recordingLogger(): { logger: Logger; warnings: { msg: string; fields?: LogFields }[] } {
  const warnings: { msg: string; fields?: LogFields }[] = [];
  const logger: Logger = {
    debug: () => undefined,
    info: () => undefined,
    warn: (msg, fields) => warnings.push({ msg, ...(fields === undefined ? {} : { fields }) }),
    error: () => undefined,
    child: () => logger,
  };
  return { logger, warnings };
}

/** The real policy whose scoring stage throws: the fallback must still use its hard filters. */
class BrokenScoringPolicy extends ResourceIntelligencePolicy {
  constructor(private readonly error: unknown) {
    super({
      taskKinds: DEFAULT_TASK_KIND_RULES,
      defaultResourceId: resourceId('b'),
      settings: DEFAULT_RESOURCE_INTELLIGENCE_SETTINGS,
    });
  }
  override evaluate(): readonly CandidateAssessment[] {
    throw this.error;
  }
}

function setup(policy: RoutingPolicy) {
  const registry = new InMemoryResourceRegistry({ clock: () => NOW });
  registry.register(descriptor('a'));
  registry.register(descriptor('b'));
  // Hard-filtered: lacks the coding capabilities.
  registry.register(descriptor('c', { capabilities: [] }));
  const { logger, warnings } = recordingLogger();
  const controller = new ResourceController({ registry, policy, clock: () => NOW, logger });
  return { controller, warnings };
}

describe('controller fallback (ADR-020 §11)', () => {
  it('falls back to deterministic ranking over the same hard filters, never silently', async () => {
    const policy = new BrokenScoringPolicy(new NexarError('INTERNAL_ERROR', 'kaboom detail'));
    expect(isFallbackRoutingPolicy(policy)).toBe(true);
    const { controller, warnings } = setup(policy);
    const decision = await controller.route(task);

    expect(decision.policy).toEqual({
      name: 'deterministic',
      version: '1',
      configId: policy.configId,
      fallback: { from: 'resource-intelligence@1', reason: 'INTERNAL_ERROR' },
    });
    expect(decision.outcome).toBe('selected');
    if (decision.outcome !== 'selected') return;
    // Default resource first, as deterministic@1 would rank it.
    expect(decision.selected.resourceId).toBe('b');
    expect(decision.rejected.map((r) => r.resourceId)).toEqual(['c']);
    expect(decision.rejected[0]?.reasons.map((r) => r.code)).toContain('capability.missing');

    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.fields).toEqual({
      from: 'resource-intelligence@1',
      reason: 'INTERNAL_ERROR',
    });
    expect(JSON.stringify(warnings)).not.toContain('kaboom');
    expect(JSON.stringify(warnings)).not.toContain('SECRET');

    expect(explainRouteDecision(decision)).toContain(
      'Fallback: resource-intelligence@1 → deterministic@1 (INTERNAL_ERROR)',
    );
    expect(explainRouteDecisionDetailed(decision)).toContain('Fallback: resource-intelligence@1');
  });

  it('records INTERNAL_ERROR for a non-Nexar error', async () => {
    const { controller } = setup(new BrokenScoringPolicy(new TypeError('x')));
    const decision = await controller.route(task);
    expect(decision.policy.fallback?.reason).toBe('INTERNAL_ERROR');
  });

  it('rethrows (fails closed) when the policy has no fallback', async () => {
    const { controller } = setup({
      name: 'plain',
      version: '1',
      evaluate: () => {
        throw new NexarError('INTERNAL_ERROR', 'no fallback');
      },
    });
    await expect(controller.route(task)).rejects.toThrow('no fallback');
  });

  it('rethrows when the fallback throws too', async () => {
    class DoublyBroken extends BrokenScoringPolicy {
      override evaluateFallback(): readonly CandidateAssessment[] {
        throw new NexarError('INTERNAL_ERROR', 'fallback broke');
      }
    }
    const { controller } = setup(new DoublyBroken(new Error('first')));
    await expect(controller.route(task)).rejects.toThrow('fallback broke');
  });

  it('does not stamp a fallback when the policy succeeds', async () => {
    const policy = new ResourceIntelligencePolicy({
      taskKinds: DEFAULT_TASK_KIND_RULES,
      settings: DEFAULT_RESOURCE_INTELLIGENCE_SETTINGS,
    });
    const { controller, warnings } = setup(policy);
    const decision = await controller.route(task);
    expect(decision.policy).toEqual({
      name: 'resource-intelligence',
      version: '1',
      configId: policy.configId,
    });
    expect(warnings).toHaveLength(0);
  });
});
