import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { OutwardAction } from '@nexar/approvals';
import { NexarError, projectId } from '@nexar/contracts';
import { ProjectRegistry } from '@nexar/projects';
import {
  DIFF_MARKER,
  GOAL_MARKER,
  createHarness,
  editFile,
  git,
  silentLogger,
  verdictText,
  type Harness,
} from './fixtures.testkit.js';
import {
  listEngineeringRecords,
  readEngineeringRecord,
  type EngineeringProgress,
  type EngineeringRecord,
} from './index.js';

const TASK = 'eng-0123456789ab';
const idOf = () => TASK;

let h: Harness | undefined;
afterEach(() => {
  h?.dispose();
  h = undefined;
});

async function harness(options: Parameters<typeof createHarness>[0] = {}): Promise<Harness> {
  h = await createHarness({ newId: idOf, ...options });
  return h;
}

const record = async (x: Harness): Promise<EngineeringRecord> => {
  const r = await readEngineeringRecord(x.stateDir, TASK);
  if (r === undefined) throw new Error('no record');
  return r;
};
const branches = (x: Harness): string => git(x.repo, 'branch', '--list', 'nexar/*');
const never = { ownerApproval: 'never' };

// These pipeline fixtures execute harvest's /bin/sh and pristine Linux GIT_DIR mount (ADR-018).
// Native Windows preflight and fail-closed guards below remain enabled.
describe.skipIf(process.platform === 'win32')('EngineeringRunner: accepted work', () => {
  it('commits on nexar/<task> with trailers, a different reviewer, and leaves the owner untouched', async () => {
    const x = await harness();
    const progress: EngineeringProgress[] = [];
    const approved = x.decideNext('approve');
    const outcome = await x.run({}, { onProgress: (e) => progress.push(e) });
    const approvalId = await approved;

    expect(outcome).toMatchObject({
      taskId: TASK,
      status: 'committed',
      branch: `nexar/${TASK}`,
    });
    expect(outcome.commit).toMatch(/^[0-9a-f]{40}$/);

    // The owner's checkout is untouched; only a new branch exists.
    expect(git(x.repo, 'rev-parse', 'HEAD').trim()).toBe(x.headBefore);
    expect(git(x.repo, 'branch', '--show-current').trim()).toBe('main');
    expect(git(x.repo, 'status', '--porcelain')).toBe('');
    expect(branches(x)).toContain(`nexar/${TASK}`);
    expect(git(x.repo, 'rev-parse', `nexar/${TASK}`).trim()).toBe(outcome.commit);
    expect(git(x.repo, 'rev-parse', `nexar/${TASK}^`).trim()).toBe(x.headBefore);
    expect(git(x.repo, 'show', `nexar/${TASK}:a.txt`)).toContain(DIFF_MARKER);

    const rec = await record(x);
    const message = git(x.repo, 'log', '-1', '--format=%B', `nexar/${TASK}`);
    expect(message.startsWith('nexar: Add the feature. GOAL-MARKER')).toBe(true);
    expect(message).toContain(`Nexar-Task: ${TASK}`);
    expect(message).toContain('Nexar-Plan: implement-review');
    expect(message).toContain('Nexar-Lane-1: feature=impl');
    expect(message).toContain('Nexar-Lane-2: review=reviewer');
    expect(message).toContain('Nexar-Reviewer: reviewer');
    expect(message).toContain(`Nexar-Patch-Sha256: ${rec.patches[0]?.sha256}`);
    expect(message).toContain(`Nexar-Approval: ${approvalId}`);
    expect(git(x.repo, 'log', '-1', '--format=%an <%ae>', `nexar/${TASK}`).trim()).toBe(
      'Nexar <nexar@localhost>',
    );

    // Routing: the implementer and the reviewer are different resources.
    expect(rec.lanes.map((l) => `${l.laneId}:${l.resourceId}:${l.outcome}`)).toEqual([
      'feature:impl:succeeded',
      'review:reviewer:succeeded',
    ]);
    expect(rec.lanes[0]?.reasonCodes.length).toBeGreaterThan(0);
    expect(rec.lanes[0]?.usage?.inputTokens).toEqual({ status: 'measured', value: 10 });
    expect(rec.reviews[0]).toMatchObject({
      resourceId: 'reviewer',
      verdict: 'approve',
      valid: true,
    });
    expect(rec).toMatchObject({
      status: 'committed',
      commit: outcome.commit,
      approval: { id: approvalId, outcome: 'approved' },
      baseCommit: x.headBefore,
    });
    expect(rec.commands.map((c) => `${c.phase}:${c.name}:${c.exitCode}`)).toEqual(['gate:test:0']);

    // Lane access modes and isolation as seen by the adapters.
    const [feature, review] = x.adapter.calls;
    expect(feature).toMatchObject({ access: 'read-write', isolation: 'sandbox' });
    expect(review).toMatchObject({ access: 'read-only', isolation: 'sandbox' });
    expect(review?.workspacePath).not.toBe(feature?.workspacePath);
    expect(review?.workspacePath).toMatch(/verify-1$/);

    // Progress announces the approval wait, without an approval id.
    const waiting = progress.find((e) => e.type === 'awaiting-approval');
    expect(waiting).toMatchObject({
      taskId: TASK,
      branch: `nexar/${TASK}`,
      reviewVerdict: 'approve',
      gatesPassed: 1,
    });
    expect(waiting).not.toHaveProperty('approvalId');
    expect(
      x.events.filter((e) => e.type === 'engineering.step').map((e) => 'step' in e && e.step),
    ).toEqual([
      'task.started',
      'lane.completed',
      'patch.harvested',
      'gate.completed',
      'lane.completed',
      'review.completed',
      'acceptance.decided',
      'commit.created',
      'task.finished',
    ]);
  });

  it('stores lane text, gate output and the review verdict as artifacts, with 0600/0700 records', async () => {
    const x = await harness({ engineering: never });
    const outcome = await x.run();
    expect(outcome.status).toBe('committed');
    const dir = join(x.base, 'work', '.nexar', 'artifacts', TASK);
    expect(readdirSync(dir).sort()).toEqual([
      'gate-test-r0.txt',
      'lane-feature-r0.md',
      'lane-review-r0.md',
      'review-r0.json',
    ]);
    // POSIX file modes apply on the Linux/WSL engineering plane.
    if (process.platform !== 'win32') {
      expect(statSync(outcome.recordPath).mode & 0o777).toBe(0o600);
      expect(statSync(join(x.stateDir, 'engineering', TASK)).mode & 0o777).toBe(0o700);
    }
    expect((await listEngineeringRecords(x.stateDir)).map((r) => r.taskId)).toEqual([TASK]);
  });

  it('runs setup in both workspaces with no network, and gates with no network', async () => {
    const setup = {
      name: 'install',
      command: [
        process.execPath,
        '-e',
        "require('node:fs').mkdirSync('node_modules',{recursive:true});require('node:fs').writeFileSync('node_modules/ok','1')",
      ],
    };
    const gate = {
      name: 'deps',
      command: [process.execPath, '-e', "require('node:fs').accessSync('node_modules/ok')"],
    };
    const x = await harness({ engineering: { ...never, setup: [setup], gates: [gate] } });
    const outcome = await x.run();
    expect(outcome.status).toBe('committed');
    // node_modules is ignored, so it is not part of the committed patch.
    expect(git(x.repo, 'ls-tree', '-r', '--name-only', `nexar/${TASK}`)).not.toContain(
      'node_modules',
    );
    const phases = (await record(x)).commands.map((c) => `${c.phase}:${c.name}`);
    expect(phases).toEqual(['agent-setup:install', 'verify-setup:install', 'gate:deps']);
    const networks = x.launcher.specs
      .filter((s) => s.command === process.execPath)
      .map((s) => s.network.mode);
    expect(networks).toEqual(['none', 'none', 'none']);
    expect(x.launcher.disposed).toBe(x.launcher.specs.length);
  });

  it('gives setup only the owner-listed hosts', async () => {
    const setup = { name: 'install', command: [process.execPath, '-e', '0'] };
    const x = await harness({
      engineering: { ...never, setup: [setup], setupAllowHosts: ['registry.example.invalid'] },
    });
    await x.run();
    const specs = x.launcher.specs.filter((s) => s.command === process.execPath);
    expect(specs.map((s) => s.network)).toEqual([
      { mode: 'proxy', allowHosts: ['registry.example.invalid'] },
      { mode: 'proxy', allowHosts: ['registry.example.invalid'] },
      { mode: 'none' },
    ]);
  });

  it('passes the architecture plan to later lanes as untrusted input', async () => {
    const x = await harness({ engineering: never });
    const outcome = await x.run({ planId: 'plan-implement-review' });
    expect(outcome.status).toBe('committed');
    const [arch, feature, review] = x.adapter.calls;
    expect(arch).toMatchObject({
      lane: 'architecture',
      resourceId: 'architect',
      access: 'read-only',
    });
    expect(feature?.prompt).toContain(
      '<untrusted-input name="plan">\nPLAN-TEXT: change a.txt only',
    );
    expect(review?.prompt).toContain('PLAN-TEXT');
    expect(feature?.systemPrompt).not.toContain(GOAL_MARKER);
    expect(feature?.prompt).toContain(
      `<untrusted-input name="goal">\nAdd the feature. ${GOAL_MARKER}`,
    );
    // The review lane sees the patch and a gate summary, never gate output.
    expect(review?.prompt).toContain('<untrusted-input name="patch">');
    expect(review?.prompt).toContain(DIFF_MARKER);
    expect(review?.prompt).toContain('- test: passed (exit 0)');
    expect(review?.prompt).not.toContain('gate-output-line');
  });

  it('runs the tests lane after the feature lane in implement-test-review', async () => {
    const x = await harness({ engineering: never });
    x.adapter.queue('tests', (call) => {
      editFile(call, 'a.test.txt', 'a test\n');
      return 'tests added';
    });
    const outcome = await x.run({ planId: 'implement-test-review' });
    expect(outcome.status).toBe('committed');
    expect(x.adapter.calls.map((c) => c.lane)).toEqual(['feature', 'tests', 'review']);
    expect(git(x.repo, 'ls-tree', '-r', '--name-only', `nexar/${TASK}`)).toContain('a.test.txt');
    const message = git(x.repo, 'log', '-1', '--format=%B', `nexar/${TASK}`);
    expect(message).toContain('Nexar-Lane-2: tests=impl');
    expect(message).toContain('Nexar-Lane-3: review=reviewer');
    expect(message).toContain('Nexar-Approval: none');
  });

  it('applies lane preferences when routing', async () => {
    const x = await harness({
      engineering: { ...never, lanePreferences: { feature: ['impl-2'] } },
      resources: [
        { id: 'impl-1', capabilities: ['coding', 'repo-editing'] },
        { id: 'impl-2', capabilities: ['coding', 'repo-editing'] },
        { id: 'reviewer', capabilities: ['code-review'] },
      ],
    });
    await x.run();
    expect(x.adapter.calls[0]?.resourceId).toBe('impl-2');
  });
});

