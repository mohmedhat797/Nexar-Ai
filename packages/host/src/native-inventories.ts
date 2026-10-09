import type {
  InventorySource,
  ProviderModelEntry,
  ProviderRuntimeIdentity,
  ResourceDescriptor,
  SubscriptionRuntimeId,
} from '@nexar/contracts';
import {
  claudeCodeResource,
  createClaudeModelInventorySource,
} from '@nexar/integration-claude-code';
import { codexDefaultInventorySource, codexResource } from '@nexar/integration-codex';
import {
  antigravityModelInventorySource,
  antigravityResource,
} from '@nexar/integration-antigravity';

export interface NativeInventoryDefinition {
  readonly sourceId: SubscriptionRuntimeId;
  readonly identity: ProviderRuntimeIdentity;
  readonly source: InventorySource;
  readonly template: (entry: ProviderModelEntry) => ResourceDescriptor;
}

/** Vendor mechanisms stay in integrations; only explicit owner refresh calls these sources. */
export function createNativeModelInventories(options: {
  readonly env: NodeJS.ProcessEnv;
  readonly privateDirectory: string;
}): readonly NativeInventoryDefinition[] {
  return [
    {
      sourceId: 'claude-code',
      identity: {
        provider: 'anthropic',
        connectionId: 'anthropic.subscription',
        runtimeId: 'claude-code',
        routeId: 'claude.native',
        machine: 'desktop',
      },
      source: createClaudeModelInventorySource(options),
      template: () => claudeCodeResource(),
    },
    {
      sourceId: 'codex',
      identity: {
        provider: 'openai',
        connectionId: 'openai.subscription',
        runtimeId: 'codex',
        routeId: 'codex.native',
        machine: 'desktop',
      },
      source: codexDefaultInventorySource(options),
      template: () => codexResource(),
    },
    {
      sourceId: 'antigravity',
      identity: {
        provider: 'google',
        connectionId: 'google.subscription',
        runtimeId: 'antigravity',
        routeId: 'google.native',
        machine: 'desktop',
      },
      source: antigravityModelInventorySource(options),
      template: () => antigravityResource(),
    },
  ];
}
