import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import type { Duplex } from 'node:stream';
import { join } from 'node:path';

// No TypeScript-only runtime syntax (enums, parameter properties): the fake launcher script runs
// this file directly with Node's type stripping.

export type FakeScenario =
  | 'normal'
  | 'error'
  | 'input-rejected'
  | 'malformed'
  | 'oversize'
  | 'hang'
  | 'close-mid-turn'
  | 'no-ready'
  | 'declined-requests'
  | 'question'
  | 'delegate';

export interface FakeServerOptions {
  readonly token: string;
  readonly host?: string;
  readonly port?: number;
  /** Health answers 503 for this long after `listen()`. */
  readonly startDelayMs?: number;
  readonly neverReady?: boolean;
  readonly failProviders?: boolean;
  /** Writes draft.md into the turn workspace when its write permission is allowed. */
  readonly writeDraft?: boolean;
  readonly onRecord?: (entry: { readonly kind: string; readonly body: unknown }) => void;
}

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

type Frame = Record<string, unknown>;

interface McpConfig {
  readonly command: string;
  readonly args: readonly string[];
  readonly env: Readonly<Record<string, string>>;
  readonly requires_approval: boolean;
}

const DELEGATE_SUBMIT = 'mcp__nexar__nexar_intelligence_submit';
const DELEGATE_STATUS = 'mcp__nexar__nexar_intelligence_status';
const DELEGATE_POLL_MS = 200;
const DELEGATE_MAX_MS = 60_000;

function isMcpConfig(value: unknown): value is McpConfig {
  if (typeof value !== 'object' || value === null) return false;
  const c = value as Record<string, unknown>;
  return (
    typeof c['command'] === 'string' &&
    Array.isArray(c['args']) &&
    c['args'].every((a) => typeof a === 'string') &&
    typeof c['env'] === 'object' &&
    c['env'] !== null &&
    Object.values(c['env']).every((v) => typeof v === 'string') &&
    typeof c['requires_approval'] === 'boolean'
  );
}

function encodeText(text: string): Buffer {
  const payload = Buffer.from(text);
  const length = payload.length;
  const header =
    length < 126
      ? Buffer.from([0x81, length])
      : length < 65_536
        ? Buffer.from([0x81, 126, length >> 8, length & 0xff])
        : (() => {
            const big = Buffer.alloc(10);
            big[0] = 0x81;
            big[1] = 127;
            big.writeBigUInt64BE(BigInt(length), 2);
            return big;
          })();
  return Buffer.concat([header, payload]);
}

/** Decodes complete masked client frames from `buffer`; returns the rest. */
function decodeFrames(buffer: Buffer): {
  readonly frames: { readonly opcode: number; readonly payload: Buffer }[];
  readonly rest: Buffer;
} {
  const frames: { opcode: number; payload: Buffer }[] = [];
  let offset = 0;
  for (;;) {
    if (buffer.length - offset < 2) break;
    const opcode = buffer[offset]! & 0x0f;
    const masked = (buffer[offset + 1]! & 0x80) !== 0;
    let length = buffer[offset + 1]! & 0x7f;
    let cursor = offset + 2;
    if (length === 126) {
      if (buffer.length - cursor < 2) break;
      length = buffer.readUInt16BE(cursor);
      cursor += 2;
    } else if (length === 127) {
      if (buffer.length - cursor < 8) break;
      length = Number(buffer.readBigUInt64BE(cursor));
      cursor += 8;
    }
    const maskLength = masked ? 4 : 0;
    if (buffer.length - cursor < maskLength + length) break;
    const mask = masked ? buffer.subarray(cursor, cursor + 4) : undefined;
    const payload = Buffer.from(buffer.subarray(cursor + maskLength, cursor + maskLength + length));
    if (mask !== undefined) for (let i = 0; i < payload.length; i++) payload[i]! ^= mask[i % 4]!;
    frames.push({ opcode, payload });
    offset = cursor + maskLength + length;
  }
  return { frames, rest: buffer.subarray(offset) };
}

/** Upstream's wire shape for server events: `{ type, data: { ...payload } }`. */
function envelope(frame: Frame): Frame {
  const { type, ...data } = frame as { type?: unknown } & Record<string, unknown>;
  return { type, data };
}

