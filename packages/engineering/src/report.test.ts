import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { NexarError } from '@nexar/contracts';
import * as realWorktrees from '@nexar/worktrees';
import {
  GOAL_MARKER,
  REPORT_MARKER,
  createHarness,
  git,
  type Harness,
} from './fixtures.testkit.js';
import { readEngineeringRecord, type WorktreeOps } from './index.js';
import { MAX_REPORT_BYTES, boundReport } from './report.js';

const TASK = 'eng-0123456789ab';
const PLAN = 'repository-report';
const lineage = {
  sessionId: `ses_${'1'.repeat(32)}`,
  turnId: `turn_${'2'.repeat(32)}`,
  correlationId: `turn_${'2'.repeat(32)}`,
  depth: 1,
};

let h: Harness | undefined;
afterEach(() => {
  h?.dispose();
  h = undefined;
});

async function harness(options: Parameters<typeof createHarness>[0] = {}): Promise<Harness> {
  h = await createHarness({ newId: () => TASK, ...options });
  return h;
}

const record = async (x: Harness) => {
  const r = await readEngineeringRecord(x.stateDir, TASK);
  if (r === undefined) throw new Error('no record');
  return r;
};
const artifactDir = (x: Harness): string => join(x.base, 'work', '.nexar', 'artifacts', TASK);

/** The real worktree operations, each wrapped in a spy so a test can see what was (not) called. */
function spiedOps() {
  const spies = {
    createTaskWorktree: vi.fn(realWorktrees.createTaskWorktree),
    harvestPatch: vi.fn(realWorktrees.harvestPatch),
    createVerificationWorkspace: vi.fn(realWorktrees.createVerificationWorkspace),
    commitPatch: vi.fn(realWorktrees.commitPatch),
    removeTaskWorktree: vi.fn(realWorktrees.removeTaskWorktree),
  };
  return { spies, ops: spies satisfies WorktreeOps };
}

describe('boundReport', () => {
  it('returns text that fits unchanged', () => {
    expect(boundReport('hello', 5)).toEqual({ text: 'hello', truncated: false });
  });

  it('cuts to the byte bound and flags it', () => {
    expect(boundReport('abcdef', 4)).toEqual({ text: 'abcd', truncated: true });
  });

  it('never splits a multi-byte character or a surrogate pair', () => {
    const emoji = '😀'; // 4 bytes, a surrogate pair
    for (const limit of [1, 2, 3, 4, 5, 6, 7, 8, 9]) {
      const bounded = boundReport(`ab${emoji.repeat(4)}`, limit);
      expect(bounded.text).not.toContain('�');
      expect(Buffer.byteLength(bounded.text)).toBeLessThanOrEqual(limit);
      expect([...bounded.text].every((ch) => ch === 'a' || ch === 'b' || ch === emoji)).toBe(true);
      expect(bounded.truncated).toBe(true);
    }
    expect(boundReport(`ab${emoji}`, 6)).toEqual({ text: `ab${emoji}`, truncated: false });
    expect(boundReport(`ab${emoji}x`, 6)).toEqual({ text: `ab${emoji}`, truncated: true });
    expect(boundReport(`é${'x'.repeat(10)}`, 1)).toEqual({ text: '', truncated: true });
  });

  it('defaults to 64 KiB', () => {
    const bounded = boundReport('é'.repeat(MAX_REPORT_BYTES));
    expect(Buffer.byteLength(bounded.text)).toBe(MAX_REPORT_BYTES);
    expect(bounded.truncated).toBe(true);
  });
});

