/* eslint-disable @typescript-eslint/require-await -- injected async seams in tests need no await */
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { LaunchSpec } from '@nexar/contracts';
import type { SandboxAvailability } from './availability.js';
import { SandboxLauncher, type SandboxLauncherOptions } from './launcher.js';
import { createRunDir } from './run-dir.js';

const AVAILABLE: SandboxAvailability = {
  available: true,
  bwrapPath: '/usr/bin/bwrap',
  bwrapVersion: '0.9.0',
  socatPath: '/usr/bin/socat',
  detail: 'ok',
};

let root: string;
let home: string;
let ws: string;
let runBase: string;
const signal = (): AbortSignal => new AbortController().signal;

beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'nexar-launcher-')));
  home = join(root, 'home');
  ws = join(root, 'ws');
  runBase = join(root, 'run');
  await mkdir(join(ws, '.git'), { recursive: true });
  await mkdir(home);
  await mkdir(runBase);
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const launcher = (overrides: SandboxLauncherOptions = {}): SandboxLauncher =>
  new SandboxLauncher({
    homeDir: home,
    runDirBase: runBase,
    availability: async () => AVAILABLE,
    ...overrides,
  });

const spec = (overrides: Partial<LaunchSpec> = {}): LaunchSpec => ({
  command: '/usr/bin/true',
  args: ['a'],
  env: { FOO: 'bar' },
  workspace: ws,
  workspaceAccess: 'read-write',
  network: { mode: 'none' },
  ...overrides,
});

async function rejection(
  promise: Promise<unknown>,
): Promise<{ code: string; retryable: boolean; message: string }> {
  return promise.then(
    () => {
      throw new Error('expected rejection');
    },
    (e: { code: string; retryable: boolean; message: string }) => e,
  );
}

function envOf(args: readonly string[]): Record<string, string> {
  const env: Record<string, string> = {};
  args.forEach((a, i) => {
    if (a === '--setenv') {
      env[args[i + 1] ?? ''] = args[i + 2] ?? '';
    }
  });
  return env;
}

