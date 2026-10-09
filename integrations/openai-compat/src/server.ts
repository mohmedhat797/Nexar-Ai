import { randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { connect as netConnect, type Socket } from 'node:net';
import {
  HttpFailure,
  MODEL_ID,
  completionBody,
  completionChunks,
  errorBody,
  failureForCode,
  parseChatRequest,
  toCompletion,
} from './translate.js';

/*
 * The loopback Chat Completions translator (ADR-027 section 7A): a tiny HTTP server that turns an
 * OpenAI-shaped request into one bridge `control` frame. It holds no secret and does no auth: the
 * bearer value is forwarded as the bridge token and the host enforces the grant.
 */

export const MAX_BODY_BYTES = 4 * 1024 * 1024;
const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
const MAX_CONCURRENT = 4;
const PROTOCOL_VERSION = 1;

export interface ControlGatewayServerOptions {
  /** The bridge endpoint (a local pipe or socket path). */
  readonly endpoint: string;
  readonly connect?: (endpoint: string) => Socket;
  /** Bound on one bridge exchange. Default 5 minutes. */
  readonly turnTimeoutMs?: number;
  readonly maxBodyBytes?: number;
  /**
   * The port the Host header must name (127.0.0.1:<port> / localhost:<port>). Default: the
   * server's own TCP port. Set it when the server listens on a unix socket and the client reaches
   * it through a TCP bridge on another port.
   */
  readonly allowedHostPort?: number;
}

type Outcome =
  { readonly ok: true; readonly value: unknown } | { readonly ok: false; readonly code: string };

/** One connection per request: send the frame, read one NDJSON response line. Never throws. */
function exchange(
  options: ControlGatewayServerOptions,
  token: string,
  turn: unknown,
  aborted: AbortSignal,
): Promise<Outcome> {
  const unavailable: Outcome = { ok: false, code: 'INTEGRATION_UNAVAILABLE' };
  return new Promise((resolve) => {
    const socket = (options.connect ?? netConnect)(options.endpoint);
    socket.setEncoding('utf8');
    let buffered = '';
    let settled = false;
    const finish = (outcome: Outcome): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      aborted.removeEventListener('abort', onAbort);
      socket.destroy();
      resolve(outcome);
    };
    const onAbort = (): void => finish(unavailable);
    const timer = setTimeout(
      () => finish({ ok: false, code: 'EXECUTION_TIMEOUT' }),
      options.turnTimeoutMs ?? 300_000,
    );
    aborted.addEventListener('abort', onAbort, { once: true });
    socket.on('error', () => finish(unavailable));
    socket.on('close', () => finish(unavailable));
    socket.on('data', (chunk: string) => {
      buffered += chunk;
      if (buffered.length > MAX_RESPONSE_BYTES) return finish(unavailable);
      const end = buffered.indexOf('\n');
      if (end === -1) return;
      try {
        const frame = JSON.parse(buffered.slice(0, end)) as {
          ok?: unknown;
          value?: unknown;
          code?: unknown;
        };
        if (frame.ok === true) finish({ ok: true, value: frame.value });
        else finish({ ok: false, code: typeof frame.code === 'string' ? frame.code : '' });
      } catch {
        finish(unavailable);
      }
    });
    socket.on('connect', () => {
      socket.write(
        `${JSON.stringify({ v: PROTOCOL_VERSION, id: 'c1', token, op: 'control', turn })}\n`,
      );
    });
  });
}

function send(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(text),
    'cache-control': 'no-store',
  });
  res.end(text);
}

const fail = (res: ServerResponse, failure: HttpFailure): void =>
  send(res, failure.status, errorBody(failure));

/** The raw body, or a 413 failure as soon as it exceeds the cap. */
function readBody(req: IncomingMessage, limit: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > limit) {
        reject(new HttpFailure(413, 'invalid_request_error', 'body_too_large'));
        req.pause();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', () => reject(new HttpFailure(400, 'invalid_request_error', 'invalid_request')));
  });
}

const BEARER = /^Bearer ([^\s]{1,256})$/i;

export function createControlGatewayServer(options: ControlGatewayServerOptions): Server {
  const limit = options.maxBodyBytes ?? MAX_BODY_BYTES;
  let inFlight = 0;

  const handle = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const address = server.address();
    const port =
      options.allowedHostPort ??
      (typeof address === 'object' && address !== null ? address.port : 0);
    const host = req.headers.host;
    // DNS-rebinding guard: only the literal loopback names on the expected port.
    // Port 0 means "no TCP port known" (a socket listener without `allowedHostPort`): nothing matches.
    if (
      port === 0 ||
      (host !== `127.0.0.1:${String(port)}` && host !== `localhost:${String(port)}`)
    ) {
      return fail(res, new HttpFailure(403, 'permission_error', 'host_not_allowed'));
    }
    const path = (req.url ?? '').split('?')[0];
    if (req.method === 'GET' && path === '/v1/models') {
      return send(res, 200, { object: 'list', data: [{ id: MODEL_ID, object: 'model' }] });
    }
    if (req.method !== 'POST' || path !== '/v1/chat/completions') {
      return fail(res, new HttpFailure(404, 'invalid_request_error', 'not_found'));
    }
    const token = BEARER.exec(req.headers.authorization ?? '')?.[1];
    if (token === undefined) {
      return fail(res, new HttpFailure(401, 'authentication_error', 'invalid_api_key'));
    }
    if (inFlight >= MAX_CONCURRENT) {
      return fail(res, new HttpFailure(429, 'rate_limit_error', 'too_many_requests'));
    }
    inFlight++;
    const abort = new AbortController();
    res.on('close', () => abort.abort());
    try {
      if (!/^application\/json\b/i.test(req.headers['content-type'] ?? '')) {
        throw new HttpFailure(415, 'invalid_request_error', 'unsupported_media_type');
      }
      const body = await readBody(req, limit);
      let raw: unknown;
      try {
        raw = JSON.parse(body.toString('utf8'));
      } catch {
        throw new HttpFailure(400, 'invalid_request_error', 'invalid_json');
      }
      const parsed = parseChatRequest(raw);
      const outcome = await exchange(options, token, parsed.turn, abort.signal);
      if (!outcome.ok) throw failureForCode(outcome.code);
      const completion = toCompletion(outcome.value);
      const id = `chatcmpl-${randomUUID()}`;
      const created = Math.floor(Date.now() / 1000);
      if (!parsed.stream) return send(res, 200, completionBody(id, created, completion));
      res.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-store',
        connection: 'keep-alive',
      });
      for (const chunk of completionChunks(id, created, completion, parsed.includeUsage)) {
        res.write(`data: ${JSON.stringify(chunk)}\n\n`);
      }
      res.end('data: [DONE]\n\n');
    } catch (error) {
      if (res.headersSent) return void res.destroy();
      const failure = error instanceof HttpFailure ? error : failureForCode('');
      // An oversized body is not read to the end: the connection is dropped once answered.
      if (failure.status === 413) res.once('finish', () => req.socket.destroy());
      fail(res, failure);
    } finally {
      inFlight--;
    }
  };

  const server = createServer((req, res) => {
    void handle(req, res);
  });
  // Node serializes the requests of one connection; the overall cap is MAX_CONCURRENT.
  server.on('clientError', (_error, socket) => socket.destroy());
  return server;
}
