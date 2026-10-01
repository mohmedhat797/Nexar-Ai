import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { LaunchSpec, NetworkPolicy, ProcessLauncher } from '@nexar/contracts';

export interface SelfTestResult {
  readonly name: string;
  readonly passed: boolean;
  readonly detail: string;
}

export interface SelfTestOptions {
  /** Base for the temporary workspace. Default `os.tmpdir()`. */
  readonly tmpBase?: string;
  /** Run the proxy-denial check. Default: socat exists at a standard location. */
  readonly socatAvailable?: boolean;
  readonly timeoutMs?: number;
}

interface RunOutcome {
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

const DEFAULT_TIMEOUT_MS = 20_000;

async function runInSandbox(
  launcher: ProcessLauncher,
  spec: LaunchSpec,
  timeoutMs: number,
): Promise<RunOutcome> {
  const controller = new AbortController();
  const prepared = await launcher.prepare(spec, controller.signal);
  try {
    return await new Promise<RunOutcome>((resolve, reject) => {
      const child = spawn(prepared.command, [...prepared.args], {
        cwd: prepared.cwd,
        env: { ...prepared.env },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString('utf8')));
      child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString('utf8')));
      const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
      child.once('error', (error) => {
        clearTimeout(timer);
        reject(error);
      });
      child.once('close', (exitCode) => {
        clearTimeout(timer);
        resolve({ exitCode, stdout, stderr });
      });
    });
  } finally {
    await prepared.dispose();
  }
}

/** Interface names listed in `/proc/net/dev` output. */
function interfaces(procNetDev: string): string[] {
  return procNetDev
    .split('\n')
    .filter((line) => line.includes(':') && !line.includes('|'))
    .map((line) => line.split(':')[0]?.trim() ?? '');
}

/**
 * Runs the sandbox isolation checks against real processes. Uses `/bin/sh` and coreutils only.
 * Never throws for a failed check; a check that cannot run is reported as failed.
 */
export async function runSandboxSelfTest(
  launcher: ProcessLauncher,
  options: SelfTestOptions = {},
): Promise<SelfTestResult[]> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const socatAvailable =
    options.socatAvailable ?? ['/usr/bin/socat', '/usr/local/bin/socat'].some((p) => existsSync(p));
  const base = await mkdtemp(join(await realpath(options.tmpBase ?? tmpdir()), 'nexar-selftest-'));
  const workspace = join(base, 'ws');
  const canary = join(base, 'canary.txt');
  await mkdir(join(workspace, '.git'), { recursive: true });
  await writeFile(join(workspace, '.git', 'HEAD'), 'ref: refs/heads/main\n');
  await writeFile(canary, 'host-only\n');

  const none: NetworkPolicy = { mode: 'none' };
  const sh = (
    script: string,
    network: NetworkPolicy = none,
    args: readonly string[] = [],
  ): LaunchSpec => ({
    command: '/bin/sh',
    args: ['-c', script, 'sh', ...args],
    env: {},
    workspace,
    workspaceAccess: 'read-write',
    network,
  });
  const results: SelfTestResult[] = [];
  const check = async (
    name: string,
    spec: LaunchSpec,
    verdict: (outcome: RunOutcome) => boolean,
  ): Promise<void> => {
    try {
      const outcome = await runInSandbox(launcher, spec, timeoutMs);
      const passed = verdict(outcome);
      results.push({
        name,
        passed,
        detail: passed
          ? 'ok'
          : `exit ${String(outcome.exitCode)}: ${outcome.stderr.trim().slice(0, 200)}`,
      });
    } catch (error) {
      const code = (error as { code?: unknown }).code;
      results.push({
        name,
        passed: false,
        detail: `could not run (${typeof code === 'string' ? code : 'error'})`,
      });
    }
  };

  try {
    await check(
      'workspace is writable at /work',
      sh('echo ok > /work/selftest.txt && cat /work/selftest.txt'),
      (o) => o.exitCode === 0 && o.stdout.trim() === 'ok',
    );
    await check(
      'root filesystem is read-only',
      sh('if touch /nexar-root-probe 2>/dev/null; then echo writable; else echo readonly; fi'),
      (o) => o.stdout.trim() === 'readonly',
    );
    await check(
      '/work/.git is read-only and cannot be moved',
      sh(
        'if touch /work/.git/probe 2>/dev/null; then echo writable; ' +
          'elif mv /work/.git /work/g 2>/dev/null; then echo moved; else echo protected; fi',
      ),
      (o) => o.stdout.trim() === 'protected',
    );
    await check(
      'host files outside the workspace are invisible',
      sh('if [ -e "$1" ]; then echo visible; else echo hidden; fi', none, [canary]),
      (o) => o.stdout.trim() === 'hidden',
    );
    await check('only loopback network interface exists', sh('cat /proc/net/dev'), (o) => {
      const names = interfaces(o.stdout);
      return o.exitCode === 0 && names.length === 1 && names[0] === 'lo';
    });
    if (socatAvailable) {
      await check(
        'proxy denies a non-allowlisted CONNECT',
        sh(
          "printf 'CONNECT evil.example:443 HTTP/1.1\\r\\nHost: evil.example:443\\r\\n\\r\\n' | " +
            'socat -t 2 - TCP:127.0.0.1:3128',
          { mode: 'proxy', allowHosts: ['allowed.example'] },
        ),
        (o) => o.stdout.startsWith('HTTP/1.1 403'),
      );
    }
  } finally {
    await rm(base, { recursive: true, force: true }).catch(() => undefined);
  }
  return results;
}
