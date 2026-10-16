import { spawn as nodeSpawn, type ChildProcess } from 'node:child_process';
import { NexarError, type Logger } from '@nexar/contracts';
import { parseGatewayExit } from '../control-gateway/exit-diagnostic.js';
import { controlGatewayLaunch, type ControlGatewayLaunch } from './control-gateway-path.js';

/*
 * Supervises the loopback Chat Completions translator (ADR-027 section 7A). Desktop main opens no
 * listener itself: the HTTP server lives in this child, bound to 127.0.0.1 on an ephemeral port. The
 * child is started on first need, restarted once after a crash, and ended at quit. Its only input is
 * the bridge endpoint path (one JSON line on stdin); it holds no key or token.
 *
 * Diagnostics: the child's stderr is always drained, and only its last bytes are kept. When the child
 * ends, the one well-formed `nexarGatewayExit` line in them (phase and short code, see
 * control-gateway/exit-diagnostic.ts) is logged beside fixed fields. Raw stderr text is never logged.
 */

const MAX_LINE_CHARS = 1024;
/** The most stderr kept in memory: only the last line can carry the exit diagnostic. */
const MAX_STDERR_TAIL_BYTES = 4096;
/** After the child exits, how long to wait for its stdio to close before logging what was read. */
const STDIO_FLUSH_GRACE_MS = 250;

export interface ControlGatewayChildOptions {
  /** The bridge endpoint path; starts the endpoint when it is not running yet. */
  readonly endpoint: () => Promise<string>;
  readonly logger: Logger;
  readonly launch?: ControlGatewayLaunch;
  readonly spawn?: typeof nodeSpawn;
  /** Bound on the child printing its `{ port }` line. Default 10 s. */
  readonly startTimeoutMs?: number;
  /** Grace after closing stdin before the child is killed. Default 2 s. */
  readonly stopGraceMs?: number;
  /** Monotonic milliseconds for `elapsedMs` in the diagnostic logs. Default `performance.now`. */
  readonly now?: () => number;
}

/** Why a start did not produce a port. */
type StartFailure = 'timeout' | 'exited-before-ready' | 'invalid-ready-line';
type PortOutcome = { readonly port: number } | { readonly failure: StartFailure };

interface Running {
  readonly child: ChildProcess;
  readonly port: number;
  readonly exited: Promise<void>;
}

const unavailable = (): NexarError =>
  new NexarError('INTEGRATION_UNAVAILABLE', 'The control gateway is not available');

/** Resolves when `promise` does, or after `ms`, whichever is first. */
function settledWithin(promise: Promise<void>, ms: number): Promise<void> {
  return new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref();
    void promise.then(() => {
      clearTimeout(timer);
      resolve();
    });
  });
}

/**
 * What is known about one spawned child, reduced to the fixed log fields. The bounded stderr tail never
 * leaves this class as text: only a validated phase and code do.
 */
class ChildDiagnostics {
  /** Whether the `{ port }` line was read. */
  ready = false;
  private readonly startedAt: number;
  private tail: Buffer = Buffer.alloc(0);
  private ended:
    | {
        readonly exitCode: number | null;
        readonly signal: string | null;
        readonly elapsedMs: number;
      }
    | undefined;

  constructor(private readonly now: () => number) {
    this.startedAt = now();
  }

  /** Keeps at most the last `MAX_STDERR_TAIL_BYTES` bytes. */
  pushStderr(chunk: Buffer | string): void {
    const joined = Buffer.concat([
      this.tail,
      typeof chunk === 'string' ? Buffer.from(chunk) : chunk,
    ]);
    this.tail =
      joined.length > MAX_STDERR_TAIL_BYTES
        ? Buffer.from(joined.subarray(joined.length - MAX_STDERR_TAIL_BYTES))
        : joined;
  }

  /** The first end wins: the process exited, or could not run at all (both nulls). */
  noteExit(code: unknown, signal: unknown): void {
    this.ended ??= {
      exitCode: typeof code === 'number' ? code : null,
      signal: typeof signal === 'string' ? signal : null,
      elapsedMs: this.elapsedMs(),
    };
  }

  /** Fixed fields only; exit facts and phase/code appear when known. */
  fields(crashes: number): Record<string, unknown> {
    const parsed = parseGatewayExit(this.tail.toString('utf8'));
    return {
      crashes,
      ...(this.ended === undefined
        ? {}
        : { exitCode: this.ended.exitCode, signal: this.ended.signal }),
      ready: this.ready,
      elapsedMs: this.ended?.elapsedMs ?? this.elapsedMs(),
      ...(parsed === undefined ? {} : { phase: parsed.phase, code: parsed.code }),
    };
  }

  private elapsedMs(): number {
    return Math.max(0, Math.round(this.now() - this.startedAt));
  }
}

export class ControlGatewayChild {
  private starting: Promise<Running> | undefined;
  private running: Running | undefined;
  private crashes = 0;
  private stopped = false;

