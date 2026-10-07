import { ChildProcess } from 'node:child_process';
import type { spawn } from 'node:child_process';
import { mkdtemp, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { PassThrough } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  CLAUDE_INVENTORY_SDK_VERSION,
  createClaudeModelInventorySource,
  type ClaudeInventoryQueryFactory,
  type ClaudeModelInventoryOptions,
} from './inventory.js';

const roots: string[] = [];
afterEach(async () => {
  vi.useRealTimers();
  for (const root of roots.splice(0)) {
    const child = relative(resolve(tmpdir()), resolve(root));
    if (isAbsolute(child) || child.startsWith('..')) throw new Error('Unsafe fixture path');
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

async function root(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), 'nexar-claude-inventory-test-'));
  roots.push(path);
  return path;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

function fakeChild(): ChildProcess {
  const child = new ChildProcess();
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.kill = vi.fn(() => true);
  child.unref = vi.fn();
  return child;
}

const rows = [
  {
    value: 'runtime-future-id',
    displayName: 'Future model',
    description: 'SECRET raw description',
    resolvedModel: 'DO_NOT_SUBSTITUTE',
    supportedEffortLevels: ['low', 'high'],
    account: 'SECRET account',
  },
];

async function fixture(
  response: unknown = rows,
  overrides: Partial<ClaudeModelInventoryOptions> = {},
) {
  const privateDirectory = await root();
  const child = fakeChild();
  const events: string[] = [];
  const captured = deferred<Parameters<ClaudeInventoryQueryFactory>[0]>();
  const close = vi.fn(() => {
    events.push('close');
  });
  const spawnImpl = vi.fn((...args: Parameters<typeof spawn>) => {
    void args;
    return child;
  });
  const terminateTree = vi.fn(() => {
    events.push('terminate-tree');
    return Promise.resolve();
  });
  const supportedModels = vi.fn(() => Promise.resolve(response));
  const queryImpl: ClaudeInventoryQueryFactory = (params) => {
    captured.resolve(params);
    params.options.spawnClaudeCodeProcess?.({
      command: 'claude',
      args: ['--output-format', 'stream-json'],
      cwd: params.options.cwd!,
      env: { ...params.options.env, INJECTED_SECRET: 'SECRET' },
      signal: params.options.abortController!.signal,
    });
    return { supportedModels, close };
  };
  const source = createClaudeModelInventorySource({
    env: { PATH: process.env.PATH, HOME: privateDirectory },
    privateDirectory,
    queryImpl,
    spawnImpl: spawnImpl as unknown as typeof spawn,
    terminateTree,
    ...overrides,
  });
  return {
    source,
    privateDirectory,
    child,
    captured,
    close,
    spawnImpl,
    terminateTree,
    supportedModels,
    events,
  };
}

describe('Claude native metadata-only inventory', () => {
  it('holds an unfed input, disables project integration and publishes only native model metadata', async () => {
    const f = await fixture();
    const resultPromise = f.source.fetch(new AbortController().signal);
    const captured = await f.captured.promise;
    const next = captured.prompt[Symbol.asyncIterator]().next();
    const options = captured.options;
    expect(options).toMatchObject({
      settingSources: [],
      settings: { disableAllHooks: true, enabledPlugins: {} },
      tools: [],
      allowedTools: [],
      hooks: {},
      plugins: [],
      skills: [],
      agents: {},
      additionalDirectories: [],
      mcpServers: {},
      strictMcpConfig: true,
      persistSession: false,
      debug: false,
      permissionMode: 'default',
    });
    expect(options.model).toBeUndefined();
    expect(options.resume).toBeUndefined();
    expect(options.continue).toBeUndefined();
    expect(options.fallbackModel).toBeUndefined();
    const result = await resultPromise;
    expect(await next).toEqual({ done: true, value: undefined });
    expect(result).toEqual({
      status: 'success',
      source: 'live-runtime',
      auth: 'unknown',
      entries: [
        {
          selection: { kind: 'model', id: 'runtime-future-id' },
          displayName: 'Future model',
          availability: 'available',
          compatibility: 'native-agent',
          source: 'live-runtime',
          reasoningModes: ['low', 'high'],
        },
      ],
    });
    expect(JSON.stringify(result)).not.toContain('SECRET');
    expect(JSON.stringify(result)).not.toContain('DO_NOT_SUBSTITUTE');
    expect(f.events).toEqual(['terminate-tree', 'close']);
    expect(f.terminateTree).toHaveBeenCalledWith(f.child, options.env);
    expect(f.close).toHaveBeenCalledTimes(1);
    expect(f.child.stdin?.destroyed).toBe(true);
    expect(f.child.stdout?.destroyed).toBe(true);
    expect(f.child.stderr?.destroyed).toBe(true);
    expect(await readdir(f.privateDirectory)).toEqual([]);
  });

  it('creates an isolated private cwd rather than reading a caller project, then removes it', async () => {
    const pending = deferred<unknown>();
    const f = await fixture(undefined);
    const project = await root();
    await writeFile(join(project, 'CLAUDE.md'), 'SECRET project instructions');
    await writeFile(join(project, '.mcp.json'), '{"SECRET":"do not load"}');
    const source = createClaudeModelInventorySource({
      env: { HOME: f.privateDirectory, PWD: project },
      privateDirectory: f.privateDirectory,
      queryImpl: (params) => {
        f.captured.resolve(params);
        return { supportedModels: () => pending.promise, close: f.close };
      },
    });
    const operation = source.fetch(new AbortController().signal);
    const params = await f.captured.promise;
    expect(params.options.cwd).not.toBe(project);
    expect(relative(f.privateDirectory, params.options.cwd!)).toMatch(/^claude-inventory-[^\\/]+$/);
    if (process.platform !== 'win32')
      expect((await stat(params.options.cwd!)).mode & 0o777).toBe(0o700);
    expect(params.options.settingSources).toEqual([]);
    pending.resolve([]);
    await operation;
    expect(await readdir(f.privateDirectory)).toEqual([]);
  });

  it('uses a replacement public environment and a validated native config path, ignoring SDK additions', async () => {
    const config = await root();
    const f = await fixture(rows, {
      env: {
        PATH: process.env.PATH,
        HOME: config,
        USERPROFILE: config,
        CLAUDE_CONFIG_DIR: config,
        ANTHROPIC_API_KEY: 'SECRET',
        CLAUDE_CODE_OAUTH_TOKEN: 'SECRET',
        CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR: 'SECRET',
        ANTHROPIC_BASE_URL: 'SECRET',
        CLAUDECODE: 'SECRET',
        CLAUDE_PROJECT_DIR: 'SECRET',
        NODE_OPTIONS: 'SECRET',
        GITHUB_TOKEN: 'SECRET',
        AWS_ACCESS_KEY_ID: 'SECRET',
        DEBUG: 'SECRET',
      },
    });
    await f.source.fetch(new AbortController().signal);
    const params = await f.captured.promise;
    expect(params.options.env).toMatchObject({
      CLAUDE_CONFIG_DIR: config,
      CLAUDE_AGENT_SDK_VERSION: CLAUDE_INVENTORY_SDK_VERSION,
    });
    expect(JSON.stringify(params.options.env)).not.toContain('SECRET');
    const spawnOptions = f.spawnImpl.mock.calls[0]?.[2];
    expect(spawnOptions).toMatchObject({
      shell: false,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: params.options.env,
    });
    expect(JSON.stringify(spawnOptions)).not.toContain('SECRET');
  });

  it('deduplicates returned ids, preserves order and treats an empty live list as authoritative', async () => {
    const f = await fixture([rows[0], rows[0], { value: 'second', displayName: 'Second' }]);
    const result = await f.source.fetch(new AbortController().signal);
    expect(result.status === 'success' && result.entries.map((entry) => entry.selection)).toEqual([
      { kind: 'model', id: 'runtime-future-id' },
      { kind: 'model', id: 'second' },
    ]);
    const empty = await fixture([]);
    expect(await empty.source.fetch(new AbortController().signal)).toEqual({
      status: 'success',
      source: 'live-runtime',
      auth: 'unknown',
      entries: [],
    });
  });

  it('does not load or spawn for pre-cancelled refresh', async () => {
    const f = await fixture();
    const controller = new AbortController();
    controller.abort();
    expect(await f.source.fetch(controller.signal)).toMatchObject({
      status: 'unavailable',
      reason: 'cancelled',
      auth: 'unknown',
    });
    expect(f.spawnImpl).not.toHaveBeenCalled();
    expect(f.close).not.toHaveBeenCalled();
    expect(await readdir(f.privateDirectory)).toEqual([]);
  });

  it('cancels pending metadata, kills the owned tree before SDK close and discards late rows', async () => {
    const pending = deferred<unknown>();
    const f = await fixture();
    f.supportedModels.mockImplementation(() => pending.promise);
    const controller = new AbortController();
    const operation = f.source.fetch(controller.signal);
    await f.captured.promise;
    controller.abort();
    expect(await operation).toMatchObject({
      status: 'unavailable',
      reason: 'cancelled',
      auth: 'unknown',
    });
    expect(f.events).toEqual(['terminate-tree', 'close']);
    pending.resolve(rows);
    await Promise.resolve();
    expect(await readdir(f.privateDirectory)).toEqual([]);
  });

  it('bounds a metadata request that never settles and closes its held input/process', async () => {
    const pending = deferred<unknown>();
    const f = await fixture(undefined, { timeoutMs: 20 });
    f.supportedModels.mockImplementation(() => pending.promise);
    vi.useFakeTimers();
    const operation = f.source.fetch(new AbortController().signal);
    await f.captured.promise;
    await vi.advanceTimersByTimeAsync(20);
    expect(await operation).toMatchObject({ status: 'unavailable', reason: 'timeout' });
    expect(f.events).toEqual(['terminate-tree', 'close']);
    pending.reject(new Error('SECRET late failure'));
    await Promise.resolve();
    expect(await readdir(f.privateDirectory)).toEqual([]);
  });

  it('keeps cancellation effective during successful-result cleanup', async () => {
    const cleanup = deferred<void>();
    const entered = deferred<void>();
    const f = await fixture(rows, {
      terminateTree: () => {
        entered.resolve();
        return cleanup.promise;
      },
    });
    const controller = new AbortController();
    const operation = f.source.fetch(controller.signal);
    await entered.promise;
    controller.abort();
    cleanup.resolve();
    expect(await operation).toMatchObject({ status: 'unavailable', reason: 'cancelled' });
    expect(f.close).toHaveBeenCalledOnce();
  });

  it('bounds stuck tree cleanup and reports a fixed unavailable result', async () => {
    const entered = deferred<void>();
    const f = await fixture(rows, {
      terminateTree: () => {
        entered.resolve();
        return new Promise(() => undefined);
      },
    });
    const kill = vi.spyOn(f.child, 'kill');
    vi.useFakeTimers();
    const operation = f.source.fetch(new AbortController().signal);
    await entered.promise;
    await vi.advanceTimersByTimeAsync(6_000);
    expect(await operation).toMatchObject({ status: 'unavailable', reason: 'runtime-unavailable' });
    expect(kill).toHaveBeenCalledWith('SIGKILL');
    expect(f.close).toHaveBeenCalledOnce();
  });

  it('returns fixed failure and cleans a spawned child when the SDK throws raw vendor text', async () => {
    const f = await fixture();
    f.supportedModels.mockRejectedValue(new Error('SECRET raw account and body'));
    const result = await f.source.fetch(new AbortController().signal);
    expect(result).toMatchObject({
      status: 'unavailable',
      reason: 'refresh-failed',
      auth: 'unknown',
    });
    expect(JSON.stringify(result)).not.toContain('SECRET');
    expect(f.events).toEqual(['terminate-tree', 'close']);
  });

  it('bounds both process streams without publishing any raw output', async () => {
    const f = await fixture();
    const pending = deferred<unknown>();
    f.supportedModels.mockImplementation(() => pending.promise);
    const operation = f.source.fetch(new AbortController().signal);
    await f.captured.promise;
    f.child.stdout?.emit('data', Buffer.alloc(128 * 1024, 'A'));
    f.child.stderr?.emit('data', Buffer.alloc(128 * 1024 + 1, 'B'));
    const result = await operation;
    expect(result).toEqual({
      status: 'unavailable',
      source: 'live-runtime',
      auth: 'unknown',
      reason: 'invalid-response',
    });
    expect(f.events).toEqual(['terminate-tree', 'close']);
    pending.resolve(rows);
  });

  it('denies tool requests even though no input is supplied', async () => {
    const f = await fixture();
    await f.source.fetch(new AbortController().signal);
    const options = (await f.captured.promise).options;
    const result = await options.canUseTool?.(
      'Read',
      { file_path: 'SECRET' },
      {
        signal: new AbortController().signal,
        toolUseID: 'test',
        requestId: 'test-request',
      },
    );
    expect(result).toEqual({ behavior: 'deny', message: 'Metadata-only inventory' });
  });
});

describe('Claude public metadata validation', () => {
  it.each([
    null,
    {},
    [{ value: 'model', displayName: 'SECRET\n' }],
    [{ value: 'x'.repeat(201), displayName: 'Model' }],
    [{ value: 'model', displayName: 'x'.repeat(161) }],
    [{ value: 'model', displayName: 'Model', supportedEffortLevels: ['SECRET'] }],
    Array.from({ length: 257 }, (_, i) => ({ value: `m${i}`, displayName: 'Model' })),
  ])('rejects malformed/bounded metadata without leaking it', async (value) => {
    const f = await fixture(value);
    const result = await f.source.fetch(new AbortController().signal);
    expect(result).toEqual({
      status: 'unavailable',
      source: 'live-runtime',
      auth: 'unknown',
      reason: 'invalid-response',
    });
    expect(JSON.stringify(result)).not.toContain('SECRET');
    expect(f.close).toHaveBeenCalledOnce();
  });

  it.each(['relative/path', 'SECRET\n', ''])(
    'refuses invalid CLAUDE_CONFIG_DIR instead of selecting another account',
    async (value) => {
      const f = await fixture(rows, { env: { CLAUDE_CONFIG_DIR: value } });
      expect(await f.source.fetch(new AbortController().signal)).toMatchObject({
        status: 'unavailable',
        auth: 'unknown',
      });
      expect(f.spawnImpl).not.toHaveBeenCalled();
      expect(await readdir(f.privateDirectory)).toEqual([]);
    },
  );
});
