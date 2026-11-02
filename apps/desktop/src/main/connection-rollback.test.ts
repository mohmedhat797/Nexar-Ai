import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { PersistentConnectionRecord } from '@nexar/contracts';
import { DesktopKeyStore, type DesktopEncryption } from './desktop-key-store.js';
import { ConnectionManager } from './connection-manager.js';
import { ConnectionRuntime } from './connection-runtime.js';
import { SettingsStore } from './settings-store.js';

const SYNTHETIC_KEY = 'synthetic-rollback-key';

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

/** A new store and manager, as after an app restart: the setting is read once per start. */
function restart(): ConnectionManager {
  return new ConnectionManager({
    settingsStore: new SettingsStore(path),
    keyStore,
    now: () => '2026-11-01T12:00:00.000Z',
  });
}

async function setOwnerConnections(value: unknown): Promise<void> {
  const file = JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>;
  await writeFile(path, JSON.stringify({ ...file, ownerConnections: value }));
}

const add = (): Promise<PersistentConnectionRecord> =>
  manager.addApiConnection({ provider: 'anthropic', label: 'Work', apiKey: SYNTHETIC_KEY });

const keyName = (record: PersistentConnectionRecord): string => {
  if (record.credentialScope.kind !== 'keystore') throw new Error('expected a key-store scope');
  return record.credentialScope.name;
};

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'nexar-conn-rollback-'));
  path = join(dir, 'desktop-settings.json');
  keyStore = new DesktopKeyStore({ userData: dir, encryption: fakeEncryption() });
  manager = restart();
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

describe('owner connections rollback control', () => {
  it('keeps owner connections when the setting is absent', async () => {
    const record = await add();
    expect((await restart().listConnections()).map((r) => r.id)).toContain(record.id);
  });

  it('hides owner connections and keeps built-ins when off', async () => {
    const record = await add();
    await setOwnerConnections({ enabled: false });
    const off = restart();
    const ids = (await off.listConnections()).map((r) => r.id);
    expect(ids).not.toContain(record.id);
    expect(ids).toContain('openai.subscription');
    expect(await off.getConnection(record.id)).toBeUndefined();
  });

  it.each(['off', null, {}, { enabled: 'false' }, { enabled: true, extra: 1 }])(
    'fails closed on a damaged setting: %j',
    async (value) => {
      const record = await add();
      await setOwnerConnections(value);
      expect((await restart().listConnections()).map((r) => r.id)).not.toContain(record.id);
    },
  );

  it('fails execution explicitly instead of using another connection', async () => {
    const record = await add();
    await setOwnerConnections({ enabled: false });
    await expect(restart().acquireExecution(record.id)).rejects.toMatchObject({
      code: 'RESOURCE_UNAVAILABLE',
      details: { reason: 'pin.connection-disabled' },
    });
  });

  it('unpublishes resources and fails a saved pin explicitly', async () => {
    await add();
    const published = await new ConnectionRuntime(restart()).descriptors();
    expect(published.length).toBeGreaterThan(0);
    await setOwnerConnections({ enabled: false });
    const off = new ConnectionRuntime(restart());
    expect(await off.descriptors()).toEqual([]);
    expect(() => off.validatePin(published[0]!.id)).toThrow(
      expect.objectContaining({
        code: 'RESOURCE_UNAVAILABLE',
        details: { reason: 'pin.connection-removed' },
      }),
    );
    expect(off.manager.isAvailable(published[0]!)).toBe(false);
  });

  it('refuses every lifecycle action and leaves stored state untouched', async () => {
    const record = await add();
    await setOwnerConnections({ enabled: false });
    const before = await readFile(path, 'utf8');
    const off = restart();
    const { id } = record;
    const refused = {
      code: 'POLICY_REJECTED',
      details: { reason: 'connection.owner-connections-off' },
    };
    await expect(off.disableConnection({ connectionId: id })).rejects.toMatchObject(refused);
    await expect(off.enableConnection({ connectionId: id })).rejects.toMatchObject(refused);
    await expect(off.removeConnection({ connectionId: id })).rejects.toMatchObject(refused);
    await expect(off.restoreConnection({ connectionId: id })).rejects.toMatchObject(refused);
    await expect(off.forgetCredential({ connectionId: id })).rejects.toMatchObject(refused);
    await expect(
      off.rotateCredential({ connectionId: id, apiKey: SYNTHETIC_KEY, sameAccount: true }),
    ).rejects.toMatchObject(refused);
    await expect(off.prepareAction({ connectionId: id, action: 'remove' })).rejects.toMatchObject(
      refused,
    );
    await expect(off.acquireAuthentication(id)).rejects.toMatchObject(refused);
    await expect(
      off.addApiConnection({ provider: 'openai', label: 'New', apiKey: SYNTHETIC_KEY }),
    ).rejects.toMatchObject(refused);
    expect(await readFile(path, 'utf8')).toBe(before);
    expect(keyStore.metadata(keyName(record)).present).toBe(true);
  });

  it('returns the same connection when turned back on', async () => {
    const record = await add();
    await setOwnerConnections({ enabled: false });
    expect(await restart().getConnection(record.id)).toBeUndefined();
    await setOwnerConnections({ enabled: true });
    const on = restart();
    expect(await on.getConnection(record.id)).toEqual(record);
    const lease = await on.acquireExecution(record.id);
    lease.release();
  });

  it('retains tombstones while off, so an id is never released', async () => {
    const record = await add();
    await manager.removeConnection({ connectionId: record.id });
    await setOwnerConnections({ enabled: false });
    await restart().listConnections();
    await setOwnerConnections({ enabled: true });
    const on = restart();
    expect((await on.getConnection(record.id))?.lifecycleState).toBe('TOMBSTONED');
    expect((await on.restoreConnection({ connectionId: record.id })).id).toBe(record.id);
  });

  it('keeps a replacement plan available, since it is the only plan left', async () => {
    const replacement = await manager.replacePlanAccount();
    await setOwnerConnections({ enabled: false });
    const off = restart();
    expect((await off.currentPlan()).id).toBe(replacement.id);
    expect((await off.listConnections()).map((r) => r.id)).toContain(replacement.id);
  });

  it('keeps the setting verbatim when other settings are saved', async () => {
    await add();
    await setOwnerConnections({ enabled: false });
    const store = new SettingsStore(path);
    await store.set({ theme: 'midnight' });
    const file = JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>;
    expect(file['ownerConnections']).toEqual({ enabled: false });
    expect(file['theme']).toBe('midnight');
    expect(await store.getOwnerConnectionsEnabled()).toBe(false);
  });
});
