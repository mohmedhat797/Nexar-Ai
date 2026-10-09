import {
  PROVIDER_INVENTORY_FAILURE_REASONS,
  PROVIDER_MODEL_INVENTORY_MAX_ENTRIES,
  PROVIDER_MODEL_SOURCES,
  type AuthState,
  type InventorySource,
  type InventorySourceResult,
  type ProviderInventoryFailureReason,
  type ProviderModelEntry,
  type ProviderModelInventory,
  type ProviderModelSelection,
  type ProviderRuntimeIdentity,
} from '@nexar/contracts';

const AUTH = ['authenticated', 'unauthenticated', 'not-required', 'unknown'] as const;
const AVAILABILITY = ['available', 'degraded', 'unavailable', 'unknown'] as const;
const CONTROL = /\p{Cc}/u;

function record(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Invalid inventory');
  return value as Record<string, unknown>;
}

function keys(value: Record<string, unknown>, allowed: readonly string[]): void {
  if (Object.keys(value).some((key) => !allowed.includes(key)))
    throw new Error('Invalid inventory');
}

function text(value: unknown, max: number): string {
  if (
    typeof value !== 'string' ||
    !value ||
    value.length > max ||
    CONTROL.test(value) ||
    value.trim() !== value
  ) {
    throw new Error('Invalid inventory');
  }
  return value;
}

function member<T extends string>(value: unknown, allowed: readonly T[]): T {
  if (typeof value !== 'string' || !allowed.includes(value as T))
    throw new Error('Invalid inventory');
  return value as T;
}

function identityCopy(identity: ProviderRuntimeIdentity): ProviderRuntimeIdentity {
  const value = record(identity);
  keys(value, ['provider', 'connectionId', 'runtimeId', 'routeId', 'machine']);
  return Object.freeze({
    provider: text(value.provider, 128),
    connectionId: text(value.connectionId, 128),
    runtimeId: text(value.runtimeId, 128),
    routeId: text(value.routeId, 128),
    machine: member(value.machine, ['desktop', 'plane']),
  });
}

/** Fixed tuple encoding, shared by the in-memory service and the host's public cache. */
export function inventoryIdentityKey(identity: ProviderRuntimeIdentity): string {
  const safe = identityCopy(identity);
  return JSON.stringify([
    safe.provider,
    safe.connectionId,
    safe.runtimeId,
    safe.routeId,
    safe.machine,
  ]);
}

function selectionCopy(input: unknown): ProviderModelSelection {
  const value = record(input);
  if (value.kind === 'provider-default') {
    keys(value, ['kind']);
    return Object.freeze({ kind: 'provider-default' });
  }
  keys(value, ['kind', 'id']);
  if (value.kind !== 'model') throw new Error('Invalid inventory');
  return Object.freeze({ kind: 'model', id: text(value.id, 200) });
}

function selectionKey(selection: ProviderModelSelection): string {
  return JSON.stringify(
    selection.kind === 'model' ? ['model', selection.id] : ['provider-default'],
  );
}

function stringList(input: unknown, maximum: number): readonly string[] {
  if (!Array.isArray(input) || input.length > maximum) throw new Error('Invalid inventory');
  const values = input.map((item: unknown) => text(item, 64));
  if (new Set(values).size !== values.length) throw new Error('Invalid inventory');
  return Object.freeze(values);
}

