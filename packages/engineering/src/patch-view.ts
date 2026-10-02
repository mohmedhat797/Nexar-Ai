import { lstat, readFile, readdir, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { NexarError, projectId as toProjectId } from '@nexar/contracts';
import { defaultWorktreesDir, parsePatch } from '@nexar/worktrees';
import { readEngineeringRecord } from './record.js';

/** A patch is already bounded by the patch policy (default 5 MiB); never read more than this. */
const MAX_PATCH_FILE_BYTES = 16 * 1024 * 1024;
const PATCH_FILE = /^patch-(\d+)\.diff$/;

export interface TaskPatchOptions {
  /** Where `record.json` lives (`<stateDir>/engineering/<task>/record.json`). */
  readonly stateDir: string;
  /** The runner's `worktreesDir`; defaults like the runner. */
  readonly worktreesDir?: string;
  readonly taskId: string;
  /** At most this many bytes of patch text are returned. */
  readonly maxBytes: number;
  /** At most this many changed files are listed. */
  readonly maxFiles: number;
}

export interface TaskPatchView {
  readonly text: string;
  readonly truncated: boolean;
  /** Repository-relative paths that already passed the patch policy; at most `maxFiles`. */
  readonly files: readonly string[];
  /** Number of files in the whole patch. */
  readonly fileCount: number;
}

function unavailable(message: string): NexarError {
  return new NexarError('VALIDATION_ERROR', message);
}

/** Cuts at most `maxBytes` of UTF-8 without splitting a multi-byte character. */
function cutUtf8(data: Buffer, maxBytes: number): { text: string; truncated: boolean } {
  if (data.length <= maxBytes) return { text: data.toString('utf8'), truncated: false };
  let end = maxBytes;
  while (end > 0 && ((data[end] ?? 0) & 0xc0) === 0x80) end -= 1;
  return { text: data.subarray(0, end).toString('utf8'), truncated: true };
}

/**
 * Reads the validated patch of a task from its `out/` directory (ADR-025 section 7). The task's
 * last valid `PatchRecord` names the patch by size and SHA-256; a file is returned only when its
 * bytes hash to exactly that value, so a patch that was swapped on disk is never shown. Errors
 * never contain paths.
 */
export async function readTaskPatch(options: TaskPatchOptions): Promise<TaskPatchView> {
  const record = await readEngineeringRecord(options.stateDir, options.taskId);
  if (record === undefined) throw unavailable('Unknown engineering task');
  const patch = [...record.patches].reverse().find((p) => p.valid);
  if (patch === undefined) throw unavailable('The task has no validated patch');

  let outDir: string;
  try {
    const baseDir = await realpath(options.worktreesDir ?? defaultWorktreesDir());
    outDir = join(baseDir, toProjectId(record.projectId), record.taskId, 'out');
  } catch {
    throw unavailable('The task patch is no longer available');
  }
  let names: string[];
  try {
    names = await readdir(outDir);
  } catch {
    throw unavailable('The task patch is no longer available');
  }
  const candidates = names
    .map((name) => ({ name, index: Number(PATCH_FILE.exec(name)?.[1] ?? Number.NaN) }))
    .filter((c) => Number.isFinite(c.index))
    .sort((a, b) => b.index - a.index);

  for (const { name } of candidates) {
    const file = join(outDir, name);
    let data: Buffer;
    try {
      const info = await lstat(file);
      if (!info.isFile() || info.size !== patch.bytes || info.size > MAX_PATCH_FILE_BYTES) continue;
      data = await readFile(file);
    } catch {
      continue;
    }
    let parsed;
    try {
      parsed = parsePatch(data);
    } catch {
      continue;
    }
    if (parsed.sha256 !== patch.sha256) continue;
    const cut = cutUtf8(data, options.maxBytes);
    return {
      text: cut.text,
      truncated: cut.truncated,
      files: parsed.entries.slice(0, options.maxFiles).map((entry) => entry.path),
      fileCount: parsed.entries.length,
    };
  }
  throw unavailable('The task patch is no longer available');
}
