import { lstat, realpath } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';

/** Checks the Linux host counterpart of a /work mutation before and after the owner decision. */
export async function coworkScratchEscape(scratch: string, target: string): Promise<boolean> {
  try {
    if (!isAbsolute(scratch) || target === '' || target.includes('\0')) return true;
    const root = await lstat(scratch);
    if (!root.isDirectory() || root.isSymbolicLink() || (await realpath(scratch)) !== scratch)
      return true;
    const resolved = resolve(scratch, target);
    const rel = relative(scratch, resolved);
    if (rel === '' || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return true;
    let current = resolved;
    while (current !== scratch) {
      try {
        const info = await lstat(current);
        if (info.isSymbolicLink() || (info.isFile() && info.nlink !== 1)) return true;
        const actual = relative(scratch, await realpath(current));
        if (actual === '..' || actual.startsWith(`..${sep}`) || isAbsolute(actual)) return true;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return true;
      }
      const parent = dirname(current);
      if (parent === current) return true;
      current = parent;
    }
    const after = await lstat(scratch);
    return after.dev !== root.dev || after.ino !== root.ino || after.isSymbolicLink();
  } catch {
    return true;
  }
}
