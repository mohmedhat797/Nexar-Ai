import {
  adapterId,
  resourceId,
  type ResourceDescriptor,
  type ResourceSnapshot,
  type ResourceState,
} from '@nexar/contracts';
import {
  DEFAULT_RESOURCE_INTELLIGENCE_SETTINGS,
  DEFAULT_TASK_KIND_RULES,
  ResourceIntelligencePolicy,
} from '@nexar/resource-controller';

/** Test fixtures shared by the gateway suites. */
export const NOW = new Date('2026-03-01T12:00:00.000Z');

const CAPS = ['text-generation', 'knowledge-work', 'reasoning'];

export function snap(
  id: string,
  d: Partial<ResourceDescriptor> = {},
  s: Partial<ResourceState> = {},
): ResourceSnapshot {
  return {
    descriptor: {
      id: resourceId(id),
      displayName: id,
      kind: { type: 'model', provider: 'acme', model: id, access: 'api' },
      capabilities: [...CAPS, 'model-turn'],
      runtime: { adapter: adapterId('test'), locality: 'remote' },
      auth: { mode: 'none' },
      cost: { model: 'free' },
      dataLocality: 'third-party',
      ...d,
    },
    state: {
      availability: 'available',
      auth: 'authenticated',
      observedAt: '2026-01-01T00:00:00.000Z',
      ...s,
    },
  };
}

export function routingPolicy(): ResourceIntelligencePolicy {
  return new ResourceIntelligencePolicy({
    taskKinds: DEFAULT_TASK_KIND_RULES,
    settings: DEFAULT_RESOURCE_INTELLIGENCE_SETTINGS,
  });
}
