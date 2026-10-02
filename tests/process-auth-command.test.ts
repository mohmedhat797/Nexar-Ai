import { ChildProcess, spawn } from 'node:child_process';
import type * as ChildProcessModule from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { PassThrough } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  publicRuntimeEnvironment,
  runRuntimeCommand,
  spawnRuntime,
  type RuntimeCommandOptions,
} from '@nexar/process';

vi.mock('node:child_process', async (original: () => Promise<typeof ChildProcessModule>) => {
  const actual = await original();
  return { ...actual, spawn: vi.fn(actual.spawn) };
});

const platform = process.platform;
const fixture = fileURLToPath(new URL('./fixtures/fake-runtime-auth-command.mjs', import.meta.url));
let cwd: string;
beforeEach(async () => {
  cwd = await realpath(await mkdtemp(join(tmpdir(), 'nexar-runtime-command-')));
});
afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.mocked(spawn).mockReset();
  vi.mocked(spawn).mockImplementation(
    (await vi.importActual<typeof ChildProcessModule>('node:child_process')).spawn,
  );
  await rm(cwd, {
    recursive: true,
    force: true,
    ...(platform === 'win32' ? { maxRetries: 10, retryDelay: 100 } : {}),
  });
});

function fakeChild(): ChildProcess {
  const child = new ChildProcess();
  Object.defineProperty(child, 'stdout', { value: new PassThrough() });
  Object.defineProperty(child, 'stderr', { value: new PassThrough() });
  child.kill = vi.fn(() => true);
  child.unref = vi.fn();
  return child;
}

function options(overrides: Partial<RuntimeCommandOptions> = {}): RuntimeCommandOptions {
  return {
    command: process.execPath,
    args: [fixture, 'exit'],
    cwd,
    env: publicRuntimeEnvironment(process.env),
    signal: new AbortController().signal,
    timeoutMs: 10_000,
    interaction: 'probe',
    ...overrides,
  };
}

describe('public runtime environment', () => {
  it('keeps only public OS and GUI variables, stripping every vendor secret and session marker', () => {
    const parent = {
      PATH: '/trusted/bin',
      HOME: '/owner',
      DISPLAY: ':0',
      WAYLAND_DISPLAY: 'wayland-0',
      DBUS_SESSION_BUS_ADDRESS: 'unix:path=/run/user/1000/bus',
      OPENAI_API_KEY: 'x'.repeat(32),
      ANTHROPIC_API_KEY: 'x'.repeat(32),
      CLAUDE_CODE_OAUTH_TOKEN: 'x'.repeat(32),
      GOOGLE_API_KEY: 'x'.repeat(32),
      CODEX_HOME: '/vendor-state',
      CLAUDECODE: '1',
      NEXAR_PROVIDER_TOKEN: 'x'.repeat(32),
      NODE_OPTIONS: '--require untrusted.js',
      BROWSER: 'untrusted-browser-command',
    };
    expect(publicRuntimeEnvironment(parent, 'linux')).toEqual({
      PATH: parent.PATH,
      HOME: parent.HOME,
      DISPLAY: parent.DISPLAY,
      WAYLAND_DISPLAY: parent.WAYLAND_DISPLAY,
      DBUS_SESSION_BUS_ADDRESS: parent.DBUS_SESSION_BUS_ADDRESS,
    });
    expect(parent.CODEX_HOME).toBe('/vendor-state');
  });

  it('inherits Windows OS variables case-insensitively and omits them on POSIX', () => {
    const parent = { Path: 'trusted', SYSTEMROOT: 'C:\\Windows', userprofile: 'C:\\Owner' };
    expect(publicRuntimeEnvironment(parent, 'win32')).toEqual({
      PATH: 'trusted',
      SystemRoot: 'C:\\Windows',
      USERPROFILE: 'C:\\Owner',
    });
    expect(publicRuntimeEnvironment(parent, 'linux')).toEqual({});
  });
});