function entryCopy(input: unknown): ProviderModelEntry {
  const value = record(input);
  keys(value, [
    'selection',
    'displayName',
    'availability',
    'compatibility',
    'source',
    'capabilities',
    'limits',
    'reasoningModes',
  ]);
  let limits: ProviderModelEntry['limits'];
  if (value.limits !== undefined) {
    const raw = record(value.limits);
    keys(raw, ['contextWindowTokens', 'maxOutputTokens']);
    for (const amount of Object.values(raw)) {
      if (typeof amount !== 'number' || !Number.isSafeInteger(amount) || amount <= 0)
        throw new Error('Invalid inventory');
    }
    limits = Object.freeze({
      ...(raw.contextWindowTokens !== undefined
        ? { contextWindowTokens: raw.contextWindowTokens as number }
        : {}),
      ...(raw.maxOutputTokens !== undefined
        ? { maxOutputTokens: raw.maxOutputTokens as number }
        : {}),
    });
  }
  const selection = selectionCopy(value.selection);
  const compatibility = member(value.compatibility, ['native-agent', 'model-turn']);
  if (selection.kind === 'provider-default' && compatibility !== 'native-agent')
    throw new Error('Invalid inventory');
  return Object.freeze({
    selection,
    displayName: text(value.displayName, 160),
    availability: member(value.availability, AVAILABILITY),
    compatibility,
    ...(value.source !== undefined ? { source: member(value.source, PROVIDER_MODEL_SOURCES) } : {}),
    ...(value.capabilities !== undefined
      ? { capabilities: stringList(value.capabilities, 64) }
      : {}),
    ...(limits !== undefined ? { limits } : {}),
    ...(value.reasoningModes !== undefined
      ? { reasoningModes: stringList(value.reasoningModes, 32) }
      : {}),
  });
}

function normalize(input: unknown): InventorySourceResult {
  const value = record(input);
  const source = member(value.source, PROVIDER_MODEL_SOURCES);
  const auth = member(value.auth, AUTH);
  if (value.status !== 'success') {
    keys(value, ['status', 'source', 'auth', 'reason']);
    return Object.freeze({
      status: member(value.status, ['unavailable', 'unsupported']),
      source,
      auth,
      reason: member(value.reason, PROVIDER_INVENTORY_FAILURE_REASONS),
    });
  }
  keys(value, ['status', 'source', 'auth', 'entries', 'current', 'runtimeVersion']);
  if (!Array.isArray(value.entries) || value.entries.length > PROVIDER_MODEL_INVENTORY_MAX_ENTRIES)
    throw new Error('Invalid inventory');
  const entries = Object.freeze(value.entries.map((entry: unknown) => entryCopy(entry)));
  const ids = new Set(entries.map((entry) => selectionKey(entry.selection)));
  if (ids.size !== entries.length) throw new Error('Invalid inventory');
  const current = value.current === undefined ? undefined : selectionCopy(value.current);
  if (current && !ids.has(selectionKey(current))) throw new Error('Invalid inventory');
  return Object.freeze({
    status: 'success',
    source,
    auth,
    entries,
    ...(current ? { current } : {}),
    ...(value.runtimeVersion !== undefined
      ? { runtimeVersion: text(value.runtimeVersion, 64) }
      : {}),
  });
}

interface Flight {
  readonly controller: AbortController;
  readonly promise: Promise<ProviderModelInventory>;
}

interface Slot {
  value: ProviderModelInventory;
  flight?: Flight;
}

export interface ProviderModelInventoryOptions {
  readonly ttlMs?: number;
  readonly timeoutMs?: number;
  readonly clock?: () => Date;
}

/** No I/O or vendor dependencies. The host schedules refreshes and persists public snapshots. */
export class InMemoryProviderModelInventory {
  readonly #slots = new Map<string, Slot>();
  readonly #ttlMs: number;
  readonly #timeoutMs: number;
  readonly #clock: () => Date;
  #disposed = false;

