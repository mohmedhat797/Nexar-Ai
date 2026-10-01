import {
  NexarError,
  adapterId,
  resourceId,
  type DiscoverySource,
  type ResourceDescriptor,
} from '@nexar/contracts';
import { describe, expect, it } from 'vitest';
import { DiscoveryService, mergeDiscovered } from './discovery.js';

function d(id: string, displayName = id): ResourceDescriptor {
  return {
    id: resourceId(id),
    displayName,
    kind: { type: 'model', provider: 'acme', model: id, access: 'api' },
    capabilities: ['text-generation'],
    runtime: { adapter: adapterId('test'), locality: 'remote' },
    auth: { mode: 'none' },
    cost: { model: 'free' },
    dataLocality: 'third-party',
  };
}

describe('mergeDiscovered', () => {
  it('stamps provenance, lets config win and orders configured first, then discovered by id', () => {
    const configured = [d('zeta', 'mine'), d('alpha')];
    const result = mergeDiscovered(configured, [
      { source: 'cli:b', descriptors: [d('zeta', 'theirs'), d('m'), d('c')] },
      { source: 'cli:a', descriptors: [d('m', 'from-a')] },
    ]);
    expect(result.resources.map((r) => [r.id, r.provenance, r.displayName])).toEqual([
      ['zeta', 'configured', 'mine'],
      ['alpha', 'configured', 'alpha'],
      ['c', 'discovered:cli:b', 'c'],
      // The lexicographically first source wins a cross-source collision.
      ['m', 'discovered:cli:a', 'from-a'],
    ]);
    expect(result.collisions).toBe(2);
  });

  it('drops excluded discovered ids but never a configured resource', () => {
    const result = mergeDiscovered([d('keep')], [{ source: 's', descriptors: [d('x'), d('y')] }], {
      excludeIds: ['x', 'keep'],
    });
    expect(result.resources.map((r) => r.id)).toEqual(['keep', 'y']);
  });

  it('is deterministic regardless of batch order', () => {
    const a = { source: 'a', descriptors: [d('p'), d('q')] };
    const b = { source: 'b', descriptors: [d('q'), d('r')] };
    expect(mergeDiscovered([], [a, b])).toEqual(mergeDiscovered([], [b, a]));
  });
});

function source(id: string, discover: DiscoverySource['discover']): DiscoverySource {
  return { id, discover };
}

describe('DiscoveryService', () => {
  it('caches until the refresh interval elapses and refresh() forces a run', async () => {
    let now = new Date('2026-03-01T00:00:00.000Z');
    let runs = 0;
    const service = new DiscoveryService({
      sources: [
        source('s', () => {
          runs += 1;
          return Promise.resolve([d('a')]);
        }),
      ],
      refreshIntervalMs: 60_000,
      clock: () => now,
    });
    expect(service.reports).toEqual([]);
    await service.discover();
    now = new Date(now.getTime() + 59_999);
    await service.discover();
    expect(runs).toBe(1);
    now = new Date(now.getTime() + 1);
    await service.discover();
    expect(runs).toBe(2);
    await service.refresh();
    expect(runs).toBe(3);
    expect(service.reports).toEqual([
      { source: 's', status: 'ok', count: 1, at: '2026-03-01T00:01:00.000Z' },
    ]);
  });

  it('isolates a failing source, reports its code only, and keeps the others', async () => {
    const service = new DiscoveryService({
      sources: [
        source('bad', () => Promise.reject(new NexarError('POLICY_REJECTED', 'secret /path'))),
        source('plain-error', () => Promise.reject(new Error('boom'))),
        source('good', () => Promise.resolve([d('a')])),
      ],
      refreshIntervalMs: 1,
    });
    const result = await service.discover();
    expect(result.batches.map((b) => b.source)).toEqual(['good']);
    const reports = result.reports.map((r) => ({
      source: r.source,
      status: r.status,
      count: r.count,
      ...(r.errorCode === undefined ? {} : { errorCode: r.errorCode }),
    }));
    expect(reports).toEqual([
      { source: 'bad', status: 'failed', count: 0, errorCode: 'POLICY_REJECTED' },
      { source: 'good', status: 'ok', count: 1 },
      { source: 'plain-error', status: 'failed', count: 0, errorCode: 'INTEGRATION_UNAVAILABLE' },
    ]);
    expect(JSON.stringify(result.reports)).not.toContain('secret');
  });

  it('times out a source that ignores its signal without blocking the others', async () => {
    const service = new DiscoveryService({
      sources: [
        source('hang', () => new Promise(() => undefined)),
        source('quick', () => Promise.resolve([d('a')])),
      ],
      refreshIntervalMs: 1,
      timeoutMs: 20,
    });
    const result = await service.discover();
    expect(result.reports.find((r) => r.source === 'hang')).toMatchObject({
      status: 'failed',
      errorCode: 'INTEGRATION_UNAVAILABLE',
    });
    expect(result.batches.map((b) => b.source)).toEqual(['quick']);
  });

  it('never runs a disabled source', async () => {
    let ran = false;
    const service = new DiscoveryService({
      sources: [
        source('off', () => {
          ran = true;
          return Promise.resolve([d('a')]);
        }),
      ],
      refreshIntervalMs: 1,
      disabled: ['off'],
    });
    const result = await service.discover();
    expect(ran).toBe(false);
    expect(result.batches).toEqual([]);
    expect(result.reports[0]).toMatchObject({ source: 'off', status: 'disabled', count: 0 });
  });

  it('shares one run between concurrent callers', async () => {
    let runs = 0;
    const service = new DiscoveryService({
      sources: [
        source('s', async () => {
          runs += 1;
          await new Promise((r) => setTimeout(r, 5));
          return [];
        }),
      ],
      refreshIntervalMs: 1,
    });
    await Promise.all([service.refresh(), service.refresh()]);
    expect(runs).toBe(1);
  });
});
