import { spawn } from 'node:child_process';
import { NexarError, type NetworkPolicy, type ProcessLauncher } from '@nexar/contracts';

/** Combined output kept for the artifact. */
export const MAX_COMMAND_OUTPUT_BYTES = 1024 * 1024;
/** Tail of the output kept for rework findings. */
export const OUTPUT_TAIL_BYTES = 4 * 1024;

export interface CommandRun {
  /** `null` when killed by a signal or never started. */
  readonly exitCode: number | null;
  readonly timedOut: boolean;
  readonly cancelled: boolean;
  /** Output up to `MAX_COMMAND_OUTPUT_BYTES` (a note is appended if it was cut). */
  readonly output: Buffer;
  readonly tail: Buffer;
  readonly outputBytes: number;
}

export interface RunCommandOptions {
  readonly launcher: ProcessLauncher;
  readonly workspace: string;
  readonly access: 'read-only' | 'read-write';
  readonly argv: readonly string[];
  readonly network: NetworkPolicy;
  readonly timeoutMs: number;
  readonly signal?: AbortSignal;
}

/** Network policy for `setup`: only the owner's listed hosts, else none. */
export function networkFor(allowHosts: readonly string[]): NetworkPolicy {
  return allowHosts.length === 0 ? { mode: 'none' } : { mode: 'proxy', allowHosts };
}

/**
 * Runs an argv command exactly as `launcher.prepare` returns it. The environment is explicit and
 * minimal (the launcher adds `PATH`, `HOME` and the rest). The process group is killed on timeout
 * or cancellation. The command's own output never leaves this function except as bytes.
 */
export async function runCommand(options: RunCommandOptions): Promise<CommandRun> {
  const { launcher, argv } = options;
  const command = argv[0];
  if (launcher.isolation !== 'sandbox' || command === undefined) {
    throw new NexarError('POLICY_REJECTED', 'Commands require a sandboxing launcher');
  }
  const controller = new AbortController();
  const onAbort = (): void => controller.abort();
  options.signal?.addEventListener('abort', onAbort, { once: true });
  const prepared = await launcher.prepare(
    {
      command,
      args: argv.slice(1),
      env: { CI: '1', NO_COLOR: '1', LC_ALL: 'C.UTF-8' },
      workspace: options.workspace,
      workspaceAccess: options.access,
      network: options.network,
    },
    controller.signal,
  );
  try {
    if (prepared.isolation !== 'sandbox') {
      throw new NexarError('POLICY_REJECTED', 'Launcher did not apply sandbox isolation');
    }
    return await new Promise<CommandRun>((resolve) => {
      const head: Buffer[] = [];
      let headBytes = 0;
      let total = 0;
      let tail: Buffer = Buffer.alloc(0);
      let timedOut = false;
      let cancelled = false;
      let settled = false;

      function finish(exitCode: number | null): void {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        options.signal?.removeEventListener('abort', onAbort);
        options.signal?.removeEventListener('abort', abort);
        const note =
          total > headBytes
            ? Buffer.from(
                `\n[output truncated: ${String(headBytes)} of ${String(total)} bytes kept]\n`,
              )
            : Buffer.alloc(0);
        resolve({
          exitCode,
          timedOut,
          cancelled,
          output: Buffer.concat([...head, note]),
          tail,
          outputBytes: total,
        });
      }
      if (options.signal?.aborted === true) {
        resolve({
          exitCode: null,
          timedOut: false,
          cancelled: true,
          output: Buffer.alloc(0),
          tail,
          outputBytes: 0,
        });
        return;
      }

      const child = spawn(prepared.command, [...prepared.args], {
        cwd: prepared.cwd,
        env: { ...prepared.env },
        stdio: ['ignore', 'pipe', 'pipe'],
        shell: false,
        detached: true,
      });
      const kill = (): void => {
        try {
          if (child.pid !== undefined) process.kill(-child.pid, 'SIGKILL');
        } catch {
          child.kill('SIGKILL');
        }
      };
      function abort(): void {
        cancelled = true;
        kill();
      }
      const timer = setTimeout(() => {
        timedOut = true;
        kill();
      }, options.timeoutMs);
      options.signal?.addEventListener('abort', abort, { once: true });

      const collect = (chunk: Buffer): void => {
        total += chunk.length;
        tail = Buffer.concat([tail, chunk]).subarray(-OUTPUT_TAIL_BYTES);
        const room = MAX_COMMAND_OUTPUT_BYTES - headBytes;
        if (room > 0) {
          const part = chunk.subarray(0, room);
          head.push(part);
          headBytes += part.length;
        }
      };
      child.stdout.on('data', collect);
      child.stderr.on('data', collect);
      child.on('error', () => finish(null));
      child.on('close', (code) => finish(code));
    });
  } finally {
    options.signal?.removeEventListener('abort', onAbort);
    await prepared.dispose();
  }
}
