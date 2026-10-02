import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NexarError } from '@nexar/contracts';
import { CHANNELS } from '../shared/channels.js';
import type { BridgeResult } from '../shared/api.js';
import { ProviderListSchema, type ProviderRow } from '../shared/providers.js';
import { createBridge } from './bridge.js';
import { DesktopKeyStore } from './desktop-key-store.js';
import { createEngineHost, type EngineHost } from './engine-host.js';
import { ProviderService } from './providers.js';
import { addProject, createHarness, type Harness } from './test-harness.js';

const SECRET = 'sk-nexar-sentinel-provider-secret-7391';
let h: Harness;
let keys: DesktopKeyStore;
let service: ProviderService;
let clipboard: string;
let cleared: number;
let call: Harness['call'];
let connectedEngine: EngineHost;

beforeEach(async () => {
  h = await createHarness();
  clipboard = SECRET;
  cleared = 0;
  keys = new DesktopKeyStore({
    userData: h.userData,
    platform: 'win32',
    encryption: {
      isEncryptionAvailable: () => true,
      encryptString: (value) => Buffer.from([...Buffer.from(value)].map((n) => n ^ 0xaa)),
      decryptString: (value) => Buffer.from([...value].map((n) => n ^ 0xaa)).toString(),
    },
  });
  const engine = await createEngineHost({
    configPath: h.config.path,
    env: {},
    logger: h.deps.logger,
    resolveSecret: keys.resolveSecret,
  });
  connectedEngine = engine;
  service = new ProviderService({
    keys,
    config: h.config,
    engine,
    clipboard: {
      readText: () => Promise.resolve(clipboard),
      clear: () => {
        cleared++;
        clipboard = '';
      },
    },
  });
  const bridge = createBridge({ ...h.deps, engine, providers: service });
  call = <T = unknown>(channel: string, args: unknown = {}) =>
    bridge.invoke(channel, args, (e) => h.events.push(e)) as Promise<BridgeResult<T>>;
});
afterEach(async () => {
  vi.restoreAllMocks();
  await h.cleanup();
});

