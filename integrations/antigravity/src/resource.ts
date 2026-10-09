import { adapterId, resourceId } from '@nexar/contracts';
import type { ResourceDescriptor } from '@nexar/contracts';

export const ANTIGRAVITY_ADAPTER_ID = adapterId('antigravity');

/**
 * A descriptor for the locally installed, signed-in Antigravity CLI (`agy`). EXPERIMENTAL:
 * `acknowledgeExperimental` is off, so the adapter refuses to execute until the owner turns it on.
 */
export function antigravityResource(
  overrides: Partial<ResourceDescriptor> = {},
): ResourceDescriptor {
  return {
    id: resourceId('antigravity'),
    displayName: 'Antigravity (experimental)',
    kind: {
      type: 'agent',
      agent: 'antigravity',
      interface: 'cli',
      underlying: { provider: 'google' },
    },
    capabilities: [
      'coding',
      'repo-editing',
      'code-review',
      'shell-execution',
      'tool-use',
      'reasoning',
    ],
    runtime: {
      adapter: ANTIGRAVITY_ADAPTER_ID,
      locality: 'local',
      options: { acknowledgeExperimental: false },
    },
    auth: {
      mode: 'subscription',
      credential: {
        source: 'runtime-managed',
        description: 'agy sign-in (Google account)',
      },
    },
    cost: { model: 'subscription' },
    dataLocality: 'third-party',
    tags: ['native-agent', 'experimental'],
    metadata: {
      connection: {
        id: 'google.subscription',
        provider: 'google',
        method: 'subscription',
        authClass: 'vendor-native',
        support: 'experimental',
      },
    },
    ...overrides,
  };
}
