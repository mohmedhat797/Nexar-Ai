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
  lastFour: '7391',
  usableBy: ['pi', 'deepseek-harness'],
  modelCount: 2,
};
const SECRET = 'sk-nexar-preload-sentinel-secret-7391';
beforeEach(() => {
  electron.invoke.mockReset();
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
    expect(Object.keys(api)).not.toContain('saveKey');
  });

  it('never sends credential-like provider values over IPC', async () => {
    for (const value of [SECRET, null, {}, ['deepseek']]) {
      for (const method of [
        (provider: never) => api.saveProviderKeyFromClipboard(provider),
        (provider: never) => api.removeProviderKey(provider),
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
