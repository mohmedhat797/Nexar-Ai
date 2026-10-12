import type { ChildProcess, spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import type { LogFields, Logger } from '@nexar/contracts';
import { ControlGatewayChild } from './control-gateway-child.js';
import { silentLogger } from '@nexar/engine-gateway/testing';

class FakeChild extends EventEmitter {
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  killed = false;
  private ended = false;
  readonly config: Promise<unknown>;

  constructor() {
    super();
    this.config = new Promise((resolve) =>
      this.stdin.once('data', (chunk: Buffer) => resolve(JSON.parse(chunk.toString()))),
    );
    // Like the real child: exit when stdin closes.
    this.stdin.once('end', () => this.exit());
  }

  kill(): boolean {
    this.killed = true;
    // Killing a process that already ended does nothing.
    if (!this.ended) this.exit();
    return true;
  }

  /** The process ends ('exit'); its stdio may still hold unread bytes. */
  end(code: number | null = 0, signal: string | null = null): void {
    this.ended = true;
    this.emit('exit', code, signal);
  }

  /** Its stdio is done ('close'), which a real child reports after 'exit'. */
  closeStdio(code: number | null = 0, signal: string | null = null): void {
    this.emit('close', code, signal);
  }

  exit(code: number | null = 0, signal: string | null = null): void {
    this.end(code, signal);
    this.closeStdio(code, signal);
  }

  listen(port: number): void {
    this.stdout.write(`${JSON.stringify({ port })}\n`);
  }
}

function setup(
  options: {
    startTimeoutMs?: number;
    stopGraceMs?: number;
    logger?: Logger;
    now?: () => number;
  } = {},
) {
  const children: FakeChild[] = [];
  const spawned: { command: string; args: readonly string[]; env: unknown }[] = [];
  const stdio: unknown[] = [];
  const fakeSpawn = ((
    command: string,
    args: readonly string[],
    opts: { env: unknown; stdio?: unknown },
  ) => {
    spawned.push({ command, args, env: opts.env });
    stdio.push(opts.stdio);
    const child = new FakeChild();
    children.push(child);
    return child as unknown as ChildProcess;
  }) as unknown as typeof spawn;
  const child = new ControlGatewayChild({
    endpoint: () => Promise.resolve('\\\\.\\pipe\\bridge-test'),
    logger: silentLogger,
    launch: { command: 'node', args: ['gateway.cjs'], env: { ELECTRON_RUN_AS_NODE: '1' } },
    spawn: fakeSpawn,
    ...options,
  });
  return { child, children, spawned, stdio };
}

interface LogCall {
  readonly level: 'debug' | 'info' | 'warn' | 'error';
  readonly message: string;
  readonly fields: LogFields | undefined;
}

/** A logger that keeps every call, so a test can look at exactly what was logged. */
function recordingLogger(): { readonly logger: Logger; readonly calls: LogCall[] } {
  const calls: LogCall[] = [];
  const at =
    (level: LogCall['level']) =>
    (message: string, fields?: LogFields): void => {
      calls.push({ level, message, fields });
    };
  const logger: Logger = {
    debug: at('debug'),
    info: at('info'),
    warn: at('warn'),
    error: at('error'),
    child: () => logger,
  };
  return { logger, calls };
}

/** Lets the supervisor attach its listeners before the fake child reports. */
const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 5));