describe('provider clipboard bridge', () => {
  it('returns only strict metadata, saves an encrypted key and selects references without plaintext', async () => {
    const initial = await call<ProviderRow[]>(CHANNELS.providersList);
    expect(initial.ok && ProviderListSchema.safeParse(initial.value).success).toBe(true);
    expect(initial.ok && initial.value.every((r) => r.status === 'missing')).toBe(true);
    const saved = await call<ProviderRow>(CHANNELS.providersSaveKeyFromClipboard, {
      provider: 'deepseek',
    });
    expect(saved.ok && saved.value).toMatchObject({
      provider: 'deepseek',
      status: 'saved',
      lastFour: '7391',
      usableBy: ['pi', 'deepseek-harness'],
    });
    expect(saved.ok && saved.value.modelCount).toBeGreaterThan(0);
    expect(keys.resolveSecret('DEEPSEEK_API_KEY')).toBe(SECRET);
    const ready = await connectedEngine.snapshots(true);
    expect(
      ready
        .filter((r) => r.descriptor.runtime.adapter === 'pi')
        .every((r) => r.state.auth === 'authenticated'),
    ).toBe(true);
    expect(cleared).toBe(1);
    const config = await h.config.readText();
    expect(JSON.parse(config)).toMatchObject({
      discovery: {
        enabled: true,
        credentialSource: 'keystore',
        sources: { piCatalog: { enabled: true, providers: ['deepseek'] } },
      },
    });
    for (const output of [
      JSON.stringify(saved),
      JSON.stringify(h.events),
      JSON.stringify(h.sessionEvents),
      config,
      await readFile(join(h.userData, 'credentials.json'), 'utf8'),
    ])
      expect(output).not.toContain(SECRET);
    const removed = await call<ProviderRow>(CHANNELS.providersRemoveKey, { provider: 'deepseek' });
    expect(removed.ok && removed.value.status).toBe('missing');
    expect(keys.resolveSecret('DEEPSEEK_API_KEY')).toBeUndefined();
    const missing = await connectedEngine.snapshots(true);
    expect(
      missing
        .filter((r) => r.descriptor.runtime.adapter === 'pi')
        .every((r) => r.state.auth === 'unauthenticated'),
    ).toBe(true);
    expect(await h.config.readText()).toContain('keystore');
  });

  it('removes an absent credential without adding providers to the owner discovery allowlist', async () => {
    expect((await call(CHANNELS.providersRemoveKey, { provider: 'groq' })).ok).toBe(true);
    expect(JSON.parse(await h.config.readText())).toMatchObject({
      discovery: { enabled: true, credentialSource: 'keystore' },
    });
    expect(await h.config.readText()).not.toContain('groq');
  });

  it('changes matching pi references while preserving native runtime authentication', async () => {
    await h.config.update((raw) => {
      const resources = raw['resources'] as unknown[];
      const common = {
        displayName: 'Configured model',
        kind: { type: 'model', provider: 'anthropic', model: 'test-model', access: 'api' },
        capabilities: ['text-generation'],
        auth: { mode: 'api-key', credential: { source: 'env', name: 'ANTHROPIC_API_KEY' } },
        cost: { model: 'unknown' },
        dataLocality: 'third-party',
      };
      resources.push({
        ...common,
        id: 'configured-pi',
        runtime: { adapter: 'pi', locality: 'remote' },
      });
      resources.push({
        ...common,
        id: 'native-api',
        kind: { type: 'agent', agent: 'claude-code', interface: 'cli' },
        runtime: { adapter: 'claude-code', locality: 'local' },
      });
    });
    expect((await call(CHANNELS.providersSaveKeyFromClipboard, { provider: 'anthropic' })).ok).toBe(
      true,
    );
    const resources = (await h.config.read())['resources'] as { id: string; auth: unknown }[];
    expect(resources.find((r) => r.id === 'configured-pi')?.auth).toEqual({
      mode: 'api-key',
      credential: { source: 'keystore', name: 'ANTHROPIC_API_KEY' },
    });
    expect(resources.find((r) => r.id === 'native-api')?.auth).toEqual({
      mode: 'api-key',
      credential: { source: 'env', name: 'ANTHROPIC_API_KEY' },
    });
  });

  it.each([
    CHANNELS.providersList,
    CHANNELS.providersSaveKeyFromClipboard,
    CHANNELS.providersRemoveKey,
  ])('rejects malformed %s input without echoing field names or values', async (channel) => {
    for (const raw of [
      { provider: SECRET },
      { provider: 'deepseek', key: SECRET },
      { [SECRET]: SECRET },
      { provider: '../outside' },
      null,
      SECRET,
    ]) {
      const result = await call(channel, raw);
      expect(result.ok).toBe(false);
      expect(JSON.stringify(result)).not.toContain(SECRET);
      expect(JSON.stringify(result)).not.toContain('../outside');
    }
    expect(cleared).toBe(0);
    expect(keys.resolveSecret('DEEPSEEK_API_KEY')).toBeUndefined();
  });

  it('refuses invalid clipboard content and unavailable encryption with no plaintext error', async () => {
    for (const content of ['', 'short', SECRET + '\nmalicious', 'x'.repeat(4097)]) {
      clipboard = content;
      const result = await call(CHANNELS.providersSaveKeyFromClipboard, { provider: 'deepseek' });
      expect(result.ok).toBe(false);
      expect(JSON.stringify(result)).not.toContain(SECRET);
    }
    clipboard = SECRET;
    vi.spyOn(keys, 'save').mockRejectedValue(new NexarError('AUTH_REQUIRED', SECRET));
    const result = await call(CHANNELS.providersSaveKeyFromClipboard, { provider: 'deepseek' });
    expect(result).toEqual({
      ok: false,
      error: { code: 'AUTH_REQUIRED', message: 'Provider setup could not be completed' },
    });
    expect(clipboard).toBe(SECRET);
  });

  it('preserves a newer clipboard value copied during the save', async () => {
    const save = keys.save.bind(keys);
    vi.spyOn(keys, 'save').mockImplementation(async (name, key) => {
      await save(name, key);
      clipboard = 'new-owner-copy';
    });
    expect((await call(CHANNELS.providersSaveKeyFromClipboard, { provider: 'openai' })).ok).toBe(
      true,
    );
    expect(clipboard).toBe('new-owner-copy');
    expect(cleared).toBe(0);
  });

  it('preserves projects, conversations and pending approvals through reload', async () => {
    const projectId = await addProject(h);
    const session = await h.sessionStore.create({
      projectId,
      mode: 'cowork',
      title: 'Preserve conversation',
    });
    await h.sessionStore.beginTurn(session.id, {
      submissionKey: 'preserved_submission_1',
      text: 'Keep this pending turn',
      state: 'pending-confirmation',
      lane: {
        policy: 'lanes@1',
        mode: 'cowork',
        requestedLane: 'code',
        effectiveLane: 'direct',
        mismatch: { from: 'cowork', to: 'code' },
      },
    });
    const active = await h.sessionStore.get(session.id);
    const id = `apr_${'b'.repeat(32)}`;
    await h.engine.approvals().create({
      id,
      createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 600_000).toISOString(),
      instanceId: 'test',
      actionType: 'engineering.commit',
      summary: 'Pending commit',
      risk: 'high',
      fingerprint: 'b'.repeat(64),
      status: 'pending',
    });
    expect((await call(CHANNELS.providersSaveKeyFromClipboard, { provider: 'deepseek' })).ok).toBe(
      true,
    );
    expect((await call(CHANNELS.providersRemoveKey, { provider: 'deepseek' })).ok).toBe(true);
    expect(await h.sessionStore.get(session.id)).toEqual(active);
    const projects = await call(CHANNELS.projectsList);
    expect(projects.ok && projects.value).toEqual([
      { id: projectId, name: 'project', root: h.projectDir },
    ]);
    const approvals = await call<{ status: string }[]>(CHANNELS.approvalsList);
    expect(approvals.ok && approvals.value[0]?.status).toBe('pending');
  });

  it('contains malformed output and dependency errors without leaking secrets', async () => {
    const info = vi.spyOn(h.deps.logger, 'info');
    const error = vi.spyOn(h.deps.logger, 'error');
    vi.spyOn(service, 'list').mockResolvedValue([
      { provider: 'deepseek', secret: SECRET },
    ] as never);
    expect(JSON.stringify(await call(CHANNELS.providersList))).not.toContain(SECRET);
    vi.spyOn(service, 'remove').mockRejectedValue(new NexarError('AUTH_REQUIRED', SECRET));
    expect(
      JSON.stringify(await call(CHANNELS.providersRemoveKey, { provider: 'deepseek' })),
    ).not.toContain(SECRET);
    const crashed = new Error(SECRET);
    crashed.name = SECRET;
    vi.spyOn(service, 'saveFromClipboard').mockRejectedValue(crashed);
    expect(
      JSON.stringify(await call(CHANNELS.providersSaveKeyFromClipboard, { provider: 'deepseek' })),
    ).not.toContain(SECRET);
    expect(JSON.stringify({ info: info.mock.calls, error: error.mock.calls })).not.toContain(
      SECRET,
    );
  });
});
