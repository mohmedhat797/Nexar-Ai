import { NexarError } from '@nexar/contracts';

const REQUEST_TIMEOUT_MS = 10_000;
const MAX_RESPONSE_BYTES = 64 * 1024;
/** The only place that knows the auth header and WebSocket subprotocol names of the upstream. */
const TOKEN_HEADER = 'X-OpenWorker-Token';
const SUBPROTOCOL = 'openworker';

/** A session socket reduced to what a turn needs; `data` is the raw frame as received. */
export interface OpenWorkerConnection {
  send(text: string): void;
  close(): void;
  onMessage(handler: (data: unknown) => void): void;
  onClose(handler: () => void): void;
}

/** A stdio MCP server entry for OpenWorker's `/v1/mcp`. `env` values may be secrets: never logged. */
export interface McpServerLaunch {
  readonly command: string;
  readonly args: readonly string[];
  readonly env: Readonly<Record<string, string>>;
}

export interface OpenWorkerClient {
  registerMcpServer(name: string, launch: McpServerLaunch): Promise<void>;
  deleteMcpServer(name: string): Promise<void>;
  attachRoot(sessionId: string, path: string, writable: boolean): Promise<void>;
  openSession(
    sessionId: string,
    options: { readonly persona?: string; readonly workspace: string },
  ): OpenWorkerConnection;
}

export interface OpenWorkerHttpOptions {
  readonly port: number;
  readonly token: string;
  readonly fetchImpl?: typeof fetch;
  readonly webSocketImpl?: typeof WebSocket;
}

function unavailable(): NexarError {
  // Never carries a URL, status body, token or payload.
  return new NexarError('INTEGRATION_UNAVAILABLE', 'OpenWorker request failed');
}

/** Loopback-only HTTP + WebSocket client for one supervised server; the token stays in memory. */
export class OpenWorkerHttpClient implements OpenWorkerClient {
  readonly #port: number;
  readonly #token: string;
  readonly #fetch: typeof fetch;
  readonly #WebSocket: typeof WebSocket;

  constructor(options: OpenWorkerHttpOptions) {
    if (!Number.isInteger(options.port) || options.port < 1 || options.port > 65_535) {
      throw new NexarError('VALIDATION_ERROR', 'Invalid OpenWorker port');
    }
    this.#port = options.port;
    this.#token = options.token;
    this.#fetch = options.fetchImpl ?? fetch;
    this.#WebSocket = options.webSocketImpl ?? WebSocket;
  }

  /** Resolves the parsed JSON body (or `undefined` when empty); rejects without detail on non-2xx. */
  async request(method: 'GET' | 'POST' | 'DELETE', path: string, body?: unknown): Promise<unknown> {
    let response: Response;
    try {
      response = await this.#fetch(`http://127.0.0.1:${this.#port}${path}`, {
        method,
        headers: {
          [TOKEN_HEADER]: this.#token,
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        redirect: 'error',
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch {
      throw unavailable();
    }
    if (!response.ok) {
      void response.body?.cancel().catch(() => undefined);
      throw unavailable();
    }
    const text = (await response.text().catch(() => '')).slice(0, MAX_RESPONSE_BYTES);
    if (text === '') return undefined;
    try {
      return JSON.parse(text) as unknown;
    } catch {
      return undefined;
    }
  }

  async health(): Promise<boolean> {
    try {
      const body = await this.request('GET', '/v1/health');
      return (
        typeof body === 'object' && body !== null && (body as { status?: unknown }).status === 'ok'
      );
    } catch {
      return false;
    }
  }

  async attachRoot(sessionId: string, path: string, writable: boolean): Promise<void> {
    await this.request('POST', `/v1/sessions/${encodeURIComponent(sessionId)}/roots`, {
      path,
      writable,
    });
  }

  /**
   * Registers a stdio MCP server. Every tool of it needs approval upstream (the policy then allows
   * only the exact bridge tools). The entry holds the turn's token: delete it after the turn.
   */
  async registerMcpServer(name: string, launch: McpServerLaunch): Promise<void> {
    await this.request('POST', '/v1/mcp', {
      name,
      config: {
        command: launch.command,
        args: [...launch.args],
        env: { ...launch.env },
        requires_approval: true,
      },
    });
  }

  async deleteMcpServer(name: string): Promise<void> {
    await this.request('DELETE', `/v1/mcp/${encodeURIComponent(name)}`);
  }

  openSession(
    sessionId: string,
    options: { readonly persona?: string; readonly workspace: string },
  ): OpenWorkerConnection {
    const query = new URLSearchParams({ workspace: options.workspace });
    if (options.persona !== undefined) query.set('agent', options.persona);
    const socket = new this.#WebSocket(
      `ws://127.0.0.1:${this.#port}/ws/session/${encodeURIComponent(sessionId)}?${query.toString()}`,
      [SUBPROTOCOL, this.#token],
    );
    socket.binaryType = 'arraybuffer';
    return {
      send: (text) => socket.send(text),
      close: () => {
        try {
          socket.close();
        } catch {
          /* Already closed. */
        }
      },
      onMessage: (handler) => socket.addEventListener('message', (event) => handler(event.data)),
      onClose: (handler) => {
        // A failed handshake (wrong token) surfaces as error then close; both end the turn.
        socket.addEventListener('close', () => handler());
        socket.addEventListener('error', () => handler());
      },
    };
  }
}
