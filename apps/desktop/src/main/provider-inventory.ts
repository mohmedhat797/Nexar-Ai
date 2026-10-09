import { lstat, open } from 'node:fs/promises';
import { constants } from 'node:fs';
import {
  NexarError,
  type InventorySource,
  type InventorySourceResult,
  type Logger,
  type ProviderModelEntry,
  type ProviderModelInventory,
  type ProviderRuntimeIdentity,
  type ResourceDescriptor,
} from '@nexar/contracts';
import {
  InMemoryProviderModelInventory,
  inventoryIdentityKey,
  inventoryResourceId,
  materializeInventory,
} from '@nexar/resource-registry';
import {
  InventoryArgsSchema,
  InventoryCacheSchema,
  InventoryListSchema,
  InventoryRowSchema,
  type InventoryRow,
  type InventorySourceId,
} from '../shared/provider-inventory.js';
import { CHANNELS } from '../shared/channels.js';
import { defineChannel, NoArgs, type ChannelDefinition } from './channel.js';
import { writeFileAtomic } from './atomic-write.js';

export interface InventoryDefinition {
  readonly sourceId: InventorySourceId;
  readonly identity: ProviderRuntimeIdentity;
  readonly source: InventorySource;
  readonly template: (entry: ProviderModelEntry) => ResourceDescriptor;
}
export interface ProviderInventoryOptions {
  readonly definitions: readonly InventoryDefinition[];
  readonly cachePath: string;
  readonly logger: Logger;
  readonly onChange: () => Promise<void>;
  readonly clock?: () => Date;
  readonly ttlMs?: number;
}
const MAX_CACHE_BYTES = 256 * 1024;

/** Public metadata only. Sources and commands are bound in main; IPC accepts a fixed source id. */
export class ProviderInventoryService {
  private readonly inventories: InMemoryProviderModelInventory;
  private readonly definitions = new Map<InventorySourceId, InventoryDefinition>();
  private readonly jobs = new Map<InventorySourceId, Promise<InventoryRow>>();
  private readonly sourceJobs = new Set<Promise<InventorySourceResult>>();
  private writes: Promise<void> = Promise.resolve();
  private disposed = false;

  constructor(private readonly options: ProviderInventoryOptions) {
    this.inventories = new InMemoryProviderModelInventory({
      ...(options.clock === undefined ? {} : { clock: options.clock }),
      ...(options.ttlMs === undefined ? {} : { ttlMs: options.ttlMs }),
    });
    for (const definition of options.definitions) {
      if (this.definitions.has(definition.sourceId)) throw new Error('Duplicate inventory source');
      this.definitions.set(definition.sourceId, definition);
    }
  }

  /** Strict, bounded regular-file read. A restored snapshot is always stale and cannot route. */
  async restore(): Promise<void> {
    try {
      const before = await lstat(this.options.cachePath, { bigint: true });
      if (
        !before.isFile() ||
        before.isSymbolicLink() ||
        before.nlink !== 1n ||
        before.size > BigInt(MAX_CACHE_BYTES)
      )
        return;
      const file = await open(
        this.options.cachePath,
        constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
      );
      try {
        const after = await file.stat({ bigint: true });
        const pathAfter = await lstat(this.options.cachePath, { bigint: true });
        if (
          !after.isFile() ||
          after.nlink !== 1n ||
          after.size > BigInt(MAX_CACHE_BYTES) ||
          !pathAfter.isFile() ||
          pathAfter.isSymbolicLink() ||
          pathAfter.ino !== after.ino ||
          pathAfter.dev !== after.dev ||
          before.ino !== after.ino ||
          before.dev !== after.dev
        )
          return;
        const bytes = Buffer.alloc(MAX_CACHE_BYTES + 1);
        const { bytesRead } = await file.read(bytes, 0, bytes.length, 0);
        if (bytesRead > MAX_CACHE_BYTES) return;
        const parsed = InventoryCacheSchema.safeParse(
          JSON.parse(bytes.subarray(0, bytesRead).toString('utf8')),
        );
        if (!parsed.success) return;
        const seen = new Set<InventorySourceId>();
        for (const saved of parsed.data.inventories) {
          if (seen.has(saved.sourceId)) return;
          seen.add(saved.sourceId);
        }
        for (const saved of parsed.data.inventories) {
          const definition = this.definitions.get(saved.sourceId);
          if (
            definition !== undefined &&
            inventoryIdentityKey(definition.identity) ===
              inventoryIdentityKey(saved.inventory.identity)
          ) {
            // JSON cannot contain present `undefined` optional fields; strict schema validated it.
            this.inventories.hydrateStale(saved.inventory as ProviderModelInventory);
          }
        }
      } finally {
        await file.close();
      }
    } catch {
      // A missing, corrupt or incompatible public cache does not rewrite owner config.
    }
  }