/** A scriptable stand-in for `openworker-server`, speaking only the subset Nexar uses. */
export class FakeOpenWorkerServer {
  scenario: FakeScenario = 'normal';
  readonly frames: Frame[] = [];
  readonly roots: { readonly sessionId: string; readonly body: unknown }[] = [];
  readonly providers: unknown[] = [];
  /** Registered /v1/mcp entries by name (the env may hold a secret: never recorded). */
  readonly mcpServers = new Map<string, McpConfig>();
  readonly requests: { readonly method: string; readonly path: string; readonly status: number }[] =
    [];
  readonly upgrades: { readonly url: string; readonly authorized: boolean }[] = [];
  readonly #options: FakeServerOptions;
  readonly #server: Server;
  readonly #sockets = new Set<Duplex>();
  #listeningAt = 0;
  #waiters: { type: string; resolve: (frame: Frame) => void }[] = [];

  constructor(options: FakeServerOptions) {
    this.#options = options;
    this.#server = createServer((req, res) => this.#http(req, res));
    this.#server.on('upgrade', (req, socket) => this.#upgrade(req, socket));
  }

  get token(): string {
    return this.#options.token;
  }

  listen(): Promise<number> {
    return new Promise((resolve, reject) => {
      this.#server.once('error', reject);
      this.#server.listen(this.#options.port ?? 0, this.#options.host ?? '127.0.0.1', () => {
        this.#listeningAt = Date.now();
        const address = this.#server.address();
        resolve(typeof address === 'object' && address !== null ? address.port : 0);
      });
    });
  }

  close(): Promise<void> {
    for (const socket of this.#sockets) socket.destroy();
    return new Promise((resolve) => {
      this.#server.close(() => resolve());
      this.#server.closeAllConnections();
    });
  }

  #authorized(value: string | string[] | undefined): boolean {
    return typeof value === 'string' && value === this.#options.token;
  }

  #http(req: IncomingMessage, res: ServerResponse): void {
    const path = (req.url ?? '').split('?')[0] ?? '';
    const method = req.method ?? 'GET';
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const reply = (status: number, body: unknown): void => {
        this.requests.push({ method, path, status });
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(body));
      };
      if (!this.#authorized(req.headers['x-openworker-token']))
        return reply(401, { error: 'auth' });
      let body: unknown;
      try {
        body = chunks.length === 0 ? undefined : JSON.parse(Buffer.concat(chunks).toString('utf8'));
      } catch {
        return reply(400, { error: 'json' });
      }
      if (method === 'GET' && path === '/v1/health') {
        const warm = Date.now() - this.#listeningAt >= (this.#options.startDelayMs ?? 0);
        return this.#options.neverReady === true || !warm
          ? reply(503, { status: 'starting' })
          : reply(200, { status: 'ok', version: '0.3.0' });
      }
      if (method === 'POST' && path === '/v1/providers') {
        this.#options.onRecord?.({ kind: 'provider', body });
        if (this.#options.failProviders === true) return reply(500, { error: 'provider' });
        this.providers.push(body);
        return reply(200, { ok: true });
      }
      if (method === 'POST' && path === '/v1/mcp') {
        const entry = body as { name?: unknown; config?: unknown } | undefined;
        if (typeof entry?.name !== 'string' || !isMcpConfig(entry.config)) {
          return reply(422, { error: 'mcp' });
        }
        this.mcpServers.set(entry.name, entry.config);
        this.#options.onRecord?.({
          kind: 'mcp-register',
          body: { name: entry.name, envNames: Object.keys(entry.config.env).sort() },
        });
        return reply(200, { ok: true });
      }
      const mcp = /^\/v1\/mcp\/([^/]+)$/.exec(path);
      if (method === 'DELETE' && mcp !== null) {
        const name = decodeURIComponent(mcp[1]!);
        if (!this.mcpServers.delete(name)) return reply(404, { error: 'not-found' });
        this.#options.onRecord?.({ kind: 'mcp-delete', body: { name } });
        return reply(200, { ok: true });
      }
      const roots = /^\/v1\/sessions\/([^/]+)\/roots$/.exec(path);
      if (method === 'POST' && roots !== null) {
        this.roots.push({ sessionId: decodeURIComponent(roots[1]!), body });
        return reply(200, { ok: true });
      }
      reply(404, { error: 'not-found' });
    });
  }

  #upgrade(req: IncomingMessage, socket: Duplex): void {
    const protocols = String(req.headers['sec-websocket-protocol'] ?? '')
      .split(',')
      .map((value) => value.trim());
    const authorized = protocols.includes('openworker') && protocols.includes(this.#options.token);
    this.upgrades.push({ url: req.url ?? '', authorized });
    const key = req.headers['sec-websocket-key'];
    if (!authorized || typeof key !== 'string' || !(req.url ?? '').startsWith('/ws/session/')) {
      socket.end('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
      return;
    }
    const accept = createHash('sha1')
      .update(key + GUID)
      .digest('base64');
    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n' +
        `Sec-WebSocket-Accept: ${accept}\r\nSec-WebSocket-Protocol: openworker\r\n\r\n`,
    );
    this.#sockets.add(socket);
    socket.on('close', () => this.#sockets.delete(socket));
    socket.on('error', () => undefined);
    const workspace =
      new URL(req.url ?? '', 'http://127.0.0.1').searchParams.get('workspace') ?? '';
    const send = (frame: Frame | string): void => {
      if (!socket.destroyed)
        socket.write(
          encodeText(typeof frame === 'string' ? frame : JSON.stringify(envelope(frame))),
        );
    };
    let pending: Buffer = Buffer.alloc(0);
    socket.on('data', (chunk: Buffer) => {
      const decoded = decodeFrames(Buffer.concat([pending, chunk]));
      pending = decoded.rest;
      for (const { opcode, payload } of decoded.frames) {
        if (opcode === 8) {
          socket.end(Buffer.from([0x88, 0x00]));
        } else if (opcode === 1) {
          const frame = JSON.parse(payload.toString('utf8')) as Frame;
          this.frames.push(frame);
          if (frame['type'] === 'user_message' || frame['type'] === 'set_mode')
            this.#options.onRecord?.({ kind: String(frame['type']), body: frame });
          const index = this.#waiters.findIndex((waiter) => waiter.type === frame['type']);
          if (index >= 0) this.#waiters.splice(index, 1)[0]!.resolve(frame);
          else if (frame['type'] === 'user_message') void this.#turn(socket, send, workspace);
        }
      }
    });
    if (this.scenario !== 'no-ready') send({ type: 'ready' });
  }

  #next(type: string): Promise<Frame> {
    return new Promise((resolve) => this.#waiters.push({ type, resolve }));
  }

  /**
   * Delegates one unit through the registered relay, as OpenWorker would: ask permission for the
   * bridge tool (by its mapped name), and only when allowed launch the registered command with its
   * env, speak minimal MCP over stdio, poll the status, and write the returned text as a draft.
   */
  async #delegate(send: (frame: Frame | string) => void, workspace: string): Promise<void> {
    send({ type: 'turn_start' });
    const ask = async (name: string): Promise<boolean> => {
      send({
        type: 'permission_required',
        name,
        arguments: { input: 'SECRET-ARGUMENT' },
        reason: 'mcp',
        category: 'mcp',
      });
      return (await this.#next('approval'))['decision'] === 'allow';
    };
    if (!(await ask(DELEGATE_SUBMIT))) {
      send({ type: 'assistant_message', text: 'Delegation was not allowed' });
      send({ type: 'turn_done' });
      return;
    }
    const config = this.mcpServers.get('nexar');
    const text = config === undefined ? undefined : await this.#runRelay(config, ask);
    if (text !== undefined && text !== '') writeFileSync(join(workspace, 'draft.md'), text);
    send({
      type: 'assistant_message',
      text: text === undefined ? 'Delegation failed' : 'Delegated unit done',
    });
    send({ type: 'turn_done' });
  }

  /** Minimal MCP client over the relay's stdio (newline-delimited JSON-RPC). */
  async #runRelay(
    config: McpConfig,
    ask: (name: string) => Promise<boolean>,
  ): Promise<string | undefined> {
    const child = spawn(config.command, [...config.args], {
      env: { PATH: process.env['PATH'] ?? '', ...config.env },
      stdio: ['pipe', 'pipe', 'ignore'],
      windowsHide: true,
    });
    child.stdin.on('error', () => undefined);
    const waiting = new Map<number, (message: Record<string, unknown>) => void>();
    let buffered = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      buffered += chunk;
      for (let i = buffered.indexOf('\n'); i !== -1; i = buffered.indexOf('\n')) {
        const line = buffered.slice(0, i);
        buffered = buffered.slice(i + 1);
        try {
          const message = JSON.parse(line) as Record<string, unknown>;
          waiting.get(message['id'] as number)?.(message);
        } catch {
          /* Not a frame. */
        }
      }
    });
    let counter = 0;
    const write = (message: Record<string, unknown>): void => {
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`);
    };
    const rpc = (method: string, params: unknown): Promise<Record<string, unknown>> =>
      new Promise((resolve, reject) => {
        const id = ++counter;
        const timer = setTimeout(() => reject(new Error('mcp timeout')), 30_000);
        waiting.set(id, (message) => {
          clearTimeout(timer);
          waiting.delete(id);
          resolve(message);
        });
        child.once('exit', () => reject(new Error('relay exited')));
        write({ id, method, params });
      });
    // The relay's text block holds JSON; an `isError` result is `{ error: code }`.
    const call = async (name: string, args: unknown): Promise<Record<string, unknown>> => {
      const response = await rpc('tools/call', { name, arguments: args });
      const result = response['result'] as { content?: { text?: string }[] } | undefined;
      return JSON.parse(result?.content?.[0]?.text ?? '{}') as Record<string, unknown>;
    };
    try {
      await rpc('initialize', {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: 'fake-openworker', version: '0.0.0' },
      });
      write({ method: 'notifications/initialized' });
      await rpc('tools/list', {});
      const submitted = await call('nexar.intelligence_submit', {
        unitId: 'u1',
        input: 'Draft a short project status note.',
        access: process.env['NEXAR_FAKE_OPENWORKER_DELEGATE_ACCESS'] ?? 'read-only',
      });
      if (typeof submitted['jobId'] !== 'string') return undefined;
      if (!(await ask(DELEGATE_STATUS))) return undefined;
      const deadline = Date.now() + DELEGATE_MAX_MS;
      while (Date.now() < deadline) {
        const status = await call('nexar.intelligence_status', { jobId: submitted['jobId'] });
        if (status['state'] === 'done') {
          const result = status['result'] as { text?: unknown } | undefined;
          return typeof result?.text === 'string' ? result.text : undefined;
        }
        if (status['state'] !== 'running') return undefined;
        await new Promise((resolve) => setTimeout(resolve, DELEGATE_POLL_MS));
      }
      return undefined;
    } catch {
      return undefined;
    } finally {
      child.stdin.end();
      child.kill();
    }
  }

  async #turn(
    socket: Duplex,
    send: (frame: Frame | string) => void,
    workspace: string,
  ): Promise<void> {
    switch (this.scenario) {
      case 'hang':
        return;
      case 'error':
        send({ type: 'turn_start' });
        send({ type: 'error', message: 'SECRET-UPSTREAM-DETAIL' });
        return;
      case 'input-rejected':
        send({ type: 'input_rejected', reason: 'busy' });
        return;
      case 'malformed':
        send('not json{');
        return;
      case 'oversize':
        send(JSON.stringify({ type: 'assistant_message', text: 'x'.repeat(1024 * 1024 + 1) }));
        return;
      case 'close-mid-turn':
        send({ type: 'turn_start' });
        socket.destroy();
        return;
      case 'declined-requests':
        send({ type: 'turn_start' });
        send({ type: 'directory_requested', path: 'C:/outside' });
        send({ type: 'tool_requested', tool: 'scanner' });
        send({ type: 'assistant_message', text: 'done without them' });
        send({ type: 'turn_done' });
        return;
      case 'question':
        send({ type: 'turn_start' });
        send({ type: 'question_requested', question: 'Which file?' });
        return;
      case 'delegate':
        return this.#delegate(send, workspace);
      default:
        break;
    }
    send({ type: 'turn_start' });
    send({ type: 'unknown_future_event', data: 1 });
    send({
      type: 'permission_required',
      name: 'write_file',
      arguments: { path: 'draft.md', content: 'SECRET-ARGUMENT' },
      reason: 'write',
      category: 'file',
      target: join(workspace, 'draft.md'),
    });
    const approval = await this.#next('approval');
    if (this.#options.writeDraft === true && approval['decision'] === 'allow') {
      writeFileSync(join(workspace, 'draft.md'), 'DRAFT-CONTENT');
    }
    send({ type: 'tool_started', name: 'write_file', arguments: { content: 'SECRET-ARGUMENT' } });
    send({ type: 'tool_finished', name: 'write_file' });
    send({
      type: 'permission_required',
      name: 'run_shell',
      arguments: { command: 'echo SECRET-ARGUMENT' },
      reason: 'shell',
      category: 'shell',
      target: 'echo hi',
    });
    await this.#next('approval');
    send({ type: 'assistant_delta', text: 'Cowork ' });
    send({ type: 'assistant_message', text: 'Cowork done' });
    send({ type: 'turn_done' });
  }
}
