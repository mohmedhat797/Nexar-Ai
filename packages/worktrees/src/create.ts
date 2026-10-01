import { chmod, mkdir, realpath, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { NexarError } from '@nexar/contracts';
import { cloneHardened } from './clone.js';
import { runGit, type GitOptions } from './git.js';
import type { TaskWorktree } from './types.js';
import { assertId, OBJECT_ID_PATTERN } from './util.js';

export interface CreateTaskWorktreeOptions extends GitOptions {
  /** Canonical path of the owner's repository, already contained by the caller. */
  readonly repository: string;
  readonly projectId: string;
  readonly taskId: string;
  /** A branch name; tags, commits and other revisions are not accepted in v0.3. */
  readonly baseBranch: string;
  readonly depth?: number;
  /** Worktrees root. Defaults to `$XDG_DATA_HOME/nexar/worktrees` or `~/.local/share/nexar/worktrees`. */
  readonly baseDir?: string;
}

export function defaultWorktreesDir(): string {
  const xdg = process.env['XDG_DATA_HOME'];
  const data = xdg !== undefined && xdg.startsWith('/') ? xdg : join(homedir(), '.local', 'share');
  return join(data, 'nexar', 'worktrees');
}

/** Validates a branch name for use in refs and `git clone --branch`. */
export async function assertBranchName(
  name: string,
  cwd: string,
  options: GitOptions,
): Promise<void> {
  let ok = name.length > 0 && name.length <= 255 && !name.startsWith('-');
  ok = ok && !name.includes('@{') && !/[\s\0]/.test(name);
  if (ok) {
    try {
      const echoed = await runGit(['check-ref-format', '--branch', name], { ...options, cwd });
      ok = echoed.trim() === name;
    } catch {
      ok = false;
    }
  }
  if (!ok) throw new NexarError('VALIDATION_ERROR', 'Branch name is not valid');
}

/**
 * Creates `<baseDir>/<projectId>/<taskId>/` holding a pristine bare clone (`base.git`) and the
 * agent's clone (`work`), both containing only the base branch's history. Nothing is shared with
 * the owner's `.git`: no hardlinks, no remotes, no hooks, no other branches.
 */
export async function createTaskWorktree(
  options: CreateTaskWorktreeOptions,
): Promise<TaskWorktree> {
  assertId('projectId', options.projectId);
  assertId('taskId', options.taskId);
  if (
    options.depth !== undefined &&
    (!Number.isInteger(options.depth) || options.depth < 1 || options.depth > 1_000_000)
  ) {
    throw new NexarError('VALIDATION_ERROR', 'depth must be a positive integer');
  }
  const git: GitOptions = options.gitPath === undefined ? {} : { gitPath: options.gitPath };

  let repository: string;
  try {
    repository = await realpath(options.repository);
  } catch {
    throw new NexarError('POLICY_REJECTED', 'Repository is not accessible or does not exist');
  }
  const probe = async (flag: string): Promise<boolean> => {
    try {
      return (await runGit(['rev-parse', flag], { ...git, cwd: repository })).trim() === 'true';
    } catch {
      return false;
    }
  };
  if (!(await probe('--is-inside-work-tree')) && !(await probe('--is-bare-repository'))) {
    throw new NexarError('VALIDATION_ERROR', 'Path is not a git repository');
  }
  await assertBranchName(options.baseBranch, repository, git);

  const configuredBase = options.baseDir ?? defaultWorktreesDir();
  await mkdir(configuredBase, { recursive: true, mode: 0o700 });
  const baseDir = await realpath(configuredBase);
  const projectDir = join(baseDir, options.projectId);
  await mkdir(projectDir, { recursive: true, mode: 0o700 });
  const taskDir = join(projectDir, options.taskId);
  try {
    await mkdir(taskDir, { mode: 0o700 });
  } catch (error) {
    const exists = (error as { code?: unknown }).code === 'EEXIST';
    throw new NexarError(
      exists ? 'POLICY_REJECTED' : 'INTERNAL_ERROR',
      exists ? 'Task worktree already exists' : 'Task directory could not be created',
    );
  }

  try {
    await chmod(taskDir, 0o700);
    const baseGitPath = join(taskDir, 'base.git');
    const workPath = join(taskDir, 'work');
    const depth = options.depth === undefined ? [] : ['--depth', String(options.depth)];
    await runGit(
      [
        'clone',
        '--bare',
        '--no-local',
        '--single-branch',
        '--no-tags',
        '--branch',
        options.baseBranch,
        ...depth,
        '--',
        repository,
        baseGitPath,
      ],
      { ...git, cwd: taskDir, label: 'clone' },
    );
    await runGit(['-C', baseGitPath, 'remote', 'remove', 'origin'], {
      ...git,
      cwd: taskDir,
      label: 'remote remove',
    });
    const baseCommit = (
      await runGit(['-C', baseGitPath, 'rev-parse', '--verify', 'HEAD^{commit}'], {
        ...git,
        cwd: taskDir,
        label: 'rev-parse',
      })
    ).trim();
    if (!OBJECT_ID_PATTERN.test(baseCommit)) {
      throw new NexarError('INTERNAL_ERROR', 'Base commit could not be resolved');
    }
    await cloneHardened(baseGitPath, workPath, baseCommit, git);
    await mkdir(join(taskDir, 'out'), { mode: 0o700 });
    return {
      projectId: options.projectId,
      taskId: options.taskId,
      taskDir,
      workPath,
      baseGitPath,
      baseCommit,
      baseBranch: options.baseBranch,
      baseDir,
    };
  } catch (error) {
    await rm(taskDir, { recursive: true, force: true });
    throw error;
  }
}