  constructor(options: ProviderModelInventoryOptions = {}) {
    this.#ttlMs = options.ttlMs ?? 5 * 60_000;
    this.#timeoutMs = options.timeoutMs ?? 10_000;
    this.#clock = options.clock ?? (() => new Date());
    if (
      !Number.isFinite(this.#ttlMs) ||
      this.#ttlMs <= 0 ||
      this.#ttlMs > 86_400_000 ||
      !Number.isFinite(this.#timeoutMs) ||
      this.#timeoutMs <= 0 ||
      this.#timeoutMs > 120_000
    ) {
      throw new Error('Invalid inventory timing');
    }
  }

  #slot(identity: ProviderRuntimeIdentity): Slot {
    const key = inventoryIdentityKey(identity);
    let slot = this.#slots.get(key);
    if (!slot) {
      slot = {
        value: Object.freeze({
          identity: identityCopy(identity),
          generation: 0,
          status: 'unavailable',
          source: 'live-runtime',
          auth: 'unknown',
          reason: 'runtime-unavailable',
          entries: Object.freeze([]),
        }),
      };
      this.#slots.set(key, slot);
    }
    return slot;
  }

  get(identity: ProviderRuntimeIdentity): ProviderModelInventory {
    const slot = this.#slot(identity);
    const value = slot.value;
    if (
      value.status === 'fresh' &&
      value.observedAt &&
      this.#clock().getTime() - Date.parse(value.observedAt) >= this.#ttlMs
    ) {
      slot.value = Object.freeze({ ...value, status: 'stale', reason: 'expired' });
    }
    return slot.value;
  }

  /** Startup only: never overwrite a live observation, active refresh or invalidated account. */
  hydrateStale(snapshot: ProviderModelInventory): ProviderModelInventory {
    const slot = this.#slot(snapshot.identity);
    if (slot.flight || slot.value.observedAt || slot.value.generation > 0)
      return this.get(snapshot.identity);
    if (
      !Number.isSafeInteger(snapshot.generation) ||
      snapshot.generation < 0 ||
      !snapshot.observedAt ||
      !Number.isFinite(Date.parse(snapshot.observedAt))
    )
      throw new Error('Invalid inventory cache');
    const data = normalize({
      status: 'success',
      source: snapshot.source,
      auth: 'unknown',
      entries: snapshot.entries,
      ...(snapshot.current ? { current: snapshot.current } : {}),
      ...(snapshot.runtimeVersion !== undefined ? { runtimeVersion: snapshot.runtimeVersion } : {}),
    });
    if (data.status !== 'success') throw new Error('Invalid inventory cache');
    slot.value = Object.freeze({
      identity: slot.value.identity,
      generation: snapshot.generation,
      status: 'stale',
      source: data.source,
      auth: 'unknown',
      observedAt: snapshot.observedAt,
      reason: 'restored',
      entries: data.entries,
      ...(data.current ? { current: data.current } : {}),
      ...(data.runtimeVersion !== undefined ? { runtimeVersion: data.runtimeVersion } : {}),
    });
    return slot.value;
  }

  invalidate(identity: ProviderRuntimeIdentity): ProviderModelInventory {
    const slot = this.#slot(identity);
    if (slot.value.generation >= Number.MAX_SAFE_INTEGER)
      throw new Error('Inventory generation exhausted');
    this.#cancel(slot);
    slot.value = Object.freeze({
      identity: slot.value.identity,
      generation: slot.value.generation + 1,
      status: 'unavailable',
      source: slot.value.source,
      auth: 'unknown',
      reason: 'invalidated',
      entries: Object.freeze([]),
    });
    return slot.value;
  }

  markStale(
    identity: ProviderRuntimeIdentity,
    reason: ProviderInventoryFailureReason = 'model-rejected',
  ): ProviderModelInventory {
    member(reason, PROVIDER_INVENTORY_FAILURE_REASONS);
    const slot = this.#slot(identity);
    this.#cancel(slot);
    slot.value = Object.freeze({
      ...slot.value,
      status: slot.value.observedAt ? 'stale' : 'unavailable',
      reason,
    });
    return slot.value;
  }

  #cancel(slot: Slot): void {
    const flight = slot.flight;
    delete slot.flight;
    flight?.controller.abort();
  }

