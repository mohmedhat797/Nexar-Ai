import { execFile, type ChildProcess, type spawn } from 'node:child_process';
import { isAbsolute, join } from 'node:path';

export const KILL_GRACE_MS = 2000;
export const MAX_LINE_BYTES = 1024 * 1024;
export const MAX_STDOUT_BYTES = 32 * 1024 * 1024;
const STDERR_CAP = 8192;

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
  /** Called for every complete stdout line. */
  readonly onLine: (line: string) => void;
  readonly onSpawn?: () => void;
  readonly killGraceMs?: number;
}

export type ProcessOutcome =
  | { readonly kind: 'exited'; readonly exitCode: number | null; readonly stderr: string }
  | { readonly kind: 'timeout'; readonly stderr: string }
  | { readonly kind: 'aborted'; readonly stderr: string }
  | { readonly kind: 'overflow'; readonly stderr: string }
  | { readonly kind: 'spawn-error'; readonly error: NodeJS.ErrnoException };

type StopReason = 'timeout' | 'aborted' | 'overflow';

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
 * Runs a child in its own process group and streams stdout line by line. Never rejects: timeout,
 * abort, output overflow (a line over 1 MiB or more than 32 MiB total) and spawn failure are
 * outcomes. POSIX sends SIGTERM to the group, then SIGKILL after a grace period, and sweeps the
 * group after leader exit. Windows abort/timeout uses taskkill for the live process tree;
 * descendants of a leader that has already exited require a Windows Job Object to contain.
 * `stderr` is a bounded tail and must never be logged at info or above.
 */
export function runProcess(spec: ProcessSpec): Promise<ProcessOutcome> {
  return new Promise((resolve) => {
    if (spec.signal.aborted) {
      resolve({ kind: 'aborted', stderr: '' });
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

    let stderr = '';
    let pending = '';
    let totalBytes = 0;
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

    function feed(chunk: string): void {
      if (stopping !== undefined) return;
      totalBytes += Buffer.byteLength(chunk);
      if (totalBytes > MAX_STDOUT_BYTES) return stop('overflow');
      pending += chunk;
      let newline = pending.indexOf('\n');
      while (newline >= 0) {
        const line = pending.slice(0, newline);
        pending = pending.slice(newline + 1);
        if (line.length > MAX_LINE_BYTES) return stop('overflow');
        spec.onLine(line);
        newline = pending.indexOf('\n');
      }
      if (pending.length > MAX_LINE_BYTES) stop('overflow');
    }

    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', feed);
    child.stderr?.setEncoding('utf8');
    child.stderr?.on('data', (chunk: string) => {
      stderr = (stderr + chunk).slice(-STDERR_CAP);
    });

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
      if (stopping === undefined && pending.trim() !== '') spec.onLine(pending);
      if (process.platform !== 'win32') cleanup = signalGroup(child, 'SIGKILL');
      finish(
        stopping === undefined ? { kind: 'exited', exitCode, stderr } : { kind: stopping, stderr },
      );
    });

    if (spec.stdin !== undefined && child.stdin) {
      child.stdin.on('error', () => undefined); // EPIPE when the child exits without reading
      child.stdin.end(spec.stdin);
    }
  });
}
