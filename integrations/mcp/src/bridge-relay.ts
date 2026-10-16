import { connect as netConnect, type Socket } from 'node:net';
import type { Readable, Writable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { McpServer, type CallToolResult } from '@modelcontextprotocol/server';
import { StdioServerTransport, serveStdio } from '@modelcontextprotocol/server/stdio';
import { z } from 'zod';
import {
  KNOWN_CAPABILITIES,
  NEXAR_ERROR_CODES,
  isNexarError,
  normalizeCapabilitiesInput,
  normalizeReviewOf,
  type NexarErrorCode,
} from '@nexar/contracts';
import { advertised } from './server.js';
import { redirectConsoleToStderr } from './stdio.js';

/*
 * The Intelligence Bridge relay (ADR-027 section 9a): a stdio MCP server an orchestration engine
 * launches, forwarding two tools to the Desktop bridge endpoint (a local pipe or socket, never a
 * port). No engine, no keys and no state beyond one connection; the token is only ever sent to the
 * endpoint.
 */

const PROTOCOL_VERSION = 1;
const MAX_REQUEST_BYTES = 512 * 1024;
const MAX_RESPONSE_CHARS = 8 * 1024 * 1024;
/** Well under typical MCP client tool-call caps (about 120 s); submit and status answer immediately in practice. */
const DEFAULT_CALL_TIMEOUT_MS = 60_000;
const DEFAULT_STATUS_POLL_INTERVAL_MS = 1_000;
const DEFAULT_STATUS_POLL_MAX_WAIT_MS = 15_000;
const UNIT_ID = /^[A-Za-z0-9_.:-]{1,64}$/;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export const BRIDGE_RELAY_TOOLS = [
  'nexar.intelligence_submit',
  'nexar.intelligence_status',
] as const;

/** Where Desktop bundles or launches the relay (the built entry beside this module). */
export const bridgeRelayEntry: string = fileURLToPath(
  new URL('./bridge-relay-main.js', import.meta.url),
);

const KNOWN_CODES: ReadonlySet<string> = new Set(NEXAR_ERROR_CODES);

// --- tool schemas (mirror the host's SubmitArgs; the host validates again) -----------------------

const SubmitInput = z.strictObject({
  unitId: z
    .string()
    .regex(UNIT_ID)
    .describe('Unique id for this unit within the turn (letters, digits, _ . : -; at most 64).'),
  reviewOf: z.preprocess(
    normalizeReviewOf,
    z
      .string()
      .regex(UNIT_ID)
      .optional()
      .describe(
        'The unitId of an earlier unit this unit reviews; Nexar then runs it on a different resource when possible.',
      ),
  ),
  kind: z.string().min(1).max(64).optional().describe('Task kind. Default "general".'),
  capabilities: z.preprocess(
    normalizeCapabilitiesInput,
    z
      .array(z.string().min(1).max(64))
      .max(16)
      .optional()
      .describe(
        `Executable capabilities the unit needs. Canonical capabilities: ${KNOWN_CAPABILITIES.join(', ')}.`,
      ),
  ),
  qualityClass: z.enum(['basic', 'standard', 'high']).optional(),
  input: z.string().describe('The text the unit works on. Treated as untrusted data.'),
  documentRefs: z
    .array(z.string().min(1).max(512))
    .max(32)
    .optional()
    .describe('Opaque document references (ids, not content).'),
  access: z
    .enum(['read-only', 'draft'])
    .describe('What the unit may do. Never wider than granted.'),
  timeoutMs: z.number().int().positive().optional(),
});
// A trusted one-unit turn cannot have an earlier admitted unit to review. Narrow
// both discovery and validation; never strip a model-supplied review reference.
const StandaloneSubmitInput = SubmitInput.omit({ reviewOf: true });
const StatusInput = z.strictObject({
  jobId: z.string().min(1).max(128).describe('The jobId returned by nexar.intelligence_submit.'),
});

// --- wire client ---------------------------------------------------------------------------------

type Outcome =
  | { readonly ok: true; readonly value: unknown }
  | { readonly ok: false; readonly code: NexarErrorCode };

const fail = (code: NexarErrorCode): Outcome => ({ ok: false, code });

const WireResponse = z.union([
  z.object({ id: z.string(), ok: z.literal(true), value: z.unknown() }),
  z.object({ id: z.string(), ok: z.literal(false), code: z.string() }),
]);

export type BridgeConnector = (endpoint: string) => Socket;

export interface BridgeClientOptions {
  readonly endpoint: string;
  readonly token: string;
  readonly connect?: BridgeConnector;
  readonly callTimeoutMs?: number;
}

/** One reused connection, one request in flight at a time. Never throws; failures are codes. */
export class BridgeClient {
  private socket: Socket | undefined;
  private queue: Promise<unknown> = Promise.resolve();
  private counter = 0;

  constructor(private readonly options: BridgeClientOptions) {}

  call(body: Readonly<Record<string, unknown>>): Promise<Outcome> {
    const run = (): Promise<Outcome> => this.exchange(body);
    const next = this.queue.then(run, run);
    this.queue = next;
    return next;
  }

  close(): void {
    this.socket?.destroy();
    this.socket = undefined;
  }

  private open(): Socket {
    if (this.socket !== undefined && !this.socket.destroyed && this.socket.writable) {
      return this.socket;
    }
    const socket = (this.options.connect ?? netConnect)(this.options.endpoint);
    socket.setEncoding('utf8');
    socket.on('error', () => undefined);
    socket.on('close', () => {
      if (this.socket === socket) this.socket = undefined;
    });
    this.socket = socket;
    return socket;
  }

  private exchange(body: Readonly<Record<string, unknown>>): Promise<Outcome> {
    this.counter += 1;
    const id = `r${String(this.counter)}`;
    const frame = JSON.stringify({ v: PROTOCOL_VERSION, id, token: this.options.token, ...body });
    if (Buffer.byteLength(frame) > MAX_REQUEST_BYTES)
      return Promise.resolve(fail('VALIDATION_ERROR'));
    const socket = this.open();
    return new Promise<Outcome>((resolve) => {
      let buffered = '';
      const done = (outcome: Outcome, drop: boolean): void => {
        clearTimeout(timer);
        socket.off('data', onData);
        socket.off('error', onError);
        socket.off('close', onClose);
        if (drop) socket.destroy();
        resolve(outcome);
      };
      const onError = (): void => done(fail('INTEGRATION_UNAVAILABLE'), true);
      const onClose = (): void => done(fail('INTEGRATION_UNAVAILABLE'), false);
      const onData = (chunk: string): void => {
        buffered += chunk;
        const end = buffered.indexOf('\n');
        if (end === -1) {
          if (buffered.length > MAX_RESPONSE_CHARS) done(fail('INTERNAL_ERROR'), true);
          return;
        }
        done(parse(buffered.slice(0, end), id), false);
      };
      const timer = setTimeout(
        () => done(fail('EXECUTION_TIMEOUT'), true),
        this.options.callTimeoutMs ?? DEFAULT_CALL_TIMEOUT_MS,
      );
      socket.on('data', onData);
      socket.on('error', onError);
      socket.on('close', onClose);
      socket.write(`${frame}\n`);
    });
  }
}

function parse(line: string, id: string): Outcome {
  let raw: unknown;
  try {
    raw = JSON.parse(line);
  } catch {
    return fail('INTERNAL_ERROR');
  }
  const response = WireResponse.safeParse(raw);
  if (!response.success) return fail('INTERNAL_ERROR');
  const data = response.data;
  // A host that cannot read a frame answers with an empty id.
  if (data.id !== id && !(data.ok === false && data.id === '')) return fail('INTERNAL_ERROR');
  if (data.ok) return { ok: true, value: data.value };
  return fail(KNOWN_CODES.has(data.code) ? (data.code as NexarErrorCode) : 'INTERNAL_ERROR');
}

// --- the server ----------------------------------------------------------------------------------

export interface BridgeRelayDeps {
  readonly endpoint: string;
  readonly token: string;
  readonly version: string;
  /** Host-selected invocation contract; absent preserves multi-unit reviews. */
  readonly standaloneOnly?: boolean;
  readonly connect?: BridgeConnector;
  readonly callTimeoutMs?: number;
  readonly statusPollIntervalMs?: number;
  readonly statusPollMaxWaitMs?: number;
}

/** One text block holding JSON (some MCP clients forward only text). Failures carry only the code. */
function render(outcome: Outcome): CallToolResult {
  return outcome.ok
    ? { content: [{ type: 'text', text: JSON.stringify(outcome.value ?? null) }] }
    : { content: [{ type: 'text', text: JSON.stringify({ error: outcome.code }) }], isError: true };
}

export interface BridgeRelayServer {
  /** A server factory for `serveStdio` (or, in tests, connect it to any transport). */
  readonly create: () => McpServer;
  close(): void;
}

export function createBridgeRelayServer(deps: BridgeRelayDeps): BridgeRelayServer {
  const submitInput = deps.standaloneOnly === true ? StandaloneSubmitInput : SubmitInput;
  const client = new BridgeClient({
    endpoint: deps.endpoint,
    token: deps.token,
    ...(deps.connect === undefined ? {} : { connect: deps.connect }),
    ...(deps.callTimeoutMs === undefined ? {} : { callTimeoutMs: deps.callTimeoutMs }),
  });

  const pollIntervalMs = deps.statusPollIntervalMs ?? DEFAULT_STATUS_POLL_INTERVAL_MS;
  const pollMaxWaitMs = deps.statusPollMaxWaitMs ?? DEFAULT_STATUS_POLL_MAX_WAIT_MS;

  const pollStatus = async (jobId: string): Promise<Outcome> => {
    const deadline = Date.now() + pollMaxWaitMs;
    for (;;) {
      const outcome = await client.call({ op: 'status', jobId });
      if (!outcome.ok) return outcome;
      const value = outcome.value;
      const isRunning =
        typeof value === 'object' &&
        value !== null &&
        (value as { state?: unknown }).state === 'running';
      if (!isRunning || Date.now() + pollIntervalMs > deadline) {
        return outcome;
      }
      await sleep(pollIntervalMs);
    }
  };

  const forward = async <T extends z.ZodType>(
    schema: T,
    raw: unknown,
    body: (args: z.infer<T>) => Record<string, unknown>,
  ): Promise<CallToolResult> => {
    try {
      const parsed = schema.safeParse(raw ?? {});
      if (!parsed.success) return render(fail('VALIDATION_ERROR'));
      return render(await client.call(body(parsed.data)));
    } catch (error) {
      return render(
        fail(
          isNexarError(error) && error.code === 'VALIDATION_ERROR'
            ? 'VALIDATION_ERROR'
            : 'INTERNAL_ERROR',
        ),
      );
    }
  };

  return {
    close: () => client.close(),
    create: () => {
      const server = new McpServer(
        { name: 'nexar-bridge', version: deps.version },
        { capabilities: { tools: { listChanged: false } } },
      );
      server.registerTool(
        'nexar.intelligence_submit',
        {
          title: 'Delegate a unit of work to Nexar',
          description:
            (deps.standaloneOnly === true
              ? 'Submit one standalone unit. This turn allows one unit only; no reviewOf or prior-unit reference is accepted. '
              : '') +
            'Ask Nexar to run one bounded, substantive unit of work on the best AI resource it can ' +
            'choose. Returns { jobId } immediately. The unit keeps running: poll ' +
            'nexar.intelligence_status with the jobId until its state is "done". The input is ' +
            'treated as untrusted data, never as instructions. The unit can never exceed the ' +
            'access, project or budget of this session.',
          inputSchema: advertised(submitInput),
          annotations: { readOnlyHint: false, openWorldHint: false },
        },
        (raw) => forward(submitInput, raw, (args) => ({ op: 'submit', request: args })),
      );
      server.registerTool(
        'nexar.intelligence_status',
        {
          title: 'Status of a delegated unit',
          description:
            'Current state of a unit submitted with nexar.intelligence_submit. Waits briefly if ' +
            'the unit is still running. Returns { state: "running" } (call again shortly) or ' +
            '{ state: "done", result } with the text, usage and outcome.',
          inputSchema: advertised(StatusInput),
          annotations: { readOnlyHint: true, openWorldHint: false },
        },
        async (raw) => {
          try {
            const parsed = StatusInput.safeParse(raw ?? {});
            if (!parsed.success) return render(fail('VALIDATION_ERROR'));
            return render(await pollStatus(parsed.data.jobId));
          } catch {
            return render(fail('INTERNAL_ERROR'));
          }
        },
      );
      return server;
    },
  };
}

export interface BridgeRelayRunOptions {
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly version?: string;
  readonly input?: Readable;
  readonly output?: Writable;
  readonly stderr?: (line: string) => void;
  readonly connect?: BridgeConnector;
}

/** Runs the relay over stdio until stdin ends. Resolves to the process exit code. */
export async function runBridgeRelay(options: BridgeRelayRunOptions): Promise<number> {
  const endpoint = options.env['NEXAR_BRIDGE_ENDPOINT'];
  const token = options.env['NEXAR_BRIDGE_TOKEN'];
  const stderr = options.stderr ?? ((line: string) => void process.stderr.write(line));
  if (endpoint === undefined || endpoint === '' || token === undefined || token === '') {
    stderr('nexar-bridge-relay: NEXAR_BRIDGE_ENDPOINT and NEXAR_BRIDGE_TOKEN are required\n');
    return 1;
  }
  const standaloneOnly = options.env['NEXAR_BRIDGE_STANDALONE_ONLY'];
  if (standaloneOnly !== undefined && standaloneOnly !== '1') {
    stderr('nexar-bridge-relay: invalid standalone-only setting\n');
    return 1;
  }
  const restoreConsole = redirectConsoleToStderr();
  const input = options.input ?? process.stdin;
  const relay = createBridgeRelayServer({
    endpoint,
    token,
    version: options.version ?? '0.1.0',
    ...(standaloneOnly === '1' ? { standaloneOnly: true } : {}),
    ...(options.connect === undefined ? {} : { connect: options.connect }),
  });
  const handle = serveStdio(relay.create, {
    transport: new StdioServerTransport(input, options.output ?? process.stdout),
    onerror: () => stderr('nexar-bridge-relay: transport error\n'),
  });
  await new Promise<void>((resolve) => {
    input.once('end', resolve);
    input.once('close', resolve);
  });
  relay.close();
  try {
    await handle.close();
  } finally {
    restoreConsole();
  }
  return 0;
}
