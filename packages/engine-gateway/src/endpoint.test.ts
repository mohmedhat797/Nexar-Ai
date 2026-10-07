import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { connect, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inspect } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  NexarError,
  measured,
  type Logger,
  type RouteDecision,
  type StrategyLedger,
} from '@nexar/contracts';
import type { BridgeAllocator, ChildExecution, ChildExecutor, ChildTaskInput } from './bridge.js';
import { BridgeHost, type BridgeEndpointLimits, type BridgeGrantInput } from './endpoint.js';
import type { ControlModelGateway } from './gateway.js';
import { createFakeControl, okTurn } from './control-test-kit.js';

const START = new Date('2026-03-01T12:00:00.000Z');
const UNIT = { unitId: 'u1', input: 'summarize this', access: 'read-only' } as const;

const grantInput: BridgeGrantInput = {
  sessionId: 's1',
  turnId: 't1',
  correlationId: 'c1',
  projectId: 'proj',
  engine: 'openworker',
  access: 'read-only',
  maxUnits: 4,
  ttlMs: 60_000,
};

/** One connection with a line queue, so tests read responses in order. */
class Conn {
  private readonly lines: string[] = [];
  private waiting: ((line: string) => void) | undefined;
  private buffered = '';
  readonly closed: Promise<void>;

  private constructor(readonly socket: Socket) {
    socket.setEncoding('utf8');
    socket.on('data', (chunk: string) => {
      this.buffered += chunk;
      for (let i = this.buffered.indexOf('\n'); i !== -1; i = this.buffered.indexOf('\n')) {
        this.push(this.buffered.slice(0, i));
        this.buffered = this.buffered.slice(i + 1);
      }
    });
    socket.on('error', () => undefined);
    this.closed = new Promise((resolve) => socket.once('close', () => resolve()));
  }

  static open(path: string): Promise<Conn> {
    return new Promise((resolve, reject) => {
      const socket = connect(path);
      socket.once('error', reject);
      socket.once('connect', () => {
        socket.off('error', reject);
        resolve(new Conn(socket));
      });
    });
  }

  private push(line: string): void {
    if (this.waiting === undefined) this.lines.push(line);
    else {
      const resolve = this.waiting;
      this.waiting = undefined;
      resolve(line);
    }
  }

  send(frame: unknown): void {
    this.socket.write(`${typeof frame === 'string' ? frame : JSON.stringify(frame)}\n`);
  }

  next(): Promise<Record<string, unknown>> {
    const line = this.lines.shift();
    if (line !== undefined) return Promise.resolve(JSON.parse(line) as Record<string, unknown>);
    return new Promise((resolve) => {
      this.waiting = (l) => resolve(JSON.parse(l) as Record<string, unknown>);
    });
  }

  async call(frame: unknown): Promise<Record<string, unknown>> {
    this.send(frame);
    return this.next();
  }

  close(): void {
    this.socket.destroy();
  }
}

