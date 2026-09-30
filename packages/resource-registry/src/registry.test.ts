import {
  adapterId,
  isNexarError,
  resourceId,
  type ResourceDescriptor,
  type ResourceState,
} from '@nexar/contracts';
import { describe, expect, it } from 'vitest';
import { InMemoryResourceRegistry, StaticResourceSource, type ResourceProbe } from './index.js';

const NOW = new Date('2026-01-01T00:00:00.000Z');

function descriptor(id: string, overrides: Partial<ResourceDescriptor> = {}): ResourceDescriptor {
  return {
    id: resourceId(id),
    displayName: id,
    kind: { type: 'model', provider: 'acme', model: id, access: 'api' },
    capabilities: ['text-generation'],
    runtime: { adapter: adapterId('test'), locality: 'remote' },
    auth: { mode: 'none' },
    cost: { model: 'free' },
    dataLocality: 'third-party',
    ...overrides,
  };
}

function state(overrides: Partial<ResourceState> = {}): ResourceState {
  return {
    availability: 'available',
    auth: 'authenticated',
    observedAt: '2026-01-02T00:00:00.000Z',
    ...overrides,
  };
}

function newRegistry(): InMemoryResourceRegistry {
  return new InMemoryResourceRegistry({ clock: () => NOW });
}

describe('register / unregister', () => {
  it('registers with unknown initial state', () => {
    const r = newRegistry();
    r.register(descriptor('a'));
    expect(r.has(resourceId('a'))).toBe(true);
    expect(r.get(resourceId('a'))?.displayName).toBe('a');
    expect(r.getState(resourceId('a'))).toEqual({
      availability: 'unknown',
      auth: 'unknown',
      observedAt: NOW.toISOString(),
    });
  });

  it('throws CONFIGURATION_ERROR on duplicate id', () => {
    const r = newRegistry();
    r.register(descriptor('a'));
    try {
      r.register(descriptor('a'));
      expect.unreachable();
    } catch (e) {
      expect(isNexarError(e) && e.code).toBe('CONFIGURATION_ERROR');
    }
  });

  it('unregisters', () => {
    const r = newRegistry();
    r.register(descriptor('a'));
    expect(r.unregister(resourceId('a'))).toBe(true);
    expect(r.unregister(resourceId('a'))).toBe(false);
    expect(r.has(resourceId('a'))).toBe(false);
    expect(r.getState(resourceId('a'))).toBeUndefined();
  });

  it('setState throws CONFIGURATION_ERROR for unknown id', () => {
    const r = newRegistry();
    try {
      r.setState(resourceId('nope'), state());
      expect.unreachable();
    } catch (e) {
      expect(isNexarError(e) && e.code).toBe('CONFIGURATION_ERROR');
    }
  });

  it('setState updates the snapshot', () => {
    const r = newRegistry();
    r.register(descriptor('a'));
    r.setState(resourceId('a'), state());
    expect(r.snapshot()[0]?.state.availability).toBe('available');
  });
});

describe('list / filters', () => {
  const build = () => {
    const r = newRegistry();
    r.register(
      descriptor('zeta', { capabilities: ['coding', 'repo-editing'], tags: ['local', 'fast'] }),
    );
    r.register(
      descriptor('alpha', {
        kind: { type: 'agent', agent: 'pi', interface: 'cli' },
        capabilities: ['coding'],
        tags: ['fast'],
      }),
    );
    r.register(
      descriptor('mid', {
        kind: { type: 'tool-runtime', tool: 'git', interface: 'cli' },
        capabilities: ['tool-use'],
      }),
    );
    return r;
  };
  const ids = (list: readonly ResourceDescriptor[]) => list.map((d) => d.id as string);

  it('keeps registration order', () => {
    expect(ids(build().list())).toEqual(['zeta', 'alpha', 'mid']);
  });

  it('filters by kind', () => {
    expect(ids(build().list({ kinds: ['agent', 'tool-runtime'] }))).toEqual(['alpha', 'mid']);
  });

  it('filters by capabilities (all-of)', () => {
    expect(ids(build().list({ capabilities: ['coding'] }))).toEqual(['zeta', 'alpha']);
    expect(ids(build().list({ capabilities: ['coding', 'repo-editing'] }))).toEqual(['zeta']);
  });

  it('filters by tags (all-of)', () => {
    expect(ids(build().list({ tags: ['fast'] }))).toEqual(['zeta', 'alpha']);
    expect(ids(build().list({ tags: ['fast', 'local'] }))).toEqual(['zeta']);
  });

  it('filters by ids', () => {
    expect(ids(build().list({ ids: [resourceId('mid'), resourceId('zeta')] }))).toEqual([
      'zeta',
      'mid',
    ]);
  });

  it('combines filters', () => {
    expect(ids(build().list({ kinds: ['model'], tags: ['fast'] }))).toEqual(['zeta']);
  });

  it('snapshot honors the filter without probing', () => {
    const snaps = build().snapshot({ ids: [resourceId('mid')] });
    expect(snaps.map((s) => s.descriptor.id)).toEqual(['mid']);
  });
});

