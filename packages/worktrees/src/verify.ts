import { readFile, realpath, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { NexarError } from '@nexar/contracts';
import { cloneHardened } from './clone.js';
import { runGit, type GitOptions } from './git.js';
import type { HarvestResult, TaskWorktree } from './types.js';
import { isWithin, nextIndex, sha256Hex } from './util.js';

/**
 * Reads a harvested patch file and proves it is the validated one: byte-identical to what was hashed at validation time. Returns the canonical path.
 */
export async function assertHarvestIntact(
  harvest: HarvestResult,
  task?: TaskWorktree,
): Promise<string> {
  if (!harvest.validation.ok) {
    throw new NexarError('POLICY_REJECTED', 'Patch did not pass validation');
  }
  let path: string;
  let data: Buffer;
  try {
    path = await realpath(harvest.patchPath);
    if (task !== undefined) {
      const outDir = await realpath(join(task.taskDir, 'out'));
      if (!isWithin(outDir, path) || path === outDir) throw new Error('outside');
    }
    data = await readFile(path);
  } catch {
    throw new NexarError('POLICY_REJECTED', 'Patch file is missing or outside the task directory');
  }
  if (sha256Hex(data) !== harvest.sha256) {
    throw new NexarError('POLICY_REJECTED', 'Patch file changed after validation');
  }
  return path;
}

/**
 * Creates `verify-<n>/`: a fresh Nexar-made clone of `base.git` with the validated patch applied
 * (staged), for gates to run in. Host git is safe here: the clone and the patch are Nexar-owned.
 * Returns the canonical workspace path.
 */
export async function createVerificationWorkspace(
  task: TaskWorktree,
  harvest: HarvestResult,
  options: GitOptions = {},
): Promise<string> {
  const patchPath = await assertHarvestIntact(harvest, task);
  const dest = join(task.taskDir, `verify-${await nextIndex(task.taskDir, 'verify-')}`);
  try {
    await cloneHardened(task.baseGitPath, dest, task.baseCommit, options);
    await runGit(['apply', '--index', '--whitespace=nowarn', patchPath], {
      ...options,
      cwd: dest,
      label: 'apply',
    });
  } catch (error) {
    await rm(dest, { recursive: true, force: true });
    throw error;
  }
  return realpath(dest);
}
