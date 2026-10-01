import type { Readable, Writable } from 'node:stream';
import { NexarError } from '@nexar/contracts';

/** A server-to-client message without an `id`. */
export interface JsonRpcNotification {
  readonly method: string;
  readonly params?: unknown;
}

export interface JsonRpcRequestOptions {
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
}

export interface JsonRpcStdioClientOptions {
  /** Stream the server writes to (child stdout). */
  readonly input: Readable;
  /** Stream the server reads from (child stdin). */
  readonly output: Writable;
  /** Called for malformed lines, unmatched responses and handler failures. */
  readonly onProtocolError?: (error: NexarError) => void;
  /** Longest accepted line; a longer one is a protocol error and closes the client. */
  readonly maxLineChars?: number;
}

/** A server-to-client request (a message with both `method` and `id`). */
export interface JsonRpcServerRequest {
  readonly method: string;
  readonly params?: unknown;
}

/** What a request handler answers: a result, or a JSON-RPC error. */
export type JsonRpcReply =
  | { readonly result: unknown }
  | { readonly error: { readonly code: number; readonly message: string } };

/** Returns `undefined` for methods it does not handle (the client then answers `-32601`). */
export type JsonRpcRequestHandler = (
  request: JsonRpcServerRequest,
) => Promise<JsonRpcReply> | undefined;

interface Pending {
  readonly method: string;
  readonly resolve: (value: unknown) => void;
  readonly reject: (error: NexarError) => void;
  readonly cleanup: () => void;
}

const DEFAULT_MAX_LINE_CHARS = 16 * 1024 * 1024;

/** Minimal newline-delimited JSON-RPC 2.0 client over a pair of streams. */
export class JsonRpcStdioClient {
  private readonly input: Readable;
  private readonly output: Writable;
  private readonly onProtocolError: (error: NexarError) => void;
  private readonly maxLineChars: number;
  private readonly pending = new Map<number, Pending>();
  private readonly notificationHandlers = new Set<(n: JsonRpcNotification) => void>();
  private readonly closeHandlers = new Set<(error: NexarError) => void>();
  private requestHandler: JsonRpcRequestHandler | undefined;
  private nextId = 1;
  private buffer = '';
  private closedWith: NexarError | undefined;

  constructor(options: JsonRpcStdioClientOptions) {
    this.input = options.input;
    this.output = options.output;
    this.onProtocolError = options.onProtocolError ?? (() => undefined);
    this.maxLineChars = options.maxLineChars ?? DEFAULT_MAX_LINE_CHARS;

    this.input.setEncoding('utf8');
    this.input.on('data', (chunk: string) => this.receive(chunk));
    this.input.on('end', () => this.shutDown(closedError('runtime closed its output')));
    this.input.on('close', () => this.shutDown(closedError('runtime closed its output')));
    this.input.on('error', () => this.shutDown(closedError('runtime output stream failed')));
    // Writing to a dead child raises EPIPE on the stream; the write callback reports it.
    this.output.on('error', () => undefined);
  }

  get closed(): boolean {
    return this.closedWith !== undefined;
  }

