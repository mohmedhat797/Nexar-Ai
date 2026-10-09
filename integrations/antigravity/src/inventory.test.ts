import type { ChildProcess, spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { lstat, mkdtemp, readdir, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { publicRuntimeEnvironment } from '@nexar/process';
import type { RuntimeCommandOptions, RuntimeCommandResult } from '@nexar/process';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { antigravityModelInventorySource, parseAntigravityModelList } from './inventory.js';

const TABLE =
  'SLUG                         NAME\r\n' +
  'gemini-new-model-high\tGemini New Model (High)\r\n' +
  'gemini-future-model  Gemini Future Model\r\n';
const signal = (): AbortSignal => new AbortController().signal;
let privateDirectory: string;

beforeEach(async () => {
  privateDirectory = await mkdtemp(join(tmpdir(), 'nexar-agy-inventory-test-'));
});
afterEach(async () => {
  vi.useRealTimers();
  await rm(privateDirectory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

describe('conservative documented tabular rows', () => {
  it('preserves returned slugs, labels and order without invented model facts', () => {
    const entries = parseAntigravityModelList(TABLE);
    expect(entries).toEqual([
      {
        selection: { kind: 'model', id: 'gemini-new-model-high' },
        displayName: 'Gemini New Model (High)',
        availability: 'available',
        compatibility: 'native-agent',
        source: 'live-runtime',
      },
      {
        selection: { kind: 'model', id: 'gemini-future-model' },
        displayName: 'Gemini Future Model',
        availability: 'available',
        compatibility: 'native-agent',
        source: 'live-runtime',
      },
    ]);
    expect(Object.isFrozen(entries)).toBe(true);
    expect(Object.isFrozen(entries?.[0]?.selection)).toBe(true);
  });

  it.each([
    '',
    'Please sign in to view available models',
    'gemini-sample',
    'gemini-sample Single space',
    '{"models":[{"slug":"gemini-sample"}]}',
    '\u001b[32mgemini-sample  Name\u001b[0m',
    'gemini-sample  Unsafe\u0000label',
    `gemini-sample  ${'n'.repeat(161)}`,
    `${'a'.repeat(201)}  Name`,
    'gemini-sample  First\ngemini-sample  Second',
    'x'.repeat(16 * 1024 + 1),
    Array.from({ length: 257 }, (_, i) => `gemini-${i}  Model ${i}`).join('\n'),
  ])('rejects unverified, unsafe or unbounded rows %#', (output) => {
    expect(parseAntigravityModelList(output)).toBeUndefined();
  });

  it('ignores header and free-form notices without emitting their content', () => {
    const entries = parseAntigravityModelList(`PRIVATE-CANARY\n---\n${TABLE}`);
    expect(entries).toHaveLength(2);
    expect(JSON.stringify(entries)).not.toContain('PRIVATE-CANARY');
  });
});

describe('owner-triggered inventory source', () => {
  it('does nothing at construction, then runs fixed metadata argv in a private neutral cwd', async () => {
    const env = {
      ...process.env,
      GOOGLE_API_KEY: 'KEY-CANARY',
      PROMPT: 'PROMPT-CANARY',
      AGY_TOKEN: 'TOKEN-CANARY',
      NODE_OPTIONS: '--require=evil',
      CUSTOM: 'ENV-CANARY',
    };
    const runCommand = vi.fn(async (spec: RuntimeCommandOptions): Promise<RuntimeCommandResult> => {
      expect(spec.command).toBe('test-runtime');
      expect(spec.args).toEqual(['fake-entrypoint', 'models']);
      expect(spec.cwd).not.toBe(process.cwd());
      expect(spec.cwd.startsWith(join(privateDirectory, 'antigravity-inventory-'))).toBe(true);
      expect(await readdir(spec.cwd)).toEqual([]);
      if (process.platform !== 'win32') expect((await lstat(spec.cwd)).mode & 0o777).toBe(0o700);
      expect(spec.env).toEqual(publicRuntimeEnvironment(env));
      expect(JSON.stringify(spec.env)).not.toContain('CANARY');
      expect(spec).toMatchObject({
        timeoutMs: 10_000,
        maxOutputBytes: 16 * 1024,
        interaction: 'probe',
      });
      return { kind: 'exited', exitCode: 0, stdout: TABLE, stderr: 'VENDOR-BODY-CANARY' };
    });
    const source = antigravityModelInventorySource({
      privateDirectory,
      env,
      binary: { command: 'test-runtime', args: ['fake-entrypoint'] },
      runCommand,
    });
    expect(runCommand).not.toHaveBeenCalled();
    const result = await source.fetch(signal());
    expect(result).toMatchObject({ status: 'success', source: 'live-runtime', auth: 'unknown' });
    expect(result).not.toHaveProperty('current');
    expect(JSON.stringify(result)).not.toContain('CANARY');
    expect(await readdir(privateDirectory)).toEqual([]);
  });

  it.each([
    ['unavailable', 'runtime-unavailable'],
    ['timed-out', 'timeout'],
    ['cancelled', 'cancelled'],
    ['overflow', 'invalid-response'],
  ] as const)('maps %s to a fixed safe reason', async (kind, reason) => {
    const result = await antigravityModelInventorySource({
      privateDirectory,
      runCommand: () => Promise.resolve({ kind, stdout: 'SECRET-CANARY', stderr: 'SECRET-CANARY' }),
    }).fetch(signal());
    expect(result).toEqual({
      status: 'unavailable',
      source: 'live-runtime',
      auth: 'unknown',
      reason,
    });
    expect(await readdir(privateDirectory)).toEqual([]);
  });

  it.each([
    {
      exitCode: 1,
      stdout: TABLE,
      stderr: 'Please sign in SECRET-CANARY',
      reason: 'refresh-failed',
    },
    { exitCode: 0, stdout: 'SECRET-CANARY', stderr: '', reason: 'invalid-response' },
    { exitCode: 0, stdout: TABLE, stderr: 'x'.repeat(16 * 1024), reason: 'invalid-response' },
  ])('fails closed without vendor output or auth inference %#', async ({ reason, ...output }) => {
    expect(
      await antigravityModelInventorySource({
        privateDirectory,
        runCommand: () => Promise.resolve({ kind: 'exited', ...output }),
      }).fetch(signal()),
    ).toEqual({ status: 'unavailable', source: 'live-runtime', auth: 'unknown', reason });
  });

  it('normalizes thrown failures and cleans up', async () => {
    const result = await antigravityModelInventorySource({
      privateDirectory,
      runCommand: () => Promise.reject(new Error('PATH-TOKEN-PROMPT-CANARY')),
    }).fetch(signal());
    expect(result).toMatchObject({ reason: 'refresh-failed', auth: 'unknown' });
    expect(JSON.stringify(result)).not.toContain('CANARY');
    expect(await readdir(privateDirectory)).toEqual([]);
  });

  it('does not launch on pre-cancellation or an untrusted cwd parent', async () => {
    const runCommand =
      vi.fn<NonNullable<Parameters<typeof antigravityModelInventorySource>[0]['runCommand']>>();
    const controller = new AbortController();
    controller.abort();
    expect(
      await antigravityModelInventorySource({ privateDirectory, runCommand }).fetch(
        controller.signal,
      ),
    ).toMatchObject({ reason: 'cancelled' });
    const alias = join(privateDirectory, 'alias');
    await symlink(privateDirectory, alias, process.platform === 'win32' ? 'junction' : 'dir');
    expect(
      await antigravityModelInventorySource({ privateDirectory: alias, runCommand }).fetch(
        signal(),
      ),
    ).toMatchObject({ reason: 'runtime-unavailable' });
    expect(
      await antigravityModelInventorySource({ privateDirectory: '.', runCommand }).fetch(signal()),
    ).toMatchObject({ reason: 'runtime-unavailable' });
    expect(runCommand).not.toHaveBeenCalled();
  });
});

function fakeSpawn() {
  let started!: () => void;
  const ready = new Promise<void>((resolve) => {
    started = resolve;
  });
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const child = Object.assign(new EventEmitter(), {
    stdout,
    stderr,
    unref: vi.fn(),
    kill: vi.fn(() => {
      queueMicrotask(() => child.emit('close', null));
      return true;
    }),
  });
  const invoke = vi.fn<(...args: unknown[]) => ChildProcess>(() => {
    started();
    return child as unknown as ChildProcess;
  });
  return { stdout, stderr, child, ready, invoke, spawnImpl: invoke as unknown as typeof spawn };
}

describe('bounded fake subprocess lifecycle', () => {
  it('ignores stdin, forbids shells and returns parsed stdout only', async () => {
    const fake = fakeSpawn();
    const pending = antigravityModelInventorySource({
      privateDirectory,
      spawnImpl: fake.spawnImpl,
    }).fetch(signal());
    await fake.ready;
    expect(fake.invoke.mock.calls[0]).toEqual([
      'agy',
      ['models'],
      expect.objectContaining({
        shell: false,
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      }),
    ]);
    fake.stdout.write(TABLE);
    fake.stderr.write('SECRET-CANARY');
    fake.child.emit('close', 0);
    const result = await pending;
    expect(result).toMatchObject({ status: 'success', auth: 'unknown' });
    expect(JSON.stringify(result)).not.toContain('CANARY');
  });

  it.each(['timeout', 'cancel', 'overflow'] as const)('stops and settles on %s', async (mode) => {
    vi.useFakeTimers();
    const fake = fakeSpawn();
    const controller = new AbortController();
    const pending = antigravityModelInventorySource({
      privateDirectory,
      spawnImpl: fake.spawnImpl,
    }).fetch(controller.signal);
    await fake.ready;
    if (mode === 'timeout') await vi.advanceTimersByTimeAsync(10_000);
    if (mode === 'cancel') controller.abort();
    if (mode === 'overflow') fake.stdout.write('x'.repeat(16 * 1024 + 1));
    expect(await pending).toMatchObject({
      status: 'unavailable',
      auth: 'unknown',
      reason: mode === 'cancel' ? 'cancelled' : mode === 'timeout' ? 'timeout' : 'invalid-response',
    });
    expect(fake.child.kill).toHaveBeenCalled();
    expect(await readdir(privateDirectory)).toEqual([]);
  });
});
