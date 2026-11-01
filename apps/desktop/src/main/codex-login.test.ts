import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  NativeSubscriptionLoginOutcome,
  NativeSubscriptionProbe,
  PersistentConnectionRecord,
} from '@nexar/contracts';
import { CodexHomeStore } from './codex-home-store.js';
import { CodexLoginService } from './codex-login.js';
import { ConnectionManager } from './connection-manager.js';
import { DesktopKeyStore, type DesktopEncryption } from './desktop-key-store.js';
import { SettingsStore } from './settings-store.js';

const encryption: DesktopEncryption = {
  isEncryptionAvailable: () => true,
  getSelectedStorageBackend: () => 'gnome_libsecret',
  encryptString: (value: string) => Buffer.from(value),
  decryptString: (value: Buffer) => value.toString(),
};
const connected: NativeSubscriptionProbe = {
  status: 'connected',
  authMode: 'vendor-account',
  loginSupported: true,
};
const signedOutProbe: NativeSubscriptionProbe = {
  status: 'not-connected',
  authMode: 'none',
  loginSupported: true,
};

let dir: string;
let manager: ConnectionManager;
let homes: string[];
let logins: number;
let probes: NativeSubscriptionProbe[];
let outcome: () => Promise<NativeSubscriptionLoginOutcome>;
let service: CodexLoginService;

function wait(id: string): Promise<void> {
  return vi.waitFor(() => {
    expect(service.status(id).loginState).not.toBe('running');
  });
}

async function signIn(id: string, sameAccount?: true): Promise<void> {
  probes = [signedOutProbe, connected];
  await service.start({ connectionId: id, ...(sameAccount ? { sameAccount } : {}) });
  await wait(id);
}

async function record(id: string): Promise<PersistentConnectionRecord> {
  const found = await manager.getConnection(id);
  if (found === undefined) throw new Error('missing connection');
  return found;
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'nexar-codex-login-'));
  manager = new ConnectionManager({
    settingsStore: new SettingsStore(join(dir, 'desktop-settings.json')),
    keyStore: new DesktopKeyStore({ userData: dir, encryption }),
    codexHomes: new CodexHomeStore({ userData: dir }),
    now: () => '2026-11-01T12:00:00.000Z',
  });
  homes = [];
  logins = 0;
  probes = [signedOutProbe, connected];
  outcome = () => Promise.resolve('succeeded');
  service = new CodexLoginService({
    manager,
    runtime: (home) => {
      homes.push(home);
      return {
        probe: () => Promise.resolve(probes.shift() ?? connected),
        login: () => {
          logins += 1;
          return outcome();
        },
      };
    },
  });
});

