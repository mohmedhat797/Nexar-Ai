import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ConnectionManager } from './connection-manager.js';
import { DesktopKeyStore, type DesktopEncryption } from './desktop-key-store.js';
import { SettingsStore } from './settings-store.js';
const A = 'synthetic-account-A-key-123456',
  B = 'synthetic-account-B-key-123456';
const barrier = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
};
let dir: string,
  settings: SettingsStore,
  keys: DesktopKeyStore,
  manager: ConnectionManager,
  encryption: DesktopEncryption;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'nexar-authority-'));
  const values = new Map<string, string>();
  let n = 0;
  encryption = {
    isEncryptionAvailable: () => true,
    getSelectedStorageBackend: () => 'gnome_libsecret',
    encryptString: (value) => {
      const id = `encrypted-${++n}`;
      values.set(id, value);
      return Buffer.from(id);
    },
    decryptString: (value) => {
      const plain = values.get(value.toString());
      if (plain === undefined) throw Error('synthetic decrypt');
      return plain;
    },
  };
  settings = new SettingsStore(join(dir, 'settings.json'));
  keys = new DesktopKeyStore({ userData: dir, encryption });
  manager = new ConnectionManager({ settingsStore: settings, keyStore: keys });
});
afterEach(async () => {
  vi.restoreAllMocks();
  await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});
const add = () =>
  manager.addApiConnection({ provider: 'openai', label: 'Fixture account', apiKey: A });
