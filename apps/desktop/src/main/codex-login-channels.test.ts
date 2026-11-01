import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CHANNELS } from '../shared/channels.js';
import type {
  CodexLoginStatus,
  ConnectionConfirmation,
  ConnectionDto,
} from '../shared/connections.js';
import { CodexHomeStore } from './codex-home-store.js';
import { CodexLoginService } from './codex-login.js';
import { ConnectionManager } from './connection-manager.js';
import { DesktopKeyStore } from './desktop-key-store.js';
import { SettingsStore } from './settings-store.js';
import { createHarness, type Harness } from './test-harness.js';

let dir: string;
let h: Harness;
let signedIn: boolean;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'nexar-codex-channels-'));
  signedIn = false;
  const manager = new ConnectionManager({
    settingsStore: new SettingsStore(join(dir, 'desktop-settings.json')),
    keyStore: new DesktopKeyStore({
      userData: dir,
      encryption: {
        isEncryptionAvailable: () => true,
        getSelectedStorageBackend: () => 'gnome_libsecret',
        encryptString: (value: string) => Buffer.from(value),
        decryptString: (value: Buffer) => value.toString(),
      },
    }),
    codexHomes: new CodexHomeStore({ userData: dir }),
  });
  const codexLogin = new CodexLoginService({
    manager,
    runtime: () => ({
      probe: () =>
        Promise.resolve({
          status: signedIn ? 'connected' : 'not-connected',
          authMode: signedIn ? 'vendor-account' : 'none',
          loginSupported: true,
        }),
      login: () => {
        signedIn = true;
        return Promise.resolve('succeeded');
      },
    }),
  });
  h = await createHarness({ connectionManager: manager, codexLogin });
});

afterEach(async () => {
  await h.cleanup();
  await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

async function add(): Promise<ConnectionDto> {
  const added = await h.call<ConnectionDto>(CHANNELS.connectionCodexAdd, { label: 'Work' });
  if (!added.ok) throw new Error('fixture add');
  return added.value;
}

describe('owner Codex channels', () => {
  it('adds, signs in and deletes the home through the bridge', async () => {
    const { id } = await add();
    const started = await h.call<CodexLoginStatus>(CHANNELS.connectionCodexLogin, {
      connectionId: id,
    });
    expect(started).toEqual({ ok: true, value: { connectionId: id, loginState: 'running' } });
    await vi.waitFor(async () => {
      expect(
        await h.call<CodexLoginStatus>(CHANNELS.connectionCodexLoginStatus, { connectionId: id }),
      ).toEqual({ ok: true, value: { connectionId: id, loginState: 'succeeded' } });
    });
    const ticket = await h.call<ConnectionConfirmation>(CHANNELS.connectionPrepare, {
      connectionId: id,
      action: 'delete-home',
    });
    if (!ticket.ok) throw new Error('fixture ticket');
    expect(
      await h.call<ConnectionDto>(CHANNELS.connectionCodexDeleteHome, {
        connectionId: id,
        confirmation: ticket.value.token,
        confirmationName: 'Work',
      }),
    ).toMatchObject({ ok: true, value: { id, hasCredential: false } });
  });

  it('sends no home, marker or sign-in time to the renderer', async () => {
    const { id } = await add();
    await h.call(CHANNELS.connectionCodexLogin, { connectionId: id });
    const text = JSON.stringify([
      await add(),
      await h.call(CHANNELS.connectionList, {}),
      await h.call(CHANNELS.connectionCodexLoginStatus, { connectionId: id }),
    ]);
    expect(text).not.toMatch(/nativeHome|marker|signedInAt|runtime-homes/);
    expect(text).not.toContain(dir);
  });

  it.each([
    [CHANNELS.connectionCodexAdd, { label: 'Work', home: 'C:\\elsewhere' }],
    [CHANNELS.connectionCodexAdd, { label: '' }],
    [CHANNELS.connectionCodexLogin, { connectionId: '../escape' }],
    [CHANNELS.connectionCodexLogin, { connectionId: 'a', sameAccount: false }],
    [CHANNELS.connectionCodexLogin, { connectionId: 'a', home: 'C:\\elsewhere' }],
    [CHANNELS.connectionCodexLoginCancel, { connectionId: 'a', extra: 1 }],
    [CHANNELS.connectionCodexLoginStatus, {}],
    [CHANNELS.connectionCodexDeleteHome, { connectionId: 'a' }],
  ])('refuses a malformed request on %s', async (channel, args) => {
    expect(await h.call(channel, args)).toMatchObject({
      ok: false,
      error: { code: 'VALIDATION_ERROR' },
    });
  });

  it('refuses a second sign-in without the assertion, with no reason or path in the error', async () => {
    const { id } = await add();
    await h.call(CHANNELS.connectionCodexLogin, { connectionId: id });
    await vi.waitFor(() => {
      expect(signedIn).toBe(true);
    });
    await vi.waitFor(async () => {
      const refused = await h.call(CHANNELS.connectionCodexLogin, { connectionId: id });
      expect(refused).toMatchObject({ ok: false, error: { code: 'POLICY_REJECTED' } });
      expect(JSON.stringify(refused)).not.toContain(dir);
    });
  });
});
