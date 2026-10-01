import { appendFileSync, existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { simulateAgent } from './agent.testkit.js';
import { createTaskWorktree } from './create.js';
import {
  cleanup,
  fakeLauncher,
  makeOwnerRepo,
  tempDir,
  type FakeLauncher,
} from './fixtures.testkit.js';
import { harvestPatch } from './harvest.js';
import type { TaskWorktree } from './types.js';

describe('harvestPatch', () => {
  let root: string;
  let home: string;
  let task: TaskWorktree;
  let launcher: FakeLauncher;
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
    launcher = fakeLauncher(home);
  });
  afterEach(() => cleanup(root, home));

  it('harvests modified, added, deleted, binary and executable files, including agent commits', async () => {
    simulateAgent(task.workPath);
    const result = await harvestPatch(task, { launcher });
    expect(result.validation.ok).toBe(true);
    const byPath = new Map(result.entries.map((e) => [e.path, e]));
    expect(byPath.get('a.txt')).toMatchObject({ status: 'modified', binary: false });
    expect(byPath.get('new.txt')).toMatchObject({ status: 'added', newMode: '100644' });
    expect(byPath.get('sub dir/run.sh')).toMatchObject({ status: 'added', newMode: '100755' });
    expect(byPath.get('del.txt')).toMatchObject({ status: 'deleted' });
    expect(byPath.get('bin.dat')).toMatchObject({ status: 'modified', binary: true });
    expect(byPath.get('blob.bin')).toMatchObject({ status: 'added', binary: true });
    expect([...byPath.keys()].some((p) => p.includes('.git/') || p === '.git')).toBe(false);
    expect(byPath.size).toBe(6);
    expect(statSync(result.patchPath).mode & 0o777).toBe(0o600);
    expect(result.bytes).toBe(statSync(result.patchPath).size);
    expect(result.patchPath.startsWith(join(task.taskDir, 'out'))).toBe(true);
    expect(launcher.disposed).toBe(1);
  });

  it('describes the launch as a no-network, read-only sandbox with the pristine repo mounted', async () => {
    simulateAgent(task.workPath);
    await harvestPatch(task, { launcher });
    const spec = launcher.specs[0];
    expect(spec).toMatchObject({
      command: '/bin/sh',
      workspace: task.workPath,
      workspaceAccess: 'read-only',
      network: { mode: 'none' },
      mounts: [
        { hostPath: task.baseGitPath, sandboxPath: '/opt/nexar/base.git', access: 'read-only' },
      ],
    });
    expect(spec?.env['NEXAR_BASE']).toBe(task.baseCommit);
    expect(spec?.env['NEXAR_GIT_DIR']).toBe('/opt/nexar/base.git');
    expect(spec?.args.join(' ')).not.toContain(task.workPath);
    expect(spec?.args.join(' ')).not.toContain(task.baseCommit);
  });

  it('never runs code planted in the agent clone config or attributes', async () => {
    simulateAgent(task.workPath);
    const canary = join(root, 'PWNED');
    appendFileSync(
      join(task.workPath, '.git', 'config'),
      [
        '[core]',
        `\tfsmonitor = sh -c "touch ${canary}.fsmonitor; echo"`,
        `\thooksPath = ${join(root, 'hooks')}`,
        '[diff]',
        `\texternal = sh -c "touch ${canary}.external"`,
        '[filter "evil"]',
        `\tclean = sh -c "touch ${canary}.clean; cat"`,
        '',
      ].join('\n'),
    );
    writeFileSync(join(task.workPath, '.gitattributes'), '* filter=evil\n');
    const result = await harvestPatch(task, { launcher });
    expect(existsSync(`${canary}.fsmonitor`)).toBe(false);
    expect(existsSync(`${canary}.external`)).toBe(false);
    expect(existsSync(`${canary}.clean`)).toBe(false);
    // the planted .gitattributes is still reported, and rejected by policy
    expect(result.validation.ok).toBe(false);
    expect(result.entries.some((e) => e.path === '.gitattributes')).toBe(true);
  });

  it('reports an empty patch when nothing changed', async () => {
    const result = await harvestPatch(task, { launcher });
    expect(result.entries).toEqual([]);
    expect(result.validation).toEqual({ ok: false, violations: [{ rule: 'empty', index: -1 }] });
  });

  it('aborts and removes the patch when it exceeds the size cap', async () => {
    writeFileSync(join(task.workPath, 'big.txt'), 'x'.repeat(50_000));
    await expect(harvestPatch(task, { launcher, maxBytes: 1000 })).rejects.toMatchObject({
      code: 'VALIDATION_ERROR',
    });
    expect(existsSync(join(task.taskDir, 'out', 'patch-1.diff'))).toBe(false);
    expect(launcher.disposed).toBe(1);
  });

  it('refuses a launcher without sandbox isolation', async () => {
    const plain = fakeLauncher(home, 'none');
    await expect(harvestPatch(task, { launcher: plain })).rejects.toMatchObject({
      code: 'POLICY_REJECTED',
    });
    expect(plain.specs).toHaveLength(0);
  });

  it('disposes the launch when the harvest command fails', async () => {
    await expect(
      harvestPatch({ ...task, baseGitPath: join(root, 'missing.git') }, { launcher }),
    ).rejects.toMatchObject({ code: 'INTERNAL_ERROR' });
    expect(launcher.disposed).toBe(1);
  });

  it('rejects a malformed base commit before launching', async () => {
    await expect(
      harvestPatch({ ...task, baseCommit: 'main; rm -rf /' }, { launcher }),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    expect(launcher.specs).toHaveLength(0);
  });

  it('numbers successive patches without overwriting', async () => {
    writeFileSync(join(task.workPath, 'one.txt'), '1\n');
    const first = await harvestPatch(task, { launcher });
    const second = await harvestPatch(task, { launcher });
    expect(first.patchPath).not.toBe(second.patchPath);
    expect(readFileSync(first.patchPath, 'utf8')).toBe(readFileSync(second.patchPath, 'utf8'));
  });
});
