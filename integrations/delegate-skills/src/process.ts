import { execFile, type ChildProcess, type spawn } from 'node:child_process';
import { isAbsolute, join } from 'node:path';

export const KILL_GRACE_MS = 2000;

export interface ProcessSpec {
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly env: Readonly<Record<string, string>>;
  /** When set, written to the child's stdin and then closed; otherwise stdin is ignored. */
  readonly stdin?: string;
  readonly timeoutMs: number;
  readonly signal: AbortSignal;
  readonly spawnImpl: typeof spawn;
  readonly onSpawn?: () => void;
  /** Receives stdout text; when absent stdout is drained and discarded. */
  readonly onStdout?: (chunk: string) => void;
  readonly killGraceMs?: number;
}

export type ProcessOutcome =
  | { readonly kind: 'exited'; readonly exitCode: number | null }
  | { readonly kind: 'timeout' }
  | { readonly kind: 'aborted' }
  | { readonly kind: 'spawn-error'; readonly error: NodeJS.ErrnoException };

type StopReason = 'timeout' | 'aborted';

function signalGroup(child: ChildProcess, sig: NodeJS.Signals): Promise<void> {
  const pid = child.pid;
  if (pid === undefined) return Promise.resolve();
  if (process.platform === 'win32') {
    // Use the host's trusted system directory, never the child's PATH or environment.
    const systemRoot = process.env['SystemRoot'] ?? process.env['SYSTEMROOT'];
    if (systemRoot === undefined || !isAbsolute(systemRoot)) {
      child.kill();
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      execFile(
        join(systemRoot, 'System32', 'taskkill.exe'),
        ['/pid', String(pid), '/t', '/f'],
        { windowsHide: true, timeout: 5000, env: { SystemRoot: systemRoot } },
        (error) => {
          if (error !== null) child.kill();
          resolve();
        },
      );
    });
  }
  try {
    process.kill(-pid, sig);
  } catch {
    // ESRCH: the group is already gone.
  }
  return Promise.resolve();
}

/**
 * Runs a child in its own process group. Never rejects: timeout, abort and spawn failure are
 * outcomes. POSIX signals and sweeps the whole group. Windows abort/timeout uses taskkill for the
 * live process tree; an already-exited leader's descendants require a Windows Job Object to contain.
 * The relay's stdout and stderr only summarize `result.json`,
 * so both are drained and discarded unless `onStdout` asks for stdout (the probe's `--version`).
 */
export function runProcess(spec: ProcessSpec): Promise<ProcessOutcome> {
  return new Promise((resolve) => {
    if (spec.signal.aborted) {
      resolve({ kind: 'aborted' });
      return;
    }

    let child: ChildProcess;
    try {
      child = spec.spawnImpl(spec.command, [...spec.args], {
        cwd: spec.cwd,
        env: spec.env,
        detached: process.platform !== 'win32',
        windowsHide: true,
        stdio: [spec.stdin === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
      });
    } catch (e) {
      resolve({ kind: 'spawn-error', error: e as NodeJS.ErrnoException });
      return;
    }

    let stopping: StopReason | undefined;
    let settled = false;
    let killTimer: NodeJS.Timeout | undefined;
    let closeTimer: NodeJS.Timeout | undefined;
    let cleanup: Promise<void> | undefined;

    const onAbort = (): void => stop('aborted');
    const timeoutTimer = setTimeout(() => stop('timeout'), spec.timeoutMs);
    spec.signal.addEventListener('abort', onAbort, { once: true });

    function finish(outcome: ProcessOutcome): void {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutTimer);
      clearTimeout(killTimer);
      clearTimeout(closeTimer);
      spec.signal.removeEventListener('abort', onAbort);
      // A Windows tree kill can finish after the leader's close event.
      void (cleanup ?? Promise.resolve()).then(() => resolve(outcome));
    }

    function stop(reason: StopReason): void {
      if (stopping !== undefined || settled) return;
      stopping = reason;
      cleanup = signalGroup(child, 'SIGTERM');
      if (process.platform === 'win32') return;
      killTimer = setTimeout(() => {
        cleanup = signalGroup(child, 'SIGKILL');
      }, spec.killGraceMs ?? KILL_GRACE_MS);
    }

    if (spec.onStdout !== undefined) {
      child.stdout?.setEncoding('utf8');
      child.stdout?.on('data', spec.onStdout);
    } else {
      child.stdout?.resume();
    }
    child.stderr?.resume();

    child.once('spawn', () => spec.onSpawn?.());
    child.once('error', (error) => {
      if (child.pid === undefined) finish({ kind: 'spawn-error', error });
    });
    child.once('exit', () => {
      if (process.platform !== 'win32') {
        cleanup = signalGroup(child, 'SIGKILL');
        return;
      }
      // Windows has no POSIX process groups. Once the leader exits, taskkill cannot
      // identify its tree; bound inherited pipe handles so the outcome still settles.
      closeTimer = setTimeout(() => {
        child.stdout?.destroy();
        child.stderr?.destroy();
      }, spec.killGraceMs ?? KILL_GRACE_MS);
    });
    child.once('close', (exitCode) => {
      if (process.platform !== 'win32') cleanup = signalGroup(child, 'SIGKILL');
      finish(stopping === undefined ? { kind: 'exited', exitCode } : { kind: stopping });
    });

    if (spec.stdin !== undefined && child.stdin) {
      child.stdin.on('error', () => undefined); // EPIPE when the child exits without reading
      child.stdin.end(spec.stdin);
    }
  });
}
