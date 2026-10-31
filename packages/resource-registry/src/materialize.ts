import { createHash } from 'node:crypto';
import {
  connectionKey,
  resourceId,
  type ConnectionDefinition,
  type ProviderModelInventory,
  type ProviderModelSelection,
  type ProviderRuntimeIdentity,
  type ResourceDescriptor,
  type ResourceId,
} from '@nexar/contracts';
import { inventoryIdentityKey } from './inventory.js';

function slugifyCatalogId(raw: string): string {
  const slug = raw
    .toLowerCase()
    .replace(/[^a-z0-9._:-]/g, '-')
    .replace(/^[^a-z0-9]+/, '')
    .slice(0, 128);
  if (slug === '') throw new Error('Invalid catalog model id');
  return slug;
}

/** Default connection → existing `pi.<provider>.<model>` id; any other → `catalog:<sha256(connectionKey, provider, model)>`. */
export function catalogResourceId(
  connection: Pick<ConnectionDefinition, 'id' | 'machine' | 'builtIn'>,
  provider: string,
  model: string,
): ResourceId {
  if (!provider || typeof provider !== 'string' || !model || typeof model !== 'string') {
    throw new Error('Invalid catalog resource selection');
  }
  if (connection.builtIn) {
    return resourceId(slugifyCatalogId(`pi.${provider}.${model}`));
  }
  const key = connectionKey(connection.machine, connection.id);
  const tuple = [key, provider, model];
  const hash = createHash('sha256').update(JSON.stringify(tuple)).digest('hex');
  return resourceId(`catalog:${hash}`);
}

/** Stable public identity: no model labels, observation dates, credentials or mutable defaults. */
export function inventoryResourceId(
  identity: ProviderRuntimeIdentity,
  selection: ProviderModelSelection,
): ResourceId {
  if (
    (selection.kind !== 'model' && selection.kind !== 'provider-default') ||
    (selection.kind === 'model' &&
      (!selection.id ||
        selection.id.length > 200 ||
        selection.id.trim() !== selection.id ||
        /\p{Cc}/u.test(selection.id)))
  ) {
    throw new Error('Invalid inventory selection');
  }
  const tuple = [
    JSON.parse(inventoryIdentityKey(identity)) as unknown,
    selection.kind === 'model' ? ['model', selection.id] : ['provider-default'],
  ];
  return resourceId(
    `inventory:${createHash('sha256').update(JSON.stringify(tuple)).digest('hex')}`,
  );
}

export interface InventoryMaterializeOptions {
  /** Explicit host migration for an existing immutable route only. Never a general id override. */
  readonly legacyId?: (
    identity: ProviderRuntimeIdentity,
    selection: ProviderModelSelection,
  ) => ResourceId | undefined;
}

function freeze<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    Object.freeze(value);
    for (const child of Object.values(value)) freeze(child);
  }
  return value;
}

/** Pure materialization. Template ids and previous concrete-model limits/prices are not inherited. */
export function materializeInventory(
  inventory: ProviderModelInventory,
  template: ResourceDescriptor,
  options: InventoryMaterializeOptions = {},
): readonly ResourceDescriptor[] {
  if (inventory.status !== 'fresh') return Object.freeze([]);
  if (template.kind.type !== 'agent' && template.kind.type !== 'model')
    throw new Error('Invalid inventory template');
  if (template.kind.type === 'model' && !template.capabilities.includes('model-turn'))
    throw new Error('Invalid inventory template');
  const compatibility = template.kind.type === 'agent' ? 'native-agent' : 'model-turn';
  const resources: ResourceDescriptor[] = [];
  for (const entry of inventory.entries) {
    const source = entry.source ?? inventory.source;
    if (
      entry.compatibility !== compatibility ||
      source === 'static-verified' ||
      (entry.availability !== 'available' && entry.availability !== 'degraded')
    )
      continue;
    if (entry.selection.kind === 'provider-default' && template.kind.type !== 'agent') continue;
    const id =
      options.legacyId?.(inventory.identity, entry.selection) ??
      inventoryResourceId(inventory.identity, entry.selection);
    const base = structuredClone(template);
    const runtimeOptions = { ...base.runtime.options };
    if (entry.selection.kind === 'model') runtimeOptions.model = entry.selection.id;
    else delete runtimeOptions.model;
    let kind: ResourceDescriptor['kind'];
    if (base.kind.type === 'agent') {
      const underlying = { ...base.kind.underlying, provider: inventory.identity.provider };
      if (entry.selection.kind === 'model') underlying.model = entry.selection.id;
      else delete underlying.model;
      kind = { ...base.kind, underlying };
    } else if (base.kind.type === 'model' && entry.selection.kind === 'model') {
      kind = { ...base.kind, provider: inventory.identity.provider, model: entry.selection.id };
    } else continue;
    const capabilities = [...new Set([...base.capabilities, ...(entry.capabilities ?? [])])].filter(
      (capability) => kind.type !== 'agent' || capability !== 'model-turn',
    );
    const { limits: _limits, ...withoutLimits } = base;
    void _limits;
    resources.push(
      freeze({
        ...withoutLimits,
        id,
        displayName: entry.displayName,
        kind,
        capabilities,
        runtime: { ...base.runtime, options: runtimeOptions },
        // A template's old token price does not establish a newly discovered model's price.
        cost: base.cost.model === 'per-token' ? { model: 'unknown' } : base.cost,
        ...(entry.selection.kind === 'model' && entry.limits
          ? { limits: structuredClone(entry.limits) }
          : {}),
        metadata: {
          ...base.metadata,
          inventory: {
            identity: structuredClone(inventory.identity),
            generation: inventory.generation,
            selection: structuredClone(entry.selection),
            source,
            ...(entry.reasoningModes
              ? { reasoningModes: structuredClone(entry.reasoningModes) }
              : {}),
          },
        },
        provenance: `discovered:inventory:${source}`,
      }),
    );
  }
  if (new Set(resources.map((resource) => resource.id)).size !== resources.length)
    throw new Error('Duplicate inventory resource identity');
  return Object.freeze(resources);
}
