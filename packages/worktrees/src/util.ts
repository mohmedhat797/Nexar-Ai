import { createHash } from 'node:crypto';
import { readdir } from 'node:fs/promises';
import { isAbsolute, relative, sep } from 'node:path';
import { NexarError } from '@nexar/contracts';

export const DEFAULT_MAX_PATCH_BYTES = 5 * 1024 * 1024;

export const OBJECT_ID_PATTERN = /^[0-9a-f]{40}([0-9a-f]{24})?$/;

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

export function assertId(kind: string, value: string): void {
  if (!ID_PATTERN.test(value)) {
    throw new NexarError('VALIDATION_ERROR', `${kind} is not a valid identifier`);
  }
}

/** True iff `candidate` is `root` or lies inside it; both must already be canonical. */
export function isWithin(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  if (rel === '') return true;
  return rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

export function sha256Hex(data: Uint8Array): string {
  return createHash('sha256').update(data).digest('hex');
}

/** Next free `<prefix><n>` number among the entries of `dir` (starting at 1). */
export async function nextIndex(dir: string, prefix: string): Promise<number> {
  const pattern = new RegExp(`^${prefix}(\\d+)(?:\\..*)?$`);
  let highest = 0;
  for (const name of await readdir(dir)) {
    const match = pattern.exec(name);
    if (match?.[1] !== undefined) highest = Math.max(highest, Number(match[1]));
  }
  return highest + 1;
}
