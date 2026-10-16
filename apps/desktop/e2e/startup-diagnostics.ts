import type { ChildProcess } from 'node:child_process';

/** Retain fixed startup phase timings only; child output may contain provider secrets. */
export function startupTimings(output: string): readonly string[] {
  return output
    .split(/\r?\n/)
    .filter((line) =>
      /^nexar-desktop: startup (begin|state-guard|ready|stores|engine-config|engine-compose|engine-workflows|engine|sessions|window) \d{1,9}ms$/.test(
        line,
      ),
    )
    .slice(-16);
}

/** Register before requesting quit: a closed automation connection does not prove process exit. */
export async function closeAndWait(
  child: ChildProcess,
  close: () => Promise<void>,
  timeoutMs = 20_000,
): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onClose: () => void = () => undefined;
  const ended = new Promise<void>((resolve) => {
    onClose = resolve;
    if (child.exitCode !== null || child.signalCode !== null) resolve();
    else child.once('close', onClose);
  });
  try {
    await Promise.race([
      close().then(() => ended),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error('Desktop process did not exit after quit')),
          timeoutMs,
        );
      }),
    ]);
  } catch (error) {
    // Reclaim a failed fixture while preserving its failure; never relaunch over a live child.
    if (child.exitCode === null && child.signalCode === null) {
      child.kill();
      if (timer !== undefined) clearTimeout(timer);
      await Promise.race([
        ended,
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, 5_000);
        }),
      ]);
    }
    throw error;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    child.removeListener('close', onClose);
  }
}
