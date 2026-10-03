import { createHash } from 'node:crypto';
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
  | 'question';

export interface FakeServerOptions {
  readonly token: string;
  readonly host?: string;
  readonly port?: number;
  /** Health answers 503 for this long after `listen()`. */
  readonly startDelayMs?: number;
  readonly neverReady?: boolean;
  readonly failProviders?: boolean;
  readonly onRecord?: (entry: { readonly kind: string; readonly body: unknown }) => void;
}

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

type Frame = Record<string, unknown>;

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
    await this.#next('approval');
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