  /** The initiating owner's signal cancels the shared flight; joiners observe that cancellation. */
  refresh(
    identity: ProviderRuntimeIdentity,
    source: InventorySource,
    options: { readonly signal?: AbortSignal } = {},
  ): Promise<ProviderModelInventory> {
    const slot = this.#slot(identity);
    if (this.#disposed) return Promise.resolve(this.get(identity));
    if (slot.flight) return slot.flight.promise;
    if (options.signal?.aborted) return Promise.resolve(this.#failure(slot, 'cancelled'));
    const controller = new AbortController();
    const attemptedAt = this.#clock().toISOString();
    let timer: ReturnType<typeof setTimeout>;
    let abortReason: ProviderInventoryFailureReason = 'cancelled';
    const onOwnerAbort = (): void => {
      controller.abort();
    };
    options.signal?.addEventListener('abort', onOwnerAbort, { once: true });
    const aborted = new Promise<InventorySourceResult>((resolve) => {
      controller.signal.addEventListener(
        'abort',
        () =>
          resolve({
            status: 'unavailable',
            source: slot.value.source,
            auth: slot.value.auth,
            reason: abortReason,
          }),
        { once: true },
      );
      timer = setTimeout(() => {
        abortReason = 'timeout';
        controller.abort();
      }, this.#timeoutMs);
    });
    // Delay invocation until the flight is installed, including synchronous source exceptions.
    const fetched = Promise.resolve().then(() => {
      if (controller.signal.aborted)
        return {
          status: 'unavailable',
          source: slot.value.source,
          auth: slot.value.auth,
          reason: abortReason,
        } as const;
      return source.fetch(controller.signal);
    });
    const flight: Flight = {
      controller,
      promise: Promise.race([fetched, aborted])
        .then(
          (raw) => {
            if (slot.flight !== flight || this.#disposed) return this.get(identity);
            if (controller.signal.aborted) return this.#failure(slot, abortReason, attemptedAt);
            let result: InventorySourceResult;
            try {
              result = normalize(raw);
            } catch {
              return this.#failure(slot, 'invalid-response', attemptedAt);
            }
            if (result.status !== 'success')
              return this.#failure(
                slot,
                result.reason,
                attemptedAt,
                result.auth,
                result.status,
                result.source,
              );
            slot.value = Object.freeze({
              identity: slot.value.identity,
              generation: slot.value.generation,
              status: 'fresh',
              source: result.source,
              auth: result.auth,
              observedAt: this.#clock().toISOString(),
              attemptedAt,
              entries: result.entries,
              ...(result.current ? { current: result.current } : {}),
              ...(result.runtimeVersion !== undefined
                ? { runtimeVersion: result.runtimeVersion }
                : {}),
            });
            return slot.value;
          },
          () => {
            if (slot.flight !== flight || this.#disposed) return this.get(identity);
            if (controller.signal.aborted) return this.#failure(slot, abortReason, attemptedAt);
            return this.#failure(slot, 'refresh-failed', attemptedAt);
          },
        )
        .finally(() => {
          clearTimeout(timer);
          options.signal?.removeEventListener('abort', onOwnerAbort);
          if (slot.flight === flight) delete slot.flight;
        }),
    };
    slot.flight = flight;
    return flight.promise;
  }

  #failure(
    slot: Slot,
    reason: ProviderInventoryFailureReason,
    attemptedAt?: string,
    auth: AuthState = slot.value.auth,
    status: 'unavailable' | 'unsupported' = 'unavailable',
    source = slot.value.source,
  ): ProviderModelInventory {
    slot.value = Object.freeze({
      ...slot.value,
      status: slot.value.observedAt ? 'stale' : status,
      reason,
      auth,
      source: slot.value.observedAt ? slot.value.source : source,
      ...(attemptedAt ? { attemptedAt } : {}),
    });
    return slot.value;
  }

  dispose(): void {
    this.#disposed = true;
    for (const slot of this.#slots.values()) {
      this.#cancel(slot);
      slot.value = Object.freeze({
        ...slot.value,
        status: slot.value.observedAt ? 'stale' : 'unavailable',
        reason: 'cancelled',
      });
    }
  }
}