describe('immutability', () => {
  it('stores frozen descriptors that cannot be mutated', () => {
    const r = newRegistry();
    const input = descriptor('a', { tags: ['x'], limits: { contextWindowTokens: 10 } });
    r.register(input);
    const stored = r.get(resourceId('a'))!;
    expect(Object.isFrozen(stored)).toBe(true);
    expect(() => (stored.capabilities as string[]).push('coding')).toThrow(TypeError);
    expect(() => (stored.tags as string[]).push('y')).toThrow(TypeError);
    expect(() => {
      (stored.limits as { contextWindowTokens: number }).contextWindowTokens = 1;
    }).toThrow(TypeError);
  });

  it('is isolated from later mutation of the input', () => {
    const r = newRegistry();
    const input = descriptor('a', { capabilities: ['coding'] });
    r.register(input);
    (input.capabilities as string[]).push('vision');
    expect(r.get(resourceId('a'))?.capabilities).toEqual(['coding']);
  });
});

describe('refresh', () => {
  const ok: ResourceProbe = () => Promise.resolve(state());

  it('applies successful probe results', async () => {
    const r = newRegistry();
    r.register(descriptor('a'), { probe: ok });
    const snaps = await r.refresh();
    expect(snaps[0]?.state).toEqual(state());
    expect(r.getState(resourceId('a'))).toEqual(state());
  });

  it('turns a throwing probe into unknown state without rejecting', async () => {
    const r = newRegistry();
    r.register(descriptor('good'), { probe: ok });
    r.register(descriptor('bad'), {
      probe: () => Promise.reject(new Error('boom')),
    });
    r.register(descriptor('sync-bad'), {
      probe: () => {
        throw new Error('sync boom');
      },
    });
    const snaps = await r.refresh();
    expect(snaps.find((s) => s.descriptor.id === 'good')?.state.availability).toBe('available');
    const bad = r.getState(resourceId('bad'));
    expect(bad).toMatchObject({
      availability: 'unknown',
      auth: 'unknown',
      observedAt: NOW.toISOString(),
    });
    expect(bad?.detail).toContain('boom');
    expect(r.getState(resourceId('sync-bad'))?.detail).toContain('sync boom');
  });

  it('times out hanging probes', async () => {
    const r = newRegistry();
    let seen: AbortSignal | undefined;
    r.register(descriptor('slow'), {
      probe: (_d, signal) => {
        seen = signal;
        return new Promise<ResourceState>(() => undefined);
      },
    });
    r.register(descriptor('fast'), { probe: ok });
    await r.refresh({ timeoutMs: 10 });
    expect(r.getState(resourceId('slow'))?.detail).toContain('timed out');
    expect(r.getState(resourceId('slow'))?.availability).toBe('unknown');
    expect(r.getState(resourceId('fast'))?.availability).toBe('available');
    expect(seen?.aborted).toBe(true);
  });

  it('honors an abort signal', async () => {
    const r = newRegistry();
    const controller = new AbortController();
    r.register(descriptor('slow'), { probe: () => new Promise<ResourceState>(() => undefined) });
    const pending = r.refresh({ signal: controller.signal, timeoutMs: 5000 });
    controller.abort();
    await pending;
    expect(r.getState(resourceId('slow'))?.detail).toContain('aborted');
  });

  it('honors an already-aborted signal', async () => {
    const r = newRegistry();
    r.register(descriptor('slow'), { probe: () => new Promise<ResourceState>(() => undefined) });
    await r.refresh({ signal: AbortSignal.abort(), timeoutMs: 5000 });
    expect(r.getState(resourceId('slow'))?.availability).toBe('unknown');
  });

  it('keeps state of resources without a probe and respects ids', async () => {
    const r = newRegistry();
    r.register(descriptor('manual'));
    r.register(descriptor('a'), { probe: ok });
    r.register(descriptor('b'), { probe: ok });
    r.setState(resourceId('manual'), state({ availability: 'degraded' }));
    const snaps = await r.refresh({ ids: [resourceId('a'), resourceId('manual')] });
    expect(snaps.map((s) => s.descriptor.id)).toEqual(['manual', 'a']);
    expect(r.getState(resourceId('manual'))?.availability).toBe('degraded');
    expect(r.getState(resourceId('a'))?.availability).toBe('available');
    expect(r.getState(resourceId('b'))?.availability).toBe('unknown');
  });
});

describe('loadFrom', () => {
  it('registers all discovered descriptors and attaches probes', async () => {
    const r = newRegistry();
    const source = new StaticResourceSource([descriptor('a'), descriptor('b')]);
    const count = await r.loadFrom(source, {
      probeFor: (d) => (d.id === 'a' ? () => Promise.resolve(state()) : undefined),
    });
    expect(count).toBe(2);
    expect(source.name).toBe('static');
    expect(r.list().map((d) => d.id)).toEqual(['a', 'b']);
    await r.refresh();
    expect(r.getState(resourceId('a'))?.availability).toBe('available');
    expect(r.getState(resourceId('b'))?.availability).toBe('unknown');
  });

  it('propagates duplicate errors', async () => {
    const r = newRegistry();
    r.register(descriptor('a'));
    await expect(r.loadFrom(new StaticResourceSource([descriptor('a')]))).rejects.toMatchObject({
      code: 'CONFIGURATION_ERROR',
    });
  });
});
