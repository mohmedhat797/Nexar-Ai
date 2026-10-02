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
let api: NexarApi;
const CANARY = 'PRIVATE-ENDPOINT-CREDENTIAL-CANARY';
const input = { kind: 'ollama' as const, baseUrl: 'http://localhost:11434' };
const row = { id: 'server-fixture', ...input, enabled: true, modelCount: 2 };
beforeEach(async () => {
  vi.resetModules();
  electron.exposeInMainWorld.mockClear();
  electron.invoke.mockReset();
  await import('./preload.js');
  api = electron.exposeInMainWorld.mock.calls[0]![1] as NexarApi;
});

describe('local endpoint preload validation', () => {
  it('uses only fixed channels and strict credential-free DTOs', async () => {
    electron.invoke.mockResolvedValue({ ok: true, value: [row] });
    expect(await api.listLocalEndpoints()).toEqual({ ok: true, value: [row] });
    expect(electron.invoke).toHaveBeenLastCalledWith('providers:listLocalEndpoints', {});
    expect(await api.saveLocalEndpoint(input)).toEqual({ ok: true, value: [row] });
    expect(electron.invoke).toHaveBeenLastCalledWith('providers:saveLocalEndpoint', input);
    const edit = { ...input, id: row.id, baseUrl: 'http://localhost:11435' };
    await api.saveLocalEndpoint(edit);
    expect(electron.invoke).toHaveBeenLastCalledWith(CHANNELS.endpointsSave, edit);
    await api.removeLocalEndpoint(row.id);
    expect(electron.invoke).toHaveBeenLastCalledWith('providers:removeLocalEndpoint', {
      id: row.id,
    });
    await api.refreshLocalEndpoints();
    expect(electron.invoke).toHaveBeenLastCalledWith('providers:refreshLocalEndpoints', {});
    expect(Object.keys(api)).not.toContain('getEndpointCredential');
  });

  it.each([
    `http://${CANARY}:password@localhost:11434`,
    `http://localhost:11434?token=${CANARY}`,
    `http://localhost:11434#${CANARY}`,
    `http://localhost:11434/\n${CANARY}`,
    `http://localhost:11434/\0${CANARY}`,
    `file:///${CANARY}`,
    `ftp://localhost/${CANARY}`,
    'http://localhost:11434?',
    'http://localhost:11434#',
    `http://localhost/${'x'.repeat(2048)}`,
    ' http://localhost:11434',
    'http://localhost:11434 ',
    CANARY,
    '',
  ])('blocks unsafe address before IPC: %s', async (baseUrl) => {
    const result = await api.saveLocalEndpoint({ ...input, baseUrl });
    expect(result).toMatchObject({ ok: false, error: { code: 'VALIDATION_ERROR' } });
    expect(JSON.stringify(result)).not.toContain(CANARY);
    expect(electron.invoke).not.toHaveBeenCalled();
  });

  it.each([
    null,
    [],
    {},
    { ...input, secret: CANARY },
    { ...input, apiKey: CANARY },
    { ...input, headers: { Authorization: CANARY } },
    { ...input, enabled: false },
    { ...input, modelCount: 10 },
    { ...input, kind: CANARY },
    { ...input, id: CANARY },
    { ...input, id: '../state' },
    { ...input, id: 'x'.repeat(33) },
    { ...input, baseUrl: 11434 },
  ])('blocks unknown fields and malformed save requests', async (request) => {
    const result = await api.saveLocalEndpoint(request as never);
    expect(result).toMatchObject({ ok: false, error: { code: 'VALIDATION_ERROR' } });
    expect(JSON.stringify(result)).not.toContain(CANARY);
    expect(electron.invoke).not.toHaveBeenCalled();
  });

  it.each([CANARY, '', '../state', 'x'.repeat(33), null, {}, ['server-fixture']])(
    'blocks malformed remove id',
    async (id) => {
      const result = await api.removeLocalEndpoint(id as never);
      expect(result).toMatchObject({ ok: false, error: { code: 'VALIDATION_ERROR' } });
      expect(JSON.stringify(result)).not.toContain(CANARY);
      expect(electron.invoke).not.toHaveBeenCalled();
    },
  );

  it.each([
    { ok: true, value: [{ ...row, secret: CANARY }] },
    { ok: true, value: [{ ...row, ciphertext: CANARY }] },
    { ok: true, value: [{ ...row, headers: { Authorization: CANARY } }] },
    { ok: true, value: [{ ...row, baseUrl: `http://${CANARY}@localhost:11434` }] },
    { ok: true, value: [{ ...row, baseUrl: `http://localhost:11434?token=${CANARY}` }] },
    { ok: true, value: [{ ...row, id: CANARY }] },
    { ok: true, value: [{ ...row, modelCount: -1 }] },
    { ok: true, value: [{ ...row, modelCount: 201 }] },
    { ok: true, value: [{ ...row, modelCount: 1.5 }] },
    { ok: true, value: [{ ...row, enabled: 'true' }] },
    { ok: true, value: [row, row] },
    {
      ok: true,
      value: Array.from({ length: 33 }, (_, index) => ({ ...row, id: `fixture-${index}` })),
    },
    { ok: true, value: row },
    { ok: false, error: { code: 'CONFIGURATION_ERROR', message: CANARY } },
    { ok: false, error: { code: CANARY, message: 'Internal error' } },
    { ok: false, error: { code: 'INTERNAL_ERROR', message: 'Internal error', stack: CANARY } },
  ])('rejects unsafe main response across every endpoint method', async (response) => {
    electron.invoke.mockResolvedValue(response);
    for (const invoke of [
      () => api.listLocalEndpoints(),
      () => api.saveLocalEndpoint(input),
      () => api.removeLocalEndpoint(row.id),
      () => api.refreshLocalEndpoints(),
    ]) {
      const result = await invoke();
      expect(result.ok).toBe(false);
      expect(JSON.stringify(result)).not.toContain(CANARY);
    }
  });

  it('contains transport rejection messages for every endpoint method', async () => {
    electron.invoke.mockRejectedValue(new Error(CANARY));
    for (const invoke of [
      () => api.listLocalEndpoints(),
      () => api.saveLocalEndpoint(input),
      () => api.removeLocalEndpoint(row.id),
      () => api.refreshLocalEndpoints(),
    ]) {
      const result = await invoke();
      expect(result).toMatchObject({ ok: false, error: { code: 'INTERNAL_ERROR' } });
      expect(JSON.stringify(result)).not.toContain(CANARY);
    }
  });
});
