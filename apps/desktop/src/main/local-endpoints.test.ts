import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { ResourceSnapshot } from '@nexar/contracts';
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import type { BridgeResult } from '../shared/api.js';
import { CHANNELS } from '../shared/channels.js';
import type { LocalEndpointRow } from '../shared/local-endpoints.js';
import { createBridge } from './bridge.js';
import { LocalEndpointService } from './local-endpoints.js';
import { createHarness, type Harness } from './test-harness.js';

const CANARY = 'PRIVATE-ENDPOINT-CREDENTIAL-CANARY';
const endpoint = { kind: 'ollama' as const, baseUrl: 'http://127.0.0.1:11434' };
let h: Harness;
let service: LocalEndpointService;
let reload: MockInstance<Harness['engine']['reload']>;
const liveSnapshots = vi.fn<Harness['engine']['snapshots']>();
const liveRefresh = vi.fn<() => Promise<ResourceSnapshot[]>>();
let call: Harness['call'];

function gate(): { ready: Promise<void>; open: () => void } {
  let open!: () => void;
  const ready = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { ready, open };
}

beforeEach(async () => {
  h = await createHarness();
  // Never run endpoint discovery or registry probes against real HTTP in this suite.
  reload = vi.spyOn(h.engine, 'reload').mockResolvedValue(undefined);
  liveSnapshots.mockReset().mockRejectedValue(new Error('Live probes are forbidden'));
  liveRefresh.mockReset().mockRejectedValue(new Error('Live probes are forbidden'));
  vi.spyOn(h.engine, 'snapshots').mockImplementation(liveSnapshots);
  vi.spyOn(h.engine.composition().runtime.registry, 'refresh').mockImplementation(liveRefresh);
  service = new LocalEndpointService(h.config, h.engine);
  const bridge = createBridge({ ...h.deps, localEndpoints: service });
  call = <T = unknown>(channel: string, args: unknown = {}) =>
    bridge.invoke(channel, args, (event) => h.events.push(event)) as Promise<BridgeResult<T>>;
});
afterEach(async () => {
  vi.restoreAllMocks();
  await h.cleanup();
});

