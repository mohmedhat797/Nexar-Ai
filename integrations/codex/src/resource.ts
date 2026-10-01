import { adapterId, resourceId } from '@nexar/contracts';
import type { ResourceDescriptor } from '@nexar/contracts';

export const CODEX_ADAPTER_ID = adapterId('codex');

/** A ready-to-register descriptor for the locally installed, logged-in Codex CLI. */
export function codexResource(overrides: Partial<ResourceDescriptor> = {}): ResourceDescriptor {
  return {
    id: resourceId('codex'),
    displayName: 'Codex',
    kind: {
      type: 'agent',
      agent: 'codex',
      interface: 'cli',
      underlying: { provider: 'openai' },
    },
    capabilities: [
      'text-generation',
      'reasoning',
      'coding',
      'repo-editing',
      'code-review',
      'tool-use',
      'shell-execution',
    ],
    runtime: { adapter: CODEX_ADAPTER_ID, locality: 'local' },
    auth: {
      mode: 'subscription',
      credential: {
        source: 'runtime-managed',
        description: 'Codex login (codex login, ChatGPT sign-in)',
      },
    },
    cost: { model: 'subscription' },
    dataLocality: 'third-party',
    tags: ['native-agent'],
    ...overrides,
  };
}
