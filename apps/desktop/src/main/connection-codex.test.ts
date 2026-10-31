import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  adapterId,
  BUILTIN_CONNECTIONS,
  isOwnerCodexConnectionId,
  ownerCodexResourceId,
  resourceId,
  type PersistentConnectionRecord,
  type ResourceDescriptor,
} from '@nexar/contracts';
import { ownerCodexResource } from '@nexar/host';
import { CodexHomeStore } from './codex-home-store.js';
import { DesktopKeyStore, type DesktopEncryption } from './desktop-key-store.js';
import { ConnectionManager } from './connection-manager.js';
import { SettingsStore } from './settings-store.js';

function fakeEncryption(): DesktopEncryption {
  return {
    isEncryptionAvailable: () => true,
    getSelectedStorageBackend: () => 'gnome_libsecret',
    encryptString: (value: string) => Buffer.from(value),
    decryptString: (value: Buffer) => value.toString(),
  };
}

let dir: string;
let path: string;
let keyStore: DesktopKeyStore;
let manager: ConnectionManager;

const restart = (): ConnectionManager =>
  new ConnectionManager({
    settingsStore: new SettingsStore(path),
    keyStore,
    now: () => '2026-11-01T12:00:00.000Z',
  });

/** Rewrites one saved record, as damage or tampering would. */
async function tamper(id: string, change: Record<string, unknown>): Promise<void> {
  const file = JSON.parse(await readFile(path, 'utf8')) as {
    connections: { connections: Record<string, Record<string, unknown>> };
  };
  file.connections.connections[id] = { ...file.connections.connections[id], ...change };
  await writeFile(path, JSON.stringify(file));
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'nexar-conn-codex-'));
  path = join(dir, 'desktop-settings.json');
  keyStore = new DesktopKeyStore({ userData: dir, encryption: fakeEncryption() });
  manager = restart();
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