const name = (r: Awaited<ReturnType<typeof add>>) => {
  if (r.credentialScope.kind !== 'keystore') throw Error('fixture');
  return r.credentialScope.name;
};
describe('connection authority accepted lifecycle and transaction behavior', () => {
  it('serializes concurrent matching RNG allocations and preserves both records across restart', async () => {
    let call = 0;
    manager = new ConnectionManager({
      settingsStore: settings,
      keyStore: keys,
      rng: () => new Uint8Array(10).fill(call++ < 2 ? 0 : 1),
    });
    const [a, b] = await Promise.all([add(), add()]);
    expect(a.id).not.toBe(b.id);
    const restarted = new ConnectionManager({
      settingsStore: new SettingsStore(join(dir, 'settings.json')),
      keyStore: keys,
    });
    expect((await restarted.listConnections()).filter((r) => !r.builtIn)).toHaveLength(2);
    expect(keys.resolveSecret(name(a))).toBe(A);
    expect(keys.resolveSecret(name(b))).toBe(A);
  });
  it('rejects Remove → Disable → Enable and restores only with a credential', async () => {
    const a = await add();
    await manager.removeConnection({ connectionId: a.id });
    await expect(manager.disableConnection({ connectionId: a.id })).rejects.toMatchObject({
      details: { reason: 'connection.invalid-transition' },
    });
    await expect(manager.enableConnection({ connectionId: a.id })).rejects.toThrow();
    await manager.forgetCredential({ connectionId: a.id });
    await expect(manager.restoreConnection({ connectionId: a.id })).rejects.toMatchObject({
      code: 'AUTH_REQUIRED',
    });
    expect((await manager.getConnection(a.id))?.lifecycleState).toBe('TOMBSTONED');
  });
  it('requires explicit continuity and records assertion evidence without fabricating verified status', async () => {
    const a = await add();
    expect(a.identityAssurance).toBe('IDENTITY_UNKNOWN');
    await expect(
      manager.rotateCredential({ connectionId: a.id, apiKey: B } as never),
    ).rejects.toThrow();
    const b = await manager.rotateCredential({ connectionId: a.id, apiKey: B, sameAccount: true });
    expect(b.identityAssurance).toBe('OWNER_ASSERTED_SAME_ACCOUNT');
    expect(b.assertion?.source).toBe('owner');
    expect(Number.isFinite(Date.parse(b.assertion!.at))).toBe(true);
    expect((await manager.getConnection('openai.chatgpt-plan'))?.identityAssurance).toBe(
      'IDENTITY_UNKNOWN',
    );
  });
  it('does not let admission pass an in-progress rotation', async () => {
    const a = await add(),
      entered = barrier(),
      resume = barrier();
    const batch = keys.batch.bind(keys);
    vi.spyOn(keys, 'batch').mockImplementationOnce(async (changes) => {
      entered.resolve();
      await resume.promise;
      return batch(changes);
    });
    const rotation = manager.rotateCredential({ connectionId: a.id, apiKey: B, sameAccount: true });
    await entered.promise;
    let admitted = false;
    const execution = manager.acquireExecution(a.id).then((l) => {
      admitted = true;
      return l;
    });
    await Promise.resolve();
    expect(admitted).toBe(false);
    resume.resolve();
    await rotation;
    const lease = await execution;
    expect(lease.record.credentialGeneration).toBe(2);
    await expect(manager.forgetCredential({ connectionId: a.id })).rejects.toMatchObject({
      details: { reason: 'connection.active' },
    });
    lease.release();
  });
  it('drains existing work on Disable and denies new admission', async () => {
    const a = await add();
    const lease = await manager.acquireExecution(a.id);
    await manager.disableConnection({ connectionId: a.id });
    expect(manager.getActiveExecutionCount(a.id)).toBe(1);
    await expect(manager.acquireExecution(a.id)).rejects.toMatchObject({
      details: { reason: 'pin.connection-disabled' },
    });
    lease.release();
    expect(manager.getActiveExecutionCount(a.id)).toBe(0);
  });
  it('recovers a committed key/settings split before admitting work, idempotently after restart', async () => {
    const a = await add();
    vi.spyOn(settings, 'saveConnections').mockRejectedValueOnce(
      Error('synthetic settings failure'),
    );
    await expect(
      manager.rotateCredential({ connectionId: a.id, apiKey: B, sameAccount: true }),
    ).rejects.toThrow();
    const restarted = new ConnectionManager({
      settingsStore: new SettingsStore(join(dir, 'settings.json')),
      keyStore: new DesktopKeyStore({ userData: dir, encryption }),
    });
    const lease = await restarted.acquireExecution(a.id);
    expect(lease.record.credentialGeneration).toBe(2);
    expect(keys.resolveSecret(name(a))).toBe(B);
    lease.release();
    await restarted.initialize();
    expect(keys.readBlob('connection-transaction')).toBeUndefined();
    expect(await readFile(join(dir, 'settings.json'), 'utf8')).not.toContain(B);
  });
  it('does not mutate either store when credential commit fails before persistence', async () => {
    const a = await add();
    vi.spyOn(keys, 'batch').mockRejectedValueOnce(Error('synthetic key failure'));
    await expect(
      manager.rotateCredential({ connectionId: a.id, apiKey: B, sameAccount: true }),
    ).rejects.toThrow();
    expect(keys.resolveSecret(name(a))).toBe(A);
    expect((await manager.getConnection(a.id))?.credentialGeneration).toBe(1);
  });
  it('rejects cross-connection scopes and forged semantic state without deleting any key', async () => {
    const a = await add(),
      b = await add();
    const state = await settings.getConnections();
    if (!state.valid) throw Error('fixture');
    for (const patch of [
      { credentialScope: b.credentialScope },
      { machine: 'plane' },
      { builtIn: true },
      { credentialGeneration: 0 },
      { enabled: false },
      { createdAt: 'invalid' },
      { identityAssurance: 'VERIFIED_SAME_ACCOUNT' },
    ]) {
      await expect(
        settings.saveConnections({
          ...state.value,
          connections: { ...state.value.connections, [a.id]: { ...a, ...patch } as typeof a },
        }),
      ).rejects.toThrow();
    }
    expect(keys.resolveSecret(name(a))).toBe(A);
    expect(keys.resolveSecret(name(b))).toBe(A);
  });
  it('serializes Remove behind Rotate without resurrecting the removed state', async () => {
    const a = await add(),
      entered = barrier(),
      resume = barrier();
    const batch = keys.batch.bind(keys);
    vi.spyOn(keys, 'batch').mockImplementationOnce(async (c) => {
      entered.resolve();
      await resume.promise;
      return batch(c);
    });
    const rotation = manager.rotateCredential({ connectionId: a.id, apiKey: B, sameAccount: true });
    await entered.promise;
    const remove = manager.removeConnection({ connectionId: a.id });
    resume.resolve();
    await rotation;
    await remove;
    expect((await manager.getConnection(a.id))?.lifecycleState).toBe('TOMBSTONED');
  });
  it('permanently retires the old Plan identity and propagates failed storage', async () => {
    vi.spyOn(keys, 'batch').mockRejectedValueOnce(Error('synthetic delete failure'));
    await expect(manager.replacePlanAccount()).rejects.toThrow();
    expect((await manager.currentPlan()).id).toBe('openai.chatgpt-plan');
    const next = await manager.replacePlanAccount();
    expect(next.id).toMatch(/^openai\.chatgpt-plan\.c[a-z2-7]{10}$/);
    expect((await manager.getConnection('openai.chatgpt-plan'))?.retirement).toBe('replaced');
    await expect(
      manager.restoreConnection({ connectionId: 'openai.chatgpt-plan' }),
    ).rejects.toThrow();
    expect(
      (await manager.listConnections()).filter(
        (r) => r.credentialScope.kind === 'account' && r.lifecycleState !== 'TOMBSTONED',
      ),
    ).toHaveLength(1);
  });
});