describe.skipIf(process.platform === 'win32')('EngineeringRunner: review diversity', () => {
  const solo = [{ id: 'solo', capabilities: ['coding', 'repo-editing', 'code-review'] }];

  it('required: fails when no independent resource exists', async () => {
    const x = await harness({
      resources: solo,
      engineering: { ...never, reviewDiversity: 'required' },
    });
    const outcome = await x.run();
    expect(outcome).toMatchObject({ status: 'failed', reason: 'review.no-independent-resource' });
    expect(outcome.branch).toBeUndefined();
    expect(branches(x)).toBe('');
    expect(x.adapter.calls.map((c) => c.lane)).toEqual(['feature']);
  });

  it('preferred: falls back to the same resource and records the reason', async () => {
    const x = await harness({
      resources: solo,
      engineering: { ...never, reviewDiversity: 'preferred' },
    });
    const outcome = await x.run();
    expect(outcome.status).toBe('committed');
    const rec = await record(x);
    expect(rec.lanes[1]).toMatchObject({ laneId: 'review', resourceId: 'solo' });
    expect(rec.lanes[1]?.reasonCodes).toContain('review.same-resource');
    expect(rec.reviews[0]?.reasonCodes).toContain('review.same-resource');
  });
});

describe.skipIf(process.platform === 'win32')('EngineeringRunner: gates, review and rework', () => {
  it('reworks after a gate failure, then passes', async () => {
    const x = await harness({ engineering: never });
    // The first attempt does not satisfy the gate; the debugging lane fixes it.
    x.adapter.queue('feature', (call) => {
      editFile(call, 'a.txt', 'not yet\n');
      return 'first try';
    });
    const outcome = await x.run();
    expect(outcome.status).toBe('committed');
    expect(x.adapter.calls.map((c) => `${c.lane}:${c.round}`)).toEqual([
      'feature:0',
      'debugging:1',
      'review:1',
    ]);
    const rework = x.adapter.calls[1];
    expect(rework?.access).toBe('read-write');
    expect(rework?.workspacePath).toBe(x.adapter.calls[0]?.workspacePath);
    expect(rework?.prompt).toContain(
      '<untrusted-input name="findings">\nGate "test" failed (exit 3)',
    );
    expect(rework?.prompt).toContain('gate-output-line');
    expect(rework?.systemPrompt).toMatch(/debugging lane/);
    const rec = await record(x);
    expect(rec.round).toBe(1);
    expect(rec.commands.map((c) => `${c.round}:${c.exitCode}`)).toEqual(['0:3', '1:0']);
    expect(rec.patches.map((p) => p.round)).toEqual([0, 1]);
    const message = git(x.repo, 'log', '-1', '--format=%B', `nexar/${TASK}`);
    expect(message).toContain('Nexar-Lane-2: debugging=impl');
  });

  it('fails when rework is exhausted', async () => {
    const x = await harness({ engineering: never });
    const bad = (call: Parameters<typeof editFile>[0]) => {
      editFile(call, 'a.txt', 'still wrong\n');
      return 'nope';
    };
    x.adapter.queue('feature', bad);
    x.adapter.queue('debugging', bad);
    const outcome = await x.run();
    expect(outcome).toMatchObject({ status: 'failed', reason: 'gates.failed' });
    expect(branches(x)).toBe('');
    expect(x.adapter.calls.map((c) => c.lane)).toEqual(['feature', 'debugging']);
    // The worktree is kept for the owner to inspect.
    expect(existsSync(join(x.worktreesDir, 'demo', TASK, 'work'))).toBe(true);
  });

  it('does not rework at all with maxReworkRounds 0', async () => {
    const x = await harness({ engineering: { ...never, maxReworkRounds: 0 } });
    x.adapter.queue('feature', (call) => {
      editFile(call, 'a.txt', 'wrong\n');
      return 'x';
    });
    expect(await x.run()).toMatchObject({ status: 'failed', reason: 'gates.failed' });
    expect(x.adapter.calls).toHaveLength(1);
  });

  it('reworks on request-changes with the findings as untrusted input, then approves', async () => {
    const x = await harness({ engineering: never });
    x.adapter.queue(
      'review',
      () =>
        verdictText('request-changes', [
          { severity: 'major', file: 'a.txt', message: 'handle empty input' },
        ]),
      () => verdictText('approve'),
    );
    const outcome = await x.run();
    expect(outcome.status).toBe('committed');
    expect(x.adapter.calls.map((c) => `${c.lane}:${c.round}`)).toEqual([
      'feature:0',
      'review:0',
      'debugging:1',
      'review:1',
    ]);
    expect(x.adapter.calls[2]?.prompt).toContain('[major] a.txt: handle empty input');
    const rec = await record(x);
    expect(rec.reviews.map((r) => `${r.round}:${r.verdict}`)).toEqual([
      '0:request-changes',
      '1:approve',
    ]);
    expect(rec.reviews[0]?.findings).toEqual({ blocker: 0, major: 1, minor: 0, nit: 0 });
    // The review lane never runs on the implementing resource when another is available.
    expect(x.adapter.calls.filter((c) => c.lane === 'review').map((c) => c.resourceId)).toEqual([
      'reviewer',
      'reviewer',
    ]);
  });

  it('ends not-accepted when review keeps requesting changes', async () => {
    const x = await harness({ engineering: { ...never, maxReworkRounds: 0 } });
    x.adapter.queue('review', () =>
      verdictText('request-changes', [{ severity: 'blocker', message: 'wrong' }]),
    );
    const outcome = await x.run();
    expect(outcome).toMatchObject({ status: 'not-accepted', reason: 'review.changes-requested' });
    expect(branches(x)).toBe('');
  });

  it('treats an unparseable verdict as request-changes', async () => {
    const x = await harness({ engineering: { ...never, maxReworkRounds: 0 } });
    x.adapter.queue('review', () => 'Looks great to me!');
    const outcome = await x.run();
    expect(outcome).toMatchObject({ status: 'not-accepted', reason: 'review.changes-requested' });
    const rec = await record(x);
    expect(rec.reviews[0]).toMatchObject({ verdict: 'request-changes', valid: false });
    expect(rec.reviews[0]?.reasonCodes).toContain('review.unparseable');
  });

  it('fails when the lane itself fails, and records it', async () => {
    const x = await harness({ engineering: never });
    x.adapter.queue('feature', () => {
      throw new NexarError('PROVIDER_ERROR', 'upstream down');
    });
    const outcome = await x.run();
    expect(outcome).toMatchObject({ status: 'failed', reason: 'lane.feature.PROVIDER_ERROR' });
    expect((await record(x)).lanes[0]).toMatchObject({
      outcome: 'failed',
      errorCode: 'PROVIDER_ERROR',
    });
  });

  it('fails an empty patch', async () => {
    const x = await harness({ engineering: never });
    x.adapter.queue('feature', () => 'did nothing');
    expect(await x.run()).toMatchObject({ status: 'failed', reason: 'patch.empty' });
  });
});

