import type { ChildProcess, spawn } from 'node:child_process';

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
 * Runs a child in its own process group. Never rejects: timeout, abort and spawn failure are
 * outcomes. Stopping sends SIGTERM to the whole group, then SIGKILL after a grace period; the group
 * is also swept once the leader exits. The relay's stdout and stderr only summarize `result.json`,
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
        detached: true,
        stdio: [spec.stdin === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
      });
    } catch (e) {
      resolve({ kind: 'spawn-error', error: e as NodeJS.ErrnoException });
      return;
    }

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
    child.once('exit', () => signalGroup(child, 'SIGKILL'));
    child.once('close', (exitCode) => {
      signalGroup(child, 'SIGKILL');
      finish(stopping === undefined ? { kind: 'exited', exitCode } : { kind: stopping });
    });

    if (spec.stdin !== undefined && child.stdin) {
      child.stdin.on('error', () => undefined); // EPIPE when the child exits without reading
      child.stdin.end(spec.stdin);
    }
  });
}