describe('BridgeHost', () => {
  let dir: string;
  let now: number;
  let host: BridgeHost;
  const conns: Conn[] = [];
  const warned: string[] = [];
  const executed: ChildTaskInput[] = [];
  let release: (() => void) | undefined;
  let gate: Promise<void> | undefined;

  const logger: Logger = {
    debug: () => undefined,
    info: () => undefined,
    warn: (msg, fields) => void warned.push(JSON.stringify({ msg, fields })),
    error: () => undefined,
    child: () => logger,
  };
  const allocator: BridgeAllocator = {
    allocate: (ledger: StrategyLedger) =>
      Promise.resolve({
        decision: {
          outcome: 'selected',
          selected: { resourceId: 'res-a' },
        } as unknown as RouteDecision,
        ledger,
      }),
  };
  const executor: ChildExecutor = async (input) => {
    executed.push(input);
    if (gate !== undefined) await gate;
    const done: ChildExecution = {
      text: 'the answer',
      resourceId: 'res-a',
      usage: { inputTokens: measured(10), outputTokens: measured(5), costUsd: measured(0) },
    };
    return done;
  };

  async function make(
    limits?: Partial<BridgeEndpointLimits>,
    exec = executor,
    gateway?: ControlModelGateway,
  ): Promise<string> {
    let n = 0;
    host = new BridgeHost({
      allocator,
      executor: exec,
      clock: () => new Date(now),
      newId: () => `id${String(++n)}`,
      logger,
      runtimeDir: join(dir, 'runtime'),
      ...(limits === undefined ? {} : { limits }),
      ...(gateway === undefined ? {} : { gateway }),
    });
    return host.start();
  }
  const open = async (): Promise<Conn> => {
    const conn = await Conn.open(host.endpoint());
    conns.push(conn);
    return conn;
  };
  const submit = (token: string, request: unknown = UNIT, id = 'r1') => ({
    v: 1,
    id,
    token,
    op: 'submit',
    request,
  });

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'nexar-bridge-host-'));
    now = START.getTime();
    warned.length = 0;
    executed.length = 0;
    gate = undefined;
    release = undefined;
  });
  afterEach(async () => {
    for (const conn of conns.splice(0)) conn.close();
    await host.stop();
    await rm(dir, { recursive: true, force: true });
  });

  it('round-trips submit, status and done over the endpoint, with lineage from the grant', async () => {
    await make();
    const { token, grantId } = host.mint(grantInput);
    const conn = await open();

    gate = new Promise((resolve) => (release = resolve));
    expect(await conn.call(submit(token))).toEqual({ id: 'r1', ok: true, value: { jobId: 'id2' } });
    const running = await conn.call({ v: 1, id: 'r2', token, op: 'status', jobId: 'id2' });
    expect(running).toEqual({ id: 'r2', ok: true, value: { state: 'running' } });

    release?.();
    let status: Record<string, unknown> = running;
    for (let i = 0; i < 50 && (status['value'] as { state: string }).state !== 'done'; i++) {
      await new Promise((resolve) => setTimeout(resolve, 10));
      status = await conn.call({ v: 1, id: 'r3', token, op: 'status', jobId: 'id2' });
    }
    const value = status['value'] as { state: string; result: { text: string; outcome: string } };
    expect(value.state).toBe('done');
    expect(value.result).toMatchObject({ outcome: 'succeeded', text: 'the answer' });

    const [child] = executed;
    expect(child?.projectId).toBe('proj');
    expect(child?.metadata).toMatchObject({
      grantId,
      rootSessionId: 's1',
      turnId: 't1',
      correlationId: 'c1',
      depth: 2,
      chain: ['nexar', 'openworker'],
    });
    expect(child?.kind).toBe('general');
  });

  it('answers AUTH_REQUIRED for unknown, missing, revoked and expired tokens', async () => {
    await make();
    const revoked = host.mint(grantInput);
    const expiring = host.mint({ ...grantInput, ttlMs: 1_000 });
    const conn = await open();

    host.revoke(revoked.grantId);
    now += 1_000;
    const bad = [
      submit('0'.repeat(64)),
      { v: 1, id: 'x', op: 'status', jobId: 'j' },
      submit(revoked.token),
      submit(expiring.token),
    ];
    for (const frame of bad) {
      expect(await conn.call(frame)).toMatchObject({ ok: false, code: 'AUTH_REQUIRED' });
    }
  });

  it('closes expired grants on the next request', async () => {
    await make();
    const { token } = host.mint({ ...grantInput, ttlMs: 1_000 });
    const conn = await open();
    expect(await conn.call(submit(token))).toMatchObject({ ok: true });
    now += 1_000;
    expect(await conn.call(submit(token, { ...UNIT, unitId: 'u2' }, 'r2'))).toEqual({
      id: 'r2',
      ok: false,
      code: 'AUTH_REQUIRED',
    });
  });

  it('keeps no plaintext token in the host and never logs it', async () => {
    await make();
    const { token } = host.mint(grantInput);
    const conn = await open();
    await conn.call(submit('f'.repeat(64)));
    await conn.call(submit(token));
    expect(inspect(host, { depth: 10, showHidden: true })).not.toContain(token);
    expect(warned.join('\n')).not.toContain(token);
    expect(warned.join('\n')).not.toContain('f'.repeat(64));
  });

  it('rejects request fields that try to set lineage, project, access or budget', async () => {
    await make();
    const { token } = host.mint(grantInput);
    const conn = await open();
    const attempts = [
      {
        ...UNIT,
        lineage: { rootSessionId: 'other', turnId: 't', correlationId: 'c', depth: 0, chain: [] },
      },
      { ...UNIT, projectId: 'other' },
      { ...UNIT, budgetUsd: 1000 },
      { ...UNIT, rootSessionId: 'other' },
    ];
    for (const request of attempts) {
      expect(await conn.call(submit(token, request))).toMatchObject({
        ok: false,
        code: 'VALIDATION_ERROR',
      });
    }
    expect(await conn.call({ ...submit(token), grantId: 'other' })).toMatchObject({
      ok: false,
      code: 'VALIDATION_ERROR',
    });
    expect(executed).toHaveLength(0);
  });

  it('accepts reviewOf only as a well-formed id of an earlier unit of the grant', async () => {
    await make();
    const { token } = host.mint({ ...grantInput, maxUnits: 10 });
    const conn = await open();
    expect(await conn.call(submit(token))).toMatchObject({ ok: true });
    expect(
      await conn.call(submit(token, { ...UNIT, unitId: 'u2', reviewOf: 'u1' }, 'r2')),
    ).toMatchObject({ ok: true });
    expect(
      await conn.call(submit(token, { ...UNIT, unitId: 'u3', reviewOf: 'nope' }, 'r3')),
    ).toEqual({ id: 'r3', ok: false, code: 'POLICY_REJECTED' });
    expect(
      await conn.call(submit(token, { ...UNIT, unitId: 'u4', reviewOf: 'bad id' }, 'r4')),
    ).toMatchObject({ ok: false, code: 'VALIDATION_ERROR' });
    expect(
      await conn.call(submit(token, { ...UNIT, unitId: 'u5', reviewOf: 1 }, 'r5')),
    ).toMatchObject({ ok: false, code: 'VALIDATION_ERROR' });
    // Sentinel reviewOf values are normalized to undefined
    expect(
      await conn.call(submit(token, { ...UNIT, unitId: 'u6', reviewOf: 'none' }, 'r6')),
    ).toMatchObject({ ok: true });
    expect(
      await conn.call(submit(token, { ...UNIT, unitId: 'u7', reviewOf: 'null' }, 'r7')),
    ).toMatchObject({ ok: true });
    expect(
      await conn.call(submit(token, { ...UNIT, unitId: 'u8', reviewOf: '' }, 'r8')),
    ).toMatchObject({ ok: true });
    expect(
      await conn.call(submit(token, { ...UNIT, unitId: 'u9', reviewOf: null }, 'r9')),
    ).toMatchObject({ ok: true });
  });

  it('never lets a request widen the grant access', async () => {
    await make();
    const { token } = host.mint(grantInput);
    const conn = await open();
    expect(await conn.call(submit(token, { ...UNIT, access: 'draft' }))).toMatchObject({
      ok: false,
      code: 'POLICY_REJECTED',
    });
  });

  it('survives malformed JSON and unknown ops on the same connection', async () => {
    await make();
    const { token } = host.mint(grantInput);
    const conn = await open();
    expect(await conn.call('{not json')).toEqual({ id: '', ok: false, code: 'VALIDATION_ERROR' });
    expect(await conn.call('[1]')).toMatchObject({ ok: false, code: 'VALIDATION_ERROR' });
    expect(await conn.call({ v: 1, id: 'k', token, op: 'delete' })).toEqual({
      id: 'k',
      ok: false,
      code: 'VALIDATION_ERROR',
    });
    expect(await conn.call({ v: 2, id: 'k', token, op: 'status', jobId: 'j' })).toMatchObject({
      code: 'VALIDATION_ERROR',
    });
    expect(await conn.call(submit(token))).toMatchObject({ ok: true });
  });

  it('refuses an oversized frame and closes the connection', async () => {
    await make({ maxFrameBytes: 1024 });
    const { token } = host.mint(grantInput);
    const huge = await open();
    huge.send(submit(token, { ...UNIT, input: 'x'.repeat(2048) }));
    expect(await huge.next()).toEqual({ id: '', ok: false, code: 'VALIDATION_ERROR' });
    await huge.closed;

    const unterminated = await open();
    unterminated.socket.write('y'.repeat(4096));
    expect(await unterminated.next()).toMatchObject({ ok: false, code: 'VALIDATION_ERROR' });
    await unterminated.closed;
    expect(executed).toHaveLength(0);
  });

  it('caps concurrent connections', async () => {
    await make({ maxConnections: 2 });
    await open();
    await open();
    const third = await open();
    expect(await third.next()).toEqual({ id: '', ok: false, code: 'RESOURCE_UNAVAILABLE' });
    await third.closed;
  });

  it('closes idle connections', async () => {
    await make({ idleTimeoutMs: 50 });
    const conn = await open();
    await conn.closed;
  });

  it.skipIf(process.platform === 'win32')('creates the socket file with mode 0600', async () => {
    const path = await make();
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    expect((await stat(join(dir, 'runtime'))).mode & 0o777).toBe(0o700);
  });

  it('uses a per-launch name and closes the endpoint on stop', async () => {
    const path = await make();
    if (process.platform === 'win32')
      expect(path).toMatch(/^\\\\\.\\pipe\\nexar-bridge-[0-9a-f]{32}$/);
    else expect(path).toMatch(/bridge-[0-9a-f]{32}\.sock$/);
    await host.stop();
    await expect(Conn.open(path)).rejects.toThrow();
    expect(() => host.endpoint()).toThrow(NexarError);
  });

  it('starts lazily once and shares the endpoint between concurrent first calls', async () => {
    await make();
    const first = host.endpoint();
    await host.stop();
    expect(() => host.endpoint()).toThrow();
    const [a, b] = await Promise.all([host.ensureStarted(), host.ensureStarted()]);
    expect(a).toBe(b);
    expect(a).not.toBe(first);
    expect(host.endpoint()).toBe(a);
  });

  it('rejects a bad ttl', async () => {
    await make();
    expect(() => host.mint({ ...grantInput, ttlMs: 0 })).toThrow(NexarError);
  });

  describe('endpointPath', () => {
    const makeAt = (endpointPath: string, platform?: NodeJS.Platform): BridgeHost =>
      (host = new BridgeHost({
        allocator,
        executor,
        clock: () => new Date(now),
        newId: () => 'id',
        logger,
        runtimeDir: join(dir, 'runtime'),
        endpointPath,
        ...(platform === undefined ? {} : { platform }),
      }));
    const rejects = async (code: string): Promise<void> => {
      await expect(host.start()).rejects.toMatchObject({ code });
    };

    it.skipIf(process.platform === 'win32')(
      'listens exactly there with mode 0600 and serves requests',
      async () => {
        const services = join(dir, 'services');
        await mkdir(services, { mode: 0o700 });
        const path = join(services, 'bridge.sock');
        makeAt(path);
        expect(await host.start()).toBe(path);
        expect(host.endpoint()).toBe(path);
        expect((await stat(path)).mode & 0o777).toBe(0o600);
        const conn = await open();
        const reply = await conn.call({ v: 1, id: 'x', token: 'nope', op: 'status', jobId: 'j' });
        expect(reply).toEqual({ id: 'x', ok: false, code: 'AUTH_REQUIRED' });
        await host.stop();
        await expect(stat(path)).rejects.toThrow();
      },
    );

    it.skipIf(process.platform === 'win32')(
      'refuses a missing, symlinked or relative parent without echoing the path',
      async () => {
        makeAt(join(dir, 'missing', 'bridge.sock'));
        await rejects('VALIDATION_ERROR');
        const real = join(dir, 'real');
        await mkdir(real);
        await symlink(real, join(dir, 'link'));
        makeAt(join(dir, 'link', 'bridge.sock'));
        await expect(host.start()).rejects.toMatchObject({ code: 'POLICY_REJECTED' });
        makeAt('bridge.sock');
        const error = await host.start().catch((e: unknown) => e);
        expect(error).toMatchObject({ code: 'VALIDATION_ERROR' });
        expect(String((error as Error).message)).not.toContain(dir);
      },
    );

    it.skipIf(process.platform === 'win32')('refuses an existing non-socket file', async () => {
      const path = join(dir, 'bridge.sock');
      await writeFile(path, 'x');
      makeAt(path);
      await rejects('POLICY_REJECTED');
    });

    it.skipIf(process.platform === 'win32')('removes a stale socket it owns', async () => {
      const path = join(dir, 'bridge.sock');
      // A killed process leaves its socket file behind (a clean close would unlink it).
      const child = spawn(process.execPath, [
        '-e',
        `require('node:net').createServer().listen(process.argv[1], () => console.log('up'))`,
        path,
      ]);
      await new Promise<void>((resolve) => child.stdout.once('data', () => resolve()));
      const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()));
      child.kill('SIGKILL');
      await exited;
      expect((await stat(path)).isSocket()).toBe(true);
      makeAt(path);
      expect(await host.start()).toBe(path);
      expect((await stat(path)).isSocket()).toBe(true);
    });

    it('is a validation error on win32', async () => {
      makeAt('/tmp/bridge.sock', 'win32');
      await rejects('VALIDATION_ERROR');
    });
  });

  describe('control op', () => {
    const SENTINEL = 'SENTINEL-prompt-and-args';
    const policy = { mode: 'auto', fallback: 'auto' } as const;
    const control = (token: string, turn: unknown, id = 'c1') => ({
      v: 1,
      id,
      token,
      op: 'control',
      turn,
    });
    const hello = { messages: [{ role: 'user' as const, content: SENTINEL }] };

    it('answers POLICY_REJECTED for a grant without a control decision', async () => {
      const { gateway } = createFakeControl({});
      await make(undefined, executor, gateway);
      const { token } = host.mint(grantInput);
      const conn = await open();
      expect(await conn.call(control(token, hello))).toEqual({
        id: 'c1',
        ok: false,
        code: 'POLICY_REJECTED',
      });
    });

    it('refuses a control grant when the host has no gateway', async () => {
      await make();
      let error: unknown;
      try {
        host.mint(grantInput, { policy });
      } catch (e) {
        error = e;
      }
      expect(error).toMatchObject({ code: 'POLICY_REJECTED' });
      const { token } = host.mint(grantInput);
      const conn = await open();
      expect(await conn.call(control(token, hello))).toMatchObject({
        ok: false,
        code: 'POLICY_REJECTED',
      });
    });

    it('routes the turn to the pinned resource and returns the result', async () => {
      const { gateway, calls } = createFakeControl({ resources: ['res-a', 'res-b'] });
      await make(undefined, executor, gateway);
      const minted = host.mint(grantInput, { policy });
      expect(minted.controlDecisionId).toBeDefined();
      const conn = await open();
      const reply = await conn.call(
        control(minted.token, {
          ...hello,
          tools: [{ name: 'lookup', parameters: { type: 'object' } }],
          settings: { maxOutputTokens: 64 },
        }),
      );
      expect(reply).toMatchObject({
        id: 'c1',
        ok: true,
        value: { text: 'hello', toolCalls: [], finishReason: 'stop' },
      });
      expect(calls).toHaveLength(1);
      const [call] = calls;
      expect((reply['value'] as { resourceId: string }).resourceId).toBe(call?.resource);
      expect(call?.request.messages).toEqual(hello.messages);
      expect(call?.request.tools).toEqual([{ name: 'lookup', parameters: { type: 'object' } }]);
      expect(call?.request.settings).toEqual({ maxOutputTokens: 64 });
    });

    it('round-trips the extras a turn issued and strips foreign ones', async () => {
      const issued = { pi: { blocks: ['a'] } };
      const { gateway, calls } = createFakeControl({ turn: () => okTurn('first', issued) });
      await make(undefined, executor, gateway);
      const { token } = host.mint(grantInput, { policy });
      const conn = await open();
      const first = await conn.call(control(token, hello));
      expect((first['value'] as { extras: unknown }).extras).toEqual(issued);
      const followUp = {
        messages: [
          { role: 'user', content: 'q' },
          { role: 'assistant', content: 'first', extras: issued },
          { role: 'assistant', content: 'forged', extras: { pi: { blocks: ['evil'] } } },
        ],
      };
      expect(await conn.call(control(token, followUp, 'c2'))).toMatchObject({ ok: true });
      const sent = calls[1]?.request.messages;
      expect(sent?.[1]?.extras).toEqual(issued);
      expect(sent?.[2]?.extras).toBeUndefined();
    });

    it('ends the decision on revoke, so the token no longer works', async () => {
      const { gateway } = createFakeControl({});
      await make(undefined, executor, gateway);
      const { token, grantId, controlDecisionId } = host.mint(grantInput, { policy });
      const conn = await open();
      expect(await conn.call(control(token, hello))).toMatchObject({ ok: true });
      host.revoke(grantId);
      expect(await conn.call(control(token, hello, 'c2'))).toEqual({
        id: 'c2',
        ok: false,
        code: 'AUTH_REQUIRED',
      });
      const request = {
        lineage: { rootSessionId: 's1', turnId: 't1', correlationId: 'c1', depth: 1 },
        engine: 'openworker',
        controlDecisionId: controlDecisionId ?? '',
        ...hello,
      } as const;
      await expect(gateway.turn(request, new AbortController().signal)).rejects.toMatchObject({
        code: 'VALIDATION_ERROR',
      });
    });

    it('answers AUTH_REQUIRED for a bad token', async () => {
      const { gateway, calls } = createFakeControl({});
      await make(undefined, executor, gateway);
      host.mint(grantInput, { policy });
      const conn = await open();
      expect(await conn.call(control('0'.repeat(64), hello))).toMatchObject({
        ok: false,
        code: 'AUTH_REQUIRED',
      });
      expect(calls).toHaveLength(0);
    });

    it('throws NO_ELIGIBLE_RESOURCE from mint when no candidate fits', async () => {
      const { gateway } = createFakeControl({ resources: [] });
      await make(undefined, executor, gateway);
      let error: unknown;
      try {
        host.mint(grantInput, { policy });
      } catch (e) {
        error = e;
      }
      expect(error).toMatchObject({ code: 'NO_ELIGIBLE_RESOURCE' });
    });

    it('aborts an in-flight turn when the host stops', async () => {
      let aborted = false;
      let started!: () => void;
      const running = new Promise<void>((resolve) => (started = resolve));
      const { gateway } = createFakeControl({
        turn: (request) =>
          new Promise((_resolve, reject) => {
            started();
            request.signal.addEventListener('abort', () => {
              aborted = true;
              reject(new Error('aborted'));
            });
          }),
      });
      await make(undefined, executor, gateway);
      const { token } = host.mint(grantInput, { policy });
      const conn = await open();
      conn.send(control(token, hello));
      await running;
      await host.stop();
      expect(aborted).toBe(true);
    });

    it('aborts an in-flight turn when its connection closes', async () => {
      let started!: () => void;
      const running = new Promise<void>((resolve) => (started = resolve));
      let onAbort!: () => void;
      const aborted = new Promise<void>((resolve) => (onAbort = resolve));
      const { gateway } = createFakeControl({
        turn: (request) =>
          new Promise((_resolve, reject) => {
            started();
            request.signal.addEventListener('abort', () => {
              onAbort();
              reject(new Error('aborted'));
            });
          }),
      });
      await make(undefined, executor, gateway);
      const { token } = host.mint(grantInput, { policy });
      const conn = await open();
      conn.send(control(token, hello));
      await running;
      conn.close();
      await aborted;
    });

    it('keeps an in-flight turn open past the idle timeout', async () => {
      let release!: () => void;
      const gateOpen = new Promise<void>((resolve) => (release = resolve));
      const { gateway } = createFakeControl({
        turn: async () => {
          await gateOpen;
          return okTurn('late');
        },
      });
      await make({ idleTimeoutMs: 50 }, executor, gateway);
      const { token } = host.mint(grantInput, { policy });
      const conn = await open();
      conn.send(control(token, hello));
      await new Promise((resolve) => setTimeout(resolve, 200));
      release();
      expect(await conn.next()).toMatchObject({ ok: true, value: { text: 'late' } });
    });

    it('never echoes messages, tool arguments or tokens in error responses or logs', async () => {
      const { gateway } = createFakeControl({
        turn: () => {
          throw new NexarError('PROVIDER_ERROR', SENTINEL);
        },
      });
      await make(undefined, executor, gateway);
      const plain = host.mint(grantInput);
      const { token } = host.mint(grantInput, { policy });
      const conn = await open();
      const replies = [
        await conn.call(control(plain.token, hello, 'a')),
        await conn.call(control(token, hello, 'b')),
        await conn.call(
          control(token, { messages: [{ role: 'user', content: SENTINEL, x: 1 }] }, 'c'),
        ),
        await conn.call(control(token, { messages: [] }, 'd')),
        await conn.call({ ...control(token, hello, 'e'), extra: SENTINEL }),
      ];
      expect(replies.map((r) => r['code'])).toEqual([
        'POLICY_REJECTED',
        'PROVIDER_ERROR',
        'VALIDATION_ERROR',
        'VALIDATION_ERROR',
        'VALIDATION_ERROR',
      ]);
      for (const reply of replies) expect(JSON.stringify(reply)).not.toContain(SENTINEL);
      expect(warned.join('\n')).not.toContain(SENTINEL);
      expect(warned.join('\n')).not.toContain(token);
    });
  });
  describe('control restart (NXR-063)', () => {
    const policy = { mode: 'auto', fallback: 'auto' } as const;
    const hello = { messages: [{ role: 'user' as const, content: 'hi' }] };
    const controlFrame = (token: string) => ({ v: 1, id: 'c1', token, op: 'control', turn: hello });

    it('returns the resource of the minted decision', async () => {
      const { gateway } = createFakeControl({ resources: ['res-a', 'res-b'] });
      await make(undefined, executor, gateway);
      const minted = host.mint(grantInput, { policy });
      expect(['res-a', 'res-b']).toContain(minted.resourceId);
      expect(host.mint(grantInput).resourceId).toBeUndefined();
    });

    it('reports a control failure of the current decision and restarts on another resource', async () => {
      let failing = '';
      const { gateway, calls } = createFakeControl({
        resources: ['res-a', 'res-b'],
        retries: 0,
        turn: (request) => {
          if (request.descriptor.id === failing) throw new NexarError('PROVIDER_ERROR', 'boom');
          return okTurn();
        },
        onEvent: (event) => host.noteControlEvent(event),
      });
      await make(undefined, executor, gateway);
      const minted = host.mint(grantInput, { policy });
      failing = minted.resourceId ?? '';
      expect(host.controlFailed(minted.grantId)).toBe(false);
      const conn = await open();
      expect(await conn.call(controlFrame(minted.token))).toMatchObject({
        ok: false,
        code: 'PROVIDER_ERROR',
      });
      expect(host.controlFailed(minted.grantId)).toBe(true);

      const next = host.restartControl(minted.grantId);
      expect(next.resourceId).not.toBe(failing);
      expect(next.controlDecisionId).not.toBe(minted.controlDecisionId);
      // The same token now drives the new decision; the failure flag belongs to the old one.
      expect(host.controlFailed(minted.grantId)).toBe(false);
      expect(await conn.call(controlFrame(minted.token))).toMatchObject({ ok: true });
      expect(calls.at(-1)?.resource).toBe(next.resourceId);
    });

    it('passes the gateway refusals through unchanged and rejects grants without control', async () => {
      const { gateway } = createFakeControl({ resources: ['res-a'] });
      await make(undefined, executor, gateway);
      const none = host.mint(grantInput, { policy: { mode: 'auto', fallback: 'none' } });
      expect(() => host.restartControl(none.grantId)).toThrow(
        expect.objectContaining({ code: 'POLICY_REJECTED' }) as Error,
      );
      const only = host.mint(grantInput, { policy });
      expect(() => host.restartControl(only.grantId)).toThrow(
        expect.objectContaining({ code: 'NO_ELIGIBLE_RESOURCE' }) as Error,
      );
      const plain = host.mint(grantInput);
      expect(() => host.restartControl(plain.grantId)).toThrow(
        expect.objectContaining({ code: 'POLICY_REJECTED' }) as Error,
      );
      expect(() => host.restartControl('nope')).toThrow(
        expect.objectContaining({ code: 'POLICY_REJECTED' }) as Error,
      );
      expect(host.controlFailed('nope')).toBe(false);
    });
  });
});