  request<T = unknown>(
    method: string,
    params?: unknown,
    options: JsonRpcRequestOptions = {},
  ): Promise<T> {
    if (this.closedWith !== undefined) {
      return Promise.reject(this.closedWith);
    }
    if (options.signal?.aborted === true) {
      return Promise.reject(cancelled(method));
    }
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      let timer: NodeJS.Timeout | undefined;
      const onAbort = (): void => this.settle(id, { error: cancelled(method) });
      const cleanup = (): void => {
        if (timer !== undefined) clearTimeout(timer);
        options.signal?.removeEventListener('abort', onAbort);
      };
      this.pending.set(id, {
        method,
        resolve: (value) => resolve(value as T),
        reject,
        cleanup,
      });
      if (options.timeoutMs !== undefined) {
        timer = setTimeout(() => {
          this.settle(id, {
            error: new NexarError(
              'EXECUTION_TIMEOUT',
              `dsh did not answer '${method}' within ${String(options.timeoutMs)} ms`,
              { details: { method } },
            ),
          });
        }, options.timeoutMs);
      }
      options.signal?.addEventListener('abort', onAbort, { once: true });

      const message =
        params === undefined
          ? { jsonrpc: '2.0', id, method }
          : { jsonrpc: '2.0', id, method, params };
      this.output.write(`${JSON.stringify(message)}\n`, (err) => {
        if (err) {
          this.settle(id, {
            error: new NexarError('PROVIDER_ERROR', `could not write '${method}' to dsh`, {
              cause: err,
              details: { reason: 'closed' },
            }),
          });
        }
      });
    });
  }

  /** Sends a notification (no `id`, no response). Rejects with `closed` if the client is closed. */
  notify(method: string, params?: unknown): Promise<void> {
    if (this.closedWith !== undefined) return Promise.reject(this.closedWith);
    const message =
      params === undefined ? { jsonrpc: '2.0', method } : { jsonrpc: '2.0', method, params };
    return new Promise((resolve, reject) => {
      this.output.write(`${JSON.stringify(message)}\n`, (err) => {
        if (err) {
          reject(
            new NexarError('PROVIDER_ERROR', `could not write '${method}' to dsh`, {
              cause: err,
              details: { reason: 'closed' },
            }),
          );
        } else {
          resolve();
        }
      });
    });
  }

  /** Installs the handler for server-to-client requests. Without one every request gets `-32601`. */
  setRequestHandler(handler: JsonRpcRequestHandler | undefined): void {
    this.requestHandler = handler;
  }

  /** Registers a notification handler; returns an unsubscribe function. */
  onNotification(handler: (notification: JsonRpcNotification) => void): () => void {
    this.notificationHandlers.add(handler);
    return () => this.notificationHandlers.delete(handler);
  }

  /** Registers a handler run once when the connection ends; fires immediately if already closed. */
  onClose(handler: (error: NexarError) => void): () => void {
    if (this.closedWith !== undefined) {
      handler(this.closedWith);
      return () => undefined;
    }
    this.closeHandlers.add(handler);
    return () => this.closeHandlers.delete(handler);
  }

  /** Stops the client: rejects pending requests and ends the output stream. */
  close(): void {
    this.shutDown(closedError('client closed'));
    if (!this.output.destroyed && !this.output.writableEnded) {
      this.output.end();
    }
  }

  private receive(chunk: string): void {
    this.buffer += chunk;
    let newline = this.buffer.indexOf('\n');
    while (newline !== -1) {
      const line = this.buffer.slice(0, newline).trim();
      this.buffer = this.buffer.slice(newline + 1);
      if (line.length > 0) this.handleLine(line);
      newline = this.buffer.indexOf('\n');
    }
    if (this.buffer.length > this.maxLineChars) {
      this.buffer = '';
      this.protocolError('dsh sent a line longer than the allowed maximum');
      this.shutDown(closedError('protocol violation: oversized line'));
    }
  }

  private handleLine(line: string): void {
    let message: unknown;
    try {
      message = JSON.parse(line);
    } catch {
      // Never echo the line: it may carry prompt or model content.
      this.protocolError('dsh sent a line that is not valid JSON');
      return;
    }
    if (typeof message !== 'object' || message === null || Array.isArray(message)) {
      this.protocolError('dsh sent a JSON value that is not an object');
      return;
    }
    const msg = message as Record<string, unknown>;
    const hasId = msg.id !== undefined && msg.id !== null;

    if (typeof msg.method === 'string') {
      if (hasId) {
        this.handleServerRequest(msg.id, msg.method, msg.params);
      } else {
        this.dispatchNotification({ method: msg.method, params: msg.params });
      }
      return;
    }
    if (typeof msg.id !== 'number' || !this.pending.has(msg.id)) {
      this.protocolError('dsh sent a response that matches no pending request');
      return;
    }
    const id = msg.id;
    if (msg.error !== undefined) {
      const rpc: { code?: unknown; message?: unknown } =
        typeof msg.error === 'object' ? { ...msg.error } : {};
      const text = typeof rpc.message === 'string' ? rpc.message.slice(0, 300) : 'unknown error';
      const code = typeof rpc.code === 'number' ? rpc.code : undefined;
      this.settle(id, {
        error: new NexarError('PROVIDER_ERROR', `dsh rejected the request: ${text}`, {
          details: { rpcCode: code },
        }),
      });
    } else if ('result' in msg) {
      this.settle(id, { result: msg.result });
    } else {
      this.protocolError('dsh sent a response with neither result nor error');
    }
  }

  private dispatchNotification(notification: JsonRpcNotification): void {
    for (const handler of [...this.notificationHandlers]) {
      try {
        handler(notification);
      } catch (e) {
        this.onProtocolError(
          new NexarError('INTERNAL_ERROR', 'a notification handler threw', { cause: e }),
        );
      }
    }
  }

  private rejectServerRequest(id: unknown, method: string): void {
    this.reply(id, { error: { code: -32601, message: `Method not found: ${method}` } });
  }

  private handleServerRequest(id: unknown, method: string, params: unknown): void {
    let pending: Promise<JsonRpcReply> | undefined;
    try {
      pending = this.requestHandler?.({ method, params });
    } catch {
      pending = Promise.resolve({ error: { code: -32603, message: 'Internal error' } });
    }
    if (pending === undefined) {
      this.rejectServerRequest(id, method);
      return;
    }
    // A handler that throws must fail closed: report an error, never an empty success.
    void pending
      .catch((): JsonRpcReply => ({ error: { code: -32603, message: 'Internal error' } }))
      .then((reply) => this.reply(id, reply));
  }

  private reply(id: unknown, reply: JsonRpcReply): void {
    if (this.closedWith !== undefined || this.output.destroyed || this.output.writableEnded) return;
    this.output.write(`${JSON.stringify({ jsonrpc: '2.0', id, ...reply })}\n`, () => undefined);
  }

  /** A protocol violation poisons every in-flight request: fail closed. */
  private protocolError(message: string): void {
    const error = new NexarError('PROVIDER_ERROR', message, { details: { reason: 'protocol' } });
    this.onProtocolError(error);
    for (const id of [...this.pending.keys()]) {
      this.settle(id, { error });
    }
  }

  private shutDown(error: NexarError): void {
    if (this.closedWith !== undefined) return;
    this.closedWith = error;
    for (const id of [...this.pending.keys()]) {
      this.settle(id, { error });
    }
    for (const handler of [...this.closeHandlers]) {
      handler(error);
    }
    this.closeHandlers.clear();
    this.notificationHandlers.clear();
  }

  private settle(id: number, outcome: { result: unknown } | { error: NexarError }): void {
    const entry = this.pending.get(id);
    if (entry === undefined) return;
    this.pending.delete(id);
    entry.cleanup();
    if ('error' in outcome) entry.reject(outcome.error);
    else entry.resolve(outcome.result);
  }
}

function closedError(message: string): NexarError {
  return new NexarError('PROVIDER_ERROR', `dsh connection closed: ${message}`, {
    details: { reason: 'closed' },
  });
}

function cancelled(method: string): NexarError {
  return new NexarError('EXECUTION_CANCELLED', `request '${method}' was cancelled`, {
    details: { method },
  });
}
