import { adapterId, resourceId } from '@nexar/contracts';
import type { ResourceDescriptor } from '@nexar/contracts';

export const DELEGATE_SKILLS_ADAPTER_ID = adapterId('delegate-skills');

/**
 * A descriptor for Codex executed through the Delegate Skills codex relay. The owner must still set
 * `runtime.options` (`relay`, `relayPath`, `relaySha256`); routing stays with the Resource Controller.
 */
export function delegateSkillsCodexResource(
  overrides: Partial<ResourceDescriptor> = {},
): ResourceDescriptor {
  return {
    id: resourceId('codex-relay'),
    displayName: 'Codex (Delegate Skills relay)',
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
    runtime: { adapter: DELEGATE_SKILLS_ADAPTER_ID, locality: 'local' },
    auth: {
      mode: 'subscription',
      credential: {
        source: 'runtime-managed',
        description: 'Codex login (codex login, ChatGPT sign-in)',
      },
    },
    cost: { model: 'subscription' },
    dataLocality: 'third-party',
    tags: ['delegate-skills', 'relay'],
    ...overrides,
  };
}
