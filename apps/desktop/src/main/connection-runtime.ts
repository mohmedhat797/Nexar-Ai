import { createHash } from 'node:crypto';
import {
  connectionOf,
  NexarError,
  type ResourceDescriptor,
  type ResourceSnapshot,
  type PersistentConnectionRecord,
} from '@nexar/contracts';
import { catalogResourceId } from '@nexar/resource-registry';
import { piCatalogDiscoverySource, type PiCatalogDiscoveryOptions } from '@nexar/integration-pi';
import type { InventoryExecutionGuard } from '@nexar/host';
import type { ConnectionManager } from './connection-manager.js';
import type { SettingsStore } from './settings-store.js';
import type { EngineHost } from './engine-host.js';

/** Production Desktop publisher. Discovery is static catalog metadata, never provider inference. */
export class ConnectionRuntime {
  private readonly published = new Map<string, ResourceDescriptor>();
  private readonly known = new Map<string, ResourceDescriptor>();
  constructor(
    readonly manager: ConnectionManager,
    private readonly options: Pick<PiCatalogDiscoveryOptions, 'listModels' | 'maxModels'> = {},
  ) {}

  async descriptors(): Promise<readonly ResourceDescriptor[]> {
    const records = await this.manager.listConnections();
    const results: ResourceDescriptor[] = [];
    for (const record of records) {
      if (record.builtIn || record.method !== 'api' || record.credentialScope.kind !== 'keystore')
        continue;
      // Only eligible sources acquire a refresh lease. Static identity enumeration is not authentication.
      if (
        !record.enabled ||
        record.lifecycleState !== 'ACTIVE' ||
        !this.manager.toDto(record).hasCredential
      )
        continue;
      const lease = await this.manager.acquireExecution(record.id);
      try {
        const found = await piCatalogDiscoverySource({
          providers: [record.provider],
          credentialSource: 'keystore',
          connection: record,
          credentialName: record.credentialScope.name,
          catalogResourceId,
          ...this.options,
        }).discover({ now: new Date(), signal: new AbortController().signal });
        for (const descriptor of found) {
          const bound = {
            ...descriptor,
            metadata: {
              ...descriptor.metadata,
              connectionGeneration: record.credentialGeneration,
              connectionHost: record.machine,
            },
          };
          this.known.set(bound.id, bound);
          if (this.manager.isAvailable(bound)) results.push(bound);
        }
      } finally {
        lease.release();
      }
    }
    this.published.clear();
    for (const r of results) this.published.set(r.id, r);
    return results;
  }
  guard(inventory?: InventoryExecutionGuard): InventoryExecutionGuard {
    return {
      isAvailable: (descriptor) =>
        this.manager.isAvailable(descriptor) &&
        (descriptor.metadata?.['inventory'] === undefined ||
          inventory === undefined ||
          inventory.isAvailable(descriptor)),
      onModelRejected: (descriptor) => inventory?.onModelRejected(descriptor),
      acquire: (descriptor) => this.manager.acquireResource(descriptor),
      validate: (descriptor) => this.manager.validateResource(descriptor),
    };
  }
  /** Selection and preview must respect current authority even while registry probes settle. */
  filterCandidates(snapshots: readonly ResourceSnapshot[]): readonly ResourceSnapshot[] {
    return snapshots.filter((snapshot) => this.manager.isAvailable(snapshot.descriptor));
  }
  /** Managed pins never silently select another account, even if their publication was removed. */
  validatePin(id: string, current?: readonly ResourceDescriptor[]): void {
    // Legacy built-in IDs also need authority checks, even before a catalog refresh has probed them.
    const descriptor =
      current?.find((resource) => resource.id === id) ??
      this.published.get(id) ??
      this.known.get(id);
    if (descriptor !== undefined) {
      this.known.set(id, descriptor);
      this.manager.assertAvailable(descriptor);
      return;
    }
    if (id.startsWith('catalog:') || id.startsWith('inventory:'))
      throw new NexarError('RESOURCE_UNAVAILABLE', 'Pinned connection is unavailable', {
        details: { reason: 'pin.connection-removed' },
      });
  }
  remember(descriptors: readonly ResourceDescriptor[]): void {
    for (const descriptor of descriptors) {
      const c = connectionOf(descriptor);
      if (c !== undefined) {
        this.known.set(descriptor.id, descriptor);
        this.published.set(descriptor.id, descriptor);
      }
    }
  }
  async effects(
    record: PersistentConnectionRecord,
    settings: SettingsStore,
    engine: EngineHost,
  ): Promise<{ labels: readonly string[]; fingerprint: string }> {
    const descriptors = [...engine.composition().runtime.registry.list(), ...this.known.values()];
    const ids = new Set(
      descriptors.filter((d) => connectionOf(d)?.id === record.id).map((d) => String(d.id)),
    );
    if (record.method === 'api' && record.credentialScope.kind === 'keystore') {
      const catalog = await piCatalogDiscoverySource({
        providers: [record.provider],
        connection: record,
        credentialName: record.credentialScope.name,
        credentialSource: 'keystore',
        catalogResourceId,
        ...this.options,
      }).discover({ now: new Date(), signal: new AbortController().signal });
      for (const d of catalog) ids.add(d.id);
    }
    const behavior = await settings.getBehavior(),
      orchestration = await settings.getOrchestration();
    if (!behavior.valid || !orchestration.valid)
      throw new NexarError('CONFIGURATION_ERROR', 'Saved resource preferences cannot be verified');
    const references: { label: string; id: string }[] = [];
    const push = (label: string, id: string | undefined) => {
      if (id !== undefined) references.push({ label, id });
    };
    push('Cowork resource preference', behavior.value.cowork.preferredResourceId);
    push('Coding resource preference', behavior.value.code.preferredResourceId);
    push('Cowork control pin', orchestration.value.cowork.controlResource.resourceId);
    const loaded = engine.composition().loaded.config;
    push('Default resource', loaded.routing.defaultResourceId);
    push('Coding control pin', loaded.orchestration?.code?.controlResource?.resourceId);
    const known = new Map(descriptors.map((d) => [String(d.id), d]));
    const labels = references.flatMap((ref) => {
      if (ids.has(ref.id))
        return [`${ref.label}: ${known.get(ref.id)?.displayName ?? record.label}`];
      if (!known.has(ref.id) && /^(catalog|inventory):/.test(ref.id))
        return [`${ref.label}: unresolved saved connection (reference retained)`];
      return [];
    });
    return {
      labels,
      fingerprint: createHash('sha256').update(JSON.stringify(references)).digest('hex'),
    };
  }
}
