import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { checkProviderApiKey } from './key-check.js';

const KEY = 'synthetic-not-a-live-api-key-1234';
const servers: Server[] = [];

interface Seen {
  readonly method: string | undefined;
  readonly path: string | undefined;
  readonly headers: IncomingMessage['headers'];
}

async function localServer(handler: (req: IncomingMessage, res: ServerResponse) => void): Promise<{
  readonly origin: string;
  readonly seen: Seen[];
}> {
  const seen: Seen[] = [];
  const server = createServer((req, res) => {
    seen.push({ method: req.method, path: req.url, headers: req.headers });
    handler(req, res);
  });
  servers.push(server);
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  return { origin: `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`, seen };
}

afterEach(async () => {
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise<void>((done, fail) =>
      server.close((error) => (error ? fail(error) : done())),
    );
  }
});

/** Translate only the test transport; production receives its fixed official URL unchanged. */
function transport(origin: string): {
  fetch: typeof fetch;
  calls: { url: string; init: RequestInit | undefined }[];
} {
  const calls: { url: string; init: RequestInit | undefined }[] = [];
  const localFetch: typeof fetch = (input, init) => {
    const url = input instanceof Request ? input.url : String(input);
    calls.push({ url, init });
    const fixed = new URL(url);
    return fetch(`${origin}${fixed.pathname}${fixed.search}`, init);
  };
  return { fetch: localFetch, calls };
}

function json(res: ServerResponse, value: unknown, status = 200): void {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(value));
}

const providers = [
  {
    provider: 'anthropic',
    url: 'https://api.anthropic.com/v1/models',
    header: 'x-api-key',
    body: { data: [{ id: 'model-a' }] },
  },
  {
    provider: 'openai',
    url: 'https://api.openai.com/v1/models',
    header: 'authorization',
    body: { data: [{ id: 'model-a' }] },
  },
  {
    provider: 'google',
    url: 'https://generativelanguage.googleapis.com/v1beta/models',
    header: 'x-goog-api-key',
    body: { models: [{ name: 'models/model-a' }] },
  },
  {
    provider: 'deepseek',
    url: 'https://api.deepseek.com/models',
    header: 'authorization',
    body: { data: [{ id: 'model-a' }] },
  },
  {
    provider: 'openrouter',
    url: 'https://openrouter.ai/api/v1/key',
    header: 'authorization',
    body: { data: { label: 'owner' } },
  },
  {
    provider: 'groq',
    url: 'https://api.groq.com/openai/v1/models',
    header: 'authorization',
    body: { data: [{ id: 'model-a' }] },
  },
  {
    provider: 'mistral',
    url: 'https://api.mistral.ai/v1/models',
    header: 'authorization',
    body: { data: [{ id: 'model-a' }] },
  },
  {
    provider: 'xai',
    url: 'https://api.x.ai/v1/models',
    header: 'authorization',
    body: { data: [{ id: 'model-a' }] },
  },
] as const;

