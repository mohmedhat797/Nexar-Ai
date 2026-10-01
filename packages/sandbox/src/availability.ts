import { execFile } from 'node:child_process';
import { access, constants, mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildBwrapArgs } from './profile.js';
import { createRunDir } from './run-dir.js';

export interface ExecResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

/** Runs a binary with a minimal environment. Must not throw for a non-zero exit. */
export type ExecFn = (file: string, args: readonly string[]) => Promise<ExecResult>;

export interface SandboxAvailabilityOptions {
  readonly bwrapPath?: string;
  readonly socatPath?: string;
  /** Test seam. */
  readonly exec?: ExecFn;
  /** Test seam: whether an executable exists. Default: `access(X_OK)`. */
  readonly exists?: (path: string) => Promise<boolean>;
  /** Base for the probe's temp directories. Default `os.tmpdir()`. */
  readonly tmpBase?: string;
  readonly allowNestedUserNamespaces?: boolean;
}

export interface SandboxAvailability {
  /** bwrap is present, new enough, and a functional probe succeeded. Independent of socat. */
  readonly available: boolean;
  readonly bwrapPath?: string;
  readonly bwrapVersion?: string;
  /** Needed only for proxy network mode. */
  readonly socatPath?: string;
  readonly detail: string;
}

const BWRAP_CANDIDATES = ['/usr/bin/bwrap', '/usr/local/bin/bwrap'];
const SOCAT_CANDIDATES = ['/usr/bin/socat', '/usr/local/bin/socat'];
/** `--disable-userns` needs bubblewrap 0.8.0. */
const MIN_VERSION: readonly [number, number, number] = [0, 8, 0];
const PROBE_TIMEOUT_MS = 10_000;

const defaultExec: ExecFn = (file, args) =>
  new Promise((resolve) => {
    execFile(
      file,
      [...args],
      { env: { PATH: '/usr/bin:/bin' }, timeout: PROBE_TIMEOUT_MS, maxBuffer: 1 << 20 },
      (error, stdout, stderr) => {
        const code = (error as { code?: unknown } | null)?.code;
        resolve({
          exitCode: error === null ? 0 : typeof code === 'number' ? code : 1,
          stdout,
          stderr,
        });
      },
    );
  });

const defaultExists = async (path: string): Promise<boolean> =>
  access(path, constants.X_OK).then(
    () => true,
    () => false,
  );

async function firstExisting(
  explicit: string | undefined,
  candidates: readonly string[],
  exists: (path: string) => Promise<boolean>,
): Promise<string | undefined> {
  for (const candidate of explicit === undefined ? candidates : [explicit]) {
    if (await exists(candidate)) {
      return candidate;
    }
  }
  return undefined;
}

function parseVersion(text: string): readonly [number, number, number] | undefined {
  const match = /(\d+)\.(\d+)\.(\d+)/.exec(text);
  return match === null ? undefined : [Number(match[1]), Number(match[2]), Number(match[3])];
}

function isAtLeast(
  version: readonly [number, number, number],
  min: readonly [number, number, number],
): boolean {
  for (let i = 0; i < 3; i += 1) {
    const a = version[i] ?? 0;
    const b = min[i] ?? 0;
    if (a !== b) {
      return a > b;
    }
  }
  return true;
}

function firstLine(text: string): string {
  return (text.trim().split('\n')[0] ?? '').slice(0, 200);
}

/** Never throws for "not available": returns `available: false` with the reason. */
export async function checkSandboxAvailability(
  options: SandboxAvailabilityOptions = {},
): Promise<SandboxAvailability> {
  const exec = options.exec ?? defaultExec;
  const exists = options.exists ?? defaultExists;
  const socatPath = await firstExisting(options.socatPath, SOCAT_CANDIDATES, exists);
  const socat = socatPath === undefined ? {} : { socatPath };

  const bwrapPath = await firstExisting(options.bwrapPath, BWRAP_CANDIDATES, exists);
  if (bwrapPath === undefined) {
    return { available: false, ...socat, detail: 'bubblewrap (bwrap) was not found' };
  }
  const versionResult = await exec(bwrapPath, ['--version']);
  const version = parseVersion(versionResult.stdout);
  if (versionResult.exitCode !== 0 || version === undefined) {
    return { available: false, bwrapPath, ...socat, detail: 'bwrap --version failed' };
  }
  const bwrapVersion = version.join('.');
  if (!isAtLeast(version, MIN_VERSION)) {
    return {
      available: false,
      bwrapPath,
      bwrapVersion,
      ...socat,
      detail: `bubblewrap ${bwrapVersion} is too old; 0.8.0 or newer is required`,
    };
  }

  const probe = await runProbe(bwrapPath, exec, options);
  if (probe !== undefined) {
    return {
      available: false,
      bwrapPath,
      bwrapVersion,
      ...socat,
      detail: `bwrap functional probe failed: ${probe}`,
    };
  }
  return {
    available: true,
    bwrapPath,
    bwrapVersion,
    ...socat,
    detail:
      socatPath === undefined
        ? `bubblewrap ${bwrapVersion} works; socat not found (proxy network mode unavailable)`
        : `bubblewrap ${bwrapVersion} works`,
  };
}

/** Runs `/usr/bin/true` in the real profile (network none). Returns a failure reason or undefined. */
async function runProbe(
  bwrapPath: string,
  exec: ExecFn,
  options: SandboxAvailabilityOptions,
): Promise<string | undefined> {
  const base = await realpath(options.tmpBase ?? tmpdir()).catch(() => undefined);
  if (base === undefined) {
    return 'no temporary directory';
  }
  let workspace: string | undefined;
  let runDir: Awaited<ReturnType<typeof createRunDir>> | undefined;
  try {
    workspace = await mkdtemp(join(base, 'nexar-sbx-probe-'));
    runDir = await createRunDir({ base });
    const args = buildBwrapArgs({
      workspace,
      workspaceAccess: 'read-only',
      protectGit: false,
      toolchainPaths: [],
      mounts: [],
      runDir: runDir.path,
      network: 'none',
      allowNestedUserNamespaces: options.allowNestedUserNamespaces ?? false,
      env: { PATH: '/usr/bin:/bin' },
      command: '/usr/bin/true',
      args: [],
    });
    const result = await exec(bwrapPath, args);
    return result.exitCode === 0
      ? undefined
      : firstLine(result.stderr) || `exit code ${result.exitCode}`;
  } catch (error) {
    return error instanceof Error ? firstLine(error.message) : 'unknown error';
  } finally {
    await runDir?.remove().catch(() => undefined);
    if (workspace !== undefined) {
      await rm(workspace, { recursive: true, force: true }).catch(() => undefined);
    }
  }
}
