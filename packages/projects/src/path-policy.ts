import { realpath, stat } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { NexarError } from '@nexar/contracts';

/** `details.reason` of the `POLICY_REJECTED` raised when a path resolves outside every allowed root. */
export const OUTSIDE_BOUNDARY_REASON = 'OUTSIDE_BOUNDARY';

/**
 * True iff `realCandidate` equals `realRoot` or lies inside it. Both arguments must already be
 * canonical (see `fs.realpath`); this is a pure, separator-aware comparison.
 */
export function isWithin(realRoot: string, realCandidate: string): boolean {
  const rel = relative(realRoot, realCandidate);
  if (rel === '') return true;
  return rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

function errnoReason(error: unknown): string {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === 'string' && /^[A-Z0-9_]{1,32}$/.test(code) ? code : 'UNKNOWN';
}

/**
 * Resolves `candidate` (against `options.base`, default `process.cwd()`) to a canonical absolute
 * path, following every symlink and `..`, and proves it is inside one of `allowedRealRoots`.
 *
 * Fails closed: any resolution error (missing, unreadable, symlink loop, ...) is `POLICY_REJECTED`.
 * Errors never contain the rejected path or its target, only a stable reason code in `details`.
 *
 * TOCTOU: the filesystem can change between this check and the caller's use of the path. Callers
 * MUST pass the returned canonical path onward and never the original input, which keeps the
 * window to the canonical path itself.
 */
export async function resolveContainedPath(
  candidate: string,
  allowedRealRoots: readonly string[],
  options: { readonly base?: string } = {},
): Promise<string> {
  let real: string;
  try {
    real = await realpath(resolve(options.base ?? process.cwd(), candidate));
  } catch (error) {
    // Deliberately no `cause`: fs errors embed the path.
    throw new NexarError('POLICY_REJECTED', 'Path is not accessible or does not exist', {
      details: { reason: errnoReason(error) },
    });
  }
  if (!allowedRealRoots.some((root) => isWithin(root, real))) {
    throw new NexarError('POLICY_REJECTED', 'Path is outside the project boundary', {
      details: { reason: OUTSIDE_BOUNDARY_REASON },
    });
  }
  return real;
}

/** Realpaths configured directories. Failures name the configured (not the resolved) path. */
export async function canonicalRoots(paths: readonly string[]): Promise<string[]> {
  const result: string[] = [];
  for (const configured of paths) {
    try {
      const real = await realpath(configured);
      if (!(await stat(real)).isDirectory()) throw new Error('not a directory');
      result.push(real);
    } catch (cause) {
      throw new NexarError(
        'CONFIGURATION_ERROR',
        `Configured path "${configured}" does not exist or is not a directory`,
        { details: { path: configured }, cause },
      );
    }
  }
  return result;
}
