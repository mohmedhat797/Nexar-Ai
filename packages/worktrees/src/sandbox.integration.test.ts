import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SandboxLauncher, checkSandboxAvailability } from '@nexar/sandbox';
import { simulateAgent } from './agent.testkit.js';
import { commitPatch } from './commit.js';
import { createTaskWorktree } from './create.js';
import { cleanup, git, makeOwnerRepo, tempDir, type OwnerRepo } from './fixtures.testkit.js';
import { harvestPatch } from './harvest.js';
import type { TaskWorktree } from './types.js';
import { createVerificationWorkspace } from './verify.js';

const availability = await checkSandboxAvailability();

describe.skipIf(!availability.available)('worktrees with the real sandbox launcher', () => {
  let root: string;
  let owner: OwnerRepo;
  let task: TaskWorktree;
  const launcher = new SandboxLauncher();

  beforeEach(async () => {
    root = tempDir();
    owner = makeOwnerRepo(root);
    task = await createTaskWorktree({
      repository: owner.path,
      projectId: 'p',
      taskId: 't',
      baseBranch: 'main',
      baseDir: join(root, 'wt'),
    });
  });
  afterEach(() => cleanup(root));

  it('harvests inside bwrap without executing agent-planted git config', async () => {
    simulateAgent(task.workPath);
    const canary = join(root, 'fsmonitor-canary');
    git(task.workPath, 'config', 'core.fsmonitor', `sh -c "touch ${canary}"`);
    git(task.workPath, 'config', 'diff.external', `sh -c "touch ${canary}"`);
    writeFileSync(join(task.workPath, '.gitattributes'), '*.txt diff=evil\n');

    const harvest = await harvestPatch(task, { launcher });
    expect(existsSync(canary)).toBe(false);
    // `.gitattributes` is a denied path, so the policy rejects this patch.
    expect(harvest.validation.ok).toBe(false);
  });

  it('runs create → agent → sandboxed harvest → verify → Nexar-owned commit end to end', async () => {
    simulateAgent(task.workPath);
    const harvest = await harvestPatch(task, { launcher });
    expect(harvest.validation.ok).toBe(true);

    const verify = await createVerificationWorkspace(task, harvest);
    expect(existsSync(join(verify, 'new.txt'))).toBe(true);
    expect(existsSync(join(verify, 'del.txt'))).toBe(false);

    const result = await commitPatch({
      repository: owner.path,
      baseCommit: task.baseCommit,
      harvest,
      branch: 'nexar/t',
      message: 'feat: agent result',
      author: { name: 'Nexar', email: 'nexar@example.invalid' },
      trailers: { 'Nexar-Task': 't' },
    });
    expect(git(owner.path, 'rev-parse', 'refs/heads/nexar/t').trim()).toBe(result.commit);
    expect(git(owner.path, 'rev-parse', 'HEAD').trim()).toBe(task.baseCommit);
    expect(existsSync(owner.canary)).toBe(false);
  });
});