describe.skipIf(process.platform === 'win32')('EngineeringRunner: patch policy', () => {
  it.each([
    ['.gitmodules', 'path-gitmodules'],
    ['.gitattributes', 'path-gitattributes'],
    ['.github/workflows/ci.yml', 'path-github-workflows'],
  ])('fails a patch touching %s with the rule id', async (file, rule) => {
    const x = await harness({ engineering: never });
    x.adapter.queue('feature', (call) => {
      editFile(call);
      editFile(call, file, 'x\n');
      return 'sneaky';
    });
    const outcome = await x.run();
    expect(outcome).toMatchObject({ status: 'failed', reason: 'patch.invalid' });
    const rec = await record(x);
    expect(rec.patches[0]).toMatchObject({ valid: false });
    expect(rec.patches[0]?.violations).toContain(rule);
    expect(JSON.stringify(rec)).not.toContain(file);
    expect(branches(x)).toBe('');
  });

  it('never stages the agent repository metadata', async () => {
    const x = await harness({ engineering: never });
    x.adapter.queue('feature', (call) => {
      editFile(call);
      // Git ignores .git/* when staging, so this cannot reach the patch.
      editFile(call, '.git/hooks/pre-commit', '#!/bin/sh\nexit 1\n');
      return 'x';
    });
    expect((await x.run()).status).toBe('committed');
    expect(git(x.repo, 'ls-tree', '-r', '--name-only', `nexar/${TASK}`).trim()).toBe(
      '.gitignore\na.txt',
    );
  });

  it('applies project deny globs', async () => {
    const x = await harness({
      engineering: { ...never, patchPolicy: { denyGlobs: ['secrets/**'] } },
    });
    x.adapter.queue('feature', (call) => {
      editFile(call);
      editFile(call, 'secrets/key.txt', 'x\n');
      return 'x';
    });
    const outcome = await x.run();
    expect(outcome).toMatchObject({ status: 'failed', reason: 'patch.invalid' });
    expect((await record(x)).patches[0]?.violations).toContain('deny-glob');
  });
});

