import { createServer, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { NexarError, type DiscoveryContext } from '@nexar/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { localEndpointDiscoverySource, piCatalogDiscoverySource } from './index.js';
import type { CatalogModel } from './pi-models.js';

const ctx = (): DiscoveryContext => ({ now: new Date(), signal: AbortSignal.timeout(5000) });

const model = (id: string, input = 3, output = 15, contextWindow = 200_000): CatalogModel => ({
  id,
  contextWindow,
  maxTokens: 8192,
  inputPerMillionTokens: input,
  outputPerMillionTokens: output,
});

describe('piCatalogDiscoverySource', () => {
  it('fails closed without an owner provider list or with a provider outside the allowlist', async () => {
    const none = piCatalogDiscoverySource({ providers: [], listModels: () => Promise.resolve([]) });
    await expect(none.discover(ctx())).rejects.toMatchObject({ code: 'CONFIGURATION_ERROR' });
    const outside = piCatalogDiscoverySource({
      providers: ['anthropic', 'evil-corp'],
      listModels: () => Promise.resolve([]),
    });
    await expect(outside.discover(ctx())).rejects.toBeInstanceOf(NexarError);
    await expect(outside.discover(ctx())).rejects.toMatchObject({ code: 'POLICY_REJECTED' });
  });

  it('builds catalog descriptors: slug ids, env references only, catalog rates, limits', async () => {
    const source = piCatalogDiscoverySource({
      providers: ['openrouter'],
      listModels: () =>
        Promise.resolve([
          model('openai/GPT-4o', 2.5, 10, 128_000),
          model('free/model', 0, 0),
          model('openai/gpt 4o', 1, 1), // collides with the first after slugging; sorts after it
        ]),
    });
    const found = await source.discover(ctx());
    expect(found.map((d) => d.id)).toEqual([
      'pi.openrouter.free-model',
      'pi.openrouter.openai-gpt-4o',
    ]);
    const [free, gpt] = found;
    // 0/0 catalog rates cannot be told apart from "unknown".
    expect(free?.cost).toEqual({ model: 'unknown' });
    expect(free?.capabilities).toContain('long-context');
    expect(gpt?.cost).toEqual({
      model: 'per-token',
      currency: 'USD',
      inputPerMillionTokens: 2.5,
      outputPerMillionTokens: 10,
    });
    expect(gpt?.capabilities).not.toContain('long-context');
    expect(gpt?.limits).toEqual({ contextWindowTokens: 128_000, maxOutputTokens: 8192 });
    expect(gpt?.metadata).toEqual({ rates: 'catalog' });
    expect(gpt?.auth).toEqual({
      mode: 'api-key',
      credential: { source: 'env', name: 'OPENROUTER_API_KEY' },
    });
    expect(gpt?.kind).toMatchObject({
      type: 'model',
      provider: 'openrouter',
      model: 'openai/GPT-4o',
    });
  });

  it('caps the number of models per provider deterministically', async () => {
    const source = piCatalogDiscoverySource({
      providers: ['openai'],
      maxModels: 2,
      listModels: () => Promise.resolve([model('c'), model('a'), model('b')]),
    });
    expect((await source.discover(ctx())).map((d) => d.id)).toEqual(['pi.openai.a', 'pi.openai.b']);
  });

  it('reads the pinned static catalog offline', async () => {
    const found = await piCatalogDiscoverySource({
      providers: ['anthropic'],
      maxModels: 3,
    }).discover(ctx());
    expect(found.length).toBeGreaterThan(0);
    for (const d of found) {
      expect(d.id).toMatch(/^pi\.anthropic\./);
      expect(d.auth).toEqual({
        mode: 'api-key',
        credential: { source: 'env', name: 'ANTHROPIC_API_KEY' },
      });
    }
  });
});

describe('localEndpointDiscoverySource', () => {
  let server: Server;
  let base: string;
  const routes: Record<string, (res: ServerResponse) => void> = {
    '/ollama/api/tags': (res) =>
      json(res, { models: [{ name: 'llama3:8b' }, { name: 'qwen2.5' }, { name: '\u0001bad' }] }),
    '/oai/v1/models': (res) => json(res, { object: 'list', data: [{ id: 'local-model' }] }),
    '/redirect/api/tags': (res) => {
      res.writeHead(302, { location: 'http://example.invalid/api/tags' });
      res.end();
    },
    '/huge/api/tags': (res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ models: [{ name: 'x'.repeat(2 * 1024 * 1024) }] }));
    },
    '/broken/api/tags': (res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{not json');
    },
  };
  const seen: string[] = [];

  function json(res: ServerResponse, body: unknown): void {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
  }

  beforeAll(async () => {
    server = createServer((req, res) => {
      seen.push(`${req.method ?? ''} ${req.url ?? ''} auth=${req.headers.authorization ?? '-'}`);
      const route = routes[req.url ?? ''];
      if (route === undefined) {
        res.writeHead(404);
        res.end();
      } else {
        route(res);
      }
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
  });
  afterAll(async () => {
    await new Promise((r) => server.close(r));
  });

  it('lists Ollama and OpenAI-compatible models as local-compute resources', async () => {
    const found = await localEndpointDiscoverySource({
      endpoints: [
        { id: 'ollama', kind: 'ollama', baseUrl: `${base}/ollama/` },
        { id: 'lab', kind: 'openai-compatible', baseUrl: `${base}/oai` },
      ],
    }).discover(ctx());
    expect(found.map((d) => d.id)).toEqual([
      'local.lab.local-model',
      'local.ollama.llama3:8b',
      'local.ollama.qwen2.5',
    ]);
    const llama = found[1];
    expect(llama?.cost).toEqual({ model: 'local-compute' });
    expect(llama?.dataLocality).toBe('local');
    expect(llama?.auth).toEqual({ mode: 'none' });
    expect(llama?.runtime.options).toEqual({ baseUrl: `${base}/ollama/v1` });
    expect(seen.every((s) => s.startsWith('GET ') && s.endsWith('auth=-'))).toBe(true);
  });

  it('refuses redirects, oversize bodies and malformed JSON', async () => {
    for (const path of ['redirect', 'huge', 'broken']) {
      const source = localEndpointDiscoverySource({
        endpoints: [{ id: path, kind: 'ollama', baseUrl: `${base}/${path}` }],
      });
      await expect(source.discover(ctx())).rejects.toMatchObject({
        code: 'INTEGRATION_UNAVAILABLE',
      });
    }
  });

  it('skips a failing endpoint while another succeeds', async () => {
    const found = await localEndpointDiscoverySource({
      endpoints: [
        { id: 'broken', kind: 'ollama', baseUrl: `${base}/broken` },
        { id: 'lab', kind: 'openai-compatible', baseUrl: `${base}/oai` },
      ],
    }).discover(ctx());
    expect(found.map((d) => d.id)).toEqual(['local.lab.local-model']);
  });

  it('rejects non-http URLs, URLs with credentials and invalid ids before any request', async () => {
    const before = seen.length;
    for (const endpoint of [
      { id: 'f', kind: 'ollama' as const, baseUrl: 'file:///etc/passwd' },
      { id: 'u', kind: 'ollama' as const, baseUrl: `http://user:pw@127.0.0.1:1` },
      { id: 'Bad Id', kind: 'ollama' as const, baseUrl: base },
    ]) {
      await expect(
        localEndpointDiscoverySource({ endpoints: [endpoint] }).discover(ctx()),
      ).rejects.toMatchObject({ code: 'CONFIGURATION_ERROR' });
    }
    expect(seen.length).toBe(before);
  });

  it('marks a non-loopback endpoint as unknown cost and third-party', async () => {
    const fake: typeof fetch = () =>
      Promise.resolve(new Response(JSON.stringify({ data: [{ id: 'm' }] }), { status: 200 }));
    const [d] = await localEndpointDiscoverySource({
      endpoints: [{ id: 'gpu', kind: 'openai-compatible', baseUrl: 'http://gpu-box.lan:8000' }],
      fetch: fake,
    }).discover(ctx());
    expect(d?.cost).toEqual({ model: 'unknown' });
    expect(d?.dataLocality).toBe('third-party');
  });
});
