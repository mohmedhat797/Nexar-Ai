import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { PreparedLaunch, ProcessLauncher, LaunchSpec } from '@nexar/contracts';

const GIT_ENV = {
  PATH: process.env['PATH'] ?? '/usr/bin:/bin',
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_AUTHOR_NAME: 'Owner',
  GIT_AUTHOR_EMAIL: 'owner@example.invalid',
  GIT_COMMITTER_NAME: 'Owner',
  GIT_COMMITTER_EMAIL: 'owner@example.invalid',
};

/** Runs real git in a fixture or agent clone from the test itself (never from library code). */
export function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, env: GIT_ENV, encoding: 'utf8' });
}

export function tempDir(): string {
  return realpathSync(mkdtempSync(join(tmpdir(), 'nexar-wt-test-')));
}

export function cleanup(...dirs: string[]): void {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
}

export interface OwnerRepo {
  readonly path: string;
  readonly canary: string;
  readonly secretBlob: string;
}

/** Owner repo: `main` (a.txt, del.txt, bin.dat, tool.sh) + `secret-branch` (secret.env) + canary hooks. */
export function makeOwnerRepo(root: string): OwnerRepo {
  const path = join(root, 'owner');
  const canary = join(root, 'hook-canary');
  mkdirSync(path);
  git(path, 'init', '-q', '-b', 'main');
  writeFileSync(join(path, 'a.txt'), 'one\ntwo\nthree\n');
  writeFileSync(join(path, 'del.txt'), 'delete me\n');
  writeFileSync(join(path, 'bin.dat'), Buffer.from([0, 1, 2, 3, 255, 254]));
  writeFileSync(join(path, 'tool.sh'), '#!/bin/sh\necho hi\n');
  git(path, 'add', '-A');
  git(path, 'commit', '-q', '-m', 'init');
  git(path, 'checkout', '-q', '-b', 'secret-branch');
  writeFileSync(join(path, 'secret.env'), 'TOKEN=hunter2\n');
  git(path, 'add', '-A');
  git(path, 'commit', '-q', '-m', 'secret');
  const secretBlob = git(path, 'rev-parse', 'secret-branch:secret.env').trim();
  git(path, 'checkout', '-q', 'main');
  for (const hook of ['pre-commit', 'post-commit', 'post-checkout', 'reference-transaction']) {
    const file = join(path, '.git', 'hooks', hook);
    writeFileSync(file, `#!/bin/sh\necho ${hook} >> "${canary}"\n`);
    chmodSync(file, 0o755);
  }
  return { path, canary, secretBlob };
}

export interface FakeLauncher extends ProcessLauncher {
  disposed: number;
  specs: LaunchSpec[];
}

/**
 * Stands in for the sandbox: runs the command unsandboxed, maps sandbox paths in env values back
 * to the mounts' host paths, uses the workspace as cwd, and gives it a private `HOME`.
 */
export function fakeLauncher(
  home: string,
  isolation: 'none' | 'sandbox' = 'sandbox',
): FakeLauncher {
  const launcher: FakeLauncher = {
    isolation,
    disposed: 0,
    specs: [],
    prepare(spec): Promise<PreparedLaunch> {
      launcher.specs.push(spec);
      const env: Record<string, string> = {};
      for (const [key, value] of Object.entries(spec.env)) {
        let mapped = value;
        for (const mount of spec.mounts ?? []) {
          if (value === mount.sandboxPath || value.startsWith(`${mount.sandboxPath}/`)) {
            mapped = mount.hostPath + value.slice(mount.sandboxPath.length);
          }
        }
        env[key] = mapped;
      }
      env['HOME'] = home;
      return Promise.resolve({
        command: spec.command,
        args: spec.args,
        env,
        cwd: spec.workspace,
        workspacePath: '/work',
        isolation,
        dispose: () => {
          launcher.disposed += 1;
          return Promise.resolve();
        },
      });
    },
  };
  return launcher;
}
