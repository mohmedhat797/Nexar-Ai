import { spawn as nodeSpawn, type ChildProcess } from 'node:child_process';
import { NexarError, type Logger } from '@nexar/contracts';
import { controlGatewayLaunch, type ControlGatewayLaunch } from './control-gateway-path.js';

/*
 * Supervises the loopback Chat Completions translator (ADR-027 section 7A). Desktop main opens no
 * listener itself: the HTTP server lives in this child, bound to 127.0.0.1 on an ephemeral port. The
 * child is started on first need, restarted once after a crash, and ended at quit. Its only input is
 * the bridge endpoint path (one JSON line on stdin); it holds no key or token.
 */

const MAX_LINE_CHARS = 1024;

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
}

interface Running {
  readonly child: ChildProcess;
  readonly port: number;
  readonly exited: Promise<void>;
}

const unavailable = (): NexarError =>
  new NexarError('INTEGRATION_UNAVAILABLE', 'The control gateway is not available');

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
    const child = (this.options.spawn ?? nodeSpawn)(launch.command, [...launch.args], {
      env: { ...launch.env },
      stdio: ['pipe', 'pipe', 'ignore'],
      windowsHide: true,
    });
    const exited = new Promise<void>((resolve) => {
      child.once('exit', () => resolve());
      child.once('error', () => resolve());
    });
    void exited.then(() => {
      if (this.running?.child !== child) return;
      this.running = undefined;
      this.starting = undefined;
      if (!this.stopped) {
        this.crashes += 1;
        this.options.logger.warn('control-gateway.exited', { crashes: this.crashes });
      }
    });
    child.stdin?.on('error', () => undefined);
    child.stdin?.write(`${JSON.stringify({ endpoint })}\n`);
    try {
      const port = await this.readPort(child, exited);
      return { child, port, exited };
    } catch (error) {
      child.kill();
      throw error;
    }
  }

  private readPort(child: ChildProcess, exited: Promise<void>): Promise<number> {
    return new Promise<number>((resolve, reject) => {
      let buffered = '';
      const timer = setTimeout(() => reject(unavailable()), this.options.startTimeoutMs ?? 10_000);
      const settle = (port: number | undefined): void => {
        clearTimeout(timer);
        child.stdout?.off('data', onData);
        if (port === undefined) reject(unavailable());
        else resolve(port);
      };
      const onData = (chunk: Buffer | string): void => {
        buffered += chunk.toString();
        const end = buffered.indexOf('\n');
        if (end === -1) {
          if (buffered.length > MAX_LINE_CHARS) settle(undefined);
          return;
        }
        try {
          const { port } = JSON.parse(buffered.slice(0, end)) as { port?: unknown };
          settle(
            Number.isInteger(port) && (port as number) > 0 && (port as number) < 65536
              ? (port as number)
              : undefined,
          );
        } catch {
          settle(undefined);
        }
      };
      child.stdout?.on('data', onData);
      void exited.then(() => settle(undefined));
    });
  }
}
