import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { simulateAgent } from './agent.testkit.js';
import { createTaskWorktree } from './create.js';
import { cleanup, fakeLauncher, git, makeOwnerRepo, tempDir } from './fixtures.testkit.js';
import { harvestPatch } from './harvest.js';
import type { TaskWorktree } from './types.js';
import { createVerificationWorkspace } from './verify.js';

describe('createVerificationWorkspace', () => {
  let root: string;
  let home: string;
  let task: TaskWorktree;
  beforeEach(async () => {
    root = tempDir();
    home = tempDir();
    const owner = makeOwnerRepo(root);
    task = await createTaskWorktree({
      repository: owner.path,
      projectId: 'p',
      taskId: 't',
      baseBranch: 'main',
      baseDir: join(root, 'wt'),
    });
  });
  afterEach(() => cleanup(root, home));

  it('applies the validated patch in a fresh clone', async () => {
    simulateAgent(task.workPath);
    const harvest = await harvestPatch(task, { launcher: fakeLauncher(home) });
    const dir = await createVerificationWorkspace(task, harvest);
    expect(dir).toBe(join(task.taskDir, 'verify-1'));
    expect(readFileSync(join(dir, 'a.txt'), 'utf8')).toBe('one\nTWO\nthree\n');
    expect(readFileSync(join(dir, 'new.txt'), 'utf8')).toBe('brand new\n');
    expect(existsSync(join(dir, 'del.txt'))).toBe(false);
    expect(git(dir, 'rev-parse', 'HEAD').trim()).toBe(task.baseCommit);
    const second = await createVerificationWorkspace(task, harvest);
    expect(second).toBe(join(task.taskDir, 'verify-2'));
  });

  it('refuses a harvest that failed validation', async () => {
    simulateAgent(task.workPath);
    writeFileSync(join(task.workPath, '.gitmodules'), '[submodule "x"]\n');
    const harvest = await harvestPatch(task, { launcher: fakeLauncher(home) });
    expect(harvest.validation.ok).toBe(false);
    await expect(createVerificationWorkspace(task, harvest)).rejects.toMatchObject({
      code: 'POLICY_REJECTED',
    });
    expect(existsSync(join(task.taskDir, 'verify-1'))).toBe(false);
  });

  it('refuses a tampered patch file and a patch outside out/', async () => {
    simulateAgent(task.workPath);
    const harvest = await harvestPatch(task, { launcher: fakeLauncher(home) });
    writeFileSync(join(home, 'copy.diff'), readFileSync(harvest.patchPath));
    await expect(
      createVerificationWorkspace(task, { ...harvest, patchPath: join(home, 'copy.diff') }),
    ).rejects.toMatchObject({ code: 'POLICY_REJECTED' });
    writeFileSync(harvest.patchPath, `${readFileSync(harvest.patchPath, 'utf8')} `);
    await expect(createVerificationWorkspace(task, harvest)).rejects.toMatchObject({
      code: 'POLICY_REJECTED',
    });
  });
});
