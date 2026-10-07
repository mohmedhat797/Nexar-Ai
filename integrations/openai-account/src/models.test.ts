import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createOpenAiAccountModelClient } from './models.js';

const TOKEN = 'account-token-canary';
const CANARY = 'provider-error-secret-canary';
let url: string;
let body: unknown;
let status: number;
let requests: { url: string | undefined; authorization: string | undefined }[];
const server = createServer((request, response) => {
  requests.push({ url: request.url, authorization: request.headers.authorization });
  response.writeHead(status, {
    'content-type': 'application/json',
    ...(status === 302 ? { location: `${url}/redirect-target` } : {}),
  });
  response.end(JSON.stringify(body));
});
beforeAll(async () => {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  url = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
});
afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});
beforeEach(() => {
  requests = [];
  status = 200;
  body = { models: [] };
});
const toLocal: typeof fetch = (input, init) => {
  expect(input).toBe('https://api.openai.com/v1/models');
  expect(init).toMatchObject({ method: 'GET', redirect: 'error' });
  return fetch(`${url}/v1/models`, init);
};
const list = () =>
  createOpenAiAccountModelClient({ fetch: toLocal }).listModels({ accessToken: TOKEN });
const visible = (slug: string, display_name = slug) => ({ slug, display_name, visibility: 'list' });

