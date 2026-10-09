import { spawn as nodeSpawn, type ChildProcess } from 'node:child_process';
import { z } from 'zod';
import { NexarError } from '@nexar/contracts';
import type { ControlGatewayLaunch } from './control-gateway-path.js';
import { signinCallbackLaunch } from './signin-callback-path.js';

/*
 * Supervises the per-sign-in loopback callback child (ADR-021: Desktop main opens no listener). One
 * child per sign-in; it is always ended, by the caller (`stop`), by an abort, or because it exits by
 * itself after its one answer. The child holds no token and prints no secret of Nexar's.
 */

const MAX_LINE_CHARS = 4096;

export type SigninCallbackResult =
  | { readonly code: string; readonly clientId: string }
  | {
      readonly error: 'denied' | 'state-mismatch' | 'invalid-callback' | 'timeout' | 'failed';
    };

export interface SigninCallbackSession {
  readonly port: number;
  /** Settles once: the child's single answer, or `failed` when it ended without one. */
  readonly result: Promise<SigninCallbackResult>;
  /** Ends the child; safe to call repeatedly. */
  stop(): Promise<void>;
}

export interface SigninCallbackOptions {
  readonly launch?: ControlGatewayLaunch;
  readonly spawn?: typeof nodeSpawn;
  /** Bound on the child printing its `{ port }` line. Default 10 s. */
  readonly startTimeoutMs?: number;
  /** Grace after closing stdin before the child is killed. Default 2 s. */
  readonly stopGraceMs?: number;
  /** How long the child waits for the browser. Default and maximum 10 minutes. */
  readonly timeoutMs?: number;
}

const PortLine = z.strictObject({ port: z.number().int().min(1).max(65535) });
const ResultLine = z.union([
  z.strictObject({
    code: z.string().min(1).max(2048),
    clientId: z.string().min(1).max(128),
  }),
  z.strictObject({
    error: z.enum(['denied', 'state-mismatch', 'invalid-callback', 'timeout']),
  }),
]);

const unavailable = (): NexarError =>
  new NexarError('INTEGRATION_UNAVAILABLE', 'The sign-in callback is not available');

export class SigninCallbackSupervisor {
  constructor(private readonly options: SigninCallbackOptions = {}) {}

  async begin(state: string, signal: AbortSignal): Promise<SigninCallbackSession> {
    if (signal.aborted) throw unavailable();
    const launch = this.options.launch ?? signinCallbackLaunch();
    const child = (this.options.spawn ?? nodeSpawn)(launch.command, [...launch.args], {
      env: { ...launch.env },
      stdio: ['pipe', 'pipe', 'ignore'],
      windowsHide: true,
    });
    const exited = new Promise<void>((resolve) => {
      child.once('exit', () => resolve());
      child.once('error', () => resolve());
    });
    let stopping: Promise<void> | undefined;
    const stop = (): Promise<void> => {
      stopping ??= (async () => {
        child.stdin?.end();
        const grace = setTimeout(() => child.kill(), this.options.stopGraceMs ?? 2_000);
        await exited;
        clearTimeout(grace);
      })();
      return stopping;
    };
    const onAbort = (): void => void stop();
    signal.addEventListener('abort', onAbort, { once: true });
    void exited.then(() => signal.removeEventListener('abort', onAbort));

    child.stdin?.on('error', () => undefined);
    child.stdin?.write(
      `${JSON.stringify({ state, ...(this.options.timeoutMs === undefined ? {} : { timeoutMs: this.options.timeoutMs }) })}\n`,
    );
    try {
      const { port, result } = await this.read(child);
      return { port, result, stop };
    } catch (error) {
      await stop().catch(() => undefined);
      throw error;
    }
  }

  private read(
    child: ChildProcess,
  ): Promise<{ port: number; result: Promise<SigninCallbackResult> }> {
    let buffered = '';
    let port: number | undefined;
    let settleResult: (value: SigninCallbackResult) => void = () => undefined;
    const result = new Promise<SigninCallbackResult>((resolve) => {
      settleResult = resolve;
    });
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(unavailable()), this.options.startTimeoutMs ?? 10_000);
      const fail = (): void => {
        clearTimeout(timer);
        child.stdout?.off('data', onData);
        if (port === undefined) reject(unavailable());
        settleResult({ error: 'failed' });
      };
      const onLine = (line: string): void => {
        let value: unknown;
        try {
          value = JSON.parse(line);
        } catch {
          fail();
          return;
        }
        if (port === undefined) {
          const parsed = PortLine.safeParse(value);
          if (!parsed.success) {
            fail();
            return;
          }
          port = parsed.data.port;
          clearTimeout(timer);
          resolve({ port, result });
          return;
        }
        const parsed = ResultLine.safeParse(value);
        child.stdout?.off('data', onData);
        settleResult(parsed.success ? parsed.data : { error: 'failed' });
      };
      const onData = (chunk: Buffer | string): void => {
        buffered += chunk.toString();
        for (let end = buffered.indexOf('\n'); end !== -1; end = buffered.indexOf('\n')) {
          const line = buffered.slice(0, end);
          buffered = buffered.slice(end + 1);
          onLine(line);
        }
        if (buffered.length > MAX_LINE_CHARS) fail();
      };
      child.stdout?.on('data', onData);
      // `close` follows `exit` once stdout has been drained, so a final line is never missed.
      child.once('close', fail);
      child.once('error', fail);
    });
  }
}
