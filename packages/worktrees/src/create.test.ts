import { existsSync, readFileSync, statSync } from 'node:fs';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { isNexarError } from '@nexar/contracts';
import { createTaskWorktree } from './create.js';
import { cleanup, git, makeOwnerRepo, tempDir, type OwnerRepo } from './fixtures.testkit.js';
import { removeTaskWorktree } from './remove.js';

describe('createTaskWorktree', () => {
  let root: string;
  let owner: OwnerRepo;
  let baseDir: string;
  beforeEach(() => {
    root = tempDir();
    owner = makeOwnerRepo(root);
    baseDir = join(root, 'wt');
  });
  afterEach(() => cleanup(root));

  const create = (taskId = 't1', baseBranch = 'main') =>
    createTaskWorktree({ repository: owner.path, projectId: 'p1', taskId, baseBranch, baseDir });

  it('clones only the base branch, with no origin and neutral hooks', async () => {
    const task = await create();
    const head = git(owner.path, 'rev-parse', 'main').trim();
    expect(task.baseCommit).toBe(head);
    expect(git(task.workPath, 'rev-parse', 'HEAD').trim()).toBe(head);
    for (const repo of [task.workPath, task.baseGitPath]) {
      expect(() => git(repo, 'cat-file', '-e', owner.secretBlob)).toThrow();
      expect(git(repo, 'remote').trim()).toBe('');
    }
    expect(git(task.workPath, 'config', 'core.hooksPath').trim()).toBe('/dev/null');
    expect(git(task.workPath, 'config', 'user.email').trim()).toBe('agent@nexar.invalid');
    expect(statSync(join(task.workPath, '.git')).isDirectory()).toBe(true);
    expect(existsSync(join(task.workPath, '.git', 'hooks', 'pre-commit'))).toBe(false);
    expect(existsSync(join(task.baseGitPath, 'hooks', 'pre-commit'))).toBe(false);
    expect(readFileSync(join(task.workPath, 'a.txt'), 'utf8')).toBe('one\ntwo\nthree\n');
  });

  it('makes the task directory private and refuses to reuse it', async () => {
    const task = await create();
    // Windows chmod cannot express owner-only POSIX permission bits; ACL audit is separate.
    if (process.platform !== 'win32') expect(statSync(task.taskDir).mode & 0o777).toBe(0o700);
    await expect(create()).rejects.toMatchObject({ code: 'POLICY_REJECTED' });
    expect(existsSync(task.workPath)).toBe(true);
  });

  it('rejects bad ids and branch names', async () => {
    for (const taskId of ['', '../x', '.hidden', 'a/b', 'x'.repeat(65)]) {
      await expect(create(taskId)).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    }
    await expect(
      createTaskWorktree({
        repository: owner.path,
        projectId: '..',
        taskId: 't',
        baseBranch: 'main',
        baseDir,
      }),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    for (const branch of ['-evil', 'a..b', 'bad name', 'main@{1}', '', 'x.lock']) {
      await expect(create('t2', branch)).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    }
  });

  it('rejects a non-repository', async () => {
    mkdirSync(join(root, 'plain'));
    await expect(
      createTaskWorktree({
        repository: join(root, 'plain'),
        projectId: 'p1',
        taskId: 't',
        baseBranch: 'main',
        baseDir,
      }),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
  });

  it('removes the partial task directory when cloning fails', async () => {
    const error = await create('t3', 'no-such-branch').catch((e: unknown) => e);
    expect(isNexarError(error)).toBe(true);
    expect(existsSync(join(baseDir, 'p1', 't3'))).toBe(false);
    expect(JSON.stringify(error)).not.toContain(root);
  });

  it('supports a shallow clone', async () => {
    git(owner.path, 'commit', '-q', '--allow-empty', '-m', 'second');
    const task = await createTaskWorktree({
      repository: owner.path,
      projectId: 'p1',
      taskId: 'shallow',
      baseBranch: 'main',
      baseDir,
      depth: 1,
    });
    expect(git(task.workPath, 'rev-list', '--count', 'HEAD').trim()).toBe('1');
  });

  it('removeTaskWorktree deletes the task, and refuses a directory outside its root', async () => {
    const task = await create();
    await removeTaskWorktree(task);
    expect(existsSync(task.taskDir)).toBe(false);
    await removeTaskWorktree(task); // already gone: no error
    await expect(removeTaskWorktree({ ...task, taskDir: owner.path })).rejects.toMatchObject({
      code: 'POLICY_REJECTED',
    });
    expect(existsSync(owner.path)).toBe(true);
    await expect(
      removeTaskWorktree({ ...task, taskDir: join(baseDir, 'p1') }),
    ).rejects.toMatchObject({ code: 'POLICY_REJECTED' });
  });
});
