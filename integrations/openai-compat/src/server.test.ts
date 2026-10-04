import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { request, type Server } from 'node:http';
import { createServer, type Server as NetServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createControlGatewayServer } from './server.js';

const TOKEN = 'fake-bridge-token';

type Target = { readonly port: number } | { readonly socketPath: string };

/** A local pipe or unix socket path that never collides between tests. */
const localPath = (dir: string, name: string): string =>
  process.platform === 'win32' ? `\\\\.\\pipe\\nexar-compat-${randomUUID()}` : join(dir, name);

/** An in-process stand-in for the bridge endpoint: counts frames, answers every turn "hi". */
class FakeEndpoint {
  frames = 0;
  readonly path: string;
  private readonly server: NetServer;

  constructor(dir: string) {
    this.path = localPath(dir, 'bridge.sock');
    this.server = createServer((socket) => {
      socket.setEncoding('utf8');
      socket.on('error', () => undefined);
      socket.on('data', (chunk: string) => {
        const frame = JSON.parse(chunk.split('\n')[0] ?? '{}') as { id: string };
        this.frames++;
        socket.write(
          `${JSON.stringify({
            id: frame.id,
            ok: true,
            value: {
              text: 'hi',
              toolCalls: [],
              finishReason: 'stop',
              usage: {
                inputTokens: { status: 'measured', value: 1 },
                outputTokens: { status: 'measured', value: 1 },
              },
              resourceId: 'res-a',
            },
          })}\n`,
        );
      });
    });
  }

  start(): Promise<void> {
    return new Promise((resolve) => this.server.listen(this.path, resolve));
  }

  stop(): Promise<void> {
    return new Promise((resolve) => this.server.close(() => resolve()));
  }
}

interface Reply {
  readonly status: number;
  readonly text: string;
}

/** One request over TCP (`port`) or a unix socket / pipe (`socketPath`), with any Host header. */
function http(
  target: Target,
  options: { method?: string; path: string; headers?: Record<string, string>; body?: string },
): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const req = request(
      {
        ...('port' in target ? { host: '127.0.0.1', port: target.port } : target),
        method: options.method ?? 'GET',
        path: options.path,
        headers: options.headers,
        agent: false,
      },
      (res) => {
        let text = '';
        res.setEncoding('utf8');
        res.on('data', (chunk: string) => (text += chunk));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, text }));
      },
    );
    req.on('error', reject);
    req.end(options.body);
  });
}

const chatRequest = (content: string): Record<string, unknown> => ({
  model: 'nexar-control',
  messages: [{ role: 'user', content }],
});

const chat = (
  target: Target,
  body: unknown,
  headers: Record<string, string> = {},
): Promise<Reply> =>
  http(target, {
    method: 'POST',
    path: '/v1/chat/completions',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}`, ...headers },
    body: JSON.stringify(body),
  });

const listen = (server: Server, ...args: [number, string] | [string]): Promise<void> =>
  new Promise((resolve) => server.listen(...(args as [string]), resolve));

const stopServer = (server: Server): void => {
  server.close();
  server.closeAllConnections();
};

describe('control gateway server', () => {
  let dir: string;
  let endpoint: FakeEndpoint;

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'nexar-openai-compat-'));
    endpoint = new FakeEndpoint(dir);
    await endpoint.start();
  });
  afterAll(async () => {
    await endpoint.stop();
    await rm(dir, { recursive: true, force: true });
  });

  it('refuses a body over the cap with 413 and contacts nothing', async () => {
    const server = createControlGatewayServer({ endpoint: endpoint.path, maxBodyBytes: 2048 });
    await listen(server, 0, '127.0.0.1');
    const port = (server.address() as { port: number }).port;
    const before = endpoint.frames;
    try {
      const reply = await chat({ port }, chatRequest('x'.repeat(4096))).catch(() => undefined);
      // The server drops the connection after answering; a client still writing may see a reset.
      if (reply !== undefined) expect(reply.status).toBe(413);
      expect(endpoint.frames).toBe(before);
    } finally {
      stopServer(server);
    }
  });

  describe('listening on a unix socket behind a TCP bridge', () => {
    const PORT = 41_731;
    let server: Server;
    let socketPath: string;

    beforeAll(async () => {
      socketPath = localPath(dir, 'gateway.sock');
      server = createControlGatewayServer({ endpoint: endpoint.path, allowedHostPort: PORT });
      await listen(server, socketPath);
    });
    afterAll(() => stopServer(server));

    const models = (host: string): Promise<Reply> =>
      http({ socketPath }, { path: '/v1/models', headers: { host } });

    it('accepts the loopback names on the allowed port only', async () => {
      expect((await models(`127.0.0.1:${String(PORT)}`)).status).toBe(200);
      expect((await models(`localhost:${String(PORT)}`)).status).toBe(200);
      expect((await models(`127.0.0.1:${String(PORT + 1)}`)).status).toBe(403);
      expect((await models(`localhost:${String(PORT + 1)}`)).status).toBe(403);
      expect((await models(`evil.example:${String(PORT)}`)).status).toBe(403);
      expect((await models('127.0.0.1')).status).toBe(403);
    });

    it('serves a completion through the socket', async () => {
      const before = endpoint.frames;
      const reply = await chat({ socketPath }, chatRequest('hello'), {
        host: `127.0.0.1:${String(PORT)}`,
      });
      expect(reply.status).toBe(200);
      expect(JSON.parse(reply.text)).toMatchObject({
        choices: [{ message: { content: 'hi' }, finish_reason: 'stop' }],
      });
      expect(endpoint.frames).toBe(before + 1);
    });

    it('rejects a wrong-port Host before contacting the endpoint', async () => {
      const before = endpoint.frames;
      const reply = await chat({ socketPath }, chatRequest('hello'), {
        host: `127.0.0.1:${String(PORT + 1)}`,
      });
      expect(reply.status).toBe(403);
      expect(endpoint.frames).toBe(before);
    });
  });

  it('without allowedHostPort a unix-socket server has no own port and accepts no Host', async () => {
    const server = createControlGatewayServer({ endpoint: endpoint.path });
    const socketPath = localPath(dir, 'strict.sock');
    await listen(server, socketPath);
    try {
      const reply = await http(
        { socketPath },
        { path: '/v1/models', headers: { host: '127.0.0.1:0' } },
      );
      expect(reply.status).toBe(403);
    } finally {
      stopServer(server);
    }
  });
});
