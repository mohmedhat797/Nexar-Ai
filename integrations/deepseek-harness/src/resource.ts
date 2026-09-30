import { adapterId, resourceId } from '@nexar/contracts';
import type { ResourceDescriptor } from '@nexar/contracts';

export const DEEPSEEK_HARNESS_ADAPTER_ID = adapterId('deepseek-harness');

/** The `dsh` version this adapter's wire protocol was verified against (exact-pinned). */
export const DSH_PINNED_VERSION = '0.2.0-rc.2';

/** Default DeepSeek Harness resource; `overrides` replace top-level fields. */
export function deepseekHarnessResource(
  overrides: Partial<ResourceDescriptor> = {},
): ResourceDescriptor {
  return {
    id: resourceId('deepseek-harness'),
    displayName: 'DeepSeek Harness (deepseek-v4-flash)',
    kind: {
      type: 'agent',
      agent: 'deepseek-harness',
      interface: 'rpc',
      underlying: { provider: 'deepseek-official', model: 'deepseek-v4-flash' },
    },
    capabilities: [
      'text-generation',
      'reasoning',
      'knowledge-work',
      'coding',
      'repo-editing',
      'code-review',
      'tool-use',
      'shell-execution',
    ],
    runtime: {
      adapter: DEEPSEEK_HARNESS_ADAPTER_ID,
      locality: 'local',
      options: { provider: 'deepseek-official', model: 'deepseek-v4-flash' },
    },
    auth: { mode: 'api-key', credential: { source: 'env', name: 'DEEPSEEK_API_KEY' } },
    cost: { model: 'unknown' },
    dataLocality: 'third-party',
    tags: ['agent-runtime'],
    ...overrides,
  };
}
