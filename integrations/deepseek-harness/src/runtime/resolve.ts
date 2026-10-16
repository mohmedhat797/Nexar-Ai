import { spawn as nodeSpawn } from 'node:child_process';
import { extname, isAbsolute } from 'node:path';
import { NexarError } from '@nexar/contracts';
import { DSH_PINNED_VERSION } from '../resource.js';

const DEFAULT_PROBE_TIMEOUT_MS = 30_000;
const VERSION_OUTPUT_MAX = 256;
const SAFE_VERSION = /^[0-9A-Za-z][0-9A-Za-z.+-]{0,39}$/;
const NODE_ENTRY_EXTENSIONS = new Set(['.js', '.mjs', '.cjs']);
const SHELL_ENTRY_EXTENSIONS = new Set(['.cmd', '.bat', '.ps1']);

/** Parent variables a host-local DSH child may inherit; nothing else is ever passed through. */
export const PARENT_ENV_ALLOWLIST = [
  'PATH',
  'Path',
  'SystemRoot',
  'SYSTEMROOT',
  'WINDIR',
  'TEMP',
  'TMP',
  'TMPDIR',
  'LANG',
  'LC_ALL',
  'TERM',
  'COMSPEC',
  'PATHEXT',
] as const;

export interface DshLaunch {
  readonly command: string;
  readonly args: readonly string[];
  /** Extra environment the launch needs (e.g. `ELECTRON_RUN_AS_NODE`). */
  readonly env: Readonly<Record<string, string>>;
}

/**
 * How to run a DSH entry without a shell. A `.js`/`.mjs`/`.cjs` entry runs as `<nodeCommand> <entry>`
 * with `nodeEnv` added (Electron passes `ELECTRON_RUN_AS_NODE=1`); anything else runs directly.
 * Rejects relative paths and `.cmd`/`.bat`/`.ps1` entries (`CONFIGURATION_ERROR`).
 */
export function dshLaunchFor(
  entry: string,
  options: { nodeCommand: string; nodeEnv?: Readonly<Record<string, string>> },
): DshLaunch {
  if (typeof entry !== 'string' || entry === '' || !isAbsolute(entry)) {
    throw new NexarError('CONFIGURATION_ERROR', 'the dsh entry must be an absolute path');
  }
  const extension = extname(entry).toLowerCase();
  if (SHELL_ENTRY_EXTENSIONS.has(extension)) {
    throw new NexarError(
      'CONFIGURATION_ERROR',
      'the dsh entry must be an executable or a Node script, not a shell script',
    );
  }
  if (!NODE_ENTRY_EXTENSIONS.has(extension)) return { command: entry, args: [], env: {} };
  if (options.nodeCommand === '' || !isAbsolute(options.nodeCommand)) {
    throw new NexarError('CONFIGURATION_ERROR', 'the Node command must be an absolute path');
  }
  return { command: options.nodeCommand, args: [entry], env: { ...options.nodeEnv } };
}

/** The allowlisted slice of `parent` plus the launch's own extra variables. */
export function allowlistedEnv(
  launch: DshLaunch,
  parent: NodeJS.ProcessEnv,
): Record<string, string> {
  const env: Record<string, string> = { ...launch.env };
  for (const name of PARENT_ENV_ALLOWLIST) {
    const value = parent[name];
    if (typeof value === 'string') env[name] = value;
  }
  return env;
}

export type DshRuntimeState = 'ready' | 'dsh-missing' | 'unsupported-version' | 'startup-failed';

export interface DshRuntimeStatus {
  readonly state: DshRuntimeState;
  readonly version?: string;
}

export interface ProbeOptions {
  readonly parentEnv: NodeJS.ProcessEnv;
  readonly timeoutMs?: number;
  readonly spawn?: typeof nodeSpawn;
}

/**
 * Runs `<launch> --version` with a minimal environment and a deadline; an exact match with
 * `DSH_PINNED_VERSION` is `ready`. Never throws and never reports the child's raw output.
 */
export function probeDshRuntime(
  launch: DshLaunch,
  options: ProbeOptions,
): Promise<DshRuntimeStatus> {
  const spawnFn = options.spawn ?? nodeSpawn;
  const timeoutMs = options.timeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS;
  return new Promise((resolve) => {
    let settled = false;
    let child: ReturnType<typeof nodeSpawn> | undefined;
    const finish = (status: DshRuntimeStatus): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(status);
    };
    const timer = setTimeout(() => {
      finish({ state: 'startup-failed' });
      try {
        child?.kill();
      } catch {
        // already gone
      }
    }, timeoutMs);

    try {
      child = spawnFn(launch.command, [...launch.args, '--version'], {
        env: allowlistedEnv(launch, options.parentEnv),
        stdio: ['ignore', 'pipe', 'ignore'],
        windowsHide: true,
      });
    } catch (error) {
      finish({ state: missing(error) ? 'dsh-missing' : 'startup-failed' });
      return;
    }

    let stdout = '';
    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => {
      if (stdout.length < VERSION_OUTPUT_MAX) stdout += chunk;
    });
    child.on('error', (error) => {
      finish({ state: missing(error) ? 'dsh-missing' : 'startup-failed' });
    });
    child.on('close', (code) => {
      if (code !== 0) return finish({ state: 'startup-failed' });
      const version = stdout.trim();
      if (version === DSH_PINNED_VERSION) return finish({ state: 'ready', version });
      finish(
        SAFE_VERSION.test(version)
          ? { state: 'unsupported-version', version }
          : { state: 'unsupported-version' },
      );
    });
  });
}

function missing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT';
}
