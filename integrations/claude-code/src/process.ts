import type { ChildProcess, spawn } from 'node:child_process';

const KILL_GRACE_MS = 2000;
const STDERR_CAP = 8192;

export interface ProcessSpec {
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
  /** When set, written to the child's stdin (then closed); otherwise stdin is ignored. */
  readonly stdin?: string;
  readonly timeoutMs: number;
  readonly signal: AbortSignal;
  readonly spawnImpl: typeof spawn;
  readonly onSpawn?: () => void;
  /** Called for each complete stdout line as it arrives (stdout is still collected in full). */
  readonly onStdoutLine?: (line: string) => void;
}

export type ProcessOutcome =
  | {
      readonly kind: 'exited';
      readonly exitCode: number | null;
      readonly stdout: string;
      readonly stderr: string;
    }
  | { readonly kind: 'timeout'; readonly stdout: string; readonly stderr: string }
  | { readonly kind: 'aborted'; readonly stdout: string; readonly stderr: string }
  | { readonly kind: 'spawn-error'; readonly error: NodeJS.ErrnoException };

/**
 * Runs a child process to completion. Never rejects: timeout, abort (SIGTERM, then SIGKILL after a
 * grace period) and spawn failure are reported as outcomes. `stderr` is the tail only.
 */
export function runProcess(spec: ProcessSpec): Promise<ProcessOutcome> {
  return new Promise((resolve) => {
    if (spec.signal.aborted) {
      resolve({ kind: 'aborted', stdout: '', stderr: '' });
      return;
    }

    let child: ChildProcess;
    try {
      child = spec.spawnImpl(spec.command, [...spec.args], {
        cwd: spec.cwd,
        env: spec.env,
        stdio: [spec.stdin === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
      });
    } catch (e) {
      resolve({ kind: 'spawn-error', error: e as NodeJS.ErrnoException });
      return;
    }

    let stdout = '';
    let stderr = '';
    let stopping: 'timeout' | 'aborted' | undefined;
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

    function stop(reason: 'timeout' | 'aborted'): void {
      if (stopping !== undefined || settled) return;
      stopping = reason;
      child.kill('SIGTERM');
      killTimer = setTimeout(() => child.kill('SIGKILL'), KILL_GRACE_MS);
    }

    child.stdout?.setEncoding('utf8');
    let lineBuffer = '';
    child.stdout?.on('data', (chunk: string) => {
      stdout += chunk;
      if (spec.onStdoutLine === undefined) return;
      lineBuffer += chunk;
      const lines = lineBuffer.split('\n');
      lineBuffer = lines.pop() ?? '';
      for (const line of lines) spec.onStdoutLine(line);
    });
    child.stdout?.on('end', () => {
      if (lineBuffer !== '') spec.onStdoutLine?.(lineBuffer);
      lineBuffer = '';
    });
    child.stderr?.setEncoding('utf8');
    child.stderr?.on('data', (chunk: string) => {
      stderr = (stderr + chunk).slice(-STDERR_CAP);
    });

    child.once('spawn', () => spec.onSpawn?.());
    child.once('error', (error) => {
      // After a successful spawn an 'error' means kill/IPC trouble; 'close' still follows.
      if (child.pid === undefined) finish({ kind: 'spawn-error', error });
    });
    child.once('close', (exitCode) => {
      finish(
        stopping === undefined
          ? { kind: 'exited', exitCode, stdout, stderr }
          : { kind: stopping, stdout, stderr },
      );
    });

    if (spec.stdin !== undefined && child.stdin) {
      child.stdin.on('error', () => undefined); // EPIPE when the child exits without reading
      child.stdin.end(spec.stdin);
    }
  });
}
