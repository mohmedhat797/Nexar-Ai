import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { request, type Server } from 'node:http';
import { createServer, type Server as NetServer } from 'node:net';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { build } from 'esbuild';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { BridgeHost } from '../main/bridge-host.js';
import { createFakeControl, okTurn, silentLogger } from '../main/control-test-kit.js';
import { createControlGatewayServer } from './server.js';

const SENTINEL = 'SENTINEL-prompt-and-args';
const TOKEN = 'tok-0123456789abcdef';

type Frame = { v: number; id: string; token: string; op: string; turn: Record<string, unknown> };
type Answer = { ok: true; value: unknown } | { ok: false; code: string };

const result = (patch: Record<string, unknown> = {}): Answer => ({
  ok: true,
  value: {
    text: 'hi there',
    toolCalls: [],
    finishReason: 'stop',
    usage: {
      inputTokens: { status: 'measured', value: 11 },
      outputTokens: { status: 'measured', value: 7 },
    },
    resourceId: 'res-a',
    ...patch,
  },
});

/** An in-process stand-in for the Desktop bridge endpoint: records frames, answers from `answer`. */
class FakeEndpoint {
  readonly frames: Frame[] = [];
  answer: (frame: Frame) => Answer | Promise<Answer> = () => result();
  private readonly server: NetServer;
  private constructor(
    readonly path: string,
    server: NetServer,
  ) {
    this.server = server;
  }

  static async start(dir: string): Promise<FakeEndpoint> {
    const path =
      process.platform === 'win32'
        ? `\\\\.\\pipe\\nexar-ctl-test-${randomUUID()}`
        : join(dir, 'bridge.sock');
    // eslint-disable-next-line prefer-const -- the connection handler needs the instance
    let endpoint: FakeEndpoint;
    const server = createServer((socket) => {
      let buffered = '';
      socket.setEncoding('utf8');
      socket.on('error', () => undefined);
      socket.on('data', (chunk: string) => {
        buffered += chunk;
        for (let i = buffered.indexOf('\n'); i !== -1; i = buffered.indexOf('\n')) {
          const frame = JSON.parse(buffered.slice(0, i)) as Frame;
          buffered = buffered.slice(i + 1);
          endpoint.frames.push(frame);
          void Promise.resolve(endpoint.answer(frame)).then((answer) => {
            if (!socket.destroyed) socket.write(`${JSON.stringify({ id: frame.id, ...answer })}\n`);
          });
        }
      });
    });
    endpoint = new FakeEndpoint(path, server);
    await new Promise<void>((resolve) => server.listen(path, resolve));
    return endpoint;
  }

  stop(): Promise<void> {
    return new Promise((resolve) => this.server.close(() => resolve()));
  }
}

interface Reply {
  readonly status: number;
  readonly headers: Record<string, string | string[] | undefined>;
  readonly text: string;
}

function http(
  port: number,
  options: {
    method?: string;
    path: string;
    headers?: Record<string, string>;
    body?: string;
  },
): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const req = request(
      {
        host: '127.0.0.1',
        port,
        method: options.method ?? 'GET',
        path: options.path,
        headers: options.headers,
        // A fresh connection per request keeps the cases independent.
        agent: false,
      },
      (res) => {
        let text = '';
        res.setEncoding('utf8');
        res.on('data', (chunk: string) => (text += chunk));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, text }));
      },
    );
    req.on('error', reject);
    req.end(options.body);
  });
}

const chat = (
  port: number,
  body: unknown,
  headers: Record<string, string> = { authorization: `Bearer ${TOKEN}` },
): Promise<Reply> => {
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  return http(port, {
    method: 'POST',
    path: '/v1/chat/completions',
    headers: { 'content-type': 'application/json', ...headers },
    body: text,
  });
};

/** The request a real OpenAI SDK sends in Chat Completions mode. */
const sdkRequest = (patch: Record<string, unknown> = {}): Record<string, unknown> => ({
  model: 'nexar-control',
  messages: [
    { role: 'system', content: 'You are helpful.' },
    { role: 'user', content: [{ type: 'text', text: SENTINEL }] },
  ],
  max_tokens: 256,
  temperature: 0.2,
  reasoning_effort: 'medium',
  ...patch,
});

