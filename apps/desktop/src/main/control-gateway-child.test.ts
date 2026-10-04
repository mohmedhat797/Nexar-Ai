import type { ChildProcess, spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { ControlGatewayChild } from './control-gateway-child.js';
import { silentLogger } from './control-test-kit.js';

class FakeChild extends EventEmitter {
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  killed = false;
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
    this.exit();
    return true;
  }

  exit(): void {
    this.emit('exit', 0);
  }

  listen(port: number): void {
    this.stdout.write(`${JSON.stringify({ port })}\n`);
  }
}

function setup(options: { startTimeoutMs?: number; stopGraceMs?: number } = {}) {
  const children: FakeChild[] = [];
  const spawned: { command: string; args: readonly string[]; env: unknown }[] = [];
  const fakeSpawn = ((command: string, args: readonly string[], opts: { env: unknown }) => {
    spawned.push({ command, args, env: opts.env });
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
  return { child, children, spawned };
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