  constructor(private readonly options: ControlGatewayChildOptions) {}

  /** The OpenAI-compatible base URL (ends in `/v1`); starts the child on first need. */
  async baseUrl(): Promise<string> {
    if (this.stopped) throw unavailable();
    // A crash is retried once: the next caller gets a fresh child (and a fresh port).
    if (this.running === undefined && this.crashes > 1) throw unavailable();
    this.starting ??= this.start().then(
      (running) => {
        this.running = running;
        return running;
      },
      (error: unknown) => {
        this.starting = undefined;
        throw error;
      },
    );
    const { port } = await this.starting;
    return `http://127.0.0.1:${String(port)}/v1`;
  }

  /** Ends the child; safe to call twice, and nothing starts afterwards. */
  async stop(): Promise<void> {
    this.stopped = true;
    const pending = this.starting;
    this.starting = undefined;
    const running = this.running ?? (await pending?.catch(() => undefined));
    this.running = undefined;
    if (running === undefined) return;
    running.child.stdin?.end();
    const grace = setTimeout(() => running.child.kill(), this.options.stopGraceMs ?? 2_000);
    await running.exited;
    clearTimeout(grace);
  }

  private async start(): Promise<Running> {
    const endpoint = await this.options.endpoint();
    if (this.stopped) throw unavailable();
    const launch = this.options.launch ?? controlGatewayLaunch();
    const diagnostics = new ChildDiagnostics(this.options.now ?? (() => performance.now()));
    const child = (this.options.spawn ?? nodeSpawn)(launch.command, [...launch.args], {
      env: { ...launch.env },
      // stderr is piped only so it can be drained into a bounded tail (see the header comment).
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    child.stderr?.on('data', (chunk: Buffer | string) => diagnostics.pushStderr(chunk));
    child.stderr?.on('error', () => undefined);
    const closed = new Promise<void>((resolve) => {
      child.once('close', () => resolve());
    });
    const exited = new Promise<void>((resolve) => {
      child.once('exit', (code: number | null, signal: string | null) => {
        diagnostics.noteExit(code, signal);
        resolve();
      });
      child.once('error', () => {
        diagnostics.noteExit(null, null);
        resolve();
      });
    });
    // 'exit' can come before the last stderr bytes are read: log once stdio closed, or after a short grace
    // (a grandchild may hold the pipe open). Only the log waits; the state changes below do not.
    const flushed = exited.then(() => settledWithin(closed, STDIO_FLUSH_GRACE_MS));
    void exited.then(() => {
      if (this.running?.child !== child) return;
      this.running = undefined;
      this.starting = undefined;
      if (!this.stopped) {
        this.crashes += 1;
        const crashes = this.crashes;
        void flushed.then(() =>
          this.options.logger.warn('control-gateway.exited', diagnostics.fields(crashes)),
        );
      }
    });
    child.stdin?.on('error', () => undefined);
    child.stdin?.write(`${JSON.stringify({ endpoint })}\n`);
    const outcome = await this.readPort(child, exited, diagnostics);
    if ('failure' in outcome) {
      const { crashes } = this;
      if (outcome.failure === 'exited-before-ready') {
        // The exit is known and the diagnostic line may still be in flight.
        void flushed.then(() => this.logStartFailed(outcome.failure, diagnostics.fields(crashes)));
      } else {
        this.logStartFailed(outcome.failure, diagnostics.fields(crashes));
      }
      child.kill();
      throw unavailable();
    }
    return { child, port: outcome.port, exited };
  }

  private logStartFailed(cause: StartFailure, fields: Record<string, unknown>): void {
    this.options.logger.warn('control-gateway.start-failed', { cause, ...fields });
  }

  private readPort(
    child: ChildProcess,
    exited: Promise<void>,
    diagnostics: ChildDiagnostics,
  ): Promise<PortOutcome> {
    return new Promise<PortOutcome>((resolve) => {
      let buffered = '';
      const timer = setTimeout(() => settle('timeout'), this.options.startTimeoutMs ?? 10_000);
      const settle = (result: number | StartFailure): void => {
        clearTimeout(timer);
        child.stdout?.off('data', onData);
        if (typeof result === 'number') {
          diagnostics.ready = true;
          resolve({ port: result });
        } else {
          resolve({ failure: result });
        }
      };
      const onData = (chunk: Buffer | string): void => {
        buffered += chunk.toString();
        const end = buffered.indexOf('\n');
        if (end === -1) {
          if (buffered.length > MAX_LINE_CHARS) settle('invalid-ready-line');
          return;
        }
        try {
          const { port } = JSON.parse(buffered.slice(0, end)) as { port?: unknown };
          settle(
            Number.isInteger(port) && (port as number) > 0 && (port as number) < 65536
              ? (port as number)
              : 'invalid-ready-line',
          );
        } catch {
          settle('invalid-ready-line');
        }
      };
      child.stdout?.on('data', onData);
      void exited.then(() => settle('exited-before-ready'));
    });
  }
}