describe('owner Codex connections', () => {
  it('adds a separate connection with its own identity and a private home scope', async () => {
    const a = await manager.addCodexConnection({ label: 'Work' });
    const b = await manager.addCodexConnection({ label: 'Personal' });
    expect(isOwnerCodexConnectionId(a.id)).toBe(true);
    expect(a.id).not.toBe(b.id);
    expect(a.nativeHome?.marker).not.toBe(b.nativeHome?.marker);
    expect(a).toMatchObject({
      label: 'Work',
      builtIn: false,
      provider: 'openai',
      method: 'subscription',
      authClass: 'vendor-native',
      credentialGeneration: 1,
      identityAssurance: 'IDENTITY_UNKNOWN',
      credentialScope: { kind: 'native-home', runtimeId: 'codex', home: 'private' },
    });
  });

  it('keeps the connection across a restart and leaves the built-in unchanged', async () => {
    const before = await manager.getConnection('openai.subscription');
    const added = await manager.addCodexConnection({ label: 'Work' });
    const after = restart();
    expect(await after.getConnection(added.id)).toEqual(added);
    expect(await after.getConnection('openai.subscription')).toEqual(before);
    expect(BUILTIN_CONNECTIONS['openai.subscription'].credentialScope).toEqual({
      kind: 'native-home',
      runtimeId: 'codex',
      home: 'default',
    });
  });

  it('cannot execute before the owner signs in', async () => {
    const added = await manager.addCodexConnection({ label: 'Work' });
    await expect(manager.acquireExecution(added.id)).rejects.toMatchObject({
      code: 'RESOURCE_UNAVAILABLE',
    });
  });

  it.each([
    [
      'a default home',
      { credentialScope: { kind: 'native-home', runtimeId: 'codex', home: 'default' } },
    ],
    [
      'another runtime',
      { credentialScope: { kind: 'native-home', runtimeId: 'claude-code', home: 'private' } },
    ],
    ['another provider', { provider: 'anthropic' }],
    ['the api method', { method: 'api' }],
    ['a built-in flag', { builtIn: true }],
    ['no recorded home', { nativeHome: undefined }],
    ['a home that is not a marker', { nativeHome: { marker: '../..' } }],
  ])('fails closed on a saved record with %s', async (_name, change) => {
    const added = await manager.addCodexConnection({ label: 'Work' });
    await tamper(added.id, change);
    const next = restart();
    await expect(next.listConnections()).rejects.toThrow();
  });

  it('refuses a recorded home on any other connection', async () => {
    const api = await manager.addApiConnection({
      provider: 'anthropic',
      label: 'Key',
      apiKey: 'synthetic-codex-test-key',
    });
    await tamper(api.id, { nativeHome: { marker: '11111111-1111-4111-8111-111111111111' } });
    await expect(restart().listConnections()).rejects.toThrow();
  });

  it('refuses a key rotation, since the vendor CLI owns the credential', async () => {
    const added = await manager.addCodexConnection({ label: 'Work' });
    await expect(
      manager.rotateCredential({
        connectionId: added.id,
        sameAccount: true,
        apiKey: 'synthetic-codex-test-key',
      }),
    ).rejects.toMatchObject({ details: { reason: 'connection.identity' } });
  });

  it('rejects a blank or oversized label', async () => {
    await expect(manager.addCodexConnection({ label: '  ' })).rejects.toThrow();
    await expect(manager.addCodexConnection({ label: 'x'.repeat(129) })).rejects.toThrow();
  });

  describe('home resolution', () => {
    const descriptor = (
      record: PersistentConnectionRecord,
      change: Partial<ResourceDescriptor> = {},
    ): ResourceDescriptor => ({ ...ownerCodexResource(record), ...change });
    let store: CodexHomeStore;
    let withHomes: ConnectionManager;

    beforeEach(() => {
      store = new CodexHomeStore({
        userData: dir,
        secureDirectory: (path) => mkdir(path, { recursive: true }).then(() => undefined),
      });
      withHomes = new ConnectionManager({
        settingsStore: new SettingsStore(path),
        keyStore,
        codexHomes: store,
        now: () => '2026-11-01T12:00:00.000Z',
      });
    });

    it('resolves each connection to its own home', async () => {
      const a = await withHomes.addCodexConnection({ label: 'A' });
      const b = await withHomes.addCodexConnection({ label: 'B' });
      const homeA = await store.ensure(a);
      const homeB = await store.ensure(b);
      expect(await withHomes.resolveCodexHome(descriptor(a))).toBe(homeA);
      expect(await withHomes.resolveCodexHome(descriptor(b))).toBe(homeB);
      expect(homeA).not.toBe(homeB);
    });

    it('asks for a sign-in while no home exists', async () => {
      const a = await withHomes.addCodexConnection({ label: 'A' });
      await expect(withHomes.resolveCodexHome(descriptor(a))).rejects.toMatchObject({
        code: 'AUTH_REQUIRED',
      });
    });

    it('refuses a resource that claims another connection or another home', async () => {
      const a = await withHomes.addCodexConnection({ label: 'A' });
      const b = await withHomes.addCodexConnection({ label: 'B' });
      await store.ensure(a);
      const options = { adapter: adapterId('codex'), locality: 'local' as const };
      for (const bad of [
        descriptor(a, { id: resourceId(ownerCodexResourceId(b.id)) }),
        descriptor(a, { id: resourceId('codex') }),
        descriptor(a, { runtime: { ...options, options: { codexHome: dir } } }),
      ])
        await expect(withHomes.resolveCodexHome(bad)).rejects.toMatchObject({
          details: { reason: 'connection.scope' },
        });
    });

    it('refuses a stale generation', async () => {
      const a = await withHomes.addCodexConnection({ label: 'A' });
      await store.ensure(a);
      const stale = descriptor({ ...a, credentialGeneration: 2 });
      await expect(withHomes.resolveCodexHome(stale)).rejects.toMatchObject({
        details: { reason: 'connection.stale-generation' },
      });
    });

    it('refuses without a home store', async () => {
      const a = await manager.addCodexConnection({ label: 'A' });
      await expect(manager.resolveCodexHome(descriptor(a))).rejects.toMatchObject({
        code: 'CONFIGURATION_ERROR',
      });
    });
  });

  it('refuses a new connection while owner connections are off', async () => {
    await manager.addCodexConnection({ label: 'Work' });
    const file = JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>;
    await writeFile(path, JSON.stringify({ ...file, ownerConnections: { enabled: false } }));
    await expect(restart().addCodexConnection({ label: 'Other' })).rejects.toMatchObject({
      details: { reason: 'connection.owner-connections-off' },
    });
  });
});
