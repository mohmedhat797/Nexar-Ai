import { spawn } from 'node:child_process';
import { NexarError } from '@nexar/contracts';

/** Options shared by every function that runs host git. */
export interface GitOptions {
  /** Git executable. Defaults to `git` resolved through `PATH`. */
  readonly gitPath?: string;
}

export interface RunGitOptions extends GitOptions {
  readonly cwd: string;
  /** Written to stdin, then stdin is closed. */
  readonly input?: string;
  /** Stdout beyond this many bytes aborts the command (default 16 MiB). */
  readonly maxOutputBytes?: number;
  /** Explicit additions to the minimal environment. */
  readonly env?: Readonly<Record<string, string>>;
  /** Short, path-free label used in error messages (for example `clone`). */
  readonly label?: string;
}

const DEFAULT_MAX_OUTPUT = 16 * 1024 * 1024;

/** Flags that neutralise repository-controlled code execution on every host git call. */
const SAFETY_FLAGS = [
  '-c',
  'core.hooksPath=/dev/null',
  '-c',
  'core.fsmonitor=false',
  '-c',
  'commit.gpgsign=false',
] as const;

function baseEnv(): Record<string, string> {
  return {
    PATH: process.env['PATH'] ?? '/usr/local/bin:/usr/bin:/bin',
    LC_ALL: 'C',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_TERMINAL_PROMPT: '0',
    GIT_OPTIONAL_LOCKS: '0',
  };
}

/**
 * Runs host git with a minimal environment and the safety flags, never through a shell.
 *
 * Rule: after a task has been handed to an agent, the host never calls this with the agent's
 * `work/` directory as `cwd` or `GIT_DIR`; the repository is attacker-controlled from then on.
 *
 * Errors carry only the label and exit status: git's stderr routinely contains paths.
 */
export function runGit(args: readonly string[], options: RunGitOptions): Promise<string> {
  const label = options.label ?? 'command';
  const max = options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT;
  return new Promise<string>((resolve, reject) => {
    const fail = (code: 'INTERNAL_ERROR' | 'VALIDATION_ERROR', message: string, exit?: unknown) =>
      reject(
        new NexarError(code, message, {
          details: { operation: label, ...(exit === undefined ? {} : { exit }) },
        }),
      );
    const child = spawn(options.gitPath ?? 'git', [...SAFETY_FLAGS, ...args], {
      cwd: options.cwd,
      env: { ...baseEnv(), ...options.env },
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: false,
    });
    const out: Buffer[] = [];
    let outBytes = 0;
    let overflow = false;
    child.stdout.on('data', (chunk: Buffer) => {
      outBytes += chunk.length;
      if (outBytes > max) {
        overflow = true;
        child.kill('SIGKILL');
        return;
      }
      out.push(chunk);
    });
    child.stderr.resume(); // drained and discarded; never surfaced
    child.stdin.on('error', () => undefined);
    child.on('error', () => fail('INTERNAL_ERROR', `git ${label} could not be started`));
    child.on('close', (exit, signal) => {
      if (overflow) {
        fail('VALIDATION_ERROR', `git ${label} output exceeded the size limit`);
      } else if (exit === 0) {
        resolve(Buffer.concat(out).toString('utf8'));
      } else {
        fail('INTERNAL_ERROR', `git ${label} failed`, exit ?? signal);
      }
    });
    child.stdin.end(options.input);
  });
}
