import { realpath, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { NexarError } from '@nexar/contracts';
import type { TaskWorktree } from './types.js';
import { assertId, isWithin } from './util.js';

/**
 * Deletes a task directory. The real path must lie strictly inside `<baseDir>/<projectId>/`;
 * `fs.rm` removes symlinks themselves and never follows them.
 */
export async function removeTaskWorktree(task: TaskWorktree): Promise<void> {
  assertId('projectId', task.projectId);
  let target: string;
  let projectDir: string;
  try {
    projectDir = await realpath(join(task.baseDir, task.projectId));
    target = await realpath(task.taskDir);
  } catch (error) {
    if ((error as { code?: unknown }).code === 'ENOENT') return;
    throw new NexarError('INTERNAL_ERROR', 'Task directory could not be resolved');
  }
  if (target === projectDir || !isWithin(projectDir, target)) {
    throw new NexarError('POLICY_REJECTED', 'Task directory is outside the worktrees root');
  }
  await rm(target, { recursive: true, force: true });
}
