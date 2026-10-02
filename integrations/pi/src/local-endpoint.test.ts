import { createServer } from 'node:http';
import type { IncomingMessage, Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { NexarError, taskId } from '@nexar/contracts';
import type { ExecutionContext, ExecutionRequest, Logger } from '@nexar/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PiExecutionAdapter, localEndpointDiscoverySource, piModelResource } from './index.js';

// A loopback-only OpenAI-compatible stub: exercises the real createProvider +
// openAICompletionsApi path with no external network.
let server: Server;
let baseUrl: string;
const seen: { method: string; path?: string; auth?: string; body?: Record<string, unknown> }[] = [];

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    let data = '';
    req.on('data', (chunk: Buffer) => (data += chunk.toString()));
    req.on('end', () => resolve(data));
  });
}

beforeAll(async () => {
  server = createServer((req, res) => {
    if (req.method === 'GET' && ['/v1/models', '/tenant/v1/models'].includes(req.url ?? '')) {
      seen.push({
        method: req.method,
        ...(req.url === undefined ? {} : { path: req.url }),
        ...(req.headers.authorization === undefined ? {} : { auth: req.headers.authorization }),
      });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ object: 'list', data: [{ id: 'tiny' }] }));
      return;
    }
    if (
      req.method !== 'POST' ||
      !['/v1/chat/completions', '/tenant/v1/chat/completions'].includes(req.url ?? '')
    ) {
      res.writeHead(404);
      res.end();
      return;
    }
    void readBody(req).then((raw) => {
      seen.push({
        method: req.method ?? '',
        ...(req.url === undefined ? {} : { path: req.url }),
        ...(req.headers.authorization === undefined ? {} : { auth: req.headers.authorization }),
        body: JSON.parse(raw) as Record<string, unknown>,
      });
      const chunk = (delta: object, finish: string | null, extra: object = {}) =>
        `data: ${JSON.stringify({
          id: 'c1',
          object: 'chat.completion.chunk',
          created: 1,
          model: 'tiny',
          choices: [{ index: 0, delta, finish_reason: finish }],
          ...extra,
        })}\n\n`;
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write(chunk({ role: 'assistant', content: 'local ' }, null));
      res.write(chunk({ content: 'answer' }, null));
      res.write(chunk({}, 'stop'));
      res.write(
        `data: ${JSON.stringify({
          id: 'c1',
          object: 'chat.completion.chunk',
          created: 1,
          model: 'tiny',
          choices: [],
          usage: { prompt_tokens: 7, completion_tokens: 2, total_tokens: 9 },
        })}\n\n`,
      );
      res.end('data: [DONE]\n\n');
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

const logger: Logger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  child: () => logger,
};

function request(resource: ExecutionRequest['resource']): ExecutionRequest {
  return {
    resource,
    task: {
      id: taskId('t-local'),
      kind: 'general',
      input: { prompt: 'hello local', systemPrompt: 'sys' },
      requirements: { capabilities: ['text-generation'] },
      origin: { source: 'test' },
      createdAt: '2026-01-01T00:00:00.000Z',
    },
  };
}

const context = (): ExecutionContext => ({ signal: new AbortController().signal, logger });

describe('local OpenAI-compatible endpoint (runtime.options.baseUrl)', () => {
  it.each([
    ['', '/v1'],
    ['/', '/v1'],
    ['/v1', '/v1'],
    ['/v1/', '/v1'],
    ['/tenant', '/tenant/v1'],
    ['/tenant/', '/tenant/v1'],
    ['/tenant/v1', '/tenant/v1'],
    ['/tenant/v1/', '/tenant/v1'],
  ])('discovers and executes through the same API prefix for %s', async (input, apiBase) => {
    const origin = new URL(baseUrl).origin;
    const before = seen.length;
    const [resource] = await localEndpointDiscoverySource({
      endpoints: [{ id: 'stub-local', kind: 'openai-compatible', baseUrl: `${origin}${input}` }],
    }).discover({ now: new Date(), signal: AbortSignal.timeout(5000) });
    expect(resource).toBeDefined();
    if (resource === undefined) throw new Error('Fake endpoint returned no resource');
    expect(resource.runtime.options).toEqual({ baseUrl: `${origin}${apiBase}` });
    expect(resource.auth).toEqual({ mode: 'none' });
    const result = await new PiExecutionAdapter({ env: {} }).execute(request(resource), context());
    expect(result.text).toBe('local answer');
    expect(result.resolved).toMatchObject({ provider: 'stub-local', model: 'tiny' });
    const calls = seen.slice(before);
    expect(calls.map(({ method, path }) => ({ method, path }))).toEqual([
      { method: 'GET', path: `${apiBase}/models` },
      { method: 'POST', path: `${apiBase}/chat/completions` },
    ]);
    expect(calls[0]?.auth).toBeUndefined();
    expect(calls[1]?.body?.model).toBe('tiny');
    expect(JSON.stringify(calls[1]?.body)).toContain('hello local');
  });

  it('executes against the configured baseUrl without an allowlist entry or key', async () => {
    const adapter = new PiExecutionAdapter({ env: {} });
    const resource = piModelResource({
      id: 'tiny',
      provider: 'stub-local',
      model: 'tiny',
      baseUrl,
    });

    const result = await adapter.execute(request(resource), context());

    expect(result.text).toBe('local answer');
    expect(result.resolved).toMatchObject({ provider: 'stub-local', model: 'tiny' });
    expect(result.usage.inputTokens).toEqual({ status: 'measured', value: 7 });
    expect(result.usage.outputTokens).toEqual({ status: 'measured', value: 2 });
    const call = seen.at(-1);
    expect(call?.path).toBe('/v1/chat/completions');
    expect(call?.body?.model).toBe('tiny');
    expect(JSON.stringify(call?.body)).toContain('hello local');
  });

  it('sends the env credential as a bearer token when one is configured', async () => {
    const adapter = new PiExecutionAdapter({ env: { LOCAL_KEY: 'local-secret' } });
    const resource = piModelResource({
      id: 'tiny-key',
      provider: 'stub-local',
      model: 'tiny',
      baseUrl,
      apiKeyEnv: 'LOCAL_KEY',
    });
    await adapter.execute(request(resource), context());
    expect(seen.at(-1)?.auth).toBe('Bearer local-secret');
  });

  it('surfaces connection failures as a NexarError, never a raw upstream error', async () => {
    const adapter = new PiExecutionAdapter({ env: {} });
    const resource = piModelResource({
      id: 'dead',
      provider: 'stub-local',
      model: 'tiny',
      baseUrl: 'http://127.0.0.1:1/v1',
    });
    await expect(adapter.execute(request(resource), context())).rejects.toBeInstanceOf(NexarError);
  });
});
