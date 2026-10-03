import { spawn, type ChildProcess } from 'node:child_process';
import { win32 } from 'node:path';
import { NexarError } from '@nexar/contracts';
import {
  createPlaneFrameDecoder,
  encodeFrame,
  type DesktopFrame,
  type PlaneFrame,
} from '@nexar/plane-protocol';
import { terminateProcessTree } from '@nexar/process';

/*
 * The process side of the Desktop <-> WSL2 engineering-plane bridge (ADR-025 sections 1 and 2):
 * how the plane is launched and a pull-based connection over its stdio. Shell-free, a minimal
 * explicit environment, stderr drained and discarded (never read, never logged), the whole process
 * tree ended on cancel, timeout or exit. No distro, command, path or environment value is ever
 * taken from the renderer.
 */

/** What the launcher is told: owner configuration only, already pattern-validated. */
export interface PlaneLaunchTarget {
  readonly distro: string;
  readonly command: string;
}

/** Starts a plane process with piped stdio; throws when the plane cannot be launched at all. */
export type PlaneLauncher = (target: PlaneLaunchTarget) => ChildProcess;

/** The fixed arguments after `wsl.exe`: no generic command, path or environment field. */
export function planeLaunchArguments(target: PlaneLaunchTarget): string[] {
  return ['-d', target.distro, '--exec', target.command, 'plane', 'serve', '--stdio'];
}

export interface WslLauncherOptions {
  readonly spawnImpl?: typeof spawn;
  /** Defaults to `process.env['SystemRoot']`. */
  readonly systemRoot?: string | undefined;
  readonly platform?: NodeJS.Platform;
}

function unavailable(): NexarError {
  return new NexarError('INTEGRATION_UNAVAILABLE', 'WSL is not available on this computer');
}

/**
 * Launches `%SystemRoot%\System32\wsl.exe -d <distro> --exec <command> plane serve --stdio`.
 * The environment is exactly `{ SystemRoot }`: never `WSLENV`, never Desktop's own environment
 * (and therefore no key-store value or credential can reach the distro).
 */
