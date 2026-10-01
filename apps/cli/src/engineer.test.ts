import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ProcessLauncher } from '@nexar/contracts';
import type {
  EngineeringOutcome,
  EngineeringProgress,
  EngineeringRecord,
  EngineeringRunOptions,
} from '@nexar/engineering';
import type { EngineeringRunnerPort } from './args.js';
import { runCli } from './cli.js';
import type { CliIo } from './io.js';

const GOAL_MARKER = 'GOAL-MARKER-7b21d4';

function capture(cwd: string) {
  let out = '';
  let err = '';
  const io: CliIo = {
    stdout: (s) => (out += s),
    stderr: (s) => (err += s),
    env: { PATH: process.env['PATH'] ?? '' },
    cwd,
  };
  return { io, out: () => out, err: () => err };
}

const echo = {
  id: 'local-echo',
  displayName: 'Local Echo',
  kind: { type: 'model', provider: 'nexar', model: 'echo', access: 'local' },
  capabilities: ['text-generation', 'coding'],
  runtime: { adapter: 'echo', locality: 'local' },
  auth: { mode: 'none' },
  cost: { model: 'free' },
  dataLocality: 'local',
};

const fakeLauncher: ProcessLauncher = {
  isolation: 'sandbox',
  prepare: () => Promise.reject(new Error('the fake launcher never launches')),
};

function record(over: Partial<EngineeringRecord> = {}): EngineeringRecord {
  return {
    schemaVersion: 1,
    taskId: 'eng-aaaaaaaaaaaa',
    projectId: 'demo',
    planId: 'implement-review',
    status: 'committed',
    startedAt: '2026-10-01T10:00:00.000Z',
    endedAt: '2026-10-01T10:05:00.000Z',
    baseBranch: 'main',
    baseCommit: 'a'.repeat(40),
    branch: 'nexar/eng-aaaaaaaaaaaa',
    round: 0,
    lanes: [
      {
        laneId: 'feature',
        role: 'feature',
        round: 0,
        taskId: 't1',
        resourceId: 'codex',
        reasonCodes: [],
        outcome: 'succeeded',
        latencyMs: 1200,
      },
    ],
    commands: [
      {
        phase: 'gate',
        name: 'test',
        round: 0,
        exitCode: 0,
        timedOut: false,
        passed: true,
        durationMs: 800,
        outputSha256: 'b'.repeat(64),
        outputBytes: 10,
      },
    ],
    patches: [
      { round: 0, sha256: 'c'.repeat(64), bytes: 120, files: 2, valid: true, violations: [] },
    ],
    reviews: [
      {
        round: 0,
        resourceId: 'claude-code',
        verdict: 'approve',
        valid: true,
        findings: { blocker: 0, major: 0, minor: 1, nit: 0 },
        reasonCodes: [],
      },
    ],
    approval: { id: `apr_${'1'.repeat(32)}`, outcome: 'approved' },
    commit: 'd'.repeat(40),
    ...over,
  };
}

async function writeRecord(dir: string, r: EngineeringRecord): Promise<void> {
  const taskDir = join(dir, '.nexar', 'engineering', r.taskId);
  await mkdir(taskDir, { recursive: true });
  await writeFile(join(taskDir, 'record.json'), JSON.stringify(r));
}

