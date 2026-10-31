import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  connectionOf,
  ownerCodexResourceId,
  type PersistentConnectionRecord,
} from '@nexar/contracts';
import { ConnectionManager } from './connection-manager.js';
import { ConnectionRuntime } from './connection-runtime.js';
import { DesktopKeyStore, type DesktopEncryption } from './desktop-key-store.js';
import { SettingsStore } from './settings-store.js';

const AT = '2026-11-01T12:00:00.000Z';

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
let runtime: ConnectionRuntime;

function restart(): void {
  manager = new ConnectionManager({
    settingsStore: new SettingsStore(path),
    keyStore,
    now: () => AT,
  });
  runtime = new ConnectionRuntime(manager);
}

async function edit(change: (file: Record<string, unknown>) => void): Promise<void> {
  const file = JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>;
  change(file);
  await writeFile(path, JSON.stringify(file));
  restart();
}

/** A connection the owner has signed in to. */
async function signedIn(label: string): Promise<PersistentConnectionRecord> {
  const added = await manager.addCodexConnection({ label });
  await edit((file) => {
    const { connections } = file['connections'] as {
      connections: Record<string, Record<string, unknown>>;
    };
    connections[added.id]!['nativeHome'] = {
      ...added.nativeHome,
      signedInAt: AT,
      associated: true,
    };
  });
  return (await manager.getConnection(added.id))!;
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'nexar-conn-codex-rt-'));
  path = join(dir, 'desktop-settings.json');
  keyStore = new DesktopKeyStore({ userData: dir, encryption: fakeEncryption() });
  restart();
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

describe('owner Codex publication', () => {
  it('publishes nothing before the owner signs in', async () => {
    await manager.addCodexConnection({ label: 'Work' });
    expect(await runtime.descriptors()).toEqual([]);
  });

  it('publishes one resource per signed-in connection, each bound to its own', async () => {
    const a = await signedIn('Work');
    const b = await signedIn('Personal');
    const published = await runtime.descriptors();
    expect(published.map((d) => d.id).sort()).toEqual(
      [ownerCodexResourceId(a.id), ownerCodexResourceId(b.id)].sort(),
    );
    for (const descriptor of published) {
      const record = descriptor.id === ownerCodexResourceId(a.id) ? a : b;
      expect(descriptor.displayName).toBe(record.label);
      expect(connectionOf(descriptor)?.id).toBe(record.id);
      expect(manager.isAvailable(descriptor)).toBe(true);
    }
  });

  it('puts no path or marker in what it publishes', async () => {
    const a = await signedIn('Work');
    const text = JSON.stringify(await runtime.descriptors());
    expect(text).not.toContain(a.nativeHome!.marker);
    expect(text).not.toContain(dir.replaceAll('\\', '\\\\'));
    expect(text).not.toContain('CODEX_HOME');
    expect(text).not.toContain('codexHome');
  });

  it('stops publishing a disabled or removed connection, and its pin fails explicitly', async () => {
    const a = await signedIn('Work');
    const id = ownerCodexResourceId(a.id);
    await runtime.descriptors();
    await manager.disableConnection({ connectionId: a.id });
    expect(await runtime.descriptors()).toEqual([]);
    expect(() => runtime.validatePin(id)).toThrow(
      expect.objectContaining({ details: { reason: 'pin.connection-disabled' } }),
    );
    await manager.enableConnection({ connectionId: a.id });
    await manager.removeConnection({ connectionId: a.id });
    expect(await runtime.descriptors()).toEqual([]);
  });

  it('hides everything when owner connections are off, with the pin failing explicitly', async () => {
    const a = await signedIn('Work');
    await edit((file) => {
      file['ownerConnections'] = { enabled: false };
    });
    expect(await runtime.descriptors()).toEqual([]);
    expect(() => runtime.validatePin(ownerCodexResourceId(a.id))).toThrow(
      expect.objectContaining({ details: { reason: 'pin.connection-removed' } }),
    );
  });

  it('refuses an old resource after the generation changes', async () => {
    const a = await signedIn('Work');
    const [old] = await runtime.descriptors();
    await edit((file) => {
      const { connections } = file['connections'] as {
        connections: Record<string, Record<string, unknown>>;
      };
      connections[a.id]!['credentialGeneration'] = 2;
    });
    expect(manager.isAvailable(old!)).toBe(false);
    await expect(manager.acquireResource(old!)).rejects.toMatchObject({
      details: { reason: 'connection.stale-generation' },
    });
  });

  it('holds the lease while a process runs, through the guard', async () => {
    const a = await signedIn('Work');
    const [descriptor] = await runtime.descriptors();
    const lease = await runtime.guard().acquire!(descriptor!);
    expect(manager.getActiveExecutionCount(a.id)).toBe(1);
    lease.release();
    expect(manager.getActiveExecutionCount(a.id)).toBe(0);
  });
});
