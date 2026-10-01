import { NexarError, isNexarError, toNexarError } from '@nexar/contracts';
import { isAuthFailureText } from './run-collector.js';
import type { RuntimeProcess } from './runtime-process.js';

export const SHUTDOWN_TIMEOUT_MS = 2_000;
const STDERR_IN_ERROR_CHARS = 500;

/** Turns anything thrown during a run into the `NexarError` Nexar callers expect. */
export async function mapFailure(
  error: unknown,
  proc: RuntimeProcess | undefined,
  secrets: readonly string[],
): Promise<NexarError> {
  const closed = isNexarError(error) && error.details?.reason === 'closed';
  if (proc === undefined || !closed) return toNexarError(error, 'INTERNAL_ERROR');

  // The connection dropped: let the exit (or a spawn failure) land so we can explain why.
  await proc.waitForExit(SHUTDOWN_TIMEOUT_MS);
  if (proc.spawnError !== undefined) {
    const { code, path, syscall } = proc.spawnError;
    return new NexarError(
      'INTEGRATION_UNAVAILABLE',
      code === 'ENOENT'
        ? `could not launch dsh: '${path ?? 'binary'}' or the working directory was not found`
        : `could not launch dsh (${code ?? 'unknown error'})`,
      { cause: proc.spawnError, details: { code, syscall } },
    );
  }
  const exit = proc.exitInfo;
  const tail = proc.stderrTail(STDERR_IN_ERROR_CHARS, secrets);
  const how =
    exit === undefined
      ? 'closed its connection'
      : exit.signal !== null
        ? `was killed by ${exit.signal}`
        : `exited with code ${String(exit.code)}`;
  return new NexarError(
    isAuthFailureText(tail) ? 'AUTH_REQUIRED' : 'PROVIDER_ERROR',
    `dsh ${how} before finishing${tail.length > 0 ? `: ${tail}` : ''}`,
    { details: { exitCode: exit?.code ?? null, signal: exit?.signal ?? null } },
  );
}