describe('documented non-generating provider key checks', () => {
  it.each(providers)(
    '$provider uses one fixed GET endpoint and keeps the key in its auth header',
    async (entry) => {
      const server = await localServer((_req, res) => json(res, entry.body));
      const mocked = transport(server.origin);
      const result = await checkProviderApiKey(entry.provider, KEY, { fetch: mocked.fetch });
      expect(result).toEqual(
        entry.provider === 'openrouter' ? { status: 'valid' } : { status: 'valid', modelCount: 1 },
      );
      expect(mocked.calls).toHaveLength(1);
      expect(mocked.calls[0]?.url).toBe(entry.url);
      expect(mocked.calls[0]?.url).not.toContain(KEY);
      expect(mocked.calls[0]?.init?.redirect).toBe('manual');
      expect(mocked.calls[0]?.init?.body).toBeUndefined();
      expect(server.seen).toHaveLength(1);
      expect(server.seen[0]?.method).toBe('GET');
      const headers = new Headers(mocked.calls[0]?.init?.headers);
      expect(headers.get(entry.header)).toBe(
        entry.header === 'authorization' ? `Bearer ${KEY}` : KEY,
      );
      expect(server.seen[0]?.headers[entry.header]).toBe(
        entry.header === 'authorization' ? `Bearer ${KEY}` : KEY,
      );
      if (entry.provider === 'anthropic')
        expect(headers.get('anthropic-version')).toBe('2023-06-01');
      expect(JSON.stringify(result)).not.toContain(KEY);
      expect(JSON.stringify(result)).not.toContain('model-a');
    },
  );

  it('counts an empty model catalog as accessible without implying model access', async () => {
    const server = await localServer((_req, res) => json(res, { data: [] }));
    const mocked = transport(server.origin);
    expect(await checkProviderApiKey('openai', KEY, { fetch: mocked.fetch })).toEqual({
      status: 'valid',
      modelCount: 0,
    });
  });

  it('does not follow pagination hints or request additional catalog pages', async () => {
    const server = await localServer((_req, res) =>
      json(res, {
        data: [{ id: 'first-page-model' }],
        has_more: true,
        next_page: `https://private.invalid/${KEY}`,
      }),
    );
    const mocked = transport(server.origin);
    expect(await checkProviderApiKey('openai', KEY, { fetch: mocked.fetch })).toEqual({
      status: 'valid',
      modelCount: 1,
    });
    expect(mocked.calls).toHaveLength(1);
    expect(server.seen).toHaveLength(1);
  });

  it.each([401, 400, 402, 403, 404, 429, 500, 502, 503])(
    'classifies HTTP %s without returning the upstream body',
    async (status) => {
      const secretBody = `${KEY}-private-upstream-message`;
      const server = await localServer((_req, res) => json(res, { error: secretBody }, status));
      const mocked = transport(server.origin);
      const result = await checkProviderApiKey('openai', KEY, { fetch: mocked.fetch });
      expect(result).toEqual({ status: status === 401 ? 'invalid' : 'unavailable' });
      expect(mocked.calls).toHaveLength(1);
      expect(JSON.stringify(result)).not.toContain(KEY);
      expect(JSON.stringify(result)).not.toContain(secretBody);
    },
  );

  it.each([undefined, '', 'short', ` ${KEY}`, `${KEY}\n`, `${KEY}/`, 'a'.repeat(4097)])(
    'does not request a missing or locally invalid key',
    async (key) => {
      const fetchMock = vi.fn<typeof fetch>(() => Promise.reject(new Error('must not request')));
      expect(await checkProviderApiKey('openai', key, { fetch: fetchMock })).toEqual({
        status: 'unchecked',
      });
      expect(fetchMock).not.toHaveBeenCalled();
    },
  );

  it.each(['unknown', 'OPENAI', '__proto__', 'https://attacker.invalid', 'openai/../models'])(
    'does not request unsupported provider %s',
    async (provider) => {
      const fetchMock = vi.fn<typeof fetch>(() => Promise.reject(new Error('must not request')));
      expect(await checkProviderApiKey(provider, KEY, { fetch: fetchMock })).toEqual({
        status: 'unchecked',
      });
      expect(fetchMock).not.toHaveBeenCalled();
    },
  );
});

