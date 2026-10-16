import { lstat, readdir, readFile, realpath } from 'node:fs/promises';
import { extname, isAbsolute, join, posix, relative, sep, win32 } from 'node:path';
import type { LocalArtifactStore, ArtifactMediaType } from '@nexar/artifacts';
import {
  isNexarError,
  projectId as asProjectId,
  type ArtifactRef,
  type Logger,
  type TaskId,
} from '@nexar/contracts';

/*
 * Cowork draft import (ADR-026 §5, ADR-013): a turn works in a private scratch directory; what it
 * leaves there is offered to the owner as draft artifacts, through `LocalArtifactStore` only. Links,
 * hard links, special files, dot entries, oversized files and unknown extensions are never imported,
 * and every file is re-checked when it is opened.
 */

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

const MAX_FILES = 32;
const MAX_BYTES = 5 * 1024 * 1024;
const MAX_DEPTH = 4;
const IGNORED_DIRS: ReadonlySet<string> = new Set(['tool-output', 'workers']);

const DRAFT_MEDIA: Readonly<Record<string, ArtifactMediaType>> = {
  '.md': 'text/markdown',
  '.txt': 'text/plain',
  '.json': 'application/json',
  '.csv': 'text/csv',
};

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
 * Lists the regular files a turn left in its scratch directory. Symbolic links and junctions,
 * hard-linked files, special files and oversized files are skipped, never followed.
 */
export async function collectDrafts(dir: string): Promise<CollectedDrafts> {
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
      if (name.startsWith('.') || IGNORED_DIRS.has(name)) {
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
        if (depth < MAX_DEPTH) await walk(filePath, relativeName, depth + 1);
        else skipped++;
      } else if (
        !info.isFile() ||
        info.isSymbolicLink() ||
        info.nlink > 1 ||
        info.size > MAX_BYTES ||
        files.length >= MAX_FILES
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

export interface ImportDraftsOptions {
  readonly scratch: string;
  readonly projectId: string;
  readonly taskId: TaskId;
  readonly store: Pick<LocalArtifactStore, 'store'>;
  readonly logger: Logger;
}

/** Imports regular scratch files as drafts of the task; anything unusual is skipped. */
export async function importDrafts(options: ImportDraftsOptions): Promise<ArtifactRef[]> {
  const { scratch, store, logger } = options;
  const refs: ArtifactRef[] = [];
  let files: readonly DraftFile[];
  try {
    files = (await collectDrafts(scratch)).files;
  } catch {
    return refs;
  }
  for (const file of files) {
    const extension = extname(file.name).toLowerCase();
    const mediaType = Object.hasOwn(DRAFT_MEDIA, extension) ? DRAFT_MEDIA[extension] : undefined;
    if (mediaType === undefined) continue;
    try {
      // Re-check at open time: only a plain, unlinked, unchanged-size regular file is imported.
      const info = await lstat(file.path);
      if (!info.isFile() || info.isSymbolicLink() || info.nlink > 1 || info.size !== file.size) {
        continue;
      }
      const canonicalFile = await realpath(file.path);
      const canonicalDir = await realpath(scratch);
      const rel = relative(canonicalDir, canonicalFile);
      if (rel === '' || rel === '..' || rel.startsWith('..' + sep) || isAbsolute(rel)) continue;
      refs.push(
        await store.store({
          projectId: asProjectId(options.projectId),
          taskId: options.taskId,
          filename: file.name.replaceAll('/', '-'),
          content: await readFile(canonicalFile),
          mediaType,
          draft: true,
        }),
      );
    } catch (error) {
      logger.warn('cowork draft import failed', {
        code: isNexarError(error) ? error.code : 'UNKNOWN',
      });
    }
  }
  return refs;
}