describe.skipIf(process.platform === 'win32')('EngineeringRunner: owner approval', () => {
  it('deny-all approvals make acceptance impossible: not-accepted, no branch', async () => {
    const x = await harness({ approvalMode: 'deny-all' });
    const outcome = await x.run();
    expect(outcome).toMatchObject({ status: 'not-accepted', reason: 'approval.no-approver' });
    expect(branches(x)).toBe('');
    expect(git(x.repo, 'rev-parse', 'HEAD').trim()).toBe(x.headBefore);
    expect((await record(x)).approval).toEqual({ outcome: 'no-approver' });
  });

  it('a denied approval is not-accepted', async () => {
    const x = await harness();
    const denied = x.decideNext('deny');
    const outcome = await x.run();
    expect(outcome).toMatchObject({ status: 'not-accepted', reason: 'approval.denied' });
    expect((await record(x)).approval).toEqual({ id: await denied, outcome: 'denied' });
    expect(branches(x)).toBe('');
  });

  it('an expired approval is not-accepted', async () => {
    const x = await harness();
    // No one decides within the (tiny) TTL.
    const outcome = await x
      .makeRunner({ approvalTtlMs: 30 })
      .run({ projectId: 'demo', goal: 'Do it' });
    expect(outcome).toMatchObject({ status: 'not-accepted', reason: 'approval.expired' });
  });

  it('consumes the grant with exactly the action that was requested and approved', async () => {
    const x = await harness();
    let requested: OutwardAction | undefined;
    let consumed: OutwardAction | undefined;
    const original = x.gate.request.bind(x.gate);
    x.gate.request = async (action, context) => {
      requested = action;
      const grant = await original(action, context);
      return {
        ...grant,
        consume: (spent) => {
          consumed = spent;
          return grant.consume(spent);
        },
      };
    };
    const approved = x.decideNext('approve');
    const outcome = await x.run();
    await approved;
    expect(outcome.status).toBe('committed');
    expect(consumed).toBe(requested);
    expect(requested).toMatchObject({
      type: 'engineering.commit',
      target: `demo:nexar/${TASK}`,
      parameters: {
        repository: x.repo,
        baseCommit: x.headBefore,
        branch: `nexar/${TASK}`,
        patchSha256: (await record(x)).patches[0]?.sha256,
      },
    });
    const [stored] = await x.store.list({ status: 'consumed' });
    expect(stored).toMatchObject({
      actionType: 'engineering.commit',
      taskId: TASK,
      projectId: 'demo',
      risk: 'medium',
      metadata: { engineeringTaskId: TASK, files: 1, gatesPassed: 1, reviewVerdict: 'approve' },
    });
  });

  it('refuses to commit when the grant cannot be consumed (fingerprint mismatch)', async () => {
    const x = await harness();
    const original = x.gate.request.bind(x.gate);
    x.gate.request = async (action, context) => {
      const grant = await original(action, context);
      return {
        ...grant,
        consume: (spent) => grant.consume({ ...spent, target: 'demo:nexar/other' }),
      };
    };
    const approved = x.decideNext('approve');
    const outcome = await x.run();
    await approved;
    expect(outcome).toMatchObject({
      status: 'not-accepted',
      reason: 'approval.fingerprint-mismatch',
    });
    expect(branches(x)).toBe('');
  });
});

