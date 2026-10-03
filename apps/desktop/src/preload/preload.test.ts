import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { NexarApi } from '../shared/api.js';
import { CHANNELS } from '../shared/channels.js';

const electron = vi.hoisted(() => ({
  exposeInMainWorld: vi.fn(),
  invoke: vi.fn(),
  on: vi.fn(),
  removeListener: vi.fn(),
}));
vi.mock('electron', () => ({
  contextBridge: { exposeInMainWorld: electron.exposeInMainWorld },
  ipcRenderer: electron,
}));
await import('./preload.js');
const api = electron.exposeInMainWorld.mock.calls[0]?.[1] as NexarApi;
const row = {
  provider: 'deepseek',
  method: 'api-key',
  status: 'saved',
  keyCheckStatus: 'unchecked',
  lastFour: '7391',
  usableBy: ['pi', 'deepseek-harness'],
  modelCount: 2,
  openWorkerSupported: true,
  openWorkerAllowed: false,
};
const SECRET = 'sk-nexar-preload-sentinel-secret-7391';
beforeEach(() => {
  electron.invoke.mockReset();
});

describe('subscription preload boundary', () => {
  const subscription = {
    runtime: 'codex',
    method: 'subscription',
    status: 'connected',
    authMode: 'vendor-account',
    loginSupported: true,
    loginState: 'idle',
    usableBy: 'codex',
    version: '1.2.3',
  };
  it('sends fixed runtime-only channels and validates normalized rows', async () => {
    electron.invoke.mockResolvedValue({ ok: true, value: [subscription] });
    expect(await api.listSubscriptions()).toEqual({ ok: true, value: [subscription] });
    expect(electron.invoke).toHaveBeenLastCalledWith(CHANNELS.subscriptionsList, {});
    electron.invoke.mockResolvedValue({ ok: true, value: subscription });
    for (const [method, channel] of [
      [(runtime: 'codex') => api.refreshSubscription(runtime), CHANNELS.subscriptionsRefresh],
      [(runtime: 'codex') => api.startSubscriptionLogin(runtime), CHANNELS.subscriptionsLogin],
      [(runtime: 'codex') => api.cancelSubscriptionLogin(runtime), CHANNELS.subscriptionsCancel],
    ] as const) {
      expect(await method('codex')).toEqual({ ok: true, value: subscription });
      expect(electron.invoke).toHaveBeenLastCalledWith(channel, { runtime: 'codex' });
    }
  });
  it('blocks malformed runtime inputs before IPC', async () => {
    for (const value of [SECRET, null, {}, ['codex']]) {
      for (const method of [
        (runtime: never) => api.refreshSubscription(runtime),
        (runtime: never) => api.startSubscriptionLogin(runtime),
        (runtime: never) => api.cancelSubscriptionLogin(runtime),
      ]) {
        expect(await method(value as never)).toMatchObject({ ok: false });
      }
    }
    expect(electron.invoke).not.toHaveBeenCalled();
  });
  it('contains raw outputs, paths, account identities and malformed main errors', async () => {
    for (const value of [
      { ...subscription, stdout: SECRET },
      { ...subscription, email: SECRET },
      { ...subscription, binary: SECRET },
      { ...subscription, version: SECRET },
      { ...subscription, usableBy: 'pi' },
      { ...subscription, authMode: 'api-key' },
      { ...subscription, runtime: 'claude-code', usableBy: 'claude-code' },
    ]) {
      electron.invoke.mockResolvedValue({ ok: true, value });
      const result = await api.refreshSubscription('codex');
      expect(result.ok).toBe(false);
      expect(JSON.stringify(result)).not.toContain(SECRET);
    }
    electron.invoke.mockRejectedValue(new Error(SECRET));
    expect(JSON.stringify(await api.startSubscriptionLogin('codex'))).not.toContain(SECRET);
  });
});

describe('provider preload boundary', () => {
  it('sends only fixed channels and provider ids and validates safe metadata', async () => {
    electron.invoke.mockResolvedValue({ ok: true, value: [row] });
    expect(await api.listProviders()).toEqual({ ok: true, value: [row] });
    expect(electron.invoke).toHaveBeenLastCalledWith(CHANNELS.providersList, {});
    electron.invoke.mockResolvedValue({ ok: true, value: row });
    expect(await api.saveProviderKeyFromClipboard('deepseek')).toEqual({ ok: true, value: row });
    expect(electron.invoke).toHaveBeenLastCalledWith(CHANNELS.providersSaveKeyFromClipboard, {
      provider: 'deepseek',
    });
    await api.removeProviderKey('deepseek');
    expect(electron.invoke).toHaveBeenLastCalledWith(CHANNELS.providersRemoveKey, {
      provider: 'deepseek',
    });
    expect(Object.keys(api)).not.toContain('getKey');
    await api.checkProviderKey('deepseek');
    expect(electron.invoke).toHaveBeenLastCalledWith(CHANNELS.providersCheckKey, {
      provider: 'deepseek',
    });
    expect(Object.keys(api)).not.toContain('saveKey');
  });

  it('never sends credential-like provider values over IPC', async () => {
    for (const value of [SECRET, null, {}, ['deepseek']]) {
      for (const method of [
        (provider: never) => api.saveProviderKeyFromClipboard(provider),
        (provider: never) => api.removeProviderKey(provider),
        (provider: never) => api.checkProviderKey(provider),
      ]) {
        const result = await method(value as never);
        expect(result.ok).toBe(false);
        expect(JSON.stringify(result)).not.toContain(SECRET);
      }
    }
    expect(electron.invoke).not.toHaveBeenCalled();
  });

  it('contains plaintext, ciphertext, unknown fields and credential-bearing errors returned by main', async () => {
    for (const value of [
      { ok: true, value: [{ ...row, secret: SECRET }] },
      { ok: true, value: [{ ...row, ciphertext: SECRET }] },
      { ok: true, value: [{ ...row, lastFour: SECRET }] },
      { ok: false, error: { code: 'AUTH_REQUIRED', message: SECRET } },
      { ok: false, error: { code: SECRET, message: 'Internal error' } },
      { ok: false, error: { code: 'AUTH_REQUIRED', message: 'Internal error', key: SECRET } },
    ]) {
      electron.invoke.mockResolvedValue(value);
      const result = await api.listProviders();
      expect(result.ok).toBe(false);
      expect(JSON.stringify(result)).not.toContain(SECRET);
    }
  });

  it('contains transport rejection details', async () => {
    electron.invoke.mockRejectedValue(new Error(SECRET));
    const result = await api.listProviders();
    expect(result.ok).toBe(false);
    expect(JSON.stringify(result)).not.toContain(SECRET);
  });
});
