import {
  adapterId,
  resourceId,
  taskId,
  type ResourceDescriptor,
  type ResourceSnapshot,
  type RoutingInput,
} from '@nexar/contracts';
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_RESOURCE_INTELLIGENCE_SETTINGS,
  DEFAULT_TASK_KIND_RULES,
  ResourceIntelligencePolicy,
  applyHardFilters,
} from './index.js';

const snapshot = (id: string, capabilities: string[]): ResourceSnapshot => {
  const descriptor: ResourceDescriptor = {
    id: resourceId(id),
    displayName: id,
    kind: { type: 'model', provider: 'anthropic', model: id, access: 'api' },
    capabilities,
    runtime: { adapter: adapterId('pi'), locality: 'remote' },
    auth: { mode: 'none' },
    cost: { model: 'unknown' },
    dataLocality: 'third-party',
    metadata: { connection: { id: 'anthropic.api' } },
  };
  return {
    descriptor,
    state: { availability: 'available', auth: 'authenticated', observedAt: '2026-01-01T00:00:00Z' },
  };
};

describe('model-turn capability and routing', () => {
  it('never makes a model-turn resource eligible for automation, which needs tool-use', () => {
    const input: RoutingInput = {
      task: { id: taskId('t'), kind: 'automation', requirements: { capabilities: [] } },
      candidates: [
        snapshot('pi-turn', ['text-generation', 'reasoning', 'knowledge-work', 'model-turn']),
        snapshot('native', ['text-generation', 'tool-use']),
      ],
      facts: { now: '2026-03-01T12:00:00.000Z' },
    };
    const filtered = applyHardFilters(input, {
      taskKinds: DEFAULT_TASK_KIND_RULES,
      settings: DEFAULT_RESOURCE_INTELLIGENCE_SETTINGS,
    });
    expect(filtered.filter((f) => f.eligible).map((f) => f.resourceId)).toEqual(['native']);
    const assessed = new ResourceIntelligencePolicy({
      taskKinds: DEFAULT_TASK_KIND_RULES,
      settings: DEFAULT_RESOURCE_INTELLIGENCE_SETTINGS,
    }).evaluate(input);
    expect(assessed.filter((a) => a.eligible).map((a) => a.resourceId)).toEqual(['native']);
  });
});
