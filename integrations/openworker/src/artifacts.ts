import { lstat, readdir, realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, posix, resolve, win32 } from 'node:path';

export interface CollectDraftsOptions {
  readonly maxFiles?: number | undefined;
  readonly maxBytes?: number | undefined;
  readonly maxDepth?: number | undefined;
  readonly ignoredDirNames?: readonly string[] | undefined;
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

const IDENTIFIER = /^[A-Za-z0-9_.-]{1,64}$/;
const DEFAULT_IGNORED_DIRS: ReadonlySet<string> = new Set(['tool-output', 'workers']);

export interface OpenWorkerWorkspaceOptions {
  readonly scratchBase?: string | undefined;
  readonly homedir?: string | undefined;
}

/**
 * Resolves the trusted conversation workspace directory for an OpenWorker session.
 * OpenWorker 0.3.1 provisions workspaces under `~/OpenWorker/<sessionId>` by default,
 * or under `COWORKER_SCRATCH_BASE` when set.
 */
export function openWorkerWorkspaceDir(
  sessionId: string,
  options: OpenWorkerWorkspaceOptions = {},
): string {
  if (!IDENTIFIER.test(sessionId)) {
    throw new Error('Invalid OpenWorker sessionId');
  }
  const base =
    options.scratchBase ??
    process.env['COWORKER_SCRATCH_BASE'] ??
    join(options.homedir ?? homedir(), 'OpenWorker');
  return resolve(base, sessionId);
}

function isInside(
  parent: string,
  child: string,
  platform: NodeJS.Platform = process.platform,
): boolean {
  const path = platform === 'win32' ? win32 : posix;
  const rel = path.relative(parent, child);
  return rel !== '' && rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel);
}

/**
 * Lists the regular files an OpenWorker turn left in its scratch or workspace directory.
 * Symbolic links and junctions, hard-linked files, special files and oversized files are skipped,
 * never followed. The import into `LocalArtifactStore` belongs to the Desktop unit.
 */
export async function collectDrafts(
  dir: string,
  options: CollectDraftsOptions = {},
): Promise<CollectedDrafts> {
  const maxFiles = options.maxFiles ?? 32;
  const maxBytes = options.maxBytes ?? 5 * 1024 * 1024;
  const maxDepth = options.maxDepth ?? 4;
  const ignoredDirs = new Set([...DEFAULT_IGNORED_DIRS, ...(options.ignoredDirNames ?? [])]);
  const files: DraftFile[] = [];
  let skipped = 0;

  let realRootDir: string;
  try {
    realRootDir = await realpath(dir);
  } catch {
    return { files: [], skipped: 0 };
  }

  async function walk(currentDir: string, prefix: string, depth: number): Promise<void> {
    let names: string[];
    try {
      names = (await readdir(currentDir)).sort();
    } catch {
      return;
    }
    for (const name of names) {
      if (name.startsWith('.') || ignoredDirs.has(name)) {
        skipped++;
        continue;
      }
      const filePath = join(currentDir, name);
      const relativeName = prefix === '' ? name : `${prefix}/${name}`;
      let info;
      try {
        info = await lstat(filePath);
      } catch {
        skipped++;
        continue;
      }
      if (info.isDirectory() && !info.isSymbolicLink()) {
        if (depth < maxDepth) await walk(filePath, relativeName, depth + 1);
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
        try {
          const canonical = await realpath(filePath);
          if (canonical === realRootDir || !isInside(realRootDir, canonical)) {
            skipped++;
            continue;
          }
        } catch {
          skipped++;
          continue;
        }
        files.push({ name: relativeName, path: filePath, size: info.size });
      }
    }
  }

  await walk(realRootDir, '', 0);
  return { files, skipped };
}
