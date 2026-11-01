import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SANDBOX_CODEX_HOME } from '@nexar/integration-codex';
import { SandboxLauncher, checkSandboxAvailability } from '@nexar/sandbox';

const availability = await checkSandboxAvailability();
const runnable = process.platform !== 'win32' && availability.available;
if (!runnable) {
  process.stderr.write(`[owner Codex home sandbox test skipped] ${availability.detail}\n`);
}

describe.skipIf(!runnable)('an owner Codex home in the real sandbox', () => {
  let base: string;

  beforeEach(async () => {
    base = await realpath(await mkdtemp(join(tmpdir(), 'nexar-owner-home-')));
  });
  afterEach(async () => {
    await rm(base, { recursive: true, force: true });
  });

  it('binds only the home of the connection that runs', async () => {
    const homeA = join(base, 'runtime-homes', 'a', 'codex');
    const homeB = join(base, 'runtime-homes', 'b', 'codex');
    const workspace = join(base, 'ws');
    await mkdir(homeA, { recursive: true, mode: 0o700 });
    await mkdir(homeB, { recursive: true, mode: 0o700 });
    await mkdir(join(workspace, '.git'), { recursive: true });
    await writeFile(join(workspace, '.git', 'HEAD'), 'ref: refs/heads/main\n');
    await writeFile(join(homeB, 'other-account'), 'synthetic');
    await mkdir(join(base, 'run'));
    const launcher = new SandboxLauncher({
      homeDir: join(base, 'home'),
      runDirBase: join(base, 'run'),
      toolchainPaths: [],
      onEgress: () => undefined,
    });

    const prepared = await launcher.prepare(
      {
        command: '/bin/sh',
        args: [
          '-c',
          `echo ran > "$CODEX_HOME/ran"; ls -A "$CODEX_HOME"; test -e "${homeB}" && echo OTHER-HOME-VISIBLE; test -e "${homeA}" && echo HOST-PATH-VISIBLE; exit 0`,
        ],
        env: { CODEX_HOME: SANDBOX_CODEX_HOME },
        workspace,
        workspaceAccess: 'read-only',
        network: { mode: 'none' },
        mounts: [{ hostPath: homeA, sandboxPath: SANDBOX_CODEX_HOME, access: 'read-write' }],
      },
      new AbortController().signal,
    );
    try {
      const { code, stdout } = await new Promise<{ code: number | null; stdout: string }>(
        (resolve, reject) => {
          const child = spawn(prepared.command, [...prepared.args], {
            cwd: prepared.cwd,
            env: { ...prepared.env },
          });
          let out = '';
          child.stdout.on('data', (chunk: Buffer) => (out += chunk.toString()));
          child.once('error', reject);
          child.once('close', (exit) => {
            resolve({ code: exit, stdout: out });
          });
        },
      );
      expect(code).toBe(0);
      expect(stdout.trim().split('\n')).toEqual(['ran']);
    } finally {
      await prepared.dispose();
    }
    expect(await readdir(homeA)).toEqual(['ran']);
    expect(await readdir(homeB)).toEqual(['other-account']);
  });
});
