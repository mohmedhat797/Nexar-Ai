import {
  BUILTIN_CONNECTIONS,
  ownerCodexResourceId,
  resourceId,
  type InventorySource,
  type PersistentConnectionRecord,
  type ProviderModelEntry,
  type ProviderRuntimeIdentity,
  type ResourceDescriptor,
  type SubscriptionRuntimeId,
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

/** The resource an owner-added Codex connection publishes. It carries no path; main resolves one. */
export function ownerCodexResource(record: PersistentConnectionRecord): ResourceDescriptor {
  return codexResource({
    id: resourceId(ownerCodexResourceId(record.id)),
    displayName: record.label,
    metadata: {
      connection: {
        id: record.id,
        provider: record.provider,
        method: record.method,
        authClass: record.authClass,
        support: record.support,
      },
      connectionGeneration: record.credentialGeneration,
      connectionHost: record.machine,
    },
  });
}

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
        provider: BUILTIN_CONNECTIONS['anthropic.subscription'].provider,
        connectionId: BUILTIN_CONNECTIONS['anthropic.subscription'].id,
        runtimeId: 'claude-code',
        routeId: 'claude.native',
        machine: BUILTIN_CONNECTIONS['anthropic.subscription'].machine,
      },
      source: createClaudeModelInventorySource(options),
      template: () => claudeCodeResource(),
    },
    {
      sourceId: 'codex',
      identity: {
        provider: BUILTIN_CONNECTIONS['openai.subscription'].provider,
        connectionId: BUILTIN_CONNECTIONS['openai.subscription'].id,
        runtimeId: 'codex',
        routeId: 'codex.native',
        machine: BUILTIN_CONNECTIONS['openai.subscription'].machine,
      },
      source: codexDefaultInventorySource(options),
      template: () => codexResource(),
    },
    {
      sourceId: 'antigravity',
      identity: {
        provider: BUILTIN_CONNECTIONS['google.subscription'].provider,
        connectionId: BUILTIN_CONNECTIONS['google.subscription'].id,
        runtimeId: 'antigravity',
        routeId: 'google.native',
        machine: BUILTIN_CONNECTIONS['google.subscription'].machine,
      },
      source: antigravityModelInventorySource(options),
      template: () => antigravityResource(),
    },
  ];
}