  list(): Promise<readonly InventoryRow[]> {
    return Promise.resolve(
      InventoryListSchema.parse([...this.definitions.keys()].map((id) => this.row(id))),
    );
  }

  snapshot(sourceId: InventorySourceId): ProviderModelInventory {
    return this.inventories.get(this.definition(sourceId).identity);
  }

  descriptors(): readonly ResourceDescriptor[] {
    return [...this.definitions.values()].flatMap((definition) => {
      const inventory = this.inventories.get(definition.identity);
      if (inventory.auth === 'unauthenticated') return [];
      const first = inventory.entries[0];
      return first === undefined ? [] : materializeInventory(inventory, definition.template(first));
    });
  }

  /** The same live guard is called at probe and execution, including legacy configured resources. */
  isModelAvailable(sourceId: InventorySourceId, descriptor: ResourceDescriptor): boolean {
    const inventory = this.snapshot(sourceId);
    if (
      descriptor.metadata?.['inventory'] !== undefined &&
      !this.matchesGeneration(descriptor, inventory)
    )
      return false;
    if (
      inventory.status !== 'fresh' ||
      inventory.auth !== 'authenticated' ||
      descriptor.kind.type !== 'model'
    )
      return false;
    return (
      inventory.identity.provider === descriptor.kind.provider &&
      inventory.entries.some(
        (entry) =>
          entry.selection.kind === 'model' &&
          entry.selection.id === (descriptor.kind.type === 'model' ? descriptor.kind.model : '') &&
          entry.compatibility === 'model-turn' &&
          entry.availability === 'available' &&
          (entry.source ?? inventory.source) !== 'static-verified',
      )
    );
  }

  refresh(sourceId: InventorySourceId): Promise<InventoryRow> {
    const pending = this.jobs.get(sourceId);
    if (pending !== undefined) return pending;
    const definition = this.definition(sourceId);
    if (this.disposed) return Promise.resolve(this.row(sourceId));
    const trackedSource: InventorySource = {
      fetch: (signal) => {
        const work = Promise.resolve().then(() => definition.source.fetch(signal));
        this.sourceJobs.add(work);
        void work.then(
          () => this.sourceJobs.delete(work),
          () => this.sourceJobs.delete(work),
        );
        return work;
      },
    };
    const job = this.inventories
      .refresh(definition.identity, trackedSource)
      .then(async (inventory) => {
        this.options.logger.info('provider-inventory.refreshed', {
          sourceId,
          status: inventory.status,
          count: inventory.entries.length,
          ...(inventory.reason === undefined ? {} : { reason: inventory.reason }),
        });
        await this.changed();
        if (this.jobs.get(sourceId) === job) this.jobs.delete(sourceId);
        return this.row(sourceId);
      })
      .finally(() => {
        if (this.jobs.get(sourceId) === job) this.jobs.delete(sourceId);
      });
    this.jobs.set(sourceId, job);
    return job;
  }

  isAvailable(descriptor: ResourceDescriptor): boolean {
    const current = this.descriptors().find((value) => value.id === descriptor.id);
    if (
      current === undefined ||
      current.runtime.adapter !== descriptor.runtime.adapter ||
      current.kind.type !== descriptor.kind.type ||
      JSON.stringify(current.metadata?.['inventory']) !==
        JSON.stringify(descriptor.metadata?.['inventory'])
    )
      return false;
    if (current.kind.type === 'model' && descriptor.kind.type === 'model') {
      return (
        current.kind.model === descriptor.kind.model &&
        current.kind.provider === descriptor.kind.provider &&
        this.isModelAvailable('chatgpt-plan', descriptor)
      );
    }
    return (
      current.kind.type === 'agent' &&
      descriptor.kind.type === 'agent' &&
      current.kind.agent === descriptor.kind.agent &&
      current.kind.underlying?.model === descriptor.kind.underlying?.model &&
      current.runtime.options?.['model'] === descriptor.runtime.options?.['model']
    );
  }

