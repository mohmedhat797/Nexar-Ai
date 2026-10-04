import type { ChildProcess, spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { rm } from 'node:fs/promises';
import { PassThrough } from 'node:stream';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SigninCallbackSupervisor } from './signin-callback-child.js';
import { bundleSigninChild } from './signin-test-kit.js';

const STATE = 'state-sentinel-abcdefgh';

class FakeChild extends EventEmitter {
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  killed = false;
  config = '';

  constructor() {
    super();
    this.stdin.on('data', (chunk: Buffer) => (this.config += chunk.toString()));
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
    this.emit('close', 0);
  }

  say(value: unknown): void {
    this.stdout.write(`${typeof value === 'string' ? value : JSON.stringify(value)}\n`);
  }
}

function fake(options: { startTimeoutMs?: number; stopGraceMs?: number } = {}) {
  const children: FakeChild[] = [];
  const spawned: { command: string; args: readonly string[]; env: unknown }[] = [];
  const supervisor = new SigninCallbackSupervisor({
    launch: { command: 'node', args: ['cb.cjs'], env: { ELECTRON_RUN_AS_NODE: '1' } },
    spawn: ((command: string, args: readonly string[], opts: { env: unknown }) => {
      spawned.push({ command, args, env: opts.env });
      const child = new FakeChild();
      children.push(child);
      return child as unknown as ChildProcess;
    }) as unknown as typeof spawn,
    ...options,
  });
  return { supervisor, children, spawned };
}

const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 5));

describe('SigninCallbackSupervisor (fake child)', () => {
  it('starts the child with a minimal env, sends only the state, and reads port then result', async () => {
    const { supervisor, children, spawned } = fake();
    const pending = supervisor.begin(STATE, new AbortController().signal);
    await tick();
    expect(spawned[0]?.env).toEqual({ ELECTRON_RUN_AS_NODE: '1' });
    expect(JSON.parse(children[0]?.config ?? '')).toEqual({ state: STATE });
    children[0]?.say({ port: 4321 });
    const session = await pending;
    expect(session.port).toBe(4321);
    children[0]?.say({ code: 'code-1', clientId: 'oaiapp_a' });
    expect(await session.result).toEqual({ code: 'code-1', clientId: 'oaiapp_a' });
    await session.stop();
  });

  it.each([
    ['a bad port', { port: 0 }],
    ['an extra field', { port: 4321, extra: 1 }],
    ['non-JSON', 'garbage'],
  ])('refuses %s on the first line and ends the child', async (_name, line) => {
    const { supervisor, children } = fake();
    const pending = supervisor.begin(STATE, new AbortController().signal);
    await tick();
    children[0]?.say(line);
    await expect(pending).rejects.toMatchObject({ code: 'INTEGRATION_UNAVAILABLE' });
    await tick();
    expect(children[0]?.stdin.writableEnded).toBe(true);
  });

  it('maps a malformed or unknown result line to failed', async () => {
    for (const line of [
      { code: 'c' },
      { error: 'surprise' },
      'garbage',
      { code: 'c', clientId: 'x', extra: 1 },
    ]) {
      const { supervisor, children } = fake();
      const pending = supervisor.begin(STATE, new AbortController().signal);
      await tick();
      children[0]?.say({ port: 4321 });
      const session = await pending;
      children[0]?.say(line);
      expect(await session.result).toEqual({ error: 'failed' });
      await session.stop();
    }
  });

  it('settles with failed when the child dies without an answer', async () => {
    const { supervisor, children } = fake();
    const pending = supervisor.begin(STATE, new AbortController().signal);
    await tick();
    children[0]?.say({ port: 4321 });
    const session = await pending;
    children[0]?.exit();
    expect(await session.result).toEqual({ error: 'failed' });
  });

  it('fails when the port never arrives', async () => {
    const { supervisor, children } = fake({ startTimeoutMs: 20 });
    await expect(supervisor.begin(STATE, new AbortController().signal)).rejects.toMatchObject({
      code: 'INTEGRATION_UNAVAILABLE',
    });
    await tick();
    expect(children[0]?.stdin.writableEnded).toBe(true);
  });

  it('ends the child on abort and never starts after one', async () => {
    const { supervisor, children, spawned } = fake();
    const controller = new AbortController();
    const pending = supervisor.begin(STATE, controller.signal);
    await tick();
    children[0]?.say({ port: 4321 });
    const session = await pending;
    controller.abort();
    expect(await session.result).toEqual({ error: 'failed' });
    expect(children[0]?.stdin.writableEnded).toBe(true);
    await expect(supervisor.begin(STATE, controller.signal)).rejects.toBeDefined();
    expect(spawned).toHaveLength(1);
  });

  it('kills a child that ignores a closed stdin, and stop is repeatable', async () => {
    const { supervisor, children } = fake({ stopGraceMs: 10 });
    const pending = supervisor.begin(STATE, new AbortController().signal);
    await tick();
    const stubborn = children[0];
    if (stubborn === undefined) throw new Error('no child');
    stubborn.stdin.removeAllListeners('end');
    stubborn.say({ port: 4321 });
    const session = await pending;
    await Promise.all([session.stop(), session.stop()]);
    expect(stubborn.killed).toBe(true);
  });
});

describe('SigninCallbackSupervisor (real child)', () => {
  let kit: Awaited<ReturnType<typeof bundleSigninChild>>;
  beforeAll(async () => {
    kit = await bundleSigninChild();
  }, 60_000);
  afterAll(async () => {
    await rm(kit.dir, { recursive: true, force: true });
  });

  it('serves the callback and always ends the child', async () => {
    const supervisor = new SigninCallbackSupervisor({ launch: kit.launch });
    const session = await supervisor.begin(STATE, new AbortController().signal);
    const res = await fetch(
      `http://127.0.0.1:${String(session.port)}/callback?code=code-1&state=${STATE}&client_id=oaiapp_a`,
    );
    expect(res.status).toBe(200);
    expect(await session.result).toEqual({ code: 'code-1', clientId: 'oaiapp_a' });
    await session.stop();
    await expect(fetch(`http://127.0.0.1:${String(session.port)}/callback`)).rejects.toThrow();
  });

  it('ends the real child when aborted', async () => {
    const supervisor = new SigninCallbackSupervisor({ launch: kit.launch });
    const controller = new AbortController();
    const session = await supervisor.begin(STATE, controller.signal);
    controller.abort();
    expect(await session.result).toEqual({ error: 'failed' });
    await session.stop();
    await expect(fetch(`http://127.0.0.1:${String(session.port)}/callback`)).rejects.toThrow();
  });

  it('relays the child timeout', async () => {
    const supervisor = new SigninCallbackSupervisor({ launch: kit.launch, timeoutMs: 300 });
    const session = await supervisor.begin(STATE, new AbortController().signal);
    expect(await session.result).toEqual({ error: 'timeout' });
    await session.stop();
  });
});