describe('EngineeringRunner: preconditions and lifecycle', () => {
  it('rejects a non-sandbox launcher before creating any worktree', async () => {
    const x = await harness({ isolation: 'none' });
    await expect(x.run()).rejects.toMatchObject({ code: 'POLICY_REJECTED' });
    expect(existsSync(x.worktreesDir)).toBe(false);
    expect(existsSync(join(x.stateDir, 'engineering'))).toBe(false);
    expect(x.adapter.calls).toHaveLength(0);
  });

  it('validates the goal, project, engineering settings and plan', async () => {
    const x = await harness();
    await expect(x.run({ goal: '   ' })).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    await expect(x.run({ goal: 'x'.repeat(20_001) })).rejects.toMatchObject({
      code: 'VALIDATION_ERROR',
    });
    await expect(x.run({ projectId: 'ghost' })).rejects.toMatchObject({ code: 'POLICY_REJECTED' });
    await expect(x.run({ planId: 'nope' })).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    await expect(x.run({ baseBranch: 'no-such-branch' })).resolves.toMatchObject({
      status: 'failed',
      reason: 'error.INTERNAL_ERROR',
    });
    expect(existsSync(join(x.worktreesDir, 'demo', TASK))).toBe(false);
  });

  it('rejects a project without engineering settings', async () => {
    const x = await harness();
    const projects = await ProjectRegistry.create([
      { id: projectId('plain'), displayName: 'Plain', roots: [join(x.base, 'work')] },
    ]);
    const runner = x.makeRunner({ projects });
    await expect(runner.run({ projectId: 'plain', goal: 'x' })).rejects.toMatchObject({
      code: 'CONFIGURATION_ERROR',
    });
  });

  it('keeps the worktree on failure and removes it on cleanup()', async () => {
    const x = await harness({ engineering: { ...never, maxReworkRounds: 0 } });
    x.adapter.queue('feature', () => 'did nothing');
    expect((await x.run()).status).toBe('failed');
    const taskDir = join(x.worktreesDir, 'demo', TASK);
    expect(existsSync(join(taskDir, 'work'))).toBe(true);
    await x.runner.cleanup(TASK);
    expect(existsSync(taskDir)).toBe(false);
    await expect(x.runner.cleanup('eng-unknown')).rejects.toMatchObject({
      code: 'VALIDATION_ERROR',
    });
  });

  it('cancels mid-lane: stops the lane, records cancelled, creates no branch', async () => {
    const x = await harness();
    const controller = new AbortController();
    x.adapter.queue(
      'feature',
      (_call, context) =>
        new Promise<string>((_resolve, reject) => {
          context.signal.addEventListener('abort', () =>
            reject(new NexarError('EXECUTION_CANCELLED', 'stopped')),
          );
        }),
    );
    const outcome = await x.run(
      {},
      {
        signal: controller.signal,
        onProgress: (e) => {
          if (e.type === 'lane.started') setTimeout(() => controller.abort(), 20);
        },
      },
    );
    expect(outcome).toMatchObject({ status: 'cancelled', reason: 'cancelled' });
    const rec = await record(x);
    expect(rec.status).toBe('cancelled');
    expect(rec.lanes[0]).toMatchObject({ laneId: 'feature', outcome: 'cancelled' });
    expect(branches(x)).toBe('');
  });

  describe('lineage (ADR-025)', () => {
    const lineage = {
      sessionId: `ses_${'1'.repeat(32)}`,
      turnId: `turn_${'2'.repeat(32)}`,
      correlationId: `turn_${'2'.repeat(32)}`,
      depth: 1,
    };

    it('is validated before anything is created', async () => {
      const x = await harness();
      for (const bad of [
        { ...lineage, sessionId: 'ses_1' },
        { ...lineage, turnId: '../x' },
        { ...lineage, depth: 3 },
        { ...lineage, extra: 'x' },
      ]) {
        await expect(x.run({ lineage: bad })).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
      }
      expect(existsSync(join(x.stateDir, 'engineering'))).toBe(false);
    });

    it('reaches the record and every engineering telemetry event, as ids only', async () => {
      const x = await harness();
      const controller = new AbortController();
      x.adapter.queue(
        'feature',
        (_call, context) =>
          new Promise<string>((_resolve, reject) => {
            context.signal.addEventListener('abort', () =>
              reject(new NexarError('EXECUTION_CANCELLED', 'stopped')),
            );
          }),
      );
      const outcome = await x.run(
        { lineage },
        {
          signal: controller.signal,
          onProgress: (e) => {
            if (e.type === 'lane.started') setTimeout(() => controller.abort(), 20);
          },
        },
      );
      expect(outcome.status).toBe('cancelled');
      expect((await record(x)).lineage).toEqual(lineage);
      const steps = x.events.filter((e) => e.type === 'engineering.step');
      expect(steps.length).toBeGreaterThan(0);
      for (const event of steps) {
        expect(event).toMatchObject({ lineage });
      }
      expect(JSON.stringify(steps)).not.toContain(GOAL_MARKER);
    });

    it('is absent when the task was not started by a turn', async () => {
      const x = await harness({ engineering: { ...never, maxReworkRounds: 0 } });
      x.adapter.queue('feature', () => 'did nothing');
      await x.run();
      expect(await record(x)).not.toHaveProperty('lineage');
      expect(x.events.filter((e) => e.type === 'engineering.step')[0]).not.toHaveProperty(
        'lineage',
      );
    });
  });

  // Reaching gates requires the Linux harvest; cancellation of native resources is tested separately.
  it.skipIf(process.platform === 'win32')(
    'cancels a running gate by killing its process group',
    async () => {
      const x = await harness({
        engineering: {
          ...never,
          gates: [{ name: 'slow', command: [process.execPath, '-e', 'setTimeout(()=>{},60000)'] }],
        },
      });
      const controller = new AbortController();
      const started = Date.now();
      const outcome = await x.run(
        {},
        {
          signal: controller.signal,
          onProgress: (e) => {
            if (e.type === 'step' && e.step === 'patch.harvested') {
              setTimeout(() => controller.abort(), 100);
            }
          },
        },
      );
      expect(outcome.status).toBe('cancelled');
      expect(Date.now() - started).toBeLessThan(20_000);
    },
  );

  it.skipIf(process.platform === 'win32')(
    'times out a gate and reports it as a failure',
    async () => {
      const x = await harness({
        engineering: {
          ...never,
          maxReworkRounds: 0,
          gates: [
            {
              name: 'slow',
              command: [process.execPath, '-e', 'setTimeout(()=>{},60000)'],
              timeoutMs: 200,
            },
          ],
        },
      });
      expect(await x.run()).toMatchObject({ status: 'failed', reason: 'gates.failed' });
      expect((await record(x)).commands[0]).toMatchObject({
        timedOut: true,
        passed: false,
        exitCode: null,
      });
    },
  );

  it.skipIf(process.platform === 'win32')(
    'keeps only the last 4 KB of a failing gate in the rework findings',
    async () => {
      const noisy = {
        name: 'noisy',
        command: [
          process.execPath,
          '-e',
          "console.log('HEAD-MARKER'+'x'.repeat(20000)); console.log('TAIL-MARKER'); process.exit(1)",
        ],
      };
      const x = await harness({ engineering: { ...never, gates: [noisy] } });
      x.adapter.queue('debugging', () => 'no change');
      await x.run();
      const findings = x.adapter.calls.find((c) => c.lane === 'debugging')?.prompt ?? '';
      expect(findings).toContain('TAIL-MARKER');
      expect(findings).not.toContain('HEAD-MARKER');
      expect(findings.length).toBeLessThan(8000);
    },
  );
});

