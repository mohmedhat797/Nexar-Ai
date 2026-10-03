import { lstat, readdir } from 'node:fs/promises';
import { join } from 'node:path';

export interface CollectDraftsOptions {
  readonly maxFiles?: number;
  readonly maxBytes?: number;
  readonly maxDepth?: number;
}

export interface DraftFile {
  /** Forward-slash path relative to the scratch directory. */
  readonly name: string;
  /** Absolute path for the importer, which re-checks the file when it opens it. */
  readonly path: string;
  readonly size: number;
}

export interface CollectedDrafts {
  readonly files: readonly DraftFile[];
  /** Entries left out: links, hard links, special files, oversized files, or beyond the file cap. */
  readonly skipped: number;
}

/**
 * Lists the regular files an OpenWorker turn left in its scratch directory. Symbolic links and
 * junctions, hard-linked files, special files and oversized files are skipped, never followed.
 * The import into `LocalArtifactStore` belongs to the Desktop unit.
 */
export async function collectDrafts(
  scratchDir: string,
  options: CollectDraftsOptions = {},
): Promise<CollectedDrafts> {
  const maxFiles = options.maxFiles ?? 32;
  const maxBytes = options.maxBytes ?? 5 * 1024 * 1024;
  const maxDepth = options.maxDepth ?? 4;
  const files: DraftFile[] = [];
  let skipped = 0;

  async function walk(dir: string, prefix: string, depth: number): Promise<void> {
    let names: string[];
    try {
      names = (await readdir(dir)).sort();
    } catch {
      return;
    }
    for (const name of names) {
      const path = join(dir, name);
      const relative = prefix === '' ? name : `${prefix}/${name}`;
      let info;
      try {
        info = await lstat(path);
      } catch {
        skipped++;
        continue;
      }
      if (info.isDirectory() && !info.isSymbolicLink()) {
        if (depth < maxDepth) await walk(path, relative, depth + 1);
        else skipped++;
      } else if (
        !info.isFile() ||
        info.isSymbolicLink() ||
        info.nlink > 1 ||
        info.size > maxBytes ||
        files.length >= maxFiles
      ) {
        skipped++;
      } else {
        files.push({ name: relative, path, size: info.size });
      }
    }
  }

  await walk(scratchDir, '', 0);
  return { files, skipped };
}
