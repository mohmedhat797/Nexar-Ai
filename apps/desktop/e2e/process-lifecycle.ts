import { execFile, type ChildProcess } from 'node:child_process';

const exited = (child: ChildProcess): boolean =>
  child.exitCode !== null || child.signalCode !== null;

function waitForExit(child: ChildProcess, timeoutMs: number): Promise<boolean> {
  if (exited(child)) return Promise.resolve(true);
  return new Promise((resolve) => {
    const finish = (done: boolean) => {
      clearTimeout(timer);
      child.removeListener('exit', onExit);
      resolve(done);
    };
    const onExit = () => finish(true);
    const timer = setTimeout(() => finish(false), timeoutMs);
    child.once('exit', onExit);
    if (exited(child)) finish(true);
  });
}

async function terminateTree(child: ChildProcess): Promise<void> {
  if (exited(child)) return;
  if (process.platform === 'win32' && child.pid !== undefined) {
    await new Promise<void>((resolve, reject) => {
      execFile(
        'taskkill.exe',
        ['/pid', String(child.pid), '/T', '/F'],
        { windowsHide: true, timeout: 5_000 },
        (error) => {
          if (error && !exited(child)) reject(new Error('E2E process tree termination failed'));
          else resolve();
        },
      );
    });
  } else if (!child.kill('SIGKILL') && !exited(child)) {
    throw new Error('E2E process termination failed');
  }
}

/**
 * A Windows shell's exit is not proof that its Electron child exited. Observe absence
 * of the main PID obtained from that application before reusing its profile. Signal 0
 * never terminates a process; even PID reuse fails closed rather than killing a stranger.
 */
export async function waitForMainProcessExit(identity: {
  readonly pid: number;
  readonly createdAtEpochMs?: number | undefined;
}): Promise<void> {
  if (!Number.isSafeInteger(identity.pid) || identity.pid <= 0)
    throw new Error('E2E main process identity unavailable; profile retained');
  const deadline = performance.now() + 5_000;
  for (;;) {
    try {
      process.kill(identity.pid, 0);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ESRCH') return;
      throw new Error('E2E main process exit could not be verified; profile retained', {
        cause: error,
      });
    }
    if (performance.now() >= deadline)
      throw new Error('E2E main process remains present; profile retained');
    await new Promise<void>((resolve) => setTimeout(resolve, 25));
  }
}

/** Profile reuse/removal is allowed only after the owned child has actually exited. */
export async function finishProcess(
  child: ChildProcess,
  close: () => Promise<void>,
  options: {
    readonly graceMs?: number;
    readonly killMs?: number;
    readonly terminate?: (child: ChildProcess) => Promise<void>;
    readonly verifyExit?: () => Promise<void>;
  } = {},
): Promise<{ forced: boolean }> {
  const finish = async (forced: boolean) => {
    await options.verifyExit?.();
    return { forced };
  };
  if (exited(child)) {
    if (options.verifyExit)
      void Promise.resolve()
        .then(close)
        .catch(() => undefined);
    return finish(false);
  }
  const closed = waitForExit(child, options.graceMs ?? 20_000);
  // Electron's connection can close before its OS process. Neither a resolved nor rejected
  // protocol close substitutes for the process-exit observation above.
  void Promise.resolve()
    .then(close)
    .catch(() => undefined);
  if (await closed) return finish(false);
  await (options.terminate ?? terminateTree)(child);
  if (!(await waitForExit(child, options.killMs ?? 5_000)))
    throw new Error('E2E process did not exit; profile retained');
  return finish(true);
}