describe.skipIf(process.platform === 'win32')(
  'EngineeringRunner: records and telemetry carry no sensitive data',
  () => {
    it('never contains the goal, diff text, gate output or absolute paths', async () => {
      const x = await harness();
      const approved = x.decideNext('approve');
      const outcome = await x.run();
      await approved;
      expect(outcome.status).toBe('committed');
      const text = [
        readFileSync(outcome.recordPath, 'utf8'),
        JSON.stringify(x.events),
        JSON.stringify(silentLogger.warnings),
      ].join('\n');
      expect(text).not.toContain(GOAL_MARKER);
      expect(text).not.toContain('Add the feature');
      expect(text).not.toContain(DIFF_MARKER);
      expect(text).not.toContain('gate-output-line');
      expect(text).not.toContain('PLAN-TEXT');
      expect(text).not.toContain(x.base);
      expect(text).not.toContain('/tmp/');
      expect(text).not.toContain('nexar-eng-test-');
      expect(text.length).toBeGreaterThan(500);
      // The engineering events do carry the scalars they should.
      const steps = x.events.filter((e) => e.type === 'engineering.step');
      expect(steps.every((e) => 'projectId' in e && e.projectId === 'demo')).toBe(true);
    });

    it('keeps the failure record free of paths and violation paths too', async () => {
      const x = await harness({ engineering: { ...never, maxReworkRounds: 0 } });
      x.adapter.queue('feature', (call) => {
        editFile(call, '.gitmodules', `[submodule "${GOAL_MARKER}"]\n`);
        return 'x';
      });
      const outcome = await x.run();
      expect(outcome.status).toBe('failed');
      const text = readFileSync(outcome.recordPath, 'utf8') + JSON.stringify(x.events);
      expect(text).not.toContain(x.base);
      expect(text).not.toContain('.gitmodules');
      expect(text).not.toContain(GOAL_MARKER);
    });
  },
);