describe('ControlGatewayChild', () => {
  it('starts on first need with a minimal env and the endpoint on stdin', async () => {
    const { child, children, spawned } = setup();
    expect(children).toHaveLength(0);
    const url = child.baseUrl();
    await tick();
    const [fake] = children;
    expect(await fake?.config).toEqual({ endpoint: '\\\\.\\pipe\\bridge-test' });
    fake?.listen(4321);
    expect(await url).toBe('http://127.0.0.1:4321/v1');
    expect(spawned).toEqual([
      { command: 'node', args: ['gateway.cjs'], env: { ELECTRON_RUN_AS_NODE: '1' } },
    ]);
    // Later calls share the same child.
    expect(await child.baseUrl()).toBe('http://127.0.0.1:4321/v1');
    expect(children).toHaveLength(1);
    await child.stop();
  });

  it('restarts once after a crash, then gives up', async () => {
    const { child, children } = setup();
    const first = child.baseUrl();
    await tick();
    children[0]?.listen(1111);
    await first;

    children[0]?.exit();
    await tick();
    const second = child.baseUrl();
    await tick();
    expect(children).toHaveLength(2);
    children[1]?.listen(2222);
    expect(await second).toBe('http://127.0.0.1:2222/v1');

    children[1]?.exit();
    await tick();
    await expect(child.baseUrl()).rejects.toMatchObject({ code: 'INTEGRATION_UNAVAILABLE' });
    expect(children).toHaveLength(2);
  });

  it('fails when the child exits before reporting a port, or reports garbage', async () => {
    const early = setup();
    const url = early.child.baseUrl();
    await tick();
    early.children[0]?.exit();
    await expect(url).rejects.toMatchObject({ code: 'INTEGRATION_UNAVAILABLE' });

    const garbage = setup();
    const bad = garbage.child.baseUrl();
    await tick();
    garbage.children[0]?.stdout.write('{"port":"x"}\n');
    await expect(bad).rejects.toMatchObject({ code: 'INTEGRATION_UNAVAILABLE' });
  });

  it('fails when the child never reports within the start timeout', async () => {
    const { child, children } = setup({ startTimeoutMs: 20 });
    await expect(child.baseUrl()).rejects.toMatchObject({ code: 'INTEGRATION_UNAVAILABLE' });
    expect(children[0]?.killed).toBe(true);
  });

  it('stop closes stdin so the child exits, and nothing starts afterwards', async () => {
    const { child, children } = setup();
    const url = child.baseUrl();
    await tick();
    children[0]?.listen(3333);
    await url;
    await child.stop();
    expect(children[0]?.stdin.writableEnded).toBe(true);
    await child.stop();
    await expect(child.baseUrl()).rejects.toMatchObject({ code: 'INTEGRATION_UNAVAILABLE' });
    expect(children).toHaveLength(1);
  });

  it('stop kills a child that ignores stdin closing, after the grace', async () => {
    const { child, children } = setup({ stopGraceMs: 20 });
    const url = child.baseUrl();
    await tick();
    const [fake] = children;
    fake?.stdin.removeAllListeners('end');
    fake?.listen(4444);
    await url;
    await child.stop();
    expect(fake?.killed).toBe(true);
  });

  it('stop before any start does nothing', async () => {
    const { child, children } = setup();
    await child.stop();
    expect(children).toHaveLength(0);
  });
});