interface Body {
  id: string;
  object: string;
  choices: {
    finish_reason: string | null;
    message: { content: string | null; tool_calls?: unknown[] };
    delta: { tool_calls?: unknown };
  }[];
  usage?: unknown;
  error: { type: string; code: string };
}
const json = (reply: Reply): Body => JSON.parse(reply.text) as Body;

function sseEvents(text: string): string[] {
  return text
    .split('\n\n')
    .filter((e) => e !== '')
    .map((e) => e.replace(/^data: /, ''));
}

describe('control gateway translator', () => {
  let dir: string;
  let script: string;
  let endpoint: FakeEndpoint;
  let child: ChildProcess | undefined;
  let port: number;

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'nexar-control-gateway-'));
    script = join(dir, 'control-gateway.cjs');
    await build({
      entryPoints: [fileURLToPath(new URL('./main.ts', import.meta.url))],
      outfile: script,
      bundle: true,
      platform: 'node',
      format: 'cjs',
      target: 'node22',
      logLevel: 'silent',
    });
  }, 60_000);
  afterAll(() => rm(dir, { recursive: true, force: true }));

  async function launch(endpointPath: string): Promise<{ child: ChildProcess; port: number }> {
    const proc = spawn(process.execPath, [script], {
      stdio: ['pipe', 'pipe', 'ignore'],
      env: { ELECTRON_RUN_AS_NODE: '1' },
    });
    proc.stdin?.on('error', () => undefined);
    proc.stdin?.write(`${JSON.stringify({ endpoint: endpointPath })}\n`);
    const line = await new Promise<string>((resolve, reject) => {
      let buffered = '';
      proc.stdout?.on('data', (chunk: Buffer) => {
        buffered += chunk.toString();
        if (buffered.includes('\n')) resolve(buffered.split('\n')[0] ?? '');
      });
      proc.once('exit', () => reject(new Error('child exited early')));
    });
    return { child: proc, port: (JSON.parse(line) as { port: number }).port };
  }

  beforeAll(async () => {
    endpoint = await FakeEndpoint.start(dir);
    ({ child, port } = await launch(endpoint.path));
  }, 30_000);
  afterAll(async () => {
    child?.stdin?.end();
    child?.kill();
    await endpoint.stop();
  });
  afterEach(() => {
    endpoint.frames.length = 0;
    endpoint.answer = () => result();
  });

  it('lists the one model', async () => {
    const reply = await http(port, { path: '/v1/models' });
    expect(reply.status).toBe(200);
    expect(json(reply)).toEqual({
      object: 'list',
      data: [{ id: 'nexar-control', object: 'model' }],
    });
  });

  it('answers 404 elsewhere and sends no CORS headers', async () => {
    for (const reply of [
      await http(port, { path: '/' }),
      await http(port, { path: '/v1/embeddings', method: 'POST' }),
      await http(port, { path: '/v1/chat/completions' }),
      await http(port, { path: '/v1/models', method: 'DELETE' }),
    ]) {
      expect(reply.status).toBe(404);
      expect(reply.headers['access-control-allow-origin']).toBeUndefined();
      expect(reply.headers['location']).toBeUndefined();
    }
  });

  it('translates a text turn, forwards the bearer as the bridge token, and drops extra settings', async () => {
    const reply = await chat(port, sdkRequest());
    expect(reply.status).toBe(200);
    expect(endpoint.frames).toHaveLength(1);
    expect(endpoint.frames[0]).toEqual({
      v: 1,
      id: 'c1',
      token: TOKEN,
      op: 'control',
      turn: {
        messages: [
          { role: 'system', content: 'You are helpful.' },
          { role: 'user', content: SENTINEL },
        ],
        settings: { maxOutputTokens: 256 },
      },
    });
    const body = json(reply);
    expect(body).toMatchObject({
      object: 'chat.completion',
      model: 'nexar-control',
      choices: [
        { index: 0, message: { role: 'assistant', content: 'hi there' }, finish_reason: 'stop' },
      ],
      usage: { prompt_tokens: 11, completion_tokens: 7, total_tokens: 18 },
    });
    expect(body.id).toMatch(/^chatcmpl-/);
    expect(body.choices[0]?.message.tool_calls).toBeUndefined();
  });

  it('accepts max_completion_tokens and maps a tool-call turn', async () => {
    endpoint.answer = () =>
      result({
        text: undefined,
        finishReason: 'tool-calls',
        toolCalls: [{ id: 'call_1', name: 'lookup', arguments: { q: 'x' } }],
      });
    const reply = await chat(
      port,
      sdkRequest({
        max_tokens: undefined,
        max_completion_tokens: 99,
        tools: [
          {
            type: 'function',
            function: { name: 'lookup', description: 'find it', parameters: { type: 'object' } },
          },
        ],
      }),
    );
    expect(endpoint.frames[0]?.turn).toMatchObject({
      tools: [{ name: 'lookup', description: 'find it', parameters: { type: 'object' } }],
      settings: { maxOutputTokens: 99 },
    });
    const message = json(reply).choices[0];
    expect(message?.finish_reason).toBe('tool_calls');
    expect(message?.message.content).toBeNull();
    expect(message?.message.tool_calls).toEqual([
      { id: 'call_1', type: 'function', function: { name: 'lookup', arguments: '{"q":"x"}' } },
    ]);
  });

  it('translates a tool result follow-up', async () => {
    await chat(
      port,
      sdkRequest({
        messages: [
          { role: 'user', content: 'find x' },
          {
            role: 'assistant',
            content: null,
            tool_calls: [
              {
                id: 'call_1',
                type: 'function',
                function: { name: 'lookup', arguments: '{"q":"x"}' },
              },
            ],
          },
          { role: 'tool', tool_call_id: 'call_1', content: 'found it' },
        ],
      }),
    );
    expect(endpoint.frames[0]?.turn['messages']).toEqual([
      { role: 'user', content: 'find x' },
      { role: 'assistant', toolCalls: [{ id: 'call_1', name: 'lookup', arguments: { q: 'x' } }] },
      { role: 'tool', toolCallId: 'call_1', content: 'found it' },
    ]);
  });

  it('rejects invalid tool arguments JSON with 400 and sends nothing', async () => {
    for (const args of ['{not json', '[1]', '"s"']) {
      const reply = await chat(
        port,
        sdkRequest({
          messages: [
            { role: 'user', content: 'q' },
            {
              role: 'assistant',
              tool_calls: [
                { id: 'c', type: 'function', function: { name: 'lookup', arguments: args } },
              ],
            },
          ],
        }),
      );
      expect(reply.status).toBe(400);
      expect(json(reply).error.code).toBe('invalid_tool_arguments');
    }
    expect(endpoint.frames).toHaveLength(0);
  });

  it('rejects the wrong model, bad bodies and non-JSON with the right status', async () => {
    expect((await chat(port, sdkRequest({ model: 'gpt-4o' }))).status).toBe(404);
    expect((await chat(port, '{nope')).status).toBe(400);
    expect((await chat(port, { model: 'nexar-control' })).status).toBe(400);
    expect((await chat(port, sdkRequest({ messages: [] }))).status).toBe(400);
    expect(
      (
        await chat(
          port,
          sdkRequest({ messages: [{ role: 'user', content: [{ type: 'image_url' }] }] }),
        )
      ).status,
    ).toBe(400);
    const plain = await http(port, {
      method: 'POST',
      path: '/v1/chat/completions',
      headers: { 'content-type': 'text/plain', authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify(sdkRequest()),
    });
    expect(plain.status).toBe(415);
    expect(endpoint.frames).toHaveLength(0);
  });

  it('answers 401 without a bearer token and never contacts the host', async () => {
    expect((await chat(port, sdkRequest(), {})).status).toBe(401);
    expect((await chat(port, sdkRequest(), { authorization: 'Basic abc' })).status).toBe(401);
    expect((await chat(port, sdkRequest(), { authorization: 'Bearer ' })).status).toBe(401);
    expect(endpoint.frames).toHaveLength(0);
  });

  it('maps host error codes to OpenAI-shaped errors without echoing content', async () => {
    const table: [string, number, string][] = [
      ['AUTH_REQUIRED', 401, 'authentication_error'],
      ['POLICY_REJECTED', 403, 'permission_error'],
      ['VALIDATION_ERROR', 400, 'invalid_request_error'],
      ['NO_ELIGIBLE_RESOURCE', 502, 'upstream_error'],
      ['PROVIDER_ERROR', 502, 'upstream_error'],
      ['EXECUTION_TIMEOUT', 504, 'timeout_error'],
      ['SOMETHING_ELSE', 502, 'upstream_error'],
    ];
    for (const [code, status, type] of table) {
      endpoint.answer = () => ({ ok: false, code });
      const reply = await chat(port, sdkRequest());
      expect(reply.status).toBe(status);
      expect(json(reply).error).toMatchObject({ type });
      expect(reply.text).not.toContain(SENTINEL);
      expect(reply.text).not.toContain(TOKEN);
    }
  });

  it('answers 502 when the host answers garbage or an error finish reason', async () => {
    endpoint.answer = () => result({ finishReason: 'error' });
    expect((await chat(port, sdkRequest())).status).toBe(502);
    endpoint.answer = () => ({ ok: true, value: { nonsense: true } });
    expect((await chat(port, sdkRequest())).status).toBe(502);
  });

  it('leaves usage out unless both counts are known', async () => {
    endpoint.answer = () =>
      result({
        usage: {
          inputTokens: { status: 'measured', value: 5 },
          outputTokens: { status: 'unavailable' },
        },
      });
    expect(json(await chat(port, sdkRequest())).usage).toBeUndefined();
    endpoint.answer = () =>
      result({
        usage: {
          inputTokens: { status: 'estimated', value: 5, basis: 'chars' },
          outputTokens: { status: 'estimated', value: 2, basis: 'chars' },
        },
      });
    expect(json(await chat(port, sdkRequest())).usage).toEqual({
      prompt_tokens: 5,
      completion_tokens: 2,
      total_tokens: 7,
    });
  });

  it('guards the Host header against DNS rebinding', async () => {
    const send = (host: string) => http(port, { path: '/v1/models', headers: { host } });
    expect((await send('evil.example')).status).toBe(403);
    expect((await send(`evil.example:${String(port)}`)).status).toBe(403);
    expect((await send(`127.0.0.1:${String(port + 1)}`)).status).toBe(403);
    expect((await send(`127.0.0.1:${String(port)}`)).status).toBe(200);
    expect((await send(`localhost:${String(port)}`)).status).toBe(200);
  });

  it('streams the SSE sequence with a usage chunk only when requested and known', async () => {
    endpoint.answer = () =>
      result({
        finishReason: 'tool-calls',
        toolCalls: [{ id: 'c1', name: 'lookup', arguments: {} }],
      });
    const withUsage = await chat(
      port,
      sdkRequest({ stream: true, stream_options: { include_usage: true } }),
    );
    expect(withUsage.headers['content-type']).toBe('text/event-stream');
    const events = sseEvents(withUsage.text);
    expect(events.at(-1)).toBe('[DONE]');
    const chunks = events.slice(0, -1).map((e) => JSON.parse(e) as Body);
    expect(chunks.map((c) => c.object)).toEqual(Array(4).fill('chat.completion.chunk'));
    expect(chunks[0]?.choices[0]?.delta).toEqual({ role: 'assistant', content: 'hi there' });
    expect(chunks[1]?.choices[0]?.delta.tool_calls).toEqual([
      { index: 0, id: 'c1', type: 'function', function: { name: 'lookup', arguments: '{}' } },
    ]);
    expect(chunks[2]?.choices[0]).toEqual({ index: 0, delta: {}, finish_reason: 'tool_calls' });
    expect(chunks[3]).toMatchObject({
      choices: [],
      usage: { prompt_tokens: 11, completion_tokens: 7, total_tokens: 18 },
    });

    const noOption = await chat(port, sdkRequest({ stream: true }));
    // content, tool calls, finish, [DONE]: no usage chunk without include_usage.
    expect(sseEvents(noOption.text)).toHaveLength(4);

    endpoint.answer = () =>
      result({
        usage: { inputTokens: { status: 'unavailable' }, outputTokens: { status: 'unavailable' } },
      });
    const unknown = await chat(
      port,
      sdkRequest({ stream: true, stream_options: { include_usage: true } }),
    );
    // content, finish, [DONE]: usage was asked for but is unknown, so no usage chunk.
    expect(sseEvents(unknown.text)).toHaveLength(3);
  });

  it('caps concurrent requests at four', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    endpoint.answer = async () => {
      await gate;
      return result();
    };
    const first = Array.from({ length: 4 }, () => chat(port, sdkRequest()));
    while (endpoint.frames.length < 4) await new Promise((resolve) => setTimeout(resolve, 10));
    expect((await chat(port, sdkRequest())).status).toBe(429);
    release();
    for (const reply of await Promise.all(first)) expect(reply.status).toBe(200);
  });

  it('answers 502 when the endpoint is unreachable', async () => {
    const dead = await launch(join(dir, 'does-not-exist.sock'));
    try {
      const reply = await chat(dead.port, sdkRequest());
      expect(reply.status).toBe(502);
    } finally {
      dead.child.stdin?.end();
      dead.child.kill();
    }
  });

  it('exits when stdin closes', async () => {
    const other = await launch(endpoint.path);
    const exited = new Promise<number | null>((resolve) => other.child.once('exit', resolve));
    other.child.stdin?.end();
    expect(await exited).toBe(0);
  });

  it('exits non-zero on a bad config line', async () => {
    const proc = spawn(process.execPath, [script], {
      stdio: ['pipe', 'pipe', 'ignore'],
      env: { ELECTRON_RUN_AS_NODE: '1' },
    });
    const exited = new Promise<number | null>((resolve) => proc.once('exit', resolve));
    proc.stdin?.on('error', () => undefined);
    proc.stdin?.write('{"endpoint":42}\n');
    expect(await exited).toBe(2);
  });

  it('binds loopback only', async () => {
    const probe = await launch(endpoint.path);
    try {
      const reply = await http(probe.port, { path: '/v1/models' });
      expect(reply.status).toBe(200);
    } finally {
      probe.child.stdin?.end();
    }
  });
});

