import type { ChildProcess, spawn } from 'node:child_process';

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

function signalGroup(child: ChildProcess, sig: NodeJS.Signals): void {
  const pid = child.pid;
  if (pid === undefined) return;
  try {
    process.kill(-pid, sig);
  } catch {
    // ESRCH: the group is already gone.
  }
}

/**
 * Runs a child in its own process group and streams stdout line by line. Never rejects: timeout,
 * abort, output overflow (a line over 1 MiB or more than 32 MiB total) and spawn failure are
 * outcomes. Stopping sends SIGTERM to the whole group, then SIGKILL after a grace period; the group
 * is also swept as soon as the leader exits, so tool subprocesses cannot outlive the run.
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
        detached: true,
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

    const onAbort = (): void => stop('aborted');
    const timeoutTimer = setTimeout(() => stop('timeout'), spec.timeoutMs);
    spec.signal.addEventListener('abort', onAbort, { once: true });

    function finish(outcome: ProcessOutcome): void {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutTimer);
      clearTimeout(killTimer);
      spec.signal.removeEventListener('abort', onAbort);
      resolve(outcome);
    }

    function stop(reason: StopReason): void {
      if (stopping !== undefined || settled) return;
      stopping = reason;
      signalGroup(child, 'SIGTERM');
      killTimer = setTimeout(
        () => signalGroup(child, 'SIGKILL'),
        spec.killGraceMs ?? KILL_GRACE_MS,
      );
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
    child.once('exit', () => signalGroup(child, 'SIGKILL'));
    child.once('close', (exitCode) => {
      if (stopping === undefined && pending.trim() !== '') spec.onLine(pending);
      signalGroup(child, 'SIGKILL');
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