describe('selected-account model catalog', () => {
  it('uses the selected bearer and returns ordered public fields only', async () => {
    body = {
      models: [
        visible('catalog-new-v7', 'New model'),
        { ...visible('hidden'), visibility: 'hide' },
        visible('older'),
        { visibility: 'hide', private: CANARY },
      ],
    };
    const models = await list();
    expect(models).toEqual([
      { slug: 'catalog-new-v7', displayName: 'New model' },
      { slug: 'older', displayName: 'older' },
    ]);
    expect(requests).toEqual([{ url: '/v1/models', authorization: `Bearer ${TOKEN}` }]);
    expect(JSON.stringify(models)).not.toContain(CANARY);
    expect(Object.isFrozen(models)).toBe(true);
  });
  it('accepts returned slugs beyond legacy resource-ID lengths and leaves unknown metadata absent', async () => {
    body = { models: [visible(`new/${'x'.repeat(160)}`, 'New model')] };
    expect(await list()).toHaveLength(1);
    expect(Object.keys((await list())[0] ?? {})).toEqual(['slug', 'displayName']);
  });
  it('returns an empty visible list without static fallback', async () => {
    expect(await list()).toEqual([]);
  });
  it.each([
    {},
    { data: [{ id: 'gpt-5.2' }] },
    { models: 'bad' },
    { models: [null] },
    { models: [visible('')] },
    { models: [visible('white space')] },
    { models: [visible('x'.repeat(201))] },
    { models: [visible('control\n')] },
    { models: [visible('valid', '')] },
    { models: [visible('valid', '\ncanary')] },
    { models: [visible('valid', 'x'.repeat(161))] },
    { models: [visible('same'), visible('same')] },
    { models: Array.from({ length: 257 }, (_, i) => visible(String(i))) },
  ])('fails closed on an incompatible catalog shape', async (invalid) => {
    body = invalid;
    await expect(list()).rejects.toMatchObject({
      code: 'PROVIDER_ERROR',
      details: { reason: 'malformed' },
    });
  });
  it.each([401, 403, 429, 500])(
    'keeps HTTP %i errors fixed and secret-free',
    async (httpStatus) => {
      status = httpStatus;
      body = { error: CANARY, token: TOKEN };
      const error = await list().catch((e: unknown) => e);
      expect(JSON.stringify(error)).not.toContain(CANARY);
      expect(JSON.stringify(error)).not.toContain(TOKEN);
      expect(error).toMatchObject({
        code: httpStatus === 401 ? 'AUTH_REQUIRED' : 'PROVIDER_ERROR',
      });
      expect(requests).toHaveLength(1);
    },
  );
  it.each([0, -1, 10_001, Infinity, NaN, 1.5])('rejects invalid deadline %s', (timeoutMs) => {
    expect(() => createOpenAiAccountModelClient({ timeoutMs })).toThrow(
      'The ChatGPT model catalog could not be loaded',
    );
  });
  it('bounds a fetch seam that never settles', async () => {
    const client = createOpenAiAccountModelClient({
      fetch: () => new Promise<Response>(() => undefined),
      timeoutMs: 30,
    });
    await expect(client.listModels({ accessToken: TOKEN })).rejects.toMatchObject({
      code: 'EXECUTION_TIMEOUT',
    });
  });
  it('bounds a stalled body and cancels it', async () => {
    const cancel = vi.fn();
    const client = createOpenAiAccountModelClient({
      fetch: () => Promise.resolve(new Response(new ReadableStream({ cancel }))),
      timeoutMs: 30,
    });
    await expect(client.listModels({ accessToken: TOKEN })).rejects.toMatchObject({
      code: 'EXECUTION_TIMEOUT',
    });
    expect(cancel).toHaveBeenCalledOnce();
  });
  it('never follows a redirect with the account bearer', async () => {
    status = 302;
    await expect(list()).rejects.toMatchObject({ code: 'PROVIDER_ERROR' });
    expect(requests).toHaveLength(1);
  });
  it('honors caller cancellation during a stalled body', async () => {
    const controller = new AbortController();
    let started: (() => void) | undefined;
    const bodyStarted = new Promise<void>((resolve) => {
      started = resolve;
    });
    const cancel = vi.fn();
    const client = createOpenAiAccountModelClient({
      fetch: () =>
        Promise.resolve(
          new Response(
            new ReadableStream({
              pull() {
                started?.();
              },
              cancel,
            }),
          ),
        ),
    });
    const pending = client.listModels({ accessToken: TOKEN, signal: controller.signal });
    await bodyStarted;
    controller.abort();
    await expect(pending).rejects.toMatchObject({ code: 'EXECUTION_CANCELLED' });
    expect(cancel).toHaveBeenCalledOnce();
  });
  it('honors an already aborted caller without a fetch', async () => {
    const doFetch = vi.fn<typeof fetch>();
    await expect(
      createOpenAiAccountModelClient({ fetch: doFetch }).listModels({
        accessToken: TOKEN,
        signal: AbortSignal.abort(),
      }),
    ).rejects.toMatchObject({ code: 'EXECUTION_CANCELLED' });
    expect(doFetch).not.toHaveBeenCalled();
  });
  it.each(['', `${TOKEN}\n`, 'x'.repeat(65_537)])(
    'refuses invalid bearer input without a fetch',
    async (accessToken) => {
      const doFetch = vi.fn<typeof fetch>();
      await expect(
        createOpenAiAccountModelClient({ fetch: doFetch }).listModels({ accessToken }),
      ).rejects.toMatchObject({ code: 'PROVIDER_ERROR' });
      expect(doFetch).not.toHaveBeenCalled();
    },
  );
  it('bounds declared and chunked response bytes', async () => {
    for (const response of [
      new Response('{}', { headers: { 'content-length': '65537' } }),
      new Response('x'.repeat(65_537)),
    ]) {
      await expect(
        createOpenAiAccountModelClient({ fetch: () => Promise.resolve(response) }).listModels({
          accessToken: TOKEN,
        }),
      ).rejects.toMatchObject({ details: { reason: 'oversize' } });
    }
  });
  it('normalizes malformed JSON and thrown network errors', async () => {
    for (const doFetch of [
      () => Promise.resolve(new Response(CANARY)),
      () => Promise.reject(new Error(`${CANARY} ${TOKEN}`)),
    ]) {
      const error = await createOpenAiAccountModelClient({ fetch: doFetch })
        .listModels({ accessToken: TOKEN })
        .catch((e: unknown) => e);
      expect(JSON.stringify(error)).not.toContain(CANARY);
      expect(JSON.stringify(error)).not.toContain(TOKEN);
    }
  });
});