afterEach(async () => {
  service.dispose();
  await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

describe('owner Codex sign-in', () => {
  it('runs only in the home of the connection that was asked for', async () => {
    const a = await manager.addCodexConnection({ label: 'Work' });
    const b = await manager.addCodexConnection({ label: 'Personal' });
    await signIn(a.id);
    await signIn(b.id);
    expect(new Set(homes).size).toBe(2);
    expect(homes[0]).toContain(a.id);
    expect(homes[1]).toContain(b.id);
    expect(homes[1]).not.toContain(a.id);
  });

  it('marks the first sign-in without claiming anything about the account', async () => {
    const { id, credentialGeneration } = await manager.addCodexConnection({ label: 'Work' });
    await signIn(id);
    expect(service.status(id)).toEqual({ connectionId: id, loginState: 'succeeded' });
    expect(await record(id)).toMatchObject({
      nativeHome: { signedInAt: '2026-11-01T12:00:00.000Z', associated: true },
      identityAssurance: 'IDENTITY_UNKNOWN',
      credentialGeneration,
    });
  });

  it('ignores an assertion on a first sign-in, when there is no account to be the same as', async () => {
    const { id } = await manager.addCodexConnection({ label: 'Work' });
    await signIn(id, true);
    expect((await record(id)).identityAssurance).toBe('IDENTITY_UNKNOWN');
  });

  it('refuses a second sign-in without the same-account assertion', async () => {
    const { id } = await manager.addCodexConnection({ label: 'Work' });
    await signIn(id);
    logins = 0;
    await expect(service.start({ connectionId: id })).rejects.toMatchObject({
      code: 'POLICY_REJECTED',
      details: { reason: 'connection.assertion-required' },
    });
    expect(logins).toBe(0);
    expect(service.status(id).loginState).toBe('succeeded');
  });

  it('records the assertion and moves the generation on when signing in again', async () => {
    const { id } = await manager.addCodexConnection({ label: 'Work' });
    await signIn(id);
    const before = await record(id);
    await signIn(id, true);
    expect(await record(id)).toMatchObject({
      id,
      identityAssurance: 'OWNER_ASSERTED_SAME_ACCOUNT',
      assertion: { type: 'same-account', source: 'owner' },
      credentialGeneration: before.credentialGeneration + 1,
      nativeHome: { marker: before.nativeHome?.marker },
    });
  });

  it('still needs the assertion after the home was deleted', async () => {
    const { id } = await manager.addCodexConnection({ label: 'Work' });
    await signIn(id);
    const ticket = await manager.prepareAction({ connectionId: id, action: 'delete-home' });
    await manager.deleteCodexHome({
      connectionId: id,
      confirmation: ticket.token,
      confirmationName: 'Work',
    });
    await expect(service.start({ connectionId: id })).rejects.toMatchObject({
      details: { reason: 'connection.assertion-required' },
    });
  });

  it('does not count an API key in the home as a sign-in', async () => {
    const { id } = await manager.addCodexConnection({ label: 'Work' });
    probes = [
      signedOutProbe,
      { status: 'not-connected', authMode: 'api-key', loginSupported: true },
    ];
    await service.start({ connectionId: id });
    await wait(id);
    expect(service.status(id).loginState).toBe('failed');
    expect((await record(id)).nativeHome?.signedInAt).toBeUndefined();
  });

  it('signs out a connection whose new sign-in cannot be verified', async () => {
    const { id } = await manager.addCodexConnection({ label: 'Work' });
    await signIn(id);
    const before = await record(id);
    probes = [connected, signedOutProbe];
    await service.start({ connectionId: id, sameAccount: true });
    await wait(id);
    expect(service.status(id).loginState).toBe('failed');
    const after = await record(id);
    expect(after.nativeHome?.signedInAt).toBeUndefined();
    expect(after.nativeHome?.associated).toBe(true);
    expect(after.credentialGeneration).toBe(before.credentialGeneration + 1);
  });

  it('signs out when the check after the sign-in itself fails', async () => {
    const { id } = await manager.addCodexConnection({ label: 'Work' });
    await signIn(id);
    let probed = 0;
    service = new CodexLoginService({
      manager,
      runtime: () => ({
        probe: () => (probed++ === 0 ? Promise.resolve(connected) : Promise.reject(new Error('x'))),
        login: () => Promise.resolve('succeeded'),
      }),
    });
    await service.start({ connectionId: id, sameAccount: true });
    await wait(id);
    expect(service.status(id).loginState).toBe('failed');
    expect((await record(id)).nativeHome?.signedInAt).toBeUndefined();
  });

  it.each(['failed', 'timed-out', 'unavailable'] as const)(
    'keeps a working sign-in when the vendor reports %s',
    async (reported) => {
      const { id } = await manager.addCodexConnection({ label: 'Work' });
      await signIn(id);
      const before = await record(id);
      probes = [connected];
      outcome = () => Promise.resolve(reported);
      await service.start({ connectionId: id, sameAccount: true });
      await wait(id);
      expect(service.status(id).loginState).toBe(reported);
      expect(await record(id)).toEqual(before);
    },
  );

  it('reports an unavailable CLI without starting a sign-in', async () => {
    const { id } = await manager.addCodexConnection({ label: 'Work' });
    probes = [{ status: 'unavailable', authMode: 'unknown', loginSupported: false }];
    await service.start({ connectionId: id });
    await wait(id);
    expect(logins).toBe(0);
    expect(service.status(id).loginState).toBe('unavailable');
  });

  it('holds the connection busy until the sign-in ends, then lets it go', async () => {
    const { id } = await manager.addCodexConnection({ label: 'Work' });
    let finish: (value: NativeSubscriptionLoginOutcome) => void = () => undefined;
    outcome = () => new Promise((resolve) => (finish = resolve));
    await service.start({ connectionId: id });
    await vi.waitFor(() => {
      expect(logins).toBe(1);
    });
    expect(manager.getActiveExecutionCount(id)).toBe(1);
    await expect(service.start({ connectionId: id })).rejects.toMatchObject({ code: 'CONFLICT' });
    const ticket = await manager.prepareAction({ connectionId: id, action: 'delete-home' });
    await expect(
      manager.deleteCodexHome({
        connectionId: id,
        confirmation: ticket.token,
        confirmationName: 'Work',
      }),
    ).rejects.toMatchObject({ details: { reason: 'connection.active' } });
    await expect(manager.acquireExecution(id)).rejects.toMatchObject({
      code: 'RESOURCE_UNAVAILABLE',
    });
    finish('succeeded');
    await wait(id);
    expect(manager.getActiveExecutionCount(id)).toBe(0);
    const lease = await manager.acquireExecution(id);
    lease.release();
  });

  it('refuses while the connection is running something', async () => {
    const { id } = await manager.addCodexConnection({ label: 'Work' });
    await signIn(id);
    const lease = await manager.acquireExecution(id);
    logins = 0;
    await expect(service.start({ connectionId: id, sameAccount: true })).rejects.toMatchObject({
      details: { reason: 'connection.active' },
    });
    expect(logins).toBe(0);
    lease.release();
  });

  it('cancels, aborting the vendor process and leaving nothing signed in', async () => {
    const { id } = await manager.addCodexConnection({ label: 'Work' });
    let seen: AbortSignal | undefined;
    service = new CodexLoginService({
      manager,
      runtime: () => ({
        probe: () => Promise.resolve(signedOutProbe),
        login: (signal) => {
          seen = signal;
          return new Promise((resolve) => {
            signal.addEventListener('abort', () => {
              resolve('cancelled');
            });
          });
        },
      }),
    });
    await service.start({ connectionId: id });
    await vi.waitFor(() => {
      expect(seen).toBeDefined();
    });
    expect(service.cancel(id).loginState).toBe('cancelled');
    expect(seen?.aborted).toBe(true);
    await vi.waitFor(() => {
      expect(manager.getActiveExecutionCount(id)).toBe(0);
    });
    expect(service.status(id).loginState).toBe('cancelled');
    expect((await record(id)).nativeHome?.signedInAt).toBeUndefined();
  });

  it('refuses the built-in connection, whose home the vendor owns', async () => {
    await expect(service.start({ connectionId: 'openai.subscription' })).rejects.toMatchObject({
      details: { reason: 'connection.invalid-transition' },
    });
    expect(homes).toEqual([]);
  });

  it('refuses a hidden connection when owner connections are off', async () => {
    const { id } = await manager.addCodexConnection({ label: 'Work' });
    const path = join(dir, 'desktop-settings.json');
    const file = JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>;
    await writeFile(path, JSON.stringify({ ...file, ownerConnections: { enabled: false } }));
    const restarted = new CodexLoginService({
      manager: new ConnectionManager({
        settingsStore: new SettingsStore(path),
        keyStore: new DesktopKeyStore({ userData: dir, encryption }),
        codexHomes: new CodexHomeStore({ userData: dir }),
      }),
      runtime: () => {
        throw new Error('must not run');
      },
    });
    await expect(restarted.start({ connectionId: id })).rejects.toMatchObject({
      details: { reason: 'connection.owner-connections-off' },
    });
  });

  it('refuses after shutdown', async () => {
    const { id } = await manager.addCodexConnection({ label: 'Work' });
    service.dispose();
    await expect(service.start({ connectionId: id })).rejects.toMatchObject({
      code: 'CONFIGURATION_ERROR',
    });
  });

  it('reads status without running anything', async () => {
    const { id } = await manager.addCodexConnection({ label: 'Work' });
    expect(service.status(id)).toEqual({ connectionId: id, loginState: 'idle' });
    expect(homes).toEqual([]);
    expect(logins).toBe(0);
  });

  it('keeps sign-in reachable from nowhere but this service', async () => {
    const source = await Promise.all(
      ['connection-runtime.ts', 'provider-inventory.ts'].map((name) =>
        readFile(join(import.meta.dirname, name), 'utf8'),
      ),
    );
    for (const text of source) {
      expect(text).not.toMatch(/\.login\(|CodexLoginService|beginCodexLogin/);
    }
  });
});
