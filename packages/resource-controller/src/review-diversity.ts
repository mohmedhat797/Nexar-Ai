import {
  connectionOf,
  connectionKey,
  resourceId as validateResourceId,
  REVIEW_DIMENSIONS,
  resolveReviewDimensions,
  type ResourceDescriptor,
  type ReviewIdentity,
  type ReviewContext,
  type ReviewDimension,
  type StrategyLedger,
  type WorkUnit,
} from '@nexar/contracts';
import {
  catalogResourceId,
  inventoryIdentityKey,
  inventoryResourceId,
} from '@nexar/resource-registry';

const record = (v: unknown): Record<string, unknown> | undefined =>
  v !== null && typeof v === 'object' && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : undefined;
const publicId = (v: unknown): v is string =>
  typeof v === 'string' && /^[a-z0-9][a-z0-9._:-]{0,199}$/.test(v);
const providerId = (v: unknown): v is string =>
  typeof v === 'string' && /^[a-z0-9][a-z0-9._-]{0,63}$/.test(v);
const hostId = (v: unknown): v is 'desktop' | 'plane' => v === 'desktop' || v === 'plane';

/** Reads only host-owned structural identity; labels, secrets and mutable generations are ignored. */
export function reviewIdentityOf(d: ResourceDescriptor): ReviewIdentity {
  const unknown = Object.freeze({ resourceId: d.id });
  const explicit = d.metadata?.connection;
  const c = connectionOf(d);
  if (
    explicit !== undefined &&
    (!record(explicit) ||
      !c ||
      ['id', 'provider', 'method', 'authClass', 'support'].some(
        (k) => (c as unknown as Record<string, unknown>)[k] !== record(explicit)?.[k],
      ))
  )
    return unknown;
  const kindProvider =
    d.kind.type === 'model'
      ? d.kind.provider
      : d.kind.type === 'agent'
        ? d.kind.underlying?.provider
        : undefined;
  if (c && kindProvider !== undefined && kindProvider !== c.provider) return unknown;
  const provider = c?.provider ?? kindProvider;
  if (!providerId(provider)) return unknown;
  const inventory = record(d.metadata?.inventory);
  const identity = record(inventory?.identity);
  const connection = record(explicit);
  const hosts = [d.metadata?.connectionHost, connection?.machine, identity?.machine].filter(
    (h) => h !== undefined,
  );
  if (hosts.some((h) => !hostId(h)) || new Set(hosts).size > 1) return unknown;
  const host = hosts.find(hostId);
  if (identity !== undefined) {
    try {
      inventoryIdentityKey(identity as unknown as Parameters<typeof inventoryIdentityKey>[0]);
      if (identity.provider !== provider || (c && identity.connectionId !== c.id)) return unknown;
      if (
        String(d.id).startsWith('inventory:') &&
        inventoryResourceId(
          identity as unknown as Parameters<typeof inventoryResourceId>[0],
          inventory?.selection as Parameters<typeof inventoryResourceId>[1],
        ) !== d.id
      )
        return unknown;
    } catch {
      return unknown;
    }
  }
  if (
    c &&
    host &&
    d.kind.type === 'model' &&
    d.kind.access === 'api' &&
    /\.c[a-z2-7]{10}$/.test(c.id)
  ) {
    if (
      catalogResourceId({ id: c.id, machine: host, builtIn: false }, provider, d.kind.model) !==
      d.id
    )
      return unknown;
  }
  // Inference from kind alone establishes a provider, not an immutable account connection.
  const connectionId =
    (connection !== undefined || identity !== undefined) && c && publicId(c.id) && host
      ? c.id
      : undefined;
  return Object.freeze({
    resourceId: d.id,
    provider,
    ...(host === undefined ? {} : { host }),
    ...(connectionId === undefined ? {} : { connectionId }),
  });
}

/** Copies retained evidence only: a disappearing resource must never be re-inferred from a new registry entry. */
export function retainedReviewIdentity(
  value: ReviewIdentity | undefined,
  resourceId: ReviewIdentity['resourceId'],
): ReviewIdentity {
  validateResourceId(resourceId);
  const safe = value?.resourceId === resourceId ? value : undefined;
  return Object.freeze({
    resourceId,
    ...(providerId(safe?.provider) ? { provider: safe.provider } : {}),
    ...(hostId(safe?.host) ? { host: safe.host } : {}),
    ...(publicId(safe?.connectionId) && hostId(safe?.host)
      ? { connectionId: safe.connectionId }
      : {}),
  });
}

export function reviewContextFor(
  unit: WorkUnit,
  ledger: StrategyLedger,
): ReviewContext | undefined {
  const dimensions = resolveReviewDimensions(ledger.reviewDimensions, ledger.reviewDiversity);
  if (dimensions === undefined) return undefined;
  const allocation = ledger.allocations.find((a) => a.unitId === unit.reviewOf);
  return Object.freeze({
    dimensions,
    ...(unit.reviewOf === undefined ? {} : { reviewOf: unit.reviewOf }),
    ...(allocation === undefined
      ? {}
      : { reviewed: retainedReviewIdentity(allocation.reviewIdentity, allocation.resourceId) }),
  });
}

export function distinctReviewIdentity(
  dimension: ReviewDimension,
  a: ReviewIdentity | undefined,
  b: ReviewIdentity,
): 'distinct' | 'same' | 'unknown' {
  if (a === undefined) return 'unknown';
  if (dimension === 'resource') return a.resourceId === b.resourceId ? 'same' : 'distinct';
  if (dimension === 'provider')
    return a.provider === undefined || b.provider === undefined
      ? 'unknown'
      : a.provider === b.provider
        ? 'same'
        : 'distinct';
  if (
    a.connectionId === undefined ||
    a.host === undefined ||
    b.connectionId === undefined ||
    b.host === undefined
  )
    return 'unknown';
  return connectionKey(a.host, a.connectionId) === connectionKey(b.host, b.connectionId)
    ? 'same'
    : 'distinct';
}

export { REVIEW_DIMENSIONS };