export function createWslLauncher(options: WslLauncherOptions = {}): PlaneLauncher {
  const platform = options.platform ?? process.platform;
  const systemRoot = 'systemRoot' in options ? options.systemRoot : process.env['SystemRoot'];
  const spawnImpl = options.spawnImpl ?? spawn;
  return (target) => {
    if (platform !== 'win32' || systemRoot === undefined || !win32.isAbsolute(systemRoot)) {
      throw unavailable();
    }
    return spawnImpl(win32.join(systemRoot, 'System32', 'wsl.exe'), planeLaunchArguments(target), {
      env: { SystemRoot: systemRoot },
      shell: false,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  };
}

/** A launcher for hermetic test runs that must never reach a real WSL. */
export const disabledPlaneLauncher: PlaneLauncher = () => {
  throw unavailable();
};

/**
 * TEST SEAM. Launches `script` with this executable (`ELECTRON_RUN_AS_NODE=1`) INSTEAD of
 * `wsl.exe`, so end-to-end tests can drive Desktop against a fake plane. `main.ts` only enables it
 * when the test-only `NEXAR_DESKTOP_USER_DATA` override is present together with
 * `NEXAR_DESKTOP_TEST_PLANE`; it is never set in production. Only `NEXAR_FAKE_PLANE_*` variables
 * (scenario selectors of the fake) are passed along.
 */
export function createScriptLauncher(
  script: string,
  parent: NodeJS.ProcessEnv = process.env,
  spawnImpl: typeof spawn = spawn,
): PlaneLauncher {
  return () => {
    const env: Record<string, string> = { ELECTRON_RUN_AS_NODE: '1' };
    const systemRoot = parent['SystemRoot'];
    if (systemRoot !== undefined) env['SystemRoot'] = systemRoot;
    for (const [name, value] of Object.entries(parent)) {
      if (name.startsWith('NEXAR_FAKE_PLANE_') && value !== undefined) env[name] = value;
    }
    return spawnImpl(process.execPath, [script], {
      env,
      shell: false,
      windowsHide: true,
      detached: process.platform !== 'win32',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  };
}

// ---- connection -------------------------------------------------------------------------------

export type ConnectionEnd = 'exit' | 'spawn-enoent' | 'spawn-error' | 'protocol';

export type ConnectionEvent =
  | { readonly type: 'frame'; readonly frame: PlaneFrame }
  | { readonly type: 'end'; readonly reason: ConnectionEnd };

/** After the leader exits, how long late stdout may still arrive before the end is reported. */
const EXIT_SETTLE_MS = 250;

/**
 * One launched plane process as an ordered event stream. A single consumer pulls events with
 * {@link next}; nothing is lost between pulls. A frame that does not decode ends the connection
 * (and the process tree): the plane never sends one.
 */
export class PlaneConnection {
  private readonly decoder = createPlaneFrameDecoder();
  private readonly queue: ConnectionEvent[] = [];
  private waiter: ((event: ConnectionEvent) => void) | undefined;
  private endEvent: ConnectionEvent | undefined;
  private killing: Promise<void> | undefined;
  private exitTimer: NodeJS.Timeout | undefined;

  constructor(private readonly child: ChildProcess) {
    child.stdout?.on('data', (chunk: Buffer | string) => this.onData(chunk));
    // Drained so the pipe never blocks; the content is discarded unread (it may hold anything).
    child.stderr?.on('data', () => undefined);
    child.stdin?.on('error', () => undefined);
    child.stdout?.on('error', () => undefined);
    child.stderr?.on('error', () => undefined);
    child.once('error', (error: NodeJS.ErrnoException) => {
      // A spawn failure has no pid; any later error (a failed kill, say) is not an end.
      if (child.pid !== undefined) return;
      this.finish(error.code === 'ENOENT' ? 'spawn-enoent' : 'spawn-error');
    });
    child.once('exit', () => {
      this.exitTimer = setTimeout(() => this.finish('exit'), EXIT_SETTLE_MS);
    });
    child.once('close', () => this.finish('exit'));
  }

  /** Whether the process has ended (or the connection was torn down). */
  get ended(): boolean {
    return this.endEvent !== undefined;
  }

  /** Validates and writes one frame. Throws `VALIDATION_ERROR` for an invalid or oversize frame. */
  send(frame: DesktopFrame): void {
    const line = encodeFrame(frame);
    const stdin = this.child.stdin;
    if (stdin === null || stdin.destroyed || !stdin.writable) return; // the end event follows
    stdin.write(line);
  }

  /** Like {@link send} but a frame that cannot be sent is dropped (cancel and shutdown paths). */
  trySend(frame: DesktopFrame): boolean {
    try {
      this.send(frame);
      return true;
    } catch {
      return false;
    }
  }

  /** The next event; `undefined` after `timeoutMs`. The end is sticky once reached. */
  next(timeoutMs?: number): Promise<ConnectionEvent | undefined> {
    const queued = this.queue.shift();
    if (queued !== undefined) return Promise.resolve(queued);
    if (this.endEvent !== undefined) return Promise.resolve(this.endEvent);
    return new Promise((resolve) => {
      const timer =
        timeoutMs === undefined
          ? undefined
          : setTimeout(
              () => {
                this.waiter = undefined;
                resolve(undefined);
              },
              Math.max(0, Math.min(timeoutMs, 2_147_483_647)),
            );
      this.waiter = (event) => {
        clearTimeout(timer);
        this.waiter = undefined;
        resolve(event);
      };
    });
  }

  /** Waits for the process to end, discarding frames, for at most `timeoutMs`. */
  async untilEnd(timeoutMs: number): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const event = await this.next(Math.max(0, deadline - Date.now()));
      if (event === undefined) return false;
      if (event.type === 'end') return true;
    }
  }

  /** Ends the process and its descendants now. Idempotent; never rejects. */
  kill(): Promise<void> {
    if (this.child.exitCode !== null || this.child.signalCode !== null) {
      return Promise.resolve();
    }
    this.killing ??= terminateProcessTree(this.child).catch(() => undefined);
    return this.killing;
  }

  /** `shutdown`, a bounded wait for the plane to leave on its own, then the tree is ended. */
  async close(graceMs: number): Promise<void> {
    if (!this.ended) {
      this.trySend({ type: 'shutdown' });
      await this.untilEnd(graceMs);
    }
    await this.kill();
    this.child.stdin?.destroy();
  }

  private onData(chunk: Buffer | string): void {
    if (this.endEvent !== undefined) return;
    for (const result of this.decoder.push(chunk)) {
      if (this.endEvent !== undefined) return;
      if (!result.ok) {
        // Reported by kind only; the offending content is never kept.
        this.finish('protocol');
        void this.kill();
        return;
      }
      this.deliver({ type: 'frame', frame: result.frame });
    }
  }

  private deliver(event: ConnectionEvent): void {
    const waiter = this.waiter;
    if (waiter !== undefined) waiter(event);
    else this.queue.push(event);
  }

  private finish(reason: ConnectionEnd): void {
    if (this.endEvent !== undefined) return;
    clearTimeout(this.exitTimer);
    const event: ConnectionEvent = { type: 'end', reason };
    this.endEvent = event;
    const waiter = this.waiter;
    if (waiter !== undefined && this.queue.length === 0) waiter(event);
  }
}