describe('local endpoint persistence and cached metadata', () => {
  it('generates a safe id, edits it in place and removes only that endpoint', async () => {
    expect(await service.list()).toEqual([]);
    const created = await service.save(endpoint);
    expect(created).toHaveLength(1);
    const id = created[0]!.id;
    expect(id).toMatch(/^[a-z0-9][a-z0-9._-]{0,31}$/);
    expect(created[0]).toEqual({ id, ...endpoint, modelCount: 0, enabled: true });
    const second = await service.save({
      kind: 'openai-compatible',
      baseUrl: 'https://models.example.test/v1',
    });
    expect(second).toHaveLength(2);
    const other = second.find((row) => row.id !== id)!;
    const edited = await service.save({
      id,
      kind: 'openai-compatible',
      baseUrl: 'http://localhost:8080/v1',
    });
    expect(edited.find((row) => row.id === id)).toMatchObject({
      id,
      kind: 'openai-compatible',
      baseUrl: 'http://localhost:8080/v1',
    });
    expect(await service.remove(id)).toEqual([other]);
    expect(reload).toHaveBeenCalledTimes(4);
    expect((await h.config.read())['discovery']).toMatchObject({
      sources: {
        localEndpoints: { endpoints: [{ id: other.id, kind: other.kind, baseUrl: other.baseUrl }] },
      },
    });
    expect(liveSnapshots).not.toHaveBeenCalled();
    expect(liveRefresh).not.toHaveBeenCalled();
  });

  it('preserves projects, routing, resources, provider discovery and encrypted credentials', async () => {
    await h.config.update((raw) => {
      raw['projects'] = [{ id: 'demo', displayName: 'Demo', roots: [h.projectDir] }];
      raw['discovery'] = {
        enabled: true,
        credentialSource: 'keystore',
        excludeIds: ['excluded-resource'],
        sources: { piCatalog: { enabled: true, providers: ['anthropic'], maxModels: 7 } },
      };
    });
    const previous = await h.config.read();
    const credentialText = '{"version":1,"entries":{}}\n';
    const credentials = join(h.userData, 'credentials.json');
    await writeFile(credentials, credentialText, { mode: 0o600 });
    const rows = await service.save(endpoint);
    await service.save({ id: rows[0]!.id, ...endpoint, baseUrl: 'http://localhost:11435' });
    await service.refresh();
    await service.remove(rows[0]!.id);
    const next = await h.config.read();
    for (const key of ['projects', 'routing', 'resources', 'telemetry', 'version'])
      expect(next[key]).toEqual(previous[key]);
    expect(next['discovery']).toMatchObject(previous['discovery'] as object);
    expect(await readFile(credentials, 'utf8')).toBe(credentialText);
  });

  it('counts only cached model descriptors for the exact endpoint provider and returns detached rows', async () => {
    const rows = await service.save(endpoint);
    const id = rows[0]!.id;
    const registry = h.engine.composition().runtime.registry;
    const original = registry.snapshot()[0]!;
    const model = (resourceId: string, provider: string): ResourceSnapshot => ({
      ...original,
      descriptor: {
        ...original.descriptor,
        provenance: 'discovered:local-endpoints',
        id: resourceId as typeof original.descriptor.id,
        kind: { type: 'model', provider, model: resourceId, access: 'local' },
      },
    });
    const configured = model('configured-near-match', id);
    vi.spyOn(registry, 'snapshot').mockReturnValue([
      model('local-one', id),
      model('local-two', id),
      model('near-match', id + '-other'),
      model('unrelated', 'openai'),
      { ...configured, descriptor: { ...configured.descriptor, provenance: 'configured' } },
      original,
    ]);
    const counted = await service.list();
    expect(counted[0]!.modelCount).toBe(2);
    (counted[0] as { baseUrl: string }).baseUrl = CANARY;
    expect((await service.list())[0]!.baseUrl).toBe(endpoint.baseUrl);
    expect(liveSnapshots).not.toHaveBeenCalled();
    expect(liveRefresh).not.toHaveBeenCalled();
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('refreshes only through a serialized config update and engine reload', async () => {
    const rows = await service.save(endpoint);
    reload.mockClear();
    const update = vi.spyOn(h.config, 'update');
    expect(await service.refresh()).toEqual(rows);
    expect(update).toHaveBeenCalledTimes(1);
    expect(reload).toHaveBeenCalledTimes(1);
    expect(liveSnapshots).not.toHaveBeenCalled();
    expect(liveRefresh).not.toHaveBeenCalled();
  });

  it('enforces 32 endpoints while allowing an existing endpoint to be edited', async () => {
    await h.config.update((raw) => {
      raw['discovery'] = {
        enabled: true,
        sources: {
          localEndpoints: {
            enabled: true,
            endpoints: Array.from({ length: 32 }, (_, index) => ({
              id: `fixture-${index}`,
              ...endpoint,
              baseUrl: `http://localhost:${12000 + index}`,
            })),
          },
        },
      };
    });
    const before = await h.config.readText();
    await expect(service.save(endpoint)).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    expect(await h.config.readText()).toBe(before);
    expect(reload).not.toHaveBeenCalled();
    const changed = await service.save({
      id: 'fixture-0',
      ...endpoint,
      baseUrl: 'http://localhost:13000',
    });
    expect(changed).toHaveLength(32);
    expect(changed.find((row) => row.id === 'fixture-0')!.baseUrl).toBe('http://localhost:13000');
  });

  it('never allows a caller to choose a new endpoint id', async () => {
    const before = await h.config.readText();
    await expect(service.save({ id: 'caller-chosen-id', ...endpoint })).rejects.toMatchObject({
      code: 'VALIDATION_ERROR',
    });
    await expect(service.remove('caller-chosen-id')).rejects.toMatchObject({
      code: 'VALIDATION_ERROR',
    });
    expect(await h.config.readText()).toBe(before);
    expect(reload).not.toHaveBeenCalled();
  });
});

describe('local endpoint bridge validation and privacy', () => {
  it.each([
    `http://${CANARY}:password@localhost:11434`,
    `http://localhost:11434?token=${CANARY}`,
    `http://localhost:11434#${CANARY}`,
    `http://localhost:11434/\n${CANARY}`,
    `http://localhost:11434/\0${CANARY}`,
    `file:///${CANARY}`,
    `ftp://localhost/${CANARY}`,
    `https://localhost/${'x'.repeat(4097)}`,
    ' http://localhost:11434',
    'http://localhost:11434 ',
    'http://localhost:11434?',
    'http://localhost:11434#',
    '',
    CANARY,
  ])('rejects unsafe URLs before config writes: %s', async (baseUrl) => {
    const before = await h.config.readText();
    const result = await call(CHANNELS.endpointsSave, { ...endpoint, baseUrl });
    expect(result).toMatchObject({ ok: false, error: { code: 'VALIDATION_ERROR' } });
    expect(JSON.stringify(result)).not.toContain(CANARY);
    expect(await h.config.readText()).toBe(before);
    expect(reload).not.toHaveBeenCalled();
  });

  it.each([
    [CHANNELS.endpointsList, { secret: CANARY }],
    [CHANNELS.endpointsRefresh, { baseUrl: CANARY }],
    [CHANNELS.endpointsSave, { ...endpoint, secret: CANARY }],
    [CHANNELS.endpointsSave, { ...endpoint, enabled: false }],
    [CHANNELS.endpointsSave, { ...endpoint, modelCount: 99 }],
    [CHANNELS.endpointsSave, { ...endpoint, kind: CANARY }],
    [CHANNELS.endpointsRemove, { id: CANARY, kind: 'ollama' }],
    [CHANNELS.endpointsRemove, {}],
    [CHANNELS.endpointsSave, null],
    [CHANNELS.endpointsSave, []],
  ])('rejects malformed fixed-channel payloads without echoing values', async (channel, args) => {
    const result = await call(channel as string, args);
    expect(result).toMatchObject({ ok: false, error: { code: 'VALIDATION_ERROR' } });
    expect(JSON.stringify(result)).not.toContain(CANARY);
    expect(reload).not.toHaveBeenCalled();
  });

  it('returns bounded metadata through all four bridge channels', async () => {
    expect(await call(CHANNELS.endpointsList)).toEqual({ ok: true, value: [] });
    const result = await call<readonly LocalEndpointRow[]>(CHANNELS.endpointsSave, endpoint);
    if (!result.ok) throw new Error('Endpoint fixture save failed');
    expect(Object.keys(result.value[0]!).sort()).toEqual([
      'baseUrl',
      'enabled',
      'id',
      'kind',
      'modelCount',
    ]);
    expect(await call(CHANNELS.endpointsRefresh)).toEqual(result);
    expect(await call(CHANNELS.endpointsRemove, { id: result.value[0]!.id })).toEqual({
      ok: true,
      value: [],
    });
  });
});

describe('endpoint config rollback and shared queue', () => {
  it.each(['save', 'remove', 'refresh'] as const)(
    'restores exact previous config and engine on failed %s reload',
    async (operation) => {
      const rows = await service.save(endpoint);
      const previous = await h.config.readText();
      // Preserve nonstandard whitespace too: rollback must restore the original bytes.
      const exact = '\n' + JSON.stringify(JSON.parse(previous), null, 4) + '\n\n';
      await h.config.restoreText(exact);
      const composition = h.engine.composition();
      reload.mockRejectedValueOnce(new Error(CANARY));
      const args =
        operation === 'save'
          ? { id: rows[0]!.id, ...endpoint, baseUrl: 'http://localhost:11435' }
          : operation === 'remove'
            ? { id: rows[0]!.id }
            : {};
      const channel =
        operation === 'save'
          ? CHANNELS.endpointsSave
          : operation === 'remove'
            ? CHANNELS.endpointsRemove
            : CHANNELS.endpointsRefresh;
      const result = await call(channel, args);
      expect(result.ok).toBe(false);
      expect(JSON.stringify(result)).not.toContain(CANARY);
      expect(await h.config.readText()).toBe(exact);
      expect(h.engine.composition()).toBe(composition);
      expect(await service.list()).toEqual(rows);
    },
  );

  it('keeps endpoint reload/rollback inside the shared project/provider mutation queue', async () => {
    const entered = gate();
    const release = gate();
    const before = await h.config.readText();
    const composition = h.engine.composition();
    reload.mockImplementationOnce(async () => {
      entered.open();
      await release.ready;
      throw new Error(CANARY);
    });
    const failed = service.save(endpoint);
    const expectedFailure = expect(failed).rejects.toThrow();
    await entered.ready;
    const read = vi.spyOn(h.config, 'readText');
    let mutationStarted = false;
    const providerAndProject = h.config.update(
      async (raw) => {
        mutationStarted = true;
        expect(await h.config.readText()).toBe(before);
        expect(h.engine.composition()).toBe(composition);
        raw['projects'] = [{ id: 'demo', displayName: 'Demo', roots: [h.projectDir] }];
        raw['discovery'] = {
          enabled: true,
          credentialSource: 'keystore',
          sources: { piCatalog: { enabled: true, providers: ['anthropic'] } },
        };
      },
      () => h.engine.reload(),
    );
    try {
      await Promise.resolve();
      expect(read).not.toHaveBeenCalled();
      expect(mutationStarted).toBe(false);
    } finally {
      release.open();
    }
    await expectedFailure;
    await providerAndProject;
    expect((await h.config.read())['projects']).toMatchObject([{ id: 'demo' }]);
    expect(await service.list()).toEqual([]);
    expect((await h.config.read())['discovery']).toMatchObject({
      credentialSource: 'keystore',
      sources: { piCatalog: { providers: ['anthropic'] } },
    });
  });

  it('waits for an existing provider mutation before endpoint save reads and writes config', async () => {
    const entered = gate();
    const release = gate();
    const provider = h.config.update(
      (raw) => {
        raw['discovery'] = {
          enabled: true,
          credentialSource: 'keystore',
          sources: { piCatalog: { enabled: true, providers: ['anthropic'] } },
        };
      },
      async () => {
        entered.open();
        await release.ready;
      },
    );
    await entered.ready;
    const read = vi.spyOn(h.config, 'readText');
    const saving = service.save(endpoint);
    try {
      await Promise.resolve();
      expect(read).not.toHaveBeenCalled();
      expect(reload).not.toHaveBeenCalled();
    } finally {
      release.open();
    }
    await provider;
    const rows = await saving;
    expect(rows).toHaveLength(1);
    expect((await h.config.read())['discovery']).toMatchObject({
      credentialSource: 'keystore',
      sources: {
        piCatalog: { providers: ['anthropic'] },
        localEndpoints: { endpoints: [{ id: rows[0]!.id }] },
      },
    });
  });
});
