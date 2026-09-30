import { adapterId, resourceId } from '@nexar/contracts';
import type { ResourceDescriptor } from '@nexar/contracts';

export const CLAUDE_CODE_ADAPTER_ID = adapterId('claude-code');

/** A ready-to-register descriptor for the locally installed, logged-in Claude Code CLI. */
export function claudeCodeResource(
  overrides: Partial<ResourceDescriptor> = {},
): ResourceDescriptor {
  return {
    id: resourceId('claude-code'),
    displayName: 'Claude Code',
    kind: {
      type: 'agent',
      agent: 'claude-code',
      interface: 'cli',
      underlying: { provider: 'anthropic' },
    },
    capabilities: [
      'text-generation',
      'reasoning',
      'knowledge-work',
      'coding',
      'repo-editing',
      'code-review',
      'tool-use',
      'long-context',
    ],
    runtime: {
      adapter: CLAUDE_CODE_ADAPTER_ID,
      locality: 'local',
      options: { permissionMode: 'plan' },
    },
    auth: {
      mode: 'subscription',
      credential: { source: 'runtime-managed', description: 'Claude Code login (claude auth)' },
    },
    cost: { model: 'subscription' },
    dataLocality: 'third-party',
    tags: ['native-agent'],
    ...overrides,
  };
}