describe('EngineeringRunner: report plans', () => {
  it('ends reported with the bounded report and the lane resources', async () => {
    const x = await harness();
    const outcome = await x.run({ planId: PLAN });
    expect(outcome).toMatchObject({
      taskId: TASK,
      status: 'reported',
      report: { truncated: false },
      lanes: [{ role: 'report', resourceId: 'reviewer' }],
    });
    expect(outcome.report?.text).toContain(REPORT_MARKER);
    expect(outcome.branch).toBeUndefined();
    expect(outcome.commit).toBeUndefined();
  });

  it('runs the implementation-plan plan as a read-only coding report with no patch', async () => {
    // The plan needs a resource with both capabilities (coding and code-review).
    const x = await harness({
      resources: [{ id: 'planner', capabilities: ['coding', 'repo-editing', 'code-review'] }],
    });
    const outcome = await x.run({ planId: 'implementation-plan' });
    expect(outcome).toMatchObject({ status: 'reported', report: { truncated: false } });
    expect(outcome.branch).toBeUndefined();
    expect(outcome.commit).toBeUndefined();
    expect(x.adapter.calls).toHaveLength(1);
    expect(x.adapter.calls[0]).toMatchObject({
      lane: 'report',
      access: 'read-only',
      isolation: 'sandbox',
    });
    expect(x.adapter.calls[0]?.systemPrompt).toMatch(/implementation plan/i);
    expect(x.adapter.calls[0]?.prompt).toContain('<untrusted-input name="goal">');
    expect(await x.store.list()).toEqual([]);
    expect(git(x.repo, 'rev-parse', 'HEAD').trim()).toBe(x.headBefore);
  });

  it('keeps the owner repository untouched and creates no branch', async () => {
    const x = await harness();
    await x.run({ planId: PLAN });
    expect(git(x.repo, 'rev-parse', 'HEAD').trim()).toBe(x.headBefore);
    expect(git(x.repo, 'status', '--porcelain')).toBe('');
    expect(git(x.repo, 'branch', '--list', 'nexar/*')).toBe('');
  });

  it('runs every lane read-only inside the sandbox, on the private clone', async () => {
    const x = await harness();
    await x.run({ planId: PLAN });
    expect(x.adapter.calls).toHaveLength(1);
    for (const call of x.adapter.calls) {
      expect(call).toMatchObject({ lane: 'report', access: 'read-only', isolation: 'sandbox' });
      expect(call.workspacePath).toMatch(/eng-0123456789ab[\\/]work$/);
    }
    expect(x.adapter.calls[0]?.prompt).toContain('<untrusted-input name="goal">');
    expect(x.adapter.calls[0]?.prompt).toContain(GOAL_MARKER);
    expect(x.adapter.calls[0]?.systemPrompt).not.toContain(GOAL_MARKER);
  });

  it('never harvests, verifies, commits, runs setup or gates, or asks for approval', async () => {
    const { spies, ops } = spiedOps();
    const x = await harness({
      engineering: { setup: [{ name: 'setup', command: ['true'], timeoutMs: 1000 }] },
    });
    const outcome = await x.makeRunner({ worktrees: ops }).run({
      projectId: 'demo',
      goal: `Report. ${GOAL_MARKER}`,
      planId: PLAN,
    });
    expect(outcome.status).toBe('reported');
    expect(spies.createTaskWorktree).toHaveBeenCalledTimes(1);
    expect(spies.harvestPatch).not.toHaveBeenCalled();
    expect(spies.createVerificationWorkspace).not.toHaveBeenCalled();
    expect(spies.commitPatch).not.toHaveBeenCalled();
    expect(await x.store.list()).toEqual([]);
    expect(x.launcher.specs).toEqual([]);
    const rec = await record(x);
    expect(rec).toMatchObject({ status: 'reported', planId: PLAN, round: 0 });
    expect(rec.commands).toEqual([]);
    expect(rec.patches).toEqual([]);
    expect(rec.reviews).toEqual([]);
    expect(rec.approval).toBeUndefined();
    expect(rec.commit).toBeUndefined();
    expect(
      x.events.filter((e) => e.type === 'engineering.step').map((e) => 'step' in e && e.step),
    ).toEqual(['task.started', 'lane.completed', 'task.finished']);
  });

  it('records the report hash and size, never the text; the text is the lane artifact', async () => {
    const x = await harness();
    await x.run({ planId: PLAN });
    const rec = await record(x);
    const file = join(artifactDir(x), 'lane-report-r0.md');
    const stored = readFileSync(file);
    expect(readdirSync(artifactDir(x))).toEqual(['lane-report-r0.md']);
    expect(rec.report).toEqual({
      sha256: createHash('sha256').update(stored).digest('hex'),
      bytes: statSync(file).size,
    });
    expect(rec.lanes[0]).toMatchObject({ laneId: 'report', outputSha256: rec.report?.sha256 });
    const json = readFileSync(join(x.stateDir, 'engineering', TASK, 'record.json'), 'utf8');
    expect(json).not.toContain(REPORT_MARKER);
    expect(json).not.toContain(GOAL_MARKER);
  });

  it('puts ids, counts and hashes on telemetry, never the report or the goal', async () => {
    const x = await harness();
    await x.run({ planId: PLAN });
    const rec = await record(x);
    const text = JSON.stringify(x.events);
    expect(text).not.toContain(REPORT_MARKER);
    expect(text).not.toContain(GOAL_MARKER);
    const finished = x.events.find((e) => 'step' in e && e.step === 'task.finished');
    expect(finished).toMatchObject({
      detail: {
        status: 'reported',
        reportSha256: rec.report?.sha256,
        reportBytes: rec.report?.bytes,
      },
    });
  });

  it('carries lineage on the record and every engineering event', async () => {
    const x = await harness();
    await x.run({ planId: PLAN, lineage });
    expect((await record(x)).lineage).toEqual(lineage);
    const steps = x.events.filter((e) => e.type === 'engineering.step');
    expect(steps.length).toBeGreaterThan(0);
    for (const event of steps) expect(event).toMatchObject({ lineage });
  });

  it('bounds the returned report to 64 KiB, flags it, and keeps the full size in the record', async () => {
    const x = await harness();
    const text = `${'é'.repeat(MAX_REPORT_BYTES)}${REPORT_MARKER}`;
    x.adapter.queue('report', () => text);
    const outcome = await x.run({ planId: PLAN });
    expect(outcome.status).toBe('reported');
    expect(outcome.report?.truncated).toBe(true);
    expect(Buffer.byteLength(outcome.report?.text ?? '')).toBeLessThanOrEqual(MAX_REPORT_BYTES);
    expect(outcome.report?.text).not.toContain('�');
    expect(outcome.report?.text).not.toContain(REPORT_MARKER);
    expect((await record(x)).report?.bytes).toBe(Buffer.byteLength(text));
  });

  it('fails an empty report with a fixed reason', async () => {
    const x = await harness();
    x.adapter.queue('report', () => '  \n');
    expect(await x.run({ planId: PLAN })).toMatchObject({
      status: 'failed',
      reason: 'report.empty',
    });
    expect((await record(x)).report).toBeUndefined();
  });

  it('applies the owner `report` lane preference when routing', async () => {
    const x = await harness({
      engineering: { lanePreferences: { report: ['reviewer-2'] } },
      resources: [
        { id: 'reviewer-1', capabilities: ['code-review'] },
        { id: 'reviewer-2', capabilities: ['code-review'] },
      ],
    });
    const outcome = await x.run({ planId: PLAN });
    expect(outcome.lanes).toEqual([{ role: 'report', resourceId: 'reviewer-2' }]);
  });

  it('fails closed without a sandbox: nothing is created and no resource is called', async () => {
    const x = await harness({ isolation: 'none' });
    await expect(x.run({ planId: PLAN })).rejects.toMatchObject({ code: 'POLICY_REJECTED' });
    expect(existsSync(x.worktreesDir)).toBe(false);
    expect(existsSync(join(x.stateDir, 'engineering'))).toBe(false);
    expect(x.adapter.calls).toHaveLength(0);
  });

  it('fails with a fixed reason when no resource can execute the lane', async () => {
    const x = await harness({ resources: [{ id: 'impl', capabilities: ['coding'] }] });
    const outcome = await x.run({ planId: PLAN });
    expect(outcome).toMatchObject({ status: 'failed', reason: 'lane.report.NO_ELIGIBLE_RESOURCE' });
    expect(outcome.report).toBeUndefined();
    expect(outcome.lanes).toBeUndefined();
    expect((await record(x)).lanes[0]).toMatchObject({ outcome: 'failed' });
  });

  it('fails with a fixed reason when the executor is unavailable', async () => {
    const x = await harness();
    x.adapter.queue('report', () => {
      throw new NexarError('INTEGRATION_UNAVAILABLE', 'dsh is not installed at /secret/path');
    });
    const outcome = await x.run({ planId: PLAN });
    expect(outcome).toMatchObject({
      status: 'failed',
      reason: 'lane.report.INTEGRATION_UNAVAILABLE',
    });
    expect(JSON.stringify(await record(x))).not.toContain('/secret/path');
    const steps = x.events.filter((e) => e.type === 'engineering.step');
    expect(JSON.stringify(steps)).not.toContain('/secret/path');
  });

  it('fails a timed-out lane', async () => {
    const x = await harness();
    x.adapter.queue('report', () => {
      throw new NexarError('EXECUTION_TIMEOUT', 'too slow');
    });
    expect(await x.run({ planId: PLAN })).toMatchObject({
      status: 'failed',
      reason: 'lane.report.EXECUTION_TIMEOUT',
    });
    expect((await record(x)).lanes[0]).toMatchObject({ outcome: 'timed-out' });
  });

  it('cancels mid-lane and records cancelled', async () => {
    const x = await harness();
    const controller = new AbortController();
    x.adapter.queue(
      'report',
      (_call, context) =>
        new Promise<string>((_resolve, reject) => {
          context.signal.addEventListener('abort', () =>
            reject(new NexarError('EXECUTION_CANCELLED', 'stopped')),
          );
        }),
    );
    const outcome = await x.run(
      { planId: PLAN },
      {
        signal: controller.signal,
        onProgress: (e) => {
          if (e.type === 'lane.started') setTimeout(() => controller.abort(), 20);
        },
      },
    );
    expect(outcome).toMatchObject({ status: 'cancelled', reason: 'cancelled' });
    expect(outcome.report).toBeUndefined();
    expect((await record(x)).lanes[0]).toMatchObject({ outcome: 'cancelled' });
  });

  it('removes its own clone once the report is stored', async () => {
    const x = await harness();
    const outcome = await x.run({ planId: PLAN });
    expect(outcome.status).toBe('reported');
    expect(existsSync(join(x.worktreesDir, 'demo', TASK))).toBe(false);
    // The report survives in the lane artifact and the record keeps its hash.
    expect((await record(x)).report?.sha256).toMatch(/^[0-9a-f]{64}$/);
    await x.runner.cleanup(TASK); // idempotent
  });
});