describe('bounded, safe HTTP behavior', () => {
  it.each([0, -1, 1.5, NaN, Infinity, 10_001])(
    'rejects unsafe deadline %s before requesting',
    async (timeoutMs) => {
      const fetchMock = vi.fn<typeof fetch>(() => Promise.reject(new Error('must not request')));
      expect(await checkProviderApiKey('openai', KEY, { fetch: fetchMock, timeoutMs })).toEqual({
        status: 'unavailable',
      });
      expect(fetchMock).not.toHaveBeenCalled();
    },
  );

  it.each(['headers', 'body'])(
    'times out while %s are stalled and returns only unavailable',
    async (phase) => {
      const server = await localServer((_req, res) => {
        if (phase === 'body') {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.flushHeaders();
          res.write('{"data":[');
        }
        // Intentionally leave the response open; afterEach terminates remaining sockets.
      });
      const mocked = transport(server.origin);
      expect(
        await checkProviderApiKey('openai', KEY, { fetch: mocked.fetch, timeoutMs: 200 }),
      ).toEqual({ status: 'unavailable' });
      expect(mocked.calls).toHaveLength(1);
      expect(mocked.calls[0]?.init?.signal?.aborted).toBe(true);
    },
  );

  it('honors an already-aborted caller signal without a request', async () => {
    const controller = new AbortController();
    controller.abort(new Error(KEY));
    const fetchMock = vi.fn<typeof fetch>(() => Promise.reject(new Error('must not request')));
    expect(
      await checkProviderApiKey('openai', KEY, { fetch: fetchMock, signal: controller.signal }),
    ).toEqual({ status: 'unavailable' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('honors caller abort during a response body without exposing its reason', async () => {
    let entered = (): void => undefined;
    const bodyStarted = new Promise<void>((done) => {
      entered = done;
    });
    const server = await localServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.flushHeaders();
      res.write('{"data":[');
      entered();
    });
    const controller = new AbortController();
    const mocked = transport(server.origin);
    const pending = checkProviderApiKey('openai', KEY, {
      fetch: mocked.fetch,
      signal: controller.signal,
      timeoutMs: 2_000,
    });
    await bodyStarted;
    controller.abort(new Error(KEY));
    expect(await pending).toEqual({ status: 'unavailable' });
    expect(mocked.calls).toHaveLength(1);
  });

  it('does not follow a redirect or send a key to its target', async () => {
    const target = await localServer((_req, res) => json(res, { data: [{ id: 'redirected' }] }));
    const source = await localServer((_req, res) => {
      res.writeHead(302, { location: `${target.origin}/capture` });
      res.end();
    });
    const mocked = transport(source.origin);
    expect(await checkProviderApiKey('openai', KEY, { fetch: mocked.fetch })).toEqual({
      status: 'unavailable',
    });
    expect(source.seen).toHaveLength(1);
    expect(target.seen).toEqual([]);
    expect(mocked.calls).toHaveLength(1);
  });

  it('refuses an oversized Content-Length without reading the response body', async () => {
    const server = await localServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json', 'content-length': 65_537 });
      res.flushHeaders();
      // No body: accepting the header would hang until the deadline.
    });
    const mocked = transport(server.origin);
    expect(
      await checkProviderApiKey('openai', KEY, { fetch: mocked.fetch, timeoutMs: 1_000 }),
    ).toEqual({ status: 'unavailable' });
    expect(mocked.calls).toHaveLength(1);
    expect(mocked.calls[0]?.init?.signal?.aborted).toBe(false);
  });

  it.each(['x'.repeat(70_000), '🧠'.repeat(18_000)])(
    'caps actual chunked bytes even without Content-Length',
    async (padding) => {
      const server = await localServer((_req, res) => {
        const validButLarge = JSON.stringify({ data: [{ id: 'large-model', padding }] });
        res.writeHead(200, { 'content-type': 'application/json' });
        res.write(validButLarge.slice(0, 40_000));
        res.end(validButLarge.slice(40_000));
      });
      const mocked = transport(server.origin);
      expect(await checkProviderApiKey('openai', KEY, { fetch: mocked.fetch })).toEqual({
        status: 'unavailable',
      });
      expect(mocked.calls).toHaveLength(1);
    },
  );

  it.each([
    '{broken',
    'null',
    '[]',
    '{"data":{}}',
    '{"data":[null]}',
    '{"data":[{}]}',
    '{"data":[{"id":""}]}',
    '{"data":[{"id":42}]}',
    '{"models":[]}',
  ])('refuses malformed JSON or unsafe models shape %s', async (body) => {
    const server = await localServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(body);
    });
    const mocked = transport(server.origin);
    expect(await checkProviderApiKey('openai', KEY, { fetch: mocked.fetch })).toEqual({
      status: 'unavailable',
    });
  });

  it.each([{}, { data: [] }, { data: null }, { data: KEY }])(
    'requires an OpenRouter key-info data object',
    async (body) => {
      const server = await localServer((_req, res) => json(res, body));
      const mocked = transport(server.origin);
      expect(await checkProviderApiKey('openrouter', KEY, { fetch: mocked.fetch })).toEqual({
        status: 'unavailable',
      });
    },
  );

  it('never exposes fetch exceptions, keys or URLs', async () => {
    const fetchMock = vi.fn<typeof fetch>(() =>
      Promise.reject(new Error(`${KEY} https://private.invalid/owner`)),
    );
    const result = await checkProviderApiKey('openai', KEY, { fetch: fetchMock });
    expect(result).toEqual({ status: 'unavailable' });
    expect(JSON.stringify(result)).not.toContain(KEY);
    expect(JSON.stringify(result)).not.toContain('private.invalid');
    expect(fetchMock).toHaveBeenCalledOnce();
  });
});