describe('nexar engineer (in-process, offline)', () => {
  let dir: string;
  let repo: string;

  beforeEach(async () => {
    dir = await realpath(await mkdtemp(join(tmpdir(), 'nexar-cli-eng-')));
    repo = join(dir, 'repo');
    await mkdir(repo);
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  /** `null` leaves the top-level `engineering` section out. */
  async function writeConfig(engineering: unknown = { toolchainPaths: [] }): Promise<void> {
    await writeFile(
      join(dir, 'nexar.config.json'),
      JSON.stringify({
        version: 1,
        resources: [echo],
        routing: { policy: 'deterministic', defaultResourceId: 'local-echo' },
        ...(engineering === null ? {} : { engineering }),
        projects: [
          {
            id: 'demo',
            displayName: 'Demo',
            roots: ['repo'],
            engineering: {
              gates: [
                { name: 'test', command: ['true'] },
                { name: 'lint', command: ['true'] },
              ],
            },
          },
        ],
      }),
    );
  }

  /** A runner that reports `events`, then ends with `outcome` (or waits for the abort signal). */
  function fakeRunner(
    outcome: EngineeringOutcome | 'wait-for-abort',
    events: readonly EngineeringProgress[] = [],
  ): { runner: EngineeringRunnerPort; inputs: unknown[]; cleaned: string[] } {
    const inputs: unknown[] = [];
    const cleaned: string[] = [];
    const runner: EngineeringRunnerPort = {
      run: async (input, options: EngineeringRunOptions = {}) => {
        inputs.push(input);
        for (const event of events) options.onProgress?.(event);
        if (outcome !== 'wait-for-abort') return outcome;
        await new Promise<void>((resolve) =>
          options.signal?.addEventListener('abort', () => resolve(), { once: true }),
        );
        return {
          taskId: 'eng-cancelled',
          status: 'cancelled',
          reason: 'cancelled',
          recordPath: '',
        };
      },
      cleanup: (taskId) => {
        cleaned.push(taskId);
        return Promise.resolve();
      },
    };
    return { runner, inputs, cleaned };
  }

  const step = (
    stepName: Extract<EngineeringProgress, { type: 'step' }>['step'],
    detail: Record<string, string | number | boolean>,
  ): EngineeringProgress => ({ type: 'step', step: stepName, detail });

  const committed: EngineeringOutcome = {
    taskId: 'eng-aaaaaaaaaaaa',
    status: 'committed',
    branch: 'nexar/eng-aaaaaaaaaaaa',
    commit: 'd'.repeat(40),
    recordPath: '/abs/secret/location/record.json',
  };

  const events: EngineeringProgress[] = [
    { type: 'lane.started', lane: 'feature', role: 'feature', round: 0 },
    step('lane.completed', {
      lane: 'feature',
      role: 'feature',
      round: 0,
      resourceId: 'codex',
      outcome: 'succeeded',
    }),
    step('gate.completed', {
      phase: 'gate',
      name: 'test',
      round: 0,
      passed: true,
      timedOut: false,
    }),
    step('gate.completed', {
      phase: 'gate',
      name: 'lint',
      round: 0,
      passed: true,
      timedOut: false,
    }),
    step('review.completed', {
      round: 0,
      resourceId: 'claude-code',
      verdict: 'approve',
      valid: true,
    }),
    {
      type: 'awaiting-approval',
      taskId: 'eng-aaaaaaaaaaaa',
      projectId: 'demo',
      branch: 'nexar/eng-aaaaaaaaaaaa',
      baseCommit: 'a'.repeat(40),
      patchSha256: 'c'.repeat(64),
      files: 2,
      gatesPassed: 2,
      reviewVerdict: 'approve',
      ttlMs: 30 * 60_000,
    },
  ];

  describe('run', () => {
    it('prints scalar progress and a summary, never the goal or any absolute path, and exits 0', async () => {
      await writeConfig();
      const { runner, inputs } = fakeRunner(committed, events);
      const c = capture(dir);
      const code = await runCli(
        [
          'engineer',
          'run',
          '--project',
          'demo',
          '--plan',
          'implement-review',
          '--base',
          'dev',
          `fix ${GOAL_MARKER}`,
        ],
        c.io,
        { engineering: { runner, launcher: fakeLauncher } },
      );
      expect(code).toBe(0);
      expect(inputs).toEqual([
        {
          projectId: 'demo',
          goal: `fix ${GOAL_MARKER}`,
          planId: 'implement-review',
          baseBranch: 'dev',
        },
      ]);
      expect(c.err()).toContain('[engineer] lane feature → codex (r1)');
      expect(c.err()).toContain('[engineer] gates 2/2 passed (r1)');
      expect(c.err()).toContain('[engineer] review by claude-code: approve (r1)');
      expect(c.err()).toContain(
        "[engineer] awaiting owner approval: run 'nexar approvals list' then 'nexar approvals approve <id>' (expires in 30 min)",
      );
      expect(c.err()).toContain('branch: nexar/eng-aaaaaaaaaaaa');
      expect(c.err()).toContain(`patch:  ${'c'.repeat(64)}`);
      expect(c.out()).toContain('task eng-aaaaaaaaaaaa: committed');
      expect(c.out()).toContain('commit: ' + 'd'.repeat(40));
      expect(c.out()).toContain('egress: 0 allowed, 0 denied');
      for (const text of [c.out(), c.err()]) {
        expect(text).not.toContain(GOAL_MARKER);
        expect(text).not.toContain(dir);
        expect(text).not.toContain('/abs/secret');
      }
    });

    it('--json prints the outcome without its record path', async () => {
      await writeConfig();
      const { runner } = fakeRunner(committed);
      const c = capture(dir);
      const code = await runCli(['engineer', 'run', '--project', 'demo', '--json', 'goal'], c.io, {
        engineering: { runner },
      });
      expect(code).toBe(0);
      expect(JSON.parse(c.out())).toEqual({
        taskId: 'eng-aaaaaaaaaaaa',
        status: 'committed',
        branch: 'nexar/eng-aaaaaaaaaaaa',
        commit: 'd'.repeat(40),
        egress: { allowed: 0, denied: 0 },
      });
      expect(c.out()).not.toContain('/abs/secret');
    });

    it('maps outcomes to exit codes', async () => {
      await writeConfig();
      const cases: readonly [Partial<EngineeringOutcome>, number][] = [
        [{ status: 'not-accepted', reason: 'review.changes-requested' }, 6],
        [{ status: 'not-accepted', reason: 'approval.denied' }, 6],
        [{ status: 'failed', reason: 'lane.feature.AUTH_REQUIRED' }, 4],
        [{ status: 'failed', reason: 'lane.feature.EXECUTION_TIMEOUT' }, 5],
        [{ status: 'failed', reason: 'lane.feature.NO_ELIGIBLE_RESOURCE' }, 3],
        [{ status: 'failed', reason: 'lane.feature.SANDBOX_UNAVAILABLE' }, 7],
        [{ status: 'failed', reason: 'gates.setup-failed' }, 1],
        [{ status: 'cancelled', reason: 'cancelled' }, 130],
      ];
      for (const [partial, expected] of cases) {
        const { runner } = fakeRunner({
          ...committed,
          branch: undefined,
          commit: undefined,
          ...partial,
        } as EngineeringOutcome);
        const c = capture(dir);
        const code = await runCli(['engineer', 'run', '--project', 'demo', 'goal'], c.io, {
          engineering: { runner },
        });
        expect(code, JSON.stringify(partial)).toBe(expected);
        expect(c.out()).toContain(partial.status as string);
      }
    });

    it('aborts the run on SIGINT and exits 130', async () => {
      await writeConfig();
      const { runner } = fakeRunner('wait-for-abort');
      const c = capture(dir);
      const pending = runCli(['engineer', 'run', '--project', 'demo', 'goal'], c.io, {
        engineering: { runner },
      });
      await new Promise((resolve) => setTimeout(resolve, 100));
      process.emit('SIGINT');
      expect(await pending).toBe(130);
      expect(c.out()).toContain('cancelled');
      expect(process.listenerCount('SIGINT')).toBe(0);
    });

    it('reports usage errors with exit code 2', async () => {
      await writeConfig();
      const { runner } = fakeRunner(committed);
      const seams = { engineering: { runner } };
      const goalFile = join(dir, 'goal.txt');
      await writeFile(goalFile, 'from a file');
      const bad: string[][] = [
        ['engineer'],
        ['engineer', 'frobnicate'],
        ['engineer', 'run', 'goal'],
        ['engineer', 'run', '--project', 'demo'],
        ['engineer', 'run', '--project', 'demo', '--goal-file', goalFile, 'and words'],
        ['engineer', 'list', 'extra'],
        ['engineer', 'show'],
        ['sandbox'],
        ['sandbox', 'selftest', 'extra'],
      ];
      for (const argv of bad) {
        const c = capture(dir);
        expect(await runCli(argv, c.io, seams), argv.join(' ')).toBe(2);
      }
    });

    it('reads the goal from --goal-file and never echoes the file path in errors', async () => {
      await writeConfig();
      const { runner, inputs } = fakeRunner(committed);
      const goalFile = join(dir, 'goal.txt');
      await writeFile(goalFile, `${GOAL_MARKER}\n`);
      const ok = capture(dir);
      expect(
        await runCli(['engineer', 'run', '--project', 'demo', '--goal-file', 'goal.txt'], ok.io, {
          engineering: { runner },
        }),
      ).toBe(0);
      expect(inputs).toEqual([{ projectId: 'demo', goal: GOAL_MARKER }]);

      await writeFile(goalFile, 'x'.repeat(64 * 1024 + 1));
      const tooBig = capture(dir);
      expect(
        await runCli(['engineer', 'run', '--project', 'demo', '--goal-file', goalFile], tooBig.io, {
          engineering: { runner },
        }),
      ).toBe(2);
      expect(tooBig.err()).toContain('larger than 64 KiB');
      expect(tooBig.err()).not.toContain(goalFile);

      const missing = capture(dir);
      expect(
        await runCli(
          ['engineer', 'run', '--project', 'demo', '--goal-file', 'nope.txt'],
          missing.io,
          {
            engineering: { runner },
          },
        ),
      ).toBe(2);
      expect(missing.err()).toContain('cannot be read');
      expect(missing.err()).not.toContain('nope.txt');
    });

    it('fails with CONFIGURATION_ERROR and names the keys when `engineering` is missing', async () => {
      await writeConfig(null);
      const { runner } = fakeRunner(committed);
      const c = capture(dir);
      const code = await runCli(['engineer', 'run', '--project', 'demo', 'goal'], c.io, {
        engineering: { runner },
      });
      expect(code).toBe(1);
      expect(c.err()).toContain('CONFIGURATION_ERROR');
      expect(c.err()).toContain('"engineering"');
      expect(c.err()).toContain('toolchainPaths');
      expect(c.err()).toContain('author');
    });

    it('does not require engineering config for other commands', async () => {
      await writeConfig(null);
      const c = capture(dir);
      expect(await runCli(['resources'], c.io)).toBe(0);
    });
  });

  describe('list / show / plans / cleanup', () => {
    it('lists records as a table and as JSON', async () => {
      await writeConfig();
      const empty = capture(dir);
      expect(await runCli(['engineer', 'list'], empty.io)).toBe(0);
      expect(empty.out()).toBe('no engineering tasks\n');

      await writeRecord(dir, record());
      await writeRecord(
        dir,
        record({
          taskId: 'eng-bbbbbbbbbbbb',
          status: 'not-accepted',
          reason: 'review.changes-requested',
          startedAt: '2026-10-01T11:00:00.000Z',
        }),
      );
      const text = capture(dir);
      expect(await runCli(['engineer', 'list'], text.io)).toBe(0);
      expect(text.out()).toContain('eng-aaaaaaaaaaaa');
      expect(text.out()).toContain('review.changes-requested');
      expect(text.out().indexOf('eng-aaaaaaaaaaaa')).toBeLessThan(
        text.out().indexOf('eng-bbbbbbbbbbbb'),
      );

      const json = capture(dir);
      expect(await runCli(['engineer', 'list', '--json'], json.io)).toBe(0);
      expect((JSON.parse(json.out()) as EngineeringRecord[]).map((r) => r.taskId)).toEqual([
        'eng-aaaaaaaaaaaa',
        'eng-bbbbbbbbbbbb',
      ]);
    });

    it('shows one record as text and JSON, and rejects unknown or malformed ids', async () => {
      await writeConfig();
      await writeRecord(dir, record());
      const text = capture(dir);
      expect(await runCli(['engineer', 'show', 'eng-aaaaaaaaaaaa'], text.io)).toBe(0);
      expect(text.out()).toContain('status:   committed');
      expect(text.out()).toContain('branch:   nexar/eng-aaaaaaaaaaaa @ ' + 'd'.repeat(40));
      expect(text.out()).toContain('Lanes');
      expect(text.out()).toContain('codex');
      expect(text.out()).toContain('claude-code');
      expect(text.out()).not.toContain(dir);

      const json = capture(dir);
      expect(await runCli(['engineer', 'show', 'eng-aaaaaaaaaaaa', '--json'], json.io)).toBe(0);
      expect((JSON.parse(json.out()) as EngineeringRecord).commit).toBe('d'.repeat(40));

      const unknown = capture(dir);
      expect(await runCli(['engineer', 'show', 'eng-cccccccccccc'], unknown.io)).toBe(1);
      expect(unknown.err()).toContain('unknown engineering task');
      const malformed = capture(dir);
      expect(await runCli(['engineer', 'show', '../etc'], malformed.io)).toBe(2);
      expect(malformed.err()).not.toContain('../etc');
    });

    it('lists the shipped plans', async () => {
      const text = capture(dir);
      expect(await runCli(['engineer', 'plans'], text.io)).toBe(0);
      for (const id of ['implement-review', 'implement-test-review', 'plan-implement-review']) {
        expect(text.out()).toContain(id);
      }
      const json = capture(dir);
      expect(await runCli(['engineer', 'plans', '--json'], json.io)).toBe(0);
      const plans = JSON.parse(json.out()) as { id: string; lanes: { role: string }[] }[];
      expect(plans.find((p) => p.id === 'implement-review')?.lanes.map((l) => l.role)).toEqual([
        'feature',
        'review',
      ]);
    });

    it('cleans up through the runner', async () => {
      await writeConfig();
      const { runner, cleaned } = fakeRunner(committed);
      const c = capture(dir);
      expect(
        await runCli(['engineer', 'cleanup', 'eng-aaaaaaaaaaaa'], c.io, {
          engineering: { runner },
        }),
      ).toBe(0);
      expect(cleaned).toEqual(['eng-aaaaaaaaaaaa']);
      expect(c.out()).toContain('worktree removed');
    });
  });
});