describe('control gateway server limits', () => {
  let dir: string;
  let endpoint: FakeEndpoint;
  let server: Server;
  let port: number;

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'nexar-control-gateway-limits-'));
    endpoint = await FakeEndpoint.start(dir);
    server = createControlGatewayServer({ endpoint: endpoint.path, maxBodyBytes: 2048 });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    port = (server.address() as { port: number }).port;
  });
  afterAll(async () => {
    server.close();
    server.closeAllConnections();
    await endpoint.stop();
    await rm(dir, { recursive: true, force: true });
  });

  it('refuses a body over the cap with 413 and contacts nothing', async () => {
    const big = sdkRequest({ messages: [{ role: 'user', content: 'x'.repeat(4096) }] });
    const reply = await chat(port, big).catch(() => undefined);
    // The server drops the connection after answering; a client that is still writing may see a reset.
    if (reply !== undefined) expect(reply.status).toBe(413);
    expect(endpoint.frames).toHaveLength(0);
  });
});

describe('control gateway end to end (child -> endpoint -> gateway -> fake port)', () => {
  let dir: string;
  let script: string;
  let host: BridgeHost;
  let child: ChildProcess;
  let port: number;
  const seen: string[] = [];

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'nexar-control-gateway-e2e-'));
    script = join(dir, 'control-gateway.cjs');
    await build({
      entryPoints: [fileURLToPath(new URL('./main.ts', import.meta.url))],
      outfile: script,
      bundle: true,
      platform: 'node',
      format: 'cjs',
      target: 'node22',
      logLevel: 'silent',
    });
    const { gateway } = createFakeControl({
      turn: (req) => {
        seen.push(JSON.stringify(req.messages));
        const last = req.messages.at(-1);
        return last?.role === 'tool'
          ? okTurn(`the tool said: ${last.content ?? ''}`)
          : {
              toolCalls: [{ id: 'call_9', name: 'lookup', arguments: { q: 'x' } }],
              finishReason: 'tool-calls',
              usage: okTurn().usage,
            };
      },
    });
    host = new BridgeHost({
      allocator: { allocate: () => Promise.reject(new Error('unused')) },
      executor: () => Promise.reject(new Error('unused')),
      clock: () => new Date(),
      newId: randomUUID,
      logger: silentLogger,
      runtimeDir: join(dir, 'runtime'),
      gateway,
    });
    const endpointPath = await host.start();
    const proc = spawn(process.execPath, [script], {
      stdio: ['pipe', 'pipe', 'ignore'],
      env: { ELECTRON_RUN_AS_NODE: '1' },
    });
    proc.stdin?.on('error', () => undefined);
    proc.stdin?.write(`${JSON.stringify({ endpoint: endpointPath })}\n`);
    const line = await new Promise<string>((resolve) => {
      let buffered = '';
      proc.stdout?.on('data', (chunk: Buffer) => {
        buffered += chunk.toString();
        if (buffered.includes('\n')) resolve(buffered.split('\n')[0] ?? '');
      });
    });
    child = proc;
    port = (JSON.parse(line) as { port: number }).port;
  }, 60_000);
  afterAll(async () => {
    child.stdin?.end();
    child.kill();
    await host.stop();
    await rm(dir, { recursive: true, force: true });
  });

  const grant = {
    sessionId: 's1',
    turnId: 't1',
    correlationId: 'c1',
    projectId: 'proj',
    engine: 'openworker',
    access: 'read-only',
    maxUnits: 1,
    ttlMs: 60_000,
  } as const;

  it('round-trips an SDK-shaped tool loop with the minted token as the bearer', async () => {
    const { token } = host.mint(grant, { policy: { mode: 'auto', fallback: 'auto' } });
    const headers = { authorization: `Bearer ${token}` };
    const tools = [
      {
        type: 'function',
        function: { name: 'lookup', description: 'find', parameters: { type: 'object' } },
      },
    ];
    const first = await chat(port, sdkRequest({ tools }), headers);
    expect(first.status).toBe(200);
    const call = json(first).choices[0];
    expect(call?.finish_reason).toBe('tool_calls');
    expect(call?.message.tool_calls?.[0]).toEqual({
      id: 'call_9',
      type: 'function',
      function: { name: 'lookup', arguments: '{"q":"x"}' },
    });

    const second = await chat(
      port,
      sdkRequest({
        tools,
        messages: [
          { role: 'user', content: 'find x' },
          { role: 'assistant', content: null, tool_calls: call?.message.tool_calls },
          { role: 'tool', tool_call_id: 'call_9', content: 'found it' },
        ],
      }),
      headers,
    );
    expect(json(second).choices[0]).toMatchObject({
      finish_reason: 'stop',
      message: { content: 'the tool said: found it' },
    });
    expect(json(second).usage).toEqual({ prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 });
  });

  it('answers 401 for an unknown token and 403 for a grant without control', async () => {
    expect((await chat(port, sdkRequest(), { authorization: 'Bearer nope' })).status).toBe(401);
    const { token } = host.mint(grant);
    expect((await chat(port, sdkRequest(), { authorization: `Bearer ${token}` })).status).toBe(403);
  });

  it('stops answering once the grant is revoked', async () => {
    const { token, grantId } = host.mint(grant, { policy: { mode: 'auto', fallback: 'auto' } });
    const headers = { authorization: `Bearer ${token}` };
    expect((await chat(port, sdkRequest(), headers)).status).toBe(200);
    host.revoke(grantId);
    expect((await chat(port, sdkRequest(), headers)).status).toBe(401);
  });
});
