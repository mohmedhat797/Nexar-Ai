import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { simulateAgent } from './agent.testkit.js';
import { commitPatch, type CommitPatchOptions } from './commit.js';
import { createTaskWorktree } from './create.js';
import {
  cleanup,
  fakeLauncher,
  git,
  makeOwnerRepo,
  tempDir,
  type OwnerRepo,
} from './fixtures.testkit.js';
import { harvestPatch } from './harvest.js';
import type { HarvestResult, TaskWorktree } from './types.js';

describe('commitPatch', () => {
  let root: string;
  let home: string;
  let owner: OwnerRepo;
  let task: TaskWorktree;
  let harvest: HarvestResult;
  beforeEach(async () => {
    root = tempDir();
    home = tempDir();
    owner = makeOwnerRepo(root);
    task = await createTaskWorktree({
      repository: owner.path,
      projectId: 'p',
      taskId: 't',
      baseBranch: 'main',
      baseDir: join(root, 'wt'),
    });
    simulateAgent(task.workPath);
    harvest = await harvestPatch(task, { launcher: fakeLauncher(home) });
  });
  afterEach(() => cleanup(root, home));

  const options = (extra: Partial<CommitPatchOptions> = {}): CommitPatchOptions => ({
    repository: owner.path,
    baseCommit: task.baseCommit,
    harvest,
    branch: 'nexar/task-t',
    message: 'feat: agent result',
    author: { name: 'Nexar', email: 'nexar@example.invalid' },
    trailers: { 'Nexar-Task': 't', 'Nexar-Patch-Sha256': harvest.sha256 },
    now: () => new Date('2026-01-02T03:04:05Z'),
    ...extra,
  });

  const ownerState = () => ({
    head: git(owner.path, 'rev-parse', 'HEAD').trim(),
    branch: git(owner.path, 'symbolic-ref', 'HEAD').trim(),
    index: git(owner.path, 'ls-files', '-s'),
    status: git(owner.path, 'status', '--porcelain'),
    a: readFileSync(join(owner.path, 'a.txt'), 'utf8'),
  });

  it('creates the branch at the right parent with exactly the patch changes', async () => {
    const result = await commitPatch(options());
    expect(result.branch).toBe('nexar/task-t');
    expect(git(owner.path, 'rev-parse', 'refs/heads/nexar/task-t').trim()).toBe(result.commit);
    expect(git(owner.path, 'rev-parse', `${result.commit}^`).trim()).toBe(task.baseCommit);
    expect(git(owner.path, 'rev-parse', `${result.commit}^{tree}`).trim()).toBe(result.tree);
    const changed = git(
      owner.path,
      'diff-tree',
      '-r',
      '--no-renames',
      '--name-only',
      task.baseCommit,
      result.commit,
    )
      .trim()
      .split('\n')
      .sort();
    expect(changed).toEqual([
      'a.txt',
      'bin.dat',
      'blob.bin',
      'del.txt',
      'new.txt',
      'sub dir/run.sh',
    ]);
    expect(git(owner.path, 'show', `${result.commit}:a.txt`)).toBe('one\nTWO\nthree\n');
    expect(git(owner.path, 'ls-tree', result.commit, 'sub dir/').trim()).toMatch(/^100755 blob/);
    // the agent's own commit object is not in the result: parent is the base, history is one commit
    expect(
      git(owner.path, 'rev-list', '--count', `${task.baseCommit}..${result.commit}`).trim(),
    ).toBe('1');
  });

  it('records author, committer, date, message and trailers', async () => {
    const result = await commitPatch(options());
    const log = git(owner.path, 'log', '-1', '--format=%an|%ae|%cn|%ce|%at', result.commit).trim();
    expect(log).toBe(
      `Nexar|nexar@example.invalid|Nexar|nexar@example.invalid|${Date.UTC(2026, 0, 2, 3, 4, 5) / 1000}`,
    );
    const body = git(owner.path, 'log', '-1', '--format=%B', result.commit);
    expect(body).toContain('feat: agent result\n\nNexar-Task: t\n');
    expect(body).toContain(`Nexar-Patch-Sha256: ${harvest.sha256}`);
  });

  it('leaves the owner working tree, index, HEAD and hooks untouched', async () => {
    writeFileSync(join(owner.path, 'a.txt'), 'dirty\n');
    git(owner.path, 'add', 'a.txt');
    writeFileSync(join(owner.path, 'untracked.txt'), 'u\n');
    const before = ownerState();
    await commitPatch(options());
    expect(ownerState()).toEqual(before);
    expect(existsSync(owner.canary)).toBe(false);
    expect(existsSync(join(owner.path, 'new.txt'))).toBe(false);
  });

  it('rejects an existing branch without moving it', async () => {
    const first = await commitPatch(options());
    await expect(commitPatch(options())).rejects.toMatchObject({ code: 'POLICY_REJECTED' });
    expect(git(owner.path, 'rev-parse', 'refs/heads/nexar/task-t').trim()).toBe(first.commit);
    await expect(commitPatch(options({ branch: 'nexar/task-t/sub' }))).rejects.toMatchObject({
      code: 'POLICY_REJECTED',
    });
  });

  it('rejects branches outside nexar/ or with invalid names', async () => {
    await expect(commitPatch(options({ branch: 'main' }))).rejects.toMatchObject({
      code: 'POLICY_REJECTED',
    });
    await expect(commitPatch(options({ branch: 'feature/x' }))).rejects.toMatchObject({
      code: 'POLICY_REJECTED',
    });
    await expect(commitPatch(options({ branch: 'nexar/a..b' }))).rejects.toMatchObject({
      code: 'VALIDATION_ERROR',
    });
    expect(git(owner.path, 'branch', '--list').includes('nexar/')).toBe(false);
  });

  it('rejects a tampered patch file', async () => {
    appendFileSync(harvest.patchPath, '\n');
    await expect(commitPatch(options())).rejects.toMatchObject({ code: 'POLICY_REJECTED' });
    expect(git(owner.path, 'branch', '--list').includes('nexar/')).toBe(false);
  });

  it('rejects a harvest that did not validate', async () => {
    const bad: HarvestResult = {
      ...harvest,
      validation: { ok: false, violations: [{ rule: 'empty', index: -1 }] },
    };
    await expect(commitPatch(options({ harvest: bad }))).rejects.toMatchObject({
      code: 'POLICY_REJECTED',
    });
  });

  it('rejects invalid trailers, messages and authors', async () => {
    for (const trailers of [{ 'bad key': 'x' }, { Key: 'two\nlines' }, { Key: '' }]) {
      await expect(commitPatch(options({ trailers }))).rejects.toMatchObject({
        code: 'VALIDATION_ERROR',
      });
    }
    await expect(commitPatch(options({ message: '  ' }))).rejects.toMatchObject({
      code: 'VALIDATION_ERROR',
    });
    await expect(
      commitPatch(options({ author: { name: 'A <b>', email: 'x@y' } })),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
  });

  it('rejects a base commit that is not a valid object id', async () => {
    await expect(commitPatch(options({ baseCommit: 'main' }))).rejects.toMatchObject({
      code: 'VALIDATION_ERROR',
    });
  });
});