describe('SandboxLauncher', () => {
  it('fails closed with a non-retryable SANDBOX_UNAVAILABLE', async () => {
    const l = launcher({ availability: async () => ({ available: false, detail: 'no bwrap' }) });
    const error = await rejection(l.prepare(spec(), signal()));
    expect(error).toMatchObject({ code: 'SANDBOX_UNAVAILABLE', retryable: false });
    expect(await readdir(runBase)).toEqual([]);
  });

  it('requires socat for proxy mode only', async () => {
    const noSocat: SandboxAvailability = {
      available: true,
      bwrapPath: '/usr/bin/bwrap',
      detail: 'ok',
    };
    const l2 = launcher({ availability: async () => noSocat });
    expect(
      (
        await rejection(
          l2.prepare(spec({ network: { mode: 'proxy', allowHosts: ['a.example'] } }), signal()),
        )
      ).code,
    ).toBe('SANDBOX_UNAVAILABLE');
    const prepared = await l2.prepare(spec(), signal());
    await prepared.dispose();
  });

  it('checks availability once per instance', async () => {
    let calls = 0;
    const l = launcher({
      availability: async () => {
        calls += 1;
        return AVAILABLE;
      },
    });
    await (await l.prepare(spec(), signal())).dispose();
    await (await l.prepare(spec(), signal())).dispose();
    expect(calls).toBe(1);
  });

  it('rejects an aborted signal', async () => {
    const controller = new AbortController();
    controller.abort();
    expect((await rejection(launcher().prepare(spec(), controller.signal))).code).toBe(
      'EXECUTION_CANCELLED',
    );
  });

  it('returns the bwrap command with the expected shape', async () => {
    const prepared = await launcher().prepare(spec(), signal());
    expect(prepared).toMatchObject({
      command: '/usr/bin/bwrap',
      env: { PATH: '/usr/bin:/bin' },
      cwd: ws,
      workspacePath: '/work',
      isolation: 'sandbox',
    });
    expect(launcher().isolation).toBe('sandbox');
    expect(prepared.args).toContain('--disable-userns');
    expect(prepared.args.slice(-2)).toEqual(['/usr/bin/true', 'a']);
    await prepared.dispose();
  });

  it('protects .git for read-write workspaces only, and rejects a .git file or symlink', async () => {
    const rw = await launcher().prepare(spec(), signal());
    expect(rw.args).toContain('/work/.git');
    await rw.dispose();
    const ro = await launcher().prepare(spec({ workspaceAccess: 'read-only' }), signal());
    expect(ro.args).not.toContain('/work/.git');
    await ro.dispose();

    const linked = join(root, 'linked');
    await mkdir(linked);
    await writeFile(join(linked, '.git'), 'gitdir: /elsewhere\n');
    expect((await rejection(launcher().prepare(spec({ workspace: linked }), signal()))).code).toBe(
      'POLICY_REJECTED',
    );
    const symlinked = join(root, 'symlinked');
    await mkdir(symlinked);
    await symlink(join(ws, '.git'), join(symlinked, '.git'));
    expect(
      (await rejection(launcher().prepare(spec({ workspace: symlinked }), signal()))).code,
    ).toBe('POLICY_REJECTED');
    expect(await readdir(runBase)).toEqual([]);
  });

  it('rejects a workspace that is not a directory, the home directory, or missing', async () => {
    const file = join(root, 'file');
    await writeFile(file, '');
    for (const workspace of [file, home, join(root, 'missing')]) {
      expect((await rejection(launcher().prepare(spec({ workspace }), signal()))).code).toBe(
        'CONFIGURATION_ERROR',
      );
    }
  });

  it('forces the environment and removes proxy variables in network none', async () => {
    const prepared = await launcher().prepare(
      spec({
        env: {
          HOME: '/root',
          TMPDIR: '/x',
          GIT_CONFIG_GLOBAL: '/etc/x',
          HTTPS_PROXY: 'http://evil',
          http_proxy: 'http://evil',
          NO_PROXY: '*',
          NODE_USE_ENV_PROXY: '1',
          KEEP: 'me',
        },
      }),
      signal(),
    );
    const env = envOf(prepared.args);
    expect(env).toEqual({
      KEEP: 'me',
      HOME: '/home/agent',
      TMPDIR: '/tmp',
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_TERMINAL_PROMPT: '0',
      PATH: '/usr/local/bin:/usr/bin:/bin',
    });
    await prepared.dispose();
  });

  it('sets proxy variables only in proxy mode and starts the proxy', async () => {
    const prepared = await launcher().prepare(
      spec({
        env: { NO_PROXY: '*', no_proxy: '*' },
        network: { mode: 'proxy', allowHosts: ['api.example.com'] },
      }),
      signal(),
    );
    const env = envOf(prepared.args);
    for (const key of ['HTTPS_PROXY', 'HTTP_PROXY', 'https_proxy', 'http_proxy']) {
      expect(env[key]).toBe('http://127.0.0.1:3128');
    }
    expect(env['NODE_USE_ENV_PROXY']).toBe('1');
    expect(env['NO_PROXY']).toBeUndefined();
    expect(env['no_proxy']).toBeUndefined();
    expect(prepared.args).toContain('/run/nexar');
    const [dirName] = await readdir(runBase);
    expect(existsSync(join(runBase, dirName ?? '', 'proxy.sock'))).toBe(true);
    await prepared.dispose();
    expect(existsSync(join(runBase, dirName ?? ''))).toBe(false);
  });

  it('rejects invalid environment entries', async () => {
    for (const env of [{ 'BAD-KEY': 'x' }, { '1BAD': 'x' }, { GOOD: 'a\0b' }]) {
      expect((await rejection(launcher().prepare(spec({ env }), signal()))).code).toBe(
        'CONFIGURATION_ERROR',
      );
    }
    expect(await readdir(runBase)).toEqual([]);
  });

  it('puts toolchain bin dirs first in the default PATH', async () => {
    const tool = join(root, 'node22');
    await mkdir(tool);
    const prepared = await launcher({ toolchainPaths: [tool] }).prepare(
      spec({ env: {}, command: join(tool, 'bin', 'node') }),
      signal(),
    );
    expect(envOf(prepared.args)['PATH']).toBe(`${tool}/bin:/usr/local/bin:/usr/bin:/bin`);
    expect(prepared.args.slice(-2)).toEqual([join(tool, 'bin', 'node'), 'a']);
    await prepared.dispose();
  });

  it('checks absolute command visibility and translates mount and workspace paths', async () => {
    const cred = join(root, 'cred');
    await mkdir(cred);
    const mounts = [
      { hostPath: cred, sandboxPath: '/opt/nexar/cred', access: 'read-only' as const },
    ];
    const viaMount = await launcher().prepare(
      spec({ command: join(cred, 'bin', 'x'), mounts }),
      signal(),
    );
    expect(viaMount.args.at(-2)).toBe('/opt/nexar/cred/bin/x');
    await viaMount.dispose();
    const viaWorkspace = await launcher().prepare(spec({ command: join(ws, 'tool.sh') }), signal());
    expect(viaWorkspace.args.at(-2)).toBe('/work/tool.sh');
    await viaWorkspace.dispose();
    const relative = await launcher().prepare(spec({ command: 'node' }), signal());
    expect(relative.args.at(-2)).toBe('node');
    await relative.dispose();
    const error = await rejection(
      launcher().prepare(spec({ command: '/somewhere/else/bin' }), signal()),
    );
    expect(error.code).toBe('CONFIGURATION_ERROR');
    expect(error.message).not.toContain('somewhere');
    expect(
      (await rejection(launcher().prepare(spec({ command: '/usr/../etc/x' }), signal()))).code,
    ).toBe('CONFIGURATION_ERROR');
  });

  it('rejects invalid mounts', async () => {
    const error = await rejection(
      launcher().prepare(
        spec({ mounts: [{ hostPath: home, sandboxPath: '/home/agent/h', access: 'read-only' }] }),
        signal(),
      ),
    );
    expect(error.code).toBe('CONFIGURATION_ERROR');
  });

  it('dispose is idempotent, removes the run dir and also runs on abort', async () => {
    const p1 = await launcher().prepare(spec(), signal());
    expect(await readdir(runBase)).toHaveLength(1);
    await p1.dispose();
    await p1.dispose();
    expect(await readdir(runBase)).toEqual([]);

    const controller = new AbortController();
    const p2 = await launcher().prepare(
      spec({ network: { mode: 'proxy', allowHosts: ['a.example'] } }),
      controller.signal,
    );
    controller.abort();
    await p2.dispose();
    expect(await readdir(runBase)).toEqual([]);
  });

  it('cleans up the run dir when the allowlist is invalid', async () => {
    const error = await rejection(
      launcher().prepare(
        spec({ network: { mode: 'proxy', allowHosts: ['*.example.com'] } }),
        signal(),
      ),
    );
    expect(error.code).toBe('CONFIGURATION_ERROR');
    expect(await readdir(runBase)).toEqual([]);
  });
});

describe('createRunDir', () => {
  it('creates a 0700 dir with passwd/group and rejects over-long socket paths', async () => {
    const dir = await createRunDir({ base: runBase, uid: 1234, gid: 5678 });
    const { readFile, stat } = await import('node:fs/promises');
    expect((await stat(dir.path)).mode & 0o777).toBe(0o700);
    expect(await readFile(dir.passwdPath, 'utf8')).toBe(
      'agent:x:1234:5678:agent:/home/agent:/bin/sh\n',
    );
    expect(await readFile(dir.groupPath, 'utf8')).toBe('agent:x:5678:\n');
    await dir.remove();
    await dir.remove();
    expect(existsSync(dir.path)).toBe(false);

    const longBase = join(runBase, 'x'.repeat(90));
    await mkdir(longBase);
    expect((await rejection(createRunDir({ base: longBase }))).code).toBe('CONFIGURATION_ERROR');
    expect(await readdir(longBase)).toEqual([]);
  });
});
