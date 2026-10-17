import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ConnectionManager } from './connection-manager.js';
import { DesktopKeyStore } from './desktop-key-store.js';
import { SettingsStore } from './settings-store.js';
import { createHarness, type Harness } from './test-harness.js';
import { CHANNELS } from '../shared/channels.js';
import type { ConnectionConfirmation, ConnectionDto } from '../shared/connections.js';
const KEY = 'synthetic-consent-key-123456789';
let dir: string,
  keys: DesktopKeyStore,
  manager: ConnectionManager,
  h: Harness,
  now: string,
  effects: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'nexar-consent-'));
  now = '2026-10-17T12:00:00.000Z';
  effects = 'initial';
  const values = new Map<string, string>();
  let n = 0;
  keys = new DesktopKeyStore({
    userData: dir,
    encryption: {
      isEncryptionAvailable: () => true,
      getSelectedStorageBackend: () => 'gnome_libsecret',
      encryptString: (value) => {
        const id = `cipher-${++n}`;
        values.set(id, value);
        return Buffer.from(id);
      },
      decryptString: (value) => {
        const text = values.get(value.toString());
        if (text === undefined) throw Error('synthetic cipher');
        return text;
      },
    },
  });
  manager = new ConnectionManager({
    settingsStore: new SettingsStore(join(dir, 'settings.json')),
    keyStore: keys,
    now: () => now,
    affectedPins: () =>
      Promise.resolve({
        labels: ['Cowork control pin: Synthetic model'],
        fingerprint: effects,
      }),
  });
  h = await createHarness({ connectionManager: manager });
});
afterEach(async () => {
  await h.cleanup();
  await rm(dir, {
    recursive: true,
    force: true,
    maxRetries: 10,
    retryDelay: 50,
  });
});
async function add() {
  const res = await h.call<ConnectionDto>(CHANNELS.connectionAdd, {
    provider: 'openai',
    label: 'Synthetic account',
    apiKey: KEY,
  });
  if (!res.ok) throw Error('fixture Add');
  return res.value;
}
async function prepare(id: string, action: 'remove' | 'forget' | 'replace') {
  const res = await h.call<ConnectionConfirmation>(CHANNELS.connectionPrepare, {
    connectionId: id,
    action,
  });
  expect(res.ok).toBe(true);
  if (!res.ok) throw Error('fixture confirmation');
  return res.value;
}
describe('main-process consent and private connection IPC', () => {
  it('rejects missing, forged, wrong-target, wrong-action and replayed tickets', async () => {
    const a = await add(),
      b = await add();
    expect(
      (
        await h.call(CHANNELS.connectionForgetCredentials, {
          connectionId: a.id,
        })
      ).ok,
    ).toBe(false);
    expect(
      (
        await h.call(CHANNELS.connectionForgetCredentials, {
          connectionId: a.id,
          confirmation: '00000000-0000-4000-8000-000000000001',
          confirmationName: a.label,
        })
      ).ok,
    ).toBe(false);
    const wrongTarget = await prepare(a.id, 'forget');
    expect(
      (
        await h.call(CHANNELS.connectionForgetCredentials, {
          connectionId: b.id,
          confirmation: wrongTarget.token,
          confirmationName: b.label,
        })
      ).ok,
    ).toBe(false);
    const wrongAction = await prepare(a.id, 'remove');
    expect(
      (
        await h.call(CHANNELS.connectionForgetCredentials, {
          connectionId: a.id,
          confirmation: wrongAction.token,
          confirmationName: a.label,
        })
      ).ok,
    ).toBe(false);
    const ticket = await prepare(a.id, 'forget');
    const args = {
      connectionId: a.id,
      confirmation: ticket.token,
      confirmationName: a.label,
    };
    expect((await h.call(CHANNELS.connectionForgetCredentials, args)).ok).toBe(true);
    expect((await h.call(CHANNELS.connectionForgetCredentials, args)).ok).toBe(false);
    expect(manager.toDto((await manager.getConnection(b.id))!).hasCredential).toBe(true);
  });
  it('requires the selected connection name and rejects expiry or changed consequence/generation', async () => {
    const a = await add();
    const named = await prepare(a.id, 'forget');
    expect(
      (
        await h.call(CHANNELS.connectionForgetCredentials, {
          connectionId: a.id,
          confirmation: named.token,
          confirmationName: 'wrong account',
        })
      ).ok,
    ).toBe(false);
    const expired = await prepare(a.id, 'remove');
    now = '2026-10-17T12:03:00.000Z';
    expect(
      (
        await h.call(CHANNELS.connectionRemove, {
          connectionId: a.id,
          confirmation: expired.token,
        })
      ).ok,
    ).toBe(false);
    const changed = await prepare(a.id, 'remove');
    effects = 'new pin';
    expect(
      (
        await h.call(CHANNELS.connectionRemove, {
          connectionId: a.id,
          confirmation: changed.token,
        })
      ).ok,
    ).toBe(false);
    const stale = await prepare(a.id, 'forget');
    await manager.rotateCredential({
      connectionId: a.id,
      apiKey: KEY,
      sameAccount: true,
    });
    expect(
      (
        await h.call(CHANNELS.connectionForgetCredentials, {
          connectionId: a.id,
          confirmation: stale.token,
          confirmationName: a.label,
        })
      ).ok,
    ).toBe(false);
    expect(manager.toDto((await manager.getConnection(a.id))!).hasCredential).toBe(true);
  });
  it('preparation/cancellation performs no persistent mutation and returns only safe consequences', async () => {
    const a = await add(),
      before = await readFile(join(dir, 'settings.json'), 'utf8');
    const ticket = await prepare(a.id, 'remove');
    expect(ticket.affectedPins).toEqual(['Cowork control pin: Synthetic model']);
    expect(JSON.stringify(ticket)).not.toContain(KEY);
    expect(await readFile(join(dir, 'settings.json'), 'utf8')).toBe(before);
    expect((await manager.getConnection(a.id))?.credentialGeneration).toBe(1);
  });
  it('confirms Plan replacement against the exact current identity and forbids restoring its old ID', async () => {
    expect((await h.call(CHANNELS.chatgptPlanReplaceAccount)).ok).toBe(false);
    const ticket = await prepare('openai.chatgpt-plan', 'replace');
    expect(
      (
        await h.call(CHANNELS.chatgptPlanReplaceAccount, {
          connectionId: ticket.connectionId,
          confirmation: ticket.token,
        })
      ).ok,
    ).toBe(true);
    expect((await manager.currentPlan()).id).not.toBe(ticket.connectionId);
    expect(
      (
        await h.call(CHANNELS.connectionRestore, {
          connectionId: ticket.connectionId,
        })
      ).ok,
    ).toBe(false);
  });
  it('rejects unknown IDs, raw scopes, paths, subjects, unsupported providers, oversized and missing assertions with fixed secret-free errors', async () => {
    const a = await add();
    const cases: [string, unknown][] = [
      [CHANNELS.connectionPrepare, { connectionId: 'openai.api.caaaaaaaaaa', action: 'remove' }],
      [CHANNELS.connectionDisable, { connectionId: a.id, credentialScope: 'OPENAI_API_KEY' }],
      [CHANNELS.connectionEnable, { connectionId: '../../private' }],
      [CHANNELS.connectionRestore, { connectionId: a.id, subject: KEY }],
      [CHANNELS.connectionRotateKey, { connectionId: a.id, apiKey: KEY }],
      [CHANNELS.connectionRotateKey, { connectionId: a.id, apiKey: KEY, sameAccount: false }],
      [CHANNELS.connectionAdd, { provider: 'unsupported', label: 'fixture', apiKey: KEY }],
      [CHANNELS.connectionAdd, { provider: 'openai', label: 'fixture', apiKey: KEY.repeat(500) }],
      [CHANNELS.connectionList, { credentialName: 'OPENAI_API_KEY' }],
    ];
    for (const [channel, args] of cases) {
      const res = await h.call(channel, args);
      expect(res.ok).toBe(false);
      expect(JSON.stringify(res)).not.toContain(KEY);
    }
    expect(manager.toDto((await manager.getConnection(a.id))!).hasCredential).toBe(true);
  });
});
