import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { PassThrough } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { NexarError } from '@nexar/contracts';
import { DSH_PINNED_VERSION } from '../resource.js';
import { dshLaunchFor, probeDshRuntime } from './resolve.js';
import type { DshLaunch } from './resolve.js';

const WINDOWS = process.platform === 'win32';
const ABS_NODE = WINDOWS ? 'C:\\node\\node.exe' : '/usr/bin/node';
const ABS_ENTRY = WINDOWS ? 'C:\\dsh\\bin\\dsh.js' : '/opt/dsh/bin/dsh.js';

describe('dsh-runtime.json', () => {
  it('pins the version the adapter was verified against', () => {
    const pin = JSON.parse(
      readFileSync(fileURLToPath(new URL('../../dsh-runtime.json', import.meta.url)), 'utf8'),
    ) as { package: string; version: string };
    expect(pin.version).toBe(DSH_PINNED_VERSION);
    expect(pin.package).toMatch(/^@[a-z0-9-]+\/[a-z0-9-]+$/);
  });
});

describe('dshLaunchFor', () => {
  it('runs a Node script through the Node command with its extra environment', () => {
    expect(
      dshLaunchFor(ABS_ENTRY, { nodeCommand: ABS_NODE, nodeEnv: { ELECTRON_RUN_AS_NODE: '1' } }),
    ).toEqual({ command: ABS_NODE, args: [ABS_ENTRY], env: { ELECTRON_RUN_AS_NODE: '1' } });
    for (const ext of ['.mjs', '.cjs', '.JS']) {
      const entry = ABS_ENTRY.replace(/\.js$/, ext);
      expect(dshLaunchFor(entry, { nodeCommand: ABS_NODE }).args).toEqual([entry]);
    }
  });

  it('runs any other absolute entry directly', () => {
    const binary = WINDOWS ? 'C:\\dsh\\dsh.exe' : '/opt/dsh/dsh';
    expect(dshLaunchFor(binary, { nodeCommand: ABS_NODE })).toEqual({
      command: binary,
      args: [],
      env: {},
    });
  });

  it.each(['dsh', 'bin/dsh.js', '.\\dsh.js', ''])('rejects the relative entry %j', (entry) => {
    expect(() => dshLaunchFor(entry, { nodeCommand: ABS_NODE })).toThrow(NexarError);
  });

  it.each(['dsh.cmd', 'dsh.BAT', 'dsh.ps1'])('rejects the shell script %s', (name) => {
    const entry = WINDOWS ? `C:\\dsh\\${name}` : `/opt/dsh/${name}`;
    expect(() => dshLaunchFor(entry, { nodeCommand: ABS_NODE })).toThrow(/shell script/);
  });

  it('requires an absolute Node command for a Node script', () => {
    expect(() => dshLaunchFor(ABS_ENTRY, { nodeCommand: 'node' })).toThrow(NexarError);
  });
});

const LAUNCH: DshLaunch = { command: 'dsh-bin', args: ['entry.js'], env: { EXTRA: '1' } };

interface FakeChildOptions {
  readonly stdout?: string;
  readonly code?: number;
  readonly error?: NodeJS.ErrnoException;
  readonly never?: boolean;
}

function fakeSpawn(options: FakeChildOptions) {
  const killed = vi.fn();
  const calls: { command: string; args: readonly string[]; env: NodeJS.ProcessEnv }[] = [];
  const spawn = ((
    command: string,
    args: readonly string[],
    spawnOptions: { env: NodeJS.ProcessEnv },
  ) => {
    calls.push({ command, args, env: spawnOptions.env });
    const child = new EventEmitter() as EventEmitter & { stdout: PassThrough; kill: () => void };
    child.stdout = new PassThrough();
    child.kill = killed;
    setImmediate(() => {
      if (options.never === true) return;
      if (options.error !== undefined) return child.emit('error', options.error);
      if (options.stdout !== undefined) child.stdout.write(options.stdout);
      child.stdout.end();
      child.emit('close', options.code ?? 0);
    });
    return child;
  }) as never;
  return { spawn, calls, killed };
}

describe('probeDshRuntime', () => {
  const parentEnv = { PATH: '/bin', DEEPSEEK_API_KEY: 'sk-secret', SystemRoot: 'C:\\Windows' };

  it('is ready on an exact version match and sends a minimal environment', async () => {
    const fake = fakeSpawn({ stdout: `${DSH_PINNED_VERSION}\n` });
    await expect(probeDshRuntime(LAUNCH, { parentEnv, spawn: fake.spawn })).resolves.toEqual({
      state: 'ready',
      version: DSH_PINNED_VERSION,
    });
    expect(fake.calls[0]?.args).toEqual(['entry.js', '--version']);
    expect(fake.calls[0]?.env).toEqual({ EXTRA: '1', PATH: '/bin', SystemRoot: 'C:\\Windows' });
  });

  it('reports a different version as unsupported', async () => {
    const fake = fakeSpawn({ stdout: '0.2.1-alpha.2\n' });
    await expect(probeDshRuntime(LAUNCH, { parentEnv, spawn: fake.spawn })).resolves.toEqual({
      state: 'unsupported-version',
      version: '0.2.1-alpha.2',
    });
  });

  it('never echoes unexpected output', async () => {
    const fake = fakeSpawn({ stdout: 'weird output with spaces\nand lines' });
    await expect(probeDshRuntime(LAUNCH, { parentEnv, spawn: fake.spawn })).resolves.toEqual({
      state: 'unsupported-version',
    });
  });

  it('maps ENOENT to dsh-missing', async () => {
    const error = Object.assign(new Error('spawn dsh ENOENT'), { code: 'ENOENT' });
    const fake = fakeSpawn({ error });
    await expect(probeDshRuntime(LAUNCH, { parentEnv, spawn: fake.spawn })).resolves.toEqual({
      state: 'dsh-missing',
    });
  });

  it('maps a synchronous spawn failure and other spawn errors to startup-failed', async () => {
    const throwing = (() => {
      throw Object.assign(new Error('boom'), { code: 'EACCES' });
    }) as never;
    await expect(probeDshRuntime(LAUNCH, { parentEnv, spawn: throwing })).resolves.toEqual({
      state: 'startup-failed',
    });
    const fake = fakeSpawn({ error: Object.assign(new Error('x'), { code: 'EACCES' }) });
    await expect(probeDshRuntime(LAUNCH, { parentEnv, spawn: fake.spawn })).resolves.toEqual({
      state: 'startup-failed',
    });
  });

  it('maps a non-zero exit to startup-failed', async () => {
    const fake = fakeSpawn({ stdout: DSH_PINNED_VERSION, code: 1 });
    await expect(probeDshRuntime(LAUNCH, { parentEnv, spawn: fake.spawn })).resolves.toEqual({
      state: 'startup-failed',
    });
  });

  it('times out and kills the child', async () => {
    const fake = fakeSpawn({ never: true });
    await expect(
      probeDshRuntime(LAUNCH, { parentEnv, spawn: fake.spawn, timeoutMs: 30 }),
    ).resolves.toEqual({ state: 'startup-failed' });
    expect(fake.killed).toHaveBeenCalled();
  });
});
