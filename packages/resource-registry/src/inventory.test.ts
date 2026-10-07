import type {
  InventorySource,
  InventorySourceResult,
  ProviderModelEntry,
  ProviderRuntimeIdentity,
} from '@nexar/contracts';
import { describe, expect, it, vi } from 'vitest';
import { InMemoryProviderModelInventory, inventoryIdentityKey } from './inventory.js';

const identity: ProviderRuntimeIdentity = {
  provider: 'openai',
  connectionId: 'owner',
  runtimeId: 'codex',
  routeId: 'native',
  machine: 'desktop',
};
const entry: ProviderModelEntry = {
  selection: { kind: 'model', id: 'model-new' },
  displayName: 'New model',
  availability: 'available',
  compatibility: 'native-agent',
};
function success(entries: readonly ProviderModelEntry[] = [entry]): InventorySourceResult {
  return { status: 'success', source: 'live-runtime', auth: 'authenticated', entries };
}
function source(result: InventorySourceResult = success()): InventorySource {
  return { fetch: () => Promise.resolve(result) };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((finish) => {
    resolve = finish;
  });
  return { promise, resolve };
}

describe('provider inventory lifecycle', () => {
  it('is single-flight, preserves returned ids, and copies immutable public facts', async () => {
    const pending = deferred<InventorySourceResult>();
    const fetch = vi.fn(() => pending.promise);
    const service = new InMemoryProviderModelInventory();
    const first = service.refresh(identity, { fetch });
    const second = service.refresh(identity, { fetch });
    expect(first).toBe(second);
    await Promise.resolve();
    expect(fetch).toHaveBeenCalledTimes(1);
    const raw = structuredClone(success());
    pending.resolve(raw);
    const result = await first;
    expect(result.status).toBe('fresh');
    expect(result.entries[0]?.selection).toEqual({ kind: 'model', id: 'model-new' });
    expect(result.entries).not.toBe(raw.status === 'success' ? raw.entries : undefined);
    expect(Object.isFrozen(result.entries[0]?.selection)).toBe(true);
    expect(service.get(identity)).toBe(result);
  });

  it('keeps each connection, route and machine isolated', async () => {
    const service = new InMemoryProviderModelInventory();
    await service.refresh(identity, source());
    for (const changed of [
      { connectionId: 'other' },
      { routeId: 'account-responses' },
      { machine: 'plane' as const },
      { runtimeId: 'other' },
    ]) {
      const other = { ...identity, ...changed };
      expect(inventoryIdentityKey(other)).not.toBe(inventoryIdentityKey(identity));
      expect(service.get(other).entries).toEqual([]);
      expect(service.get(other).auth).toBe('unknown');
    }
  });

  it('expires without invoking a provider and preserves observation time', async () => {
    let now = new Date('2026-10-07T00:00:00.000Z');
    const fetch = vi.fn(() => Promise.resolve(success()));
    const service = new InMemoryProviderModelInventory({ clock: () => now, ttlMs: 100 });
    const first = await service.refresh(identity, { fetch });
    now = new Date(now.getTime() + 100);
    expect(service.get(identity)).toMatchObject({
      status: 'stale',
      reason: 'expired',
      observedAt: first.observedAt,
      entries: [entry],
    });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('retains successful empty observations but failed refreshes retain only stale history', async () => {
    const service = new InMemoryProviderModelInventory();
    const first = await service.refresh(identity, source());
    const failed = await service.refresh(identity, {
      fetch: () => Promise.reject(new Error('SECRET provider body')),
    });
    expect(failed).toMatchObject({
      status: 'stale',
      reason: 'refresh-failed',
      observedAt: first.observedAt,
      entries: [entry],
    });
    expect(JSON.stringify(failed)).not.toContain('SECRET');
    const empty = await service.refresh(identity, source(success([])));
    expect(empty.status).toBe('fresh');
    expect(empty.entries).toEqual([]);
    expect(empty.reason).toBeUndefined();
  });

  it('clears old-account data before reauthentication and discards a late successful result', async () => {
    const service = new InMemoryProviderModelInventory();
    await service.refresh(identity, source());
    const pending = deferred<InventorySourceResult>();
    let signal: AbortSignal | undefined;
    const old = service.refresh(identity, {
      fetch: (abort) => {
        signal = abort;
        return pending.promise;
      },
    });
    await Promise.resolve();
    const cleared = service.invalidate(identity);
    expect(signal?.aborted).toBe(true);
    expect(cleared).toMatchObject({
      generation: 1,
      status: 'unavailable',
      auth: 'unknown',
      entries: [],
    });
    expect(cleared.observedAt).toBeUndefined();
    pending.resolve(success());
    expect(await old).toBe(cleared);
    expect(service.get(identity)).toBe(cleared);
    const refreshed = await service.refresh(identity, source(success([])));
    expect(refreshed).toMatchObject({ generation: 1, status: 'fresh', entries: [] });
  });

  it('marks rejected models stale and discards a refresh already underway', async () => {
    const service = new InMemoryProviderModelInventory();
    const first = await service.refresh(identity, source());
    const pending = deferred<InventorySourceResult>();
    const refresh = service.refresh(identity, { fetch: () => pending.promise });
    await Promise.resolve();
    const rejected = service.markStale(identity);
    expect(rejected).toMatchObject({
      status: 'stale',
      reason: 'model-rejected',
      observedAt: first.observedAt,
      entries: [entry],
    });
    pending.resolve(success([]));
    expect(await refresh).toBe(rejected);
    expect((await service.refresh(identity, source(success([])))).entries).toEqual([]);
  });

  it('restores cached data only as stale with unknown auth, and cannot undo invalidation', async () => {
    const prior = new InMemoryProviderModelInventory();
    const snapshot = await prior.refresh(identity, source());
    const service = new InMemoryProviderModelInventory();
    expect(service.hydrateStale(snapshot)).toMatchObject({
      status: 'stale',
      auth: 'unknown',
      reason: 'restored',
      observedAt: snapshot.observedAt,
    });
    service.invalidate(identity);
    expect(service.hydrateStale(snapshot)).toMatchObject({
      generation: 1,
      entries: [],
      reason: 'invalidated',
    });
  });

  it('bounds a source that ignores cancellation, and discards its eventual success', async () => {
    const pending = deferred<InventorySourceResult>();
    const service = new InMemoryProviderModelInventory({ timeoutMs: 10 });
    const result = await service.refresh(identity, { fetch: () => pending.promise });
    expect(result).toMatchObject({ status: 'unavailable', reason: 'timeout', entries: [] });
    pending.resolve(success());
    await Promise.resolve();
    expect(service.get(identity)).toBe(result);
  });

  it('owner cancellation and disposal abort active sources without late publication', async () => {
    const controller = new AbortController();
    const service = new InMemoryProviderModelInventory();
    const pending = deferred<InventorySourceResult>();
    const operation = service.refresh(
      identity,
      { fetch: () => pending.promise },
      { signal: controller.signal },
    );
    controller.abort();
    expect(await operation).toMatchObject({ status: 'unavailable', reason: 'cancelled' });
    const second = service.refresh(identity, { fetch: () => pending.promise });
    await Promise.resolve();
    service.dispose();
    pending.resolve(success());
    expect(await second).toMatchObject({ status: 'unavailable', reason: 'cancelled', entries: [] });
    const fetch = vi.fn(() => Promise.resolve(success()));
    await service.refresh(identity, { fetch });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('rejects success resolved immediately before owner cancellation but not yet published', async () => {
    const service = new InMemoryProviderModelInventory();
    const controller = new AbortController();
    const pending = deferred<InventorySourceResult>();
    const operation = service.refresh(
      identity,
      { fetch: () => pending.promise },
      { signal: controller.signal },
    );
    await Promise.resolve();
    pending.resolve(success());
    controller.abort();
    expect(await operation).toMatchObject({
      status: 'unavailable',
      reason: 'cancelled',
      entries: [],
    });
  });

  it('reports unsupported discovery honestly without invented choices', async () => {
    const service = new InMemoryProviderModelInventory();
    expect(
      await service.refresh(
        identity,
        source({
          status: 'unsupported',
          source: 'live-runtime',
          auth: 'unknown',
          reason: 'unsupported',
        }),
      ),
    ).toMatchObject({ status: 'unsupported', entries: [], auth: 'unknown' });
  });
});

describe('public inventory result bounds', () => {
  const malformed: unknown[] = [
    { ...success(), token: 'SECRET' },
    { ...success(), entries: [entry, entry] },
    { ...success(), entries: [{ ...entry, selection: { kind: 'model', id: 'SECRET\n' } }] },
    { ...success(), entries: [{ ...entry, selection: { kind: 'model', id: 'x'.repeat(201) } }] },
    { ...success(), entries: [{ ...entry, displayName: 'x'.repeat(161) }] },
    {
      ...success(),
      entries: Array.from({ length: 257 }, (_, i) => ({
        ...entry,
        selection: { kind: 'model', id: `m${i}` },
      })),
    },
    { ...success(), entries: [{ ...entry, limits: { contextWindowTokens: -1 } }] },
    {
      ...success(),
      entries: [{ ...entry, selection: { kind: 'provider-default' }, compatibility: 'model-turn' }],
    },
    { ...success(), current: { kind: 'model', id: 'missing' } },
    { status: 'unavailable', source: 'live-runtime', auth: 'unknown', reason: 'SECRET' },
  ];
  it.each(malformed.map((value, i) => [i, value] as const))(
    'rejects malformed response %i without leaking raw data',
    async (_i, value) => {
      const service = new InMemoryProviderModelInventory();
      const result = await service.refresh(identity, source(value as InventorySourceResult));
      expect(result).toMatchObject({
        status: 'unavailable',
        reason: 'invalid-response',
        entries: [],
      });
      expect(JSON.stringify(result)).not.toContain('SECRET');
    },
  );
});