  rejectResource(descriptor: ResourceDescriptor): void {
    for (const definition of this.definitions.values()) {
      const inventory = this.inventories.get(definition.identity);
      if (!this.matchesGeneration(descriptor, inventory)) continue;
      if (
        inventory.entries.some(
          (entry) => inventoryResourceId(inventory.identity, entry.selection) === descriptor.id,
        )
      ) {
        this.rejectModel(definition.sourceId);
        return;
      }
    }
  }

  /** Account changes clear entries before another credential can be used; late results are discarded. */
  invalidate(sourceId: InventorySourceId): void {
    this.inventories.invalidate(this.definition(sourceId).identity);
    this.jobs.delete(sourceId);
    void this.changed();
  }

  rejectModel(sourceId: InventorySourceId): void {
    this.inventories.markStale(this.definition(sourceId).identity, 'model-rejected');
    this.jobs.delete(sourceId);
    this.options.logger.info('provider-inventory.model-rejected', { sourceId });
    void this.changed();
    // One deduplicated metadata refresh, never an inference retry or mid-loop switch.
    void this.refresh(sourceId).catch(() => undefined);
  }

  dispose(): void {
    this.disposed = true;
    this.inventories.dispose();
  }

  async flush(): Promise<void> {
    await this.writes;
    await Promise.allSettled([...this.sourceJobs]);
  }

  private definition(sourceId: InventorySourceId): InventoryDefinition {
    const definition = this.definitions.get(sourceId);
    if (definition === undefined)
      throw new NexarError('CONFIGURATION_ERROR', 'Inventory source unavailable');
    return definition;
  }

  private matchesGeneration(
    descriptor: ResourceDescriptor,
    inventory: ProviderModelInventory,
  ): boolean {
    const raw = descriptor.metadata?.['inventory'];
    if (raw === null || typeof raw !== 'object') return false;
    const metadata = raw as { generation?: unknown; identity?: unknown };
    if (
      metadata.generation !== inventory.generation ||
      metadata.identity === null ||
      typeof metadata.identity !== 'object'
    )
      return false;
    try {
      return (
        inventoryIdentityKey(metadata.identity as ProviderRuntimeIdentity) ===
        inventoryIdentityKey(inventory.identity)
      );
    } catch {
      return false;
    }
  }

  private row(sourceId: InventorySourceId): InventoryRow {
    const inventory = this.snapshot(sourceId);
    return InventoryRowSchema.parse({
      sourceId,
      inventory,
      refreshing: this.jobs.has(sourceId),
      resources: inventory.entries.map((entry) => ({
        id: inventoryResourceId(inventory.identity, entry.selection),
        displayName: entry.displayName,
        selection: entry.selection,
      })),
    });
  }

  private async changed(): Promise<void> {
    if (this.disposed) return;
    this.writes = this.writes
      .catch(() => undefined)
      .then(async () => {
        if (this.disposed) return;
        const cache = InventoryCacheSchema.parse({
          version: 1,
          inventories: [...this.definitions].map(([sourceId, definition]) => ({
            sourceId,
            inventory: this.inventories.get(definition.identity),
          })),
        });
        const text = JSON.stringify(cache);
        if (Buffer.byteLength(text) > MAX_CACHE_BYTES) return;
        await writeFileAtomic(this.options.cachePath, text);
      })
      .catch(() => {
        this.options.logger.warn('provider-inventory.cache-unavailable', {});
      });
    await this.writes;
    try {
      if (!this.disposed) await this.options.onChange();
    } catch {
      this.options.logger.warn('provider-inventory.publish-unavailable', {});
    }
  }
}

function service(value: ProviderInventoryService | undefined): ProviderInventoryService {
  if (value === undefined)
    throw new NexarError('CONFIGURATION_ERROR', 'Inventory service unavailable');
  return value;
}
export const inventoryChannels: Readonly<Record<string, ChannelDefinition>> = {
  [CHANNELS.inventoryList]: defineChannel(NoArgs, (_args, { deps }) =>
    service(deps.providerInventory).list(),
  ),
  [CHANNELS.inventoryRefresh]: defineChannel(InventoryArgsSchema, ({ sourceId }, { deps }) => {
    if (sourceId !== 'chatgpt-plan' && deps.subscriptions?.isSigningIn(sourceId))
      throw new NexarError('CONFLICT', 'Native sign-in is already running');
    return service(deps.providerInventory).refresh(sourceId);
  }),
};