describe('ControlGatewayChild exit diagnostics', () => {
  const line = (phase: string, code: string): string =>
    `${JSON.stringify({ nexarGatewayExit: { phase, code } })}\n`;
  const LISTEN_FAILED = line('listen', 'EADDRINUSE');
  const START_FAILED = 'control-gateway.start-failed';

  /**
   * Starts a child that writes `stderr`, then exits before it reports a port; returns what was logged.
   * The stderr is given a tick to arrive first, as it does for a real child before 'close'.
   */
  async function failBeforeReady(
    stderr: readonly (Buffer | string)[],
    exit: { code: number | null; signal: string | null } = { code: 1, signal: null },
  ) {
    const log = recordingLogger();
    const clock = { now: 1000 };
    const { child, children } = setup({ logger: log.logger, now: () => clock.now });
    const url = child.baseUrl();
    const rejected = expect(url).rejects.toMatchObject({ code: 'INTEGRATION_UNAVAILABLE' });
    await tick();
    const [fake] = children;
    for (const chunk of stderr) fake?.stderr.write(chunk);
    await tick();
    clock.now += 1500;
    fake?.exit(exit.code, exit.signal);
    await rejected;
    await tick();
    return { calls: log.calls, fake };
  }

  it('spawns with stderr piped and always drains it', async () => {
    const { child, children, stdio } = setup();
    const url = child.baseUrl();
    await tick();
    const [fake] = children;
    expect(stdio).toEqual([['pipe', 'pipe', 'pipe']]);
    fake?.listen(4321);
    await url;
    expect(fake?.stderr.readableFlowing).toBe(true);
    await child.stop();
  });

  it('logs the phase and code of a child that exits before it is ready', async () => {
    const { calls } = await failBeforeReady([LISTEN_FAILED]);
    expect(calls).toEqual([
      {
        level: 'warn',
        message: START_FAILED,
        fields: {
          cause: 'exited-before-ready',
          crashes: 0,
          exitCode: 1,
          signal: null,
          ready: false,
          elapsedMs: 1500,
          phase: 'listen',
          code: 'EADDRINUSE',
        },
      },
    ]);
  });

  it('logs the exit facts without a phase when the child left no diagnostic', async () => {
    const { calls } = await failBeforeReady([], { code: null, signal: 'SIGKILL' });
    expect(calls).toEqual([
      {
        level: 'warn',
        message: START_FAILED,
        fields: {
          cause: 'exited-before-ready',
          crashes: 0,
          exitCode: null,
          signal: 'SIGKILL',
          ready: false,
          elapsedMs: 1500,
        },
      },
    ]);
  });

  it('never logs arbitrary stderr text, only the fixed fields', async () => {
    const secrets = [
      'C:\\Users\\victim\\secret.txt',
      'Bearer sk-live-0123456789abcdefSECRET',
      '\\\\.\\pipe\\bridge-test',
      'Error: connect ENOENT',
    ];
    const { calls } = await failBeforeReady([
      `${secrets.join('\n')}\n`,
      // Diagnostic-shaped, but the code is a path: rejected whole.
      '{"nexarGatewayExit":{"phase":"listen","code":"C:\\\\Users\\\\victim"}}\n',
    ]);
    expect(calls).toHaveLength(1);
    expect(Object.keys(calls[0]?.fields ?? {}).sort()).toEqual([
      'cause',
      'crashes',
      'elapsedMs',
      'exitCode',
      'ready',
      'signal',
    ]);
    const everything = JSON.stringify(calls);
    for (const text of [...secrets, 'victim', 'SECRET', 'sk-live', 'bridge-test', 'ENOENT']) {
      expect(everything).not.toContain(text);
    }
  });

  it('drains more than 1 MB of stderr and keeps only the last bytes', async () => {
    // 1.5 MiB in 1 KiB lines, so a diagnostic written after it starts a line of its own.
    const flood = Array.from({ length: 24 }, () => Buffer.from(`${'x'.repeat(1023)}\n`.repeat(64)));

    const after = await failBeforeReady([...flood, LISTEN_FAILED]);
    // Nothing is left queued: every byte was consumed as it arrived.
    expect(after.fake?.stderr.readableLength).toBe(0);
    expect(after.fake?.stderr.writableLength).toBe(0);
    expect(after.calls[0]?.fields).toMatchObject({ phase: 'listen', code: 'EADDRINUSE' });

    // A line that fell out of the 4096-byte tail is gone: the flood is not retained.
    const before = await failBeforeReady([LISTEN_FAILED, ...flood]);
    expect(before.fake?.stderr.readableLength).toBe(0);
    expect(before.calls).toHaveLength(1);
    expect(before.calls[0]?.fields).toMatchObject({ cause: 'exited-before-ready', exitCode: 1 });
    expect(before.calls[0]?.fields).not.toHaveProperty('phase');
    expect(before.calls[0]?.fields).not.toHaveProperty('code');
  });

  it('records the timeout as the start failure cause', async () => {
    const log = recordingLogger();
    // A frozen clock: the start failed 0 ms after the spawn as far as the log is concerned.
    const { child, children } = setup({ startTimeoutMs: 20, logger: log.logger, now: () => 0 });
    await expect(child.baseUrl()).rejects.toMatchObject({ code: 'INTEGRATION_UNAVAILABLE' });
    expect(children[0]?.killed).toBe(true);
    await tick();
    // The child had not exited when the decision was made, so no exit facts are logged.
    expect(log.calls).toEqual([
      {
        level: 'warn',
        message: START_FAILED,
        fields: { cause: 'timeout', crashes: 0, ready: false, elapsedMs: 0 },
      },
    ]);
  });

  it('records an invalid ready line as the start failure cause', async () => {
    for (const written of ['{"port":"x"}\n', '9'.repeat(1100)]) {
      const log = recordingLogger();
      const { child, children } = setup({ logger: log.logger, now: () => 0 });
      const url = child.baseUrl();
      const rejected = expect(url).rejects.toMatchObject({ code: 'INTEGRATION_UNAVAILABLE' });
      await tick();
      children[0]?.stdout.write(written);
      await rejected;
      await tick();
      expect(log.calls).toEqual([
        {
          level: 'warn',
          message: START_FAILED,
          fields: {
            cause: 'invalid-ready-line',
            crashes: 0,
            ready: false,
            elapsedMs: 0,
          },
        },
      ]);
      expect(children[0]?.killed).toBe(true);
    }
  });

  it('logs a crash after ready with the exit facts, timing and diagnostic', async () => {
    const log = recordingLogger();
    const clock = { now: 1000 };
    const { child, children } = setup({ logger: log.logger, now: () => clock.now });
    const first = child.baseUrl();
    await tick();
    children[0]?.listen(1111);
    await first;
    expect(log.calls).toEqual([]);

    clock.now += 2500;
    children[0]?.stderr.write(line('uncaught', 'ERR_BOOM'));
    await tick();
    children[0]?.exit(1);
    await tick();
    expect(log.calls).toEqual([
      {
        level: 'warn',
        message: 'control-gateway.exited',
        fields: {
          crashes: 1,
          exitCode: 1,
          signal: null,
          ready: true,
          elapsedMs: 2500,
          phase: 'uncaught',
          code: 'ERR_BOOM',
        },
      },
    ]);

    // The restart and the second crash behave as before; a kill by signal has no exit code.
    const second = child.baseUrl();
    await tick();
    children[1]?.listen(2222);
    await second;
    children[1]?.exit(null, 'SIGKILL');
    await tick();
    expect(log.calls[1]).toMatchObject({
      message: 'control-gateway.exited',
      fields: { crashes: 2, exitCode: null, signal: 'SIGKILL', ready: true },
    });
    expect(log.calls[1]?.fields).not.toHaveProperty('phase');
    await expect(child.baseUrl()).rejects.toMatchObject({ code: 'INTEGRATION_UNAVAILABLE' });
    expect(children).toHaveLength(2);
  });

  it('logs nothing when it ends the child itself', async () => {
    const log = recordingLogger();
    const { child, children } = setup({ logger: log.logger });
    const url = child.baseUrl();
    await tick();
    children[0]?.listen(3333);
    await url;
    await child.stop();
    await tick();
    expect(log.calls).toEqual([]);
  });

  it("reads a diagnostic that arrives after 'exit' but before 'close'", async () => {
    const log = recordingLogger();
    const { child, children } = setup({ logger: log.logger, now: () => 0 });
    const url = child.baseUrl();
    const rejected = expect(url).rejects.toMatchObject({ code: 'INTEGRATION_UNAVAILABLE' });
    await tick();
    const [fake] = children;
    fake?.end(1);
    await rejected;
    await tick();
    // The failure is thrown at once; the log waits for stdio to close.
    expect(log.calls).toEqual([]);
    fake?.stderr.write(line('uncaught', 'ERR_LATE'));
    await tick();
    fake?.closeStdio(1);
    await tick();
    expect(log.calls).toEqual([
      {
        level: 'warn',
        message: START_FAILED,
        fields: {
          cause: 'exited-before-ready',
          crashes: 0,
          exitCode: 1,
          signal: null,
          ready: false,
          elapsedMs: 0,
          phase: 'uncaught',
          code: 'ERR_LATE',
        },
      },
    ]);
  });

  it('still logs after a short grace when the child exits but its stdio never closes', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const log = recordingLogger();
      const { child, children } = setup({ logger: log.logger });
      const url = child.baseUrl();
      await vi.advanceTimersByTimeAsync(5);
      const [fake] = children;
      fake?.listen(2222);
      await url;
      fake?.stderr.write(line('stdin', 'EPIPE'));
      await vi.advanceTimersByTimeAsync(5);
      // A grandchild holding the pipe open: 'exit' comes, 'close' does not.
      fake?.end(1);
      await vi.advanceTimersByTimeAsync(200);
      expect(log.calls).toEqual([]);
      await vi.advanceTimersByTimeAsync(100);
      expect(log.calls).toHaveLength(1);
      expect(log.calls[0]).toMatchObject({
        message: 'control-gateway.exited',
        fields: { crashes: 1, exitCode: 1, ready: true, phase: 'stdin', code: 'EPIPE' },
      });
    } finally {
      vi.useRealTimers();
    }
  });
});