describe('bounded runtime commands', () => {
  it('returns a bounded exit result, including nonzero exits, without invoking a shell', async () => {
    const result = await runRuntimeCommand(options({ args: [fixture, 'exit', '7'] }));
    expect(result).toEqual({
      kind: 'exited',
      exitCode: 7,
      stdout: 'safe metadata',
      stderr: 'safe diagnostic',
    });
    expect(vi.mocked(spawn).mock.calls[0]?.[2]).toMatchObject({
      shell: false,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  });

  it('passes arguments literally, including shell metacharacters', async () => {
    const args = ['with spaces', '$(echo unsafe)', '%PATH%', 'a&b', 'a|b', '`literal`'];
    const result = await runRuntimeCommand(options({ args: [fixture, 'args', ...args] }));
    expect(result.kind).toBe('exited');
    expect(JSON.parse(result.stdout)).toEqual(args);
  });

  it('does not intercept browser output and requests explicit visible, detached launch', async () => {
    const child = fakeChild();
    const spawnImpl = vi.fn(() => child) as unknown as typeof spawn;
    const result = runRuntimeCommand(options({ interaction: 'browser', spawnImpl }));
    expect(child.stdout?.listenerCount('data')).toBe(0);
    expect(child.stderr?.listenerCount('data')).toBe(0);
    expect(spawnImpl).toHaveBeenCalledWith(process.execPath, [fixture, 'exit'], {
      cwd,
      env: publicRuntimeEnvironment(process.env),
      shell: false,
      windowsHide: false,
      detached: true,
      stdio: 'ignore',
    });
    child.stdout?.emit('data', Buffer.from('private vendor output'));
    child.stderr?.emit('data', Buffer.from('private vendor error'));
    child.emit('close', 0);
    await expect(result).resolves.toEqual({ kind: 'exited', exitCode: 0, stdout: '', stderr: '' });
    const actual = await runRuntimeCommand(
      options({ args: [fixture, 'browser'], interaction: 'browser' }),
    );
    expect(actual).toEqual({ kind: 'exited', exitCode: 0, stdout: '', stderr: '' });
  });

  it('bounds combined raw bytes across both streams and enforces the 16KiB hard ceiling', async () => {
    for (const limit of [16, 32 * 1024]) {
      const child = fakeChild();
      const result = runRuntimeCommand(
        options({
          maxOutputBytes: limit,
          spawnImpl: (() => child) as typeof spawn,
        }),
      );
      const cap = Math.min(limit, 16 * 1024);
      child.stdout?.emit('data', Buffer.alloc(cap / 2));
      child.stderr?.emit('data', Buffer.alloc(cap / 2 + 1));
      child.emit('close', null);
      const outcome = await result;
      expect(outcome.kind).toBe('overflow');
      expect(
        Buffer.byteLength(outcome.stdout) + Buffer.byteLength(outcome.stderr),
      ).toBeLessThanOrEqual(cap);
      expect(vi.mocked(child).kill.mock.calls.length).toBeGreaterThan(0);
    }
  });

  it('counts UTF-8 bytes rather than JavaScript string length', async () => {
    const child = fakeChild();
    const result = runRuntimeCommand(
      options({ maxOutputBytes: 3, spawnImpl: (() => child) as typeof spawn }),
    );
    child.stdout?.emit('data', 'éé');
    child.emit('close', null);
    await expect(result).resolves.toEqual({ kind: 'overflow', stdout: '', stderr: '' });
  });

  it('bounds decoded invalid UTF-8 while preserving characters split across chunks', async () => {
    const child = fakeChild();
    const result = runRuntimeCommand(
      options({ maxOutputBytes: 8, spawnImpl: (() => child) as typeof spawn }),
    );
    child.stdout?.emit('data', Buffer.alloc(8, 0xff));
    child.emit('close', 0);
    await expect(result).resolves.toEqual({ kind: 'overflow', stdout: '', stderr: '' });
    const valid = fakeChild();
    const validResult = runRuntimeCommand(
      options({ maxOutputBytes: 2, spawnImpl: (() => valid) as typeof spawn }),
    );
    valid.stdout?.emit('data', Buffer.from([0xc3]));
    valid.stdout?.emit('data', Buffer.from([0xa9]));
    valid.emit('close', 0);
    await expect(validResult).resolves.toEqual({
      kind: 'exited',
      exitCode: 0,
      stdout: 'é',
      stderr: '',
    });
  });

  it('normalizes synchronous and emitted process errors without error details', async () => {
    const unavailable = { kind: 'unavailable', stdout: '', stderr: '' };
    await expect(
      runRuntimeCommand(
        options({
          spawnImpl: () => {
            throw new Error('private process error');
          },
        }),
      ),
    ).resolves.toEqual(unavailable);
    const child = fakeChild();
    const result = runRuntimeCommand(options({ spawnImpl: (() => child) as typeof spawn }));
    child.emit('error', new Error('private process error'));
    await expect(result).resolves.toEqual(unavailable);
  });

  it('does not launch when already cancelled and catches cancellation during spawn', async () => {
    const controller = new AbortController();
    controller.abort();
    const spawnImpl = vi.fn(() => fakeChild()) as unknown as typeof spawn;
    await expect(
      runRuntimeCommand(options({ signal: controller.signal, spawnImpl })),
    ).resolves.toEqual({
      kind: 'cancelled',
      stdout: '',
      stderr: '',
    });
    expect(spawnImpl).not.toHaveBeenCalled();
    const racing = new AbortController();
    const child = fakeChild();
    const result = runRuntimeCommand(
      options({
        signal: racing.signal,
        spawnImpl: (() => {
          racing.abort();
          return child;
        }) as typeof spawn,
      }),
    );
    child.emit('close', null);
    await expect(result).resolves.toEqual({ kind: 'cancelled', stdout: '', stderr: '' });
    expect(vi.mocked(child).kill.mock.calls.length).toBeGreaterThan(0);
  });

  it('settles after a bounded grace when a child never emits close', async () => {
    vi.useFakeTimers();
    const child = fakeChild();
    const controller = new AbortController();
    const result = runRuntimeCommand(
      options({ signal: controller.signal, spawnImpl: (() => child) as typeof spawn }),
    );
    controller.abort();
    await vi.advanceTimersByTimeAsync(6000);
    await expect(result).resolves.toEqual({ kind: 'cancelled', stdout: '', stderr: '' });
    expect(child.stdout?.destroyed).toBe(true);
    expect(child.stderr?.destroyed).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('times out an actual offline child', async () => {
    const result = await runRuntimeCommand(options({ args: [fixture, 'wait'], timeoutMs: 300 }));
    expect(result).toEqual({ kind: 'timed-out', stdout: '', stderr: '' });
  }, 15_000);

  it('cancels an actual live tree and waits for its cleanup', async () => {
    const marker = join(cwd, 'fake-process-ids.json');
    const controller = new AbortController();
    const result = runRuntimeCommand(
      options({ args: [fixture, 'tree', marker], signal: controller.signal }),
    );
    let ids: { leader: number; descendant: number } | undefined;
    try {
      await vi.waitFor(
        async () => {
          ids = JSON.parse(await readFile(marker, 'utf8')) as typeof ids;
          expect(ids?.descendant).toBeTypeOf('number');
        },
        { timeout: 8000 },
      );
    } finally {
      controller.abort();
    }
    expect((await result).kind).toBe('cancelled');
    if (ids === undefined) throw new Error('Fake child did not start');
    const processIds = ids;
    await vi.waitFor(
      () => {
        for (const pid of [processIds.leader, processIds.descendant]) {
          expect(() => process.kill(pid, 0)).toThrow();
        }
      },
      { timeout: 3000 },
    );
  }, 20_000);
});

describe('shell-free executable resolution', () => {
  it.skipIf(platform === 'win32')(
    'skips cwd and relative PATH entries and requires POSIX executable access',
    async () => {
      const trusted = join(cwd, 'trusted');
      await mkdir(trusted);
      await writeFile(join(cwd, 'vendor'), 'untrusted', { mode: 0o755 });
      const executable = join(trusted, 'vendor');
      await writeFile(executable, 'trusted', { mode: 0o755 });
      vi.mocked(spawn).mockReturnValue(fakeChild());
      const env = { PATH: ['', '.', 'relative', trusted].join(delimiter) };
      spawnRuntime('vendor', ['--help'], { cwd, env, shell: true });
      expect(spawn).toHaveBeenCalledWith(
        executable,
        ['--help'],
        expect.objectContaining({ shell: false }),
      );
      await chmod(executable, 0o644);
      expect(() => spawnRuntime('vendor', [], { cwd, env })).toThrow(
        'Runtime executable is unavailable',
      );
    },
  );

  it('preserves Windows npm shim resolution while honoring explicit visible launch', async () => {
    vi.stubGlobal('process', { ...process, platform: 'win32' });
    const shim = join(cwd, 'vendor.cmd');
    const script = join(cwd, 'vendor.js');
    const node = join(cwd, 'node.exe');
    await writeFile(shim, '@echo off\n"%dp0%/vendor.js" %*\n');
    await writeFile(script, '// public fixture entrypoint\n');
    await writeFile(node, 'fake executable');
    vi.mocked(spawn).mockReturnValue(fakeChild());
    spawnRuntime(shim, ['auth', 'login'], { cwd, env: {}, windowsHide: false, shell: true });
    expect(spawn).toHaveBeenCalledWith(
      node,
      [script, 'auth', 'login'],
      expect.objectContaining({
        windowsHide: false,
        shell: false,
      }),
    );
    spawnRuntime(shim, ['--help'], { cwd, env: {} });
    expect(spawn).toHaveBeenLastCalledWith(
      node,
      [script, '--help'],
      expect.objectContaining({ windowsHide: true }),
    );
  });

  it('rejects arbitrary Windows batch files and skips relative PATH entries', async () => {
    vi.stubGlobal('process', { ...process, platform: 'win32' });
    const trusted = join(cwd, 'trusted');
    await mkdir(trusted);
    const executable = join(trusted, 'vendor.EXE');
    await writeFile(executable, 'trusted executable');
    await writeFile(join(cwd, 'vendor.EXE'), 'untrusted executable');
    vi.mocked(spawn).mockReturnValue(fakeChild());
    spawnRuntime('vendor', [], {
      cwd,
      env: { PATH: ['', '.', trusted].join(delimiter), PATHEXT: '.EXE' },
    });
    expect(spawn).toHaveBeenCalledWith(executable, [], expect.objectContaining({ shell: false }));
    const batch = join(cwd, 'arbitrary.cmd');
    await writeFile(batch, '@echo unsafe\n');
    expect(() => spawnRuntime(batch, [], { cwd, env: {} })).toThrow('supported Node npm shim');
  });
});
