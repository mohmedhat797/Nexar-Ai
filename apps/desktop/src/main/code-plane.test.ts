import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NexarError, type Logger } from '@nexar/contracts';
import { rootCorrelation, type CodeRequest } from '@nexar/operating';
import type { PlaneReadiness } from '@nexar/plane-protocol';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  CodePlane,
  MAX_ACTIVE_RUNS,
  MAX_STORED_DIFFS,
  PLANE_REASONS,
  progressLine,
  stateFromReadiness,
  type PlaneTimings,
} from './code-plane.js';
import {
  FAKE_PLANE_SCRIPT,
  fakePlaneLauncher,
  type FakePlaneLauncher,
} from './fake-plane-launcher.js';
import {
  createScriptLauncher,
  createWslLauncher,
  planeLaunchArguments,
  type PlaneLauncher,
} from './plane-connection.js';
import type { CodePlaneConfig, CodePlaneConfigResult } from './settings-store.js';

const FAKE_PLANE = FAKE_PLANE_SCRIPT;
const SESSION = `ses_${'1'.repeat(32)}`;
const TURN = `turn_${'2'.repeat(32)}`;
const DESKTOP_PROJECT = 'desktop-proj';
const PLANE_PROJECT = 'plane-proj';

const TIMINGS: Partial<PlaneTimings> = {
  handshakeMs: 15_000,
  shutdownMs: 1_500,
  cancelMs: 1_500,
  requestMs: 4_000,
};

let dir: string;
let launched: FakePlaneLauncher[];

/** Every process any launcher of this test started. */
const spawnedChildren = (): ChildProcess[] => launched.flatMap((l) => l.children);

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'nexar-code-plane-'));
  launched = [];
});

afterEach(async () => {
  for (const child of spawnedChildren()) if (child.exitCode === null) child.kill('SIGKILL');
  await rm(dir, { recursive: true, force: true });
});

function logger(): Logger & { readonly lines: string[] } {
  const lines: string[] = [];
  const write = (level: string) => (msg: string, fields?: unknown) =>
    void lines.push(JSON.stringify({ level, msg, fields }));
  const instance = {
    lines,
    debug: write('debug'),
    info: write('info'),
    warn: write('warn'),
    error: write('error'),
    child: () => instance,
  };
  return instance;
}

/** A launcher over the fake plane with the given scenario variables; counts launches. */
function fakeLauncher(env: Record<string, string> = {}): FakePlaneLauncher {
  const launcher = fakePlaneLauncher({ NEXAR_FAKE_PLANE_LOG: join(dir, 'plane.log'), ...env });
  launched.push(launcher);
  return launcher;
}

function config(
  projects: Record<string, string> = { [DESKTOP_PROJECT]: PLANE_PROJECT },
): CodePlaneConfigResult {
  const value: CodePlaneConfig = {
    distro: 'nexar-plane',
    command: '/usr/local/bin/nexar',
    projects,
  };
  return { valid: true, value };
}

function plane(
  launcher: PlaneLauncher,
  options: { settings?: CodePlaneConfigResult; timings?: Partial<PlaneTimings> } = {},
): { plane: CodePlane; log: ReturnType<typeof logger> } {
  const log = logger();
  let counter = 0;
  const instance = new CodePlane({
    settings: { getCodePlane: () => Promise.resolve(options.settings ?? config()) },
    launcher,
    logger: log,
    decider: 'desktop:tester',
    newRunId: () => `run_${(counter += 1).toString(16).padStart(32, '0')}`,
    timings: { ...TIMINGS, ...options.timings },
  });
  return { plane: instance, log };
}

interface Recorded {
  readonly request: CodeRequest;
  readonly tasks: string[];
  readonly progress: string[];
  readonly approvals: string[];
}

function codeRequest(
  overrides: Partial<
    Pick<CodeRequest, 'intent' | 'goal' | 'turnText' | 'projectId' | 'turnId' | 'sessionId'>
  > = {},
): Recorded {
  const tasks: string[] = [];
  const progress: string[] = [];
  const approvals: string[] = [];
  const sessionId = overrides.sessionId ?? SESSION;
  const turnId = overrides.turnId ?? TURN;
  const request: CodeRequest = {
    sessionId,
    turnId,
    projectId: overrides.projectId ?? DESKTOP_PROJECT,
    intent: overrides.intent ?? 'coding',
    goal: overrides.goal ?? 'Add a retry.',
    turnText: overrides.turnText ?? 'Add a retry.',
    correlation: rootCorrelation(sessionId, turnId),
    onTask: (taskId) => {
      tasks.push(taskId);
      return Promise.resolve();
    },
    onProgress: (_type, message) => void progress.push(message),
    onApproval: (approvalId) => {
      approvals.push(approvalId);
      return Promise.resolve();
    },
  };
  return { request, tasks, progress, approvals };
}

interface LogEntry {
  readonly event: string;
  readonly type?: string;
  readonly env?: string[];
  readonly frame?: Record<string, unknown>;
}

async function readLog(): Promise<LogEntry[]> {
  const text = await readFile(join(dir, 'plane.log'), 'utf8').catch(() => '');
  return text
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as LogEntry);
}

const received = async (): Promise<string[]> =>
  (await readLog()).flatMap((e) => (e.event === 'frame' && e.type !== undefined ? [e.type] : []));

describe('probe states', () => {
  it('is ready with a healthy plane, reports the version and projects, and caches for the window', async () => {
    const launcher = fakeLauncher();
    const { plane: p, log } = plane(launcher);
    const status = await p.status();
    expect(status).toMatchObject({
      state: 'ready',
      reason: PLANE_REASONS.ready,
      planeVersion: '0.0.0-fake',
      kernel: '5.15.0-fake-WSL2',
      projects: [PLANE_PROJECT],
    });
    expect(new Date(status.checkedAt).toISOString()).toBe(status.checkedAt);
    expect(launcher.launches).toBe(1);
    expect(await p.status()).toBe(status); // cached
    expect(launcher.launches).toBe(1);
    const refreshed = await p.refresh(); // forced
    expect(refreshed).not.toBe(status);
    expect(launcher.launches).toBe(2);
    // The probe is short-lived: the plane was told to shut down and left.
    await expect.poll(async () => (await received()).includes('shutdown')).toBe(true);
    await expect.poll(() => spawnedChildren().every((c) => c.exitCode !== null)).toBe(true);
    expect(log.lines.join('\n')).not.toContain(dir);
  });

  it('asks for the resources feature and exposes the plane resources read-only', async () => {
    const { plane: p } = plane(fakeLauncher({ NEXAR_FAKE_PLANE_RESOURCES: '1' }));
    const status = await p.status();
    expect(status.state).toBe('ready');
    expect(status.planeResources).toEqual([
      {
        id: 'claude-code',
        provider: 'anthropic',
        method: 'subscription',
        support: 'official',
        auth: 'authenticated',
        availability: 'available',
        control: { openworker: false, dsh: false },
      },
      {
        id: 'pi:deepseek-chat',
        provider: 'deepseek',
        method: 'api',
        support: 'official',
        auth: 'unknown',
        availability: 'unknown',
        control: { openworker: true, dsh: true },
      },
    ]);
    const init = (await readLog()).find((e) => e.event === 'frame' && e.type === 'initialize');
    expect(init?.frame).toMatchObject({ features: ['resources'] });
    // Only whitelisted keys reach the DTO: no connection id, auth class, path or detail text.
    const keys = new Set((status.planeResources ?? []).flatMap((r) => Object.keys(r)));
    expect([...keys].sort()).toEqual(
      ['auth', 'availability', 'control', 'id', 'method', 'provider', 'support'].sort(),
    );
    const text = JSON.stringify(status);
    expect(text).not.toContain(dir);
    expect(text).not.toContain('authClass');
    expect(text).not.toContain('anthropic.subscription');
  });

  it('maps the plane Code control policy to ids and enums only', async () => {
    const { plane: p } = plane(
      fakeLauncher({ NEXAR_FAKE_PLANE_RESOURCES: '1', NEXAR_FAKE_PLANE_CONTROL: '1' }),
    );
    const status = await p.status();
    expect(status.codeControl).toEqual({
      mode: 'pinned',
      resourceId: 'pi:deepseek-chat',
      fallback: 'none',
    });
    expect(p.cachedStatus()).toBe(status);
  });

  it('has no Code control policy for an older plane that reports none', async () => {
    const { plane: p } = plane(fakeLauncher({ NEXAR_FAKE_PLANE_RESOURCES: '1' }));
    const status = await p.status();
    expect(status.state).toBe('ready');
    expect(status).not.toHaveProperty('codeControl');
    expect(plane(fakeLauncher()).plane.cachedStatus()).toBeUndefined();
  });

  it('leaves planeResources undefined for an older plane that sends none', async () => {
    const { plane: p } = plane(fakeLauncher());
    const status = await p.status();
    expect(status.state).toBe('ready');
    expect(status).not.toHaveProperty('planeResources');
  });

  it('shares one probe between concurrent callers', async () => {
    const launcher = fakeLauncher();
    const { plane: p } = plane(launcher);
    await Promise.all([p.status(), p.refresh(), p.refresh()]);
    expect(launcher.launches).toBe(1);
  });

  it('re-probes after the cache window', async () => {
    const launcher = fakeLauncher();
    const { plane: p } = plane(launcher, { timings: { cacheMs: 0 } });
    await p.status();
    await p.status();
    expect(launcher.launches).toBe(2);
  });

  it('maps a missing WSL (the launcher cannot start wsl.exe) to wsl-unavailable', async () => {
    const launcher: PlaneLauncher = () => {
      throw new NexarError('INTEGRATION_UNAVAILABLE', 'WSL is not available on this computer');
    };
    expect((await plane(launcher).plane.refresh()).state).toBe('wsl-unavailable');
  });

  it('maps ENOENT at spawn (wsl.exe missing) to wsl-unavailable', async () => {
    const launcher: PlaneLauncher = () =>
      spawn(join(dir, 'definitely-not-here.exe'), [], { stdio: ['pipe', 'pipe', 'pipe'] });
    expect((await plane(launcher).plane.refresh()).state).toBe('wsl-unavailable');
  });

  it('maps an exit before ready with no frames to plane-missing', async () => {
    const { plane: p } = plane(fakeLauncher({ NEXAR_FAKE_PLANE_SCENARIO: 'exit-before-ready' }));
    expect(await p.refresh()).toMatchObject({
      state: 'plane-missing',
      reason: PLANE_REASONS['plane-missing'],
    });
  });

  it('maps a handshake timeout to plane-unreachable and ends the process', async () => {
    const launcher = fakeLauncher({ NEXAR_FAKE_PLANE_SCENARIO: 'hang' });
    const { plane: p } = plane(launcher, { timings: { handshakeMs: 400 } });
    expect((await p.refresh()).state).toBe('plane-unreachable');
    await expect
      .poll(() => spawnedChildren().every((c) => c.exitCode !== null || c.signalCode !== null))
      .toBe(true);
  });

  it.each([
    ['protocol-mismatch', 'protocol-mismatch'],
    ['bad-ready', 'protocol-mismatch'],
    ['config-error', 'engineering-unavailable'],
    ['sandbox-unavailable', 'sandbox-unavailable'],
    ['selftest-fail', 'sandbox-unavailable'],
    ['hardening-drift', 'hardening-drift'],
    ['interop-unknown', 'hardening-drift'],
    ['no-plans', 'engineering-unavailable'],
    ['no-projects', 'engineering-unavailable'],
    ['malformed', 'protocol-mismatch'],
    ['oversized', 'protocol-mismatch'],
  ] as const)('maps the %s plane to %s', async (scenario, state) => {
    const { plane: p } = plane(fakeLauncher({ NEXAR_FAKE_PLANE_SCENARIO: scenario }));
    const status = await p.refresh();
    expect(status.state).toBe(state);
    expect(status.reason).toBe(PLANE_REASONS[state]);
  });

  it('fails closed on damaged Code plane settings without launching anything', async () => {
    const launcher = fakeLauncher();
    const { plane: p } = plane(launcher, { settings: { valid: false } });
    expect(await p.refresh()).toMatchObject({
      state: 'plane-missing',
      reason: PLANE_REASONS['settings-invalid'],
    });
    expect(launcher.launches).toBe(0);
    await expect(p.run(codeRequest().request, new AbortController().signal)).rejects.toMatchObject({
      code: 'CONFIGURATION_ERROR',
    });
  });

  it('never crashes the caller when the probe itself throws', async () => {
    const broken = new CodePlane({
      settings: { getCodePlane: () => Promise.reject(new Error('disk')) },
      launcher: fakeLauncher(),
      logger: logger(),
      decider: 'desktop:t',
    });
    expect((await broken.refresh()).state).toBe('plane-unreachable');
  });

  it('maps readiness values purely', () => {
    const ok: PlaneReadiness = {
      sandbox: 'ok',
      selftest: 'skipped',
      automount: 'disabled',
      interop: 'disabled',
      kernel: 'k',
      plans: ['p'],
      projects: ['x'],
    };
    expect(stateFromReadiness(ok)).toBe('ready'); // skipped is not a failure
    expect(stateFromReadiness({ ...ok, automount: 'unknown' })).toBe('hardening-drift');
    expect(stateFromReadiness({ ...ok, sandbox: 'unavailable' })).toBe('sandbox-unavailable');
  });
});

describe('project availability', () => {
  it('is false before the first probe, with a "being checked" reason', async () => {
    const { plane: p } = plane(fakeLauncher());
    await p.reloadConfig();
    expect(p.available(DESKTOP_PROJECT)).toBe(false);
    expect(p.reason(DESKTOP_PROJECT)).toBe(PLANE_REASONS.checking);
    await p.status(); // the background probe from available() shares this one
  });

  it('is ready only for a mapped project the plane knows', async () => {
    const { plane: p } = plane(fakeLauncher(), {
      settings: config({ [DESKTOP_PROJECT]: PLANE_PROJECT, other: 'missing-project' }),
    });
    await p.status();
    expect(p.available(DESKTOP_PROJECT)).toBe(true);
    expect(p.reason(DESKTOP_PROJECT)).toBeUndefined();
    expect(await p.projectStatus(DESKTOP_PROJECT)).toEqual({
      projectId: DESKTOP_PROJECT,
      state: 'ready',
      reason: PLANE_REASONS.ready,
      planeProject: PLANE_PROJECT,
    });

    expect(p.available('unmapped')).toBe(false);
    expect(p.reason('unmapped')).toBe(PLANE_REASONS['project-unmapped']);
    expect(await p.projectStatus('unmapped')).toMatchObject({ state: 'project-unmapped' });

    expect(p.available('other')).toBe(false);
    expect(p.reason('other')).toBe(PLANE_REASONS['project-unknown-to-plane']);
    expect(await p.projectStatus('other')).toMatchObject({
      state: 'project-unknown-to-plane',
      planeProject: 'missing-project',
    });
  });

  it('is unavailable with the plane-level reason when the plane is not ready', async () => {
    const { plane: p } = plane(fakeLauncher({ NEXAR_FAKE_PLANE_SCENARIO: 'hardening-drift' }));
    await p.status();
    expect(p.available(DESKTOP_PROJECT)).toBe(false);
    expect(p.reason(DESKTOP_PROJECT)).toBe(PLANE_REASONS['hardening-drift']);
  });

  it('does not treat prototype keys as mappings', async () => {
    const { plane: p } = plane(fakeLauncher());
    await p.status();
    for (const key of ['constructor', 'toString', '__proto__']) {
      expect(p.available(key)).toBe(false);
      expect(p.reason(key)).toBe(PLANE_REASONS['project-unmapped']);
    }
  });
});

describe('run', () => {
  it('commits: forwards safe progress, links the task and returns a fixed-format summary', async () => {
    const { plane: p } = plane(fakeLauncher());
    const rec = codeRequest();
    const result = await p.run(rec.request, new AbortController().signal);

    expect(result.taskId).toBe('task_fake_1');
    expect(result.engineering).toEqual({
      planeTaskId: 'task_fake_1',
      status: 'committed',
      branch: 'nexar/task-fake-1',
      commit: 'c'.repeat(40),
    });
    expect(result.text).toBe(
      [
        'The engineering changes were committed.',
        'Branch: nexar/task-fake-1',
        `Commit: ${'c'.repeat(12)}`,
        'Task: task_fake_1',
      ].join('\n'),
    );
    expect(rec.tasks).toEqual(['task_fake_1']);
    expect(rec.progress).toEqual([
      'Engineering task started',
      'Engineering lane started: implementation',
      'Quality gate completed',
    ]);
    expect(p.pendingApprovals()).toEqual([]);
    // The diff of the turn was retrieved on the run's own process before shutdown.
    expect(p.diff(SESSION, TURN)).toEqual({
      text: expect.stringContaining('diff --git') as string,
      truncated: false,
      files: ['a.txt', 'src/b.ts'],
    });
    const frames = await received();
    expect(frames).toEqual(['initialize', 'run', 'diff', 'shutdown']);
    await expect.poll(() => spawnedChildren().every((c) => c.exitCode !== null)).toBe(true);
  });

  it('sends the run frame with ids only: project mapping, goal, title, intent and lineage', async () => {
    const { plane: p } = plane(fakeLauncher());
    const goal = 'Session policy: mode=code; lane=code; project=demo\n\nDo the thing';
    await p.run(
      codeRequest({ goal, turnText: '\n  Do the thing\nwith care' }).request,
      new AbortController().signal,
    );
    const frames = (await readLog()).flatMap((e) => (e.frame === undefined ? [] : [e.frame]));
    expect(frames[0]).toEqual({
      type: 'initialize',
      protocol: 'nexar-plane/1',
      features: ['resources'],
    });
    expect(frames[1]).toEqual({
      type: 'run',
      runId: `run_${'1'.padStart(32, '0')}`,
      planeProject: PLANE_PROJECT,
      goal,
      title: 'Do the thing',
      intent: 'coding',
      lineage: { sessionId: SESSION, turnId: TURN, correlationId: TURN, depth: 0 },
    });
    expect(Object.keys(frames[1] as object).sort()).toEqual(
      ['goal', 'intent', 'lineage', 'planeProject', 'runId', 'title', 'type'].sort(),
    );
  });

  it('omits the title when the turn text has no visible line', async () => {
    const { plane: p } = plane(fakeLauncher());
    await p.run(codeRequest({ turnText: ' \n\t ' }).request, new AbortController().signal);
    const frames = (await readLog()).flatMap((e) => (e.frame === undefined ? [] : [e.frame]));
    expect(frames[1]).toMatchObject({ type: 'run', goal: 'Add a retry.' });
    expect(frames[1]).not.toHaveProperty('title');
  });

  it.each([
    [
      'not-accepted',
      'not-accepted',
      'The engineering changes were not accepted. Nothing was committed.',
    ],
    ['failed', 'failed', 'The engineering run did not complete. Nothing was committed.'],
  ] as const)('reports a %s outcome without committing', async (behavior, status, line) => {
    const { plane: p } = plane(fakeLauncher({ NEXAR_FAKE_PLANE_RUN: behavior }));
    const result = await p.run(codeRequest().request, new AbortController().signal);
    expect(result.engineering.status).toBe(status);
    expect(result.engineering.branch).toBeUndefined();
    expect(result.text.split('\n')[0]).toBe(line);
    expect(result.text).toMatch(/Reason: (gate\.failed|setup\.failed)/);
  });

  it('passes the lanes of a change run through', async () => {
    const { plane: p } = plane(fakeLauncher({ NEXAR_FAKE_PLANE_LANES: '1' }));
    const result = await p.run(codeRequest().request, new AbortController().signal);
    expect(result.engineering.lanes).toEqual([
      { role: 'implementation', resourceId: 'dsh:deepseek' },
      { role: 'review', resourceId: 'claude-code:sonnet' },
    ]);
  });

  it('passes the executor facts of a lane through, and omits them for an older plane', async () => {
    const { plane: p } = plane(
      fakeLauncher({ NEXAR_FAKE_PLANE_LANES: '1', NEXAR_FAKE_PLANE_LANE_FACTS: '1' }),
    );
    const result = await p.run(codeRequest().request, new AbortController().signal);
    expect(result.engineering.lanes).toEqual([
      {
        role: 'implementation',
        resourceId: 'dsh:deepseek',
        executor: 'engine',
        engine: 'dsh',
        controlResourceId: 'pi:deepseek-chat',
      },
      {
        role: 'review',
        resourceId: 'claude-code:sonnet',
        executor: 'native',
        executorReason: 'engine-not-selected',
      },
    ]);
  });

  it('runs a review: the report is the text, lanes pass through and no diff is requested', async () => {
    const { plane: p } = plane(fakeLauncher());
    const rec = codeRequest({ intent: 'review' });
    const result = await p.run(rec.request, new AbortController().signal);
    expect(result.engineering).toEqual({
      planeTaskId: 'task_fake_1',
      status: 'reported',
      lanes: [{ role: 'report', resourceId: 'dsh:deepseek' }],
    });
    expect(result.text).toContain('# Repository review');
    expect(result.textTruncated).toBeUndefined();
    expect(p.pendingApprovals()).toEqual([]);
    expect(p.diff(SESSION, TURN)).toBeUndefined();
    expect(await received()).toEqual(['initialize', 'run', 'shutdown']);
    expect(rec.tasks).toEqual(['task_fake_1']);
  });

  it('runs a plan: a plan intent frame, a reported outcome, no approval and no diff', async () => {
    const { plane: p } = plane(fakeLauncher());
    const rec = codeRequest({ intent: 'plan' });
    const result = await p.run(rec.request, new AbortController().signal);
    expect(result.engineering).toEqual({
      planeTaskId: 'task_fake_1',
      status: 'reported',
      lanes: [{ role: 'report', resourceId: 'dsh:deepseek' }],
    });
    expect(result.text).toContain('# Implementation plan');
    expect(p.pendingApprovals()).toEqual([]);
    expect(p.diff(SESSION, TURN)).toBeUndefined();
    const frames = await received();
    expect(frames).toEqual(['initialize', 'run', 'shutdown']);
    const run = (await readLog()).find((e) => e.event === 'frame' && e.type === 'run');
    expect(run?.frame).toMatchObject({ type: 'run', intent: 'plan' });
  });

  it('advertises plan support only for a ready plane that lists implementation-plan', async () => {
    const without = plane(fakeLauncher({ NEXAR_FAKE_PLANE_NO_PLAN: '1' }));
    expect(without.plane.supportsPlan()).toBe(false); // unknown before the first probe
    await without.plane.refresh();
    expect(without.plane.supportsPlan()).toBe(false);
    const withPlan = plane(fakeLauncher());
    await withPlan.plane.refresh();
    expect(withPlan.plane.supportsPlan()).toBe(true);
    const broken = plane(fakeLauncher({ NEXAR_FAKE_PLANE_SCENARIO: 'sandbox-unavailable' }));
    await broken.plane.refresh();
    expect(broken.plane.supportsPlan()).toBe(false);
  });
  it('keeps a report within the turn outcome limit and carries the truncation flag', async () => {
    const big = plane(fakeLauncher({ NEXAR_FAKE_PLANE_REPORT: 'big' }));
    const result = await big.plane.run(
      codeRequest({ intent: 'review' }).request,
      new AbortController().signal,
    );
    expect(result.text.length).toBeLessThanOrEqual(64 * 1024);
    const cut = plane(fakeLauncher({ NEXAR_FAKE_PLANE_REPORT: 'truncated' }));
    const flagged = await cut.plane.run(
      codeRequest({ intent: 'review' }).request,
      new AbortController().signal,
    );
    expect(flagged.textTruncated).toBe(true);
  });

  it('treats a reported outcome for a coding run as a protocol violation', async () => {
    const { plane: p } = plane(fakeLauncher({ NEXAR_FAKE_PLANE_RUN: 'reported' }));
    await expect(p.run(codeRequest().request, new AbortController().signal)).rejects.toMatchObject({
      code: 'INTERNAL_ERROR',
      message: 'The engineering plane sent an unexpected outcome',
    });
    expect(await received()).not.toContain('diff');
  });

  it('advertises report support only for a ready plane that lists repository-report', async () => {
    const without = plane(fakeLauncher({ NEXAR_FAKE_PLANE_NO_REPORT: '1' }));
    expect(without.plane.supportsReport()).toBe(false); // unknown before the first probe
    await without.plane.refresh();
    expect(without.plane.supportsReport()).toBe(false);
    const withPlan = plane(fakeLauncher());
    await withPlan.plane.refresh();
    expect(withPlan.plane.supportsReport()).toBe(true);
    const broken = plane(fakeLauncher({ NEXAR_FAKE_PLANE_SCENARIO: 'sandbox-unavailable' }));
    await broken.plane.refresh();
    expect(broken.plane.supportsReport()).toBe(false);
  });

  it('surfaces the plane refusing a review as a typed error with a fixed message', async () => {
    const { plane: p } = plane(fakeLauncher({ NEXAR_FAKE_PLANE_NO_REPORT: '1' }));
    await expect(
      p.run(codeRequest({ intent: 'review' }).request, new AbortController().signal),
    ).rejects.toMatchObject({
      code: 'POLICY_REJECTED',
      message: 'The engineering plane rejected the request',
    });
    await expect.poll(() => spawnedChildren().every((c) => c.exitCode !== null)).toBe(true);
  });

  it('rejects with the run error code when the plane reports one', async () => {
    const { plane: p } = plane(fakeLauncher({ NEXAR_FAKE_PLANE_RUN: 'error-run' }));
    await expect(p.run(codeRequest().request, new AbortController().signal)).rejects.toMatchObject({
      code: 'CONFLICT',
      message: 'The engineering plane is busy',
    });
  });

  it.each(['garbage', 'oversized-run'])(
    'ends the run and the process when the plane sends a %s frame mid-run',
    async (behavior) => {
      const { plane: p } = plane(fakeLauncher({ NEXAR_FAKE_PLANE_RUN: behavior }));
      await expect(
        p.run(codeRequest().request, new AbortController().signal),
      ).rejects.toMatchObject({
        code: 'INTEGRATION_UNAVAILABLE',
        message: 'The engineering plane sent an invalid message',
      });
      await expect
        .poll(() => spawnedChildren().every((c) => c.exitCode !== null || c.signalCode !== null), {
          timeout: 10_000,
        })
        .toBe(true);
    },
  );

  it('rejects a run that crashes mid-run and cleans up its approvals', async () => {
    const { plane: p } = plane(fakeLauncher({ NEXAR_FAKE_PLANE_RUN: 'crash' }));
    await expect(p.run(codeRequest().request, new AbortController().signal)).rejects.toMatchObject({
      code: 'INTEGRATION_UNAVAILABLE',
    });
    expect(p.pendingApprovals()).toEqual([]);
  });

  it('fails an unmapped project and an unknown plane project before running anything', async () => {
    const launcher = fakeLauncher();
    const { plane: p } = plane(launcher);
    await expect(
      p.run(codeRequest({ projectId: 'nobody' }).request, new AbortController().signal),
    ).rejects.toMatchObject({
      code: 'SANDBOX_UNAVAILABLE',
      message: PLANE_REASONS['project-unmapped'],
    });
    expect(launcher.launches).toBe(0);

    const unknown = plane(fakeLauncher(), { settings: config({ [DESKTOP_PROJECT]: 'ghost' }) });
    await expect(
      unknown.plane.run(codeRequest().request, new AbortController().signal),
    ).rejects.toMatchObject({
      code: 'SANDBOX_UNAVAILABLE',
      message: PLANE_REASONS['project-unknown-to-plane'],
    });
    expect(await received()).not.toContain('run');
  });

  it('refuses to run against a plane that is no longer ready', async () => {
    const { plane: p } = plane(fakeLauncher({ NEXAR_FAKE_PLANE_SCENARIO: 'hardening-drift' }));
    await expect(p.run(codeRequest().request, new AbortController().signal)).rejects.toMatchObject({
      code: 'SANDBOX_UNAVAILABLE',
      message: PLANE_REASONS['hardening-drift'],
    });
    expect(await received()).not.toContain('run');
  });

  it('refuses an already-aborted signal and limits concurrent runs', async () => {
    const launcher = fakeLauncher();
    const { plane: p } = plane(launcher);
    const aborted = AbortSignal.abort();
    await expect(p.run(codeRequest().request, aborted)).rejects.toMatchObject({
      code: 'EXECUTION_CANCELLED',
    });
    expect(launcher.launches).toBe(0);

    const busy = plane(fakeLauncher({ NEXAR_FAKE_PLANE_RUN: 'hang-run' }));
    const controller = new AbortController();
    const running = Array.from({ length: MAX_ACTIVE_RUNS }, (_unused, index) =>
      busy.plane.run(
        codeRequest({ turnId: `turn_${String(index + 3).repeat(32)}` }).request,
        controller.signal,
      ),
    );
    await expect
      .poll(async () => (await readLog()).filter((e) => e.type === 'run').length)
      .toBe(MAX_ACTIVE_RUNS);
    await expect(
      busy.plane.run(
        codeRequest({ turnId: `turn_${'9'.repeat(32)}` }).request,
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ code: 'POLICY_REJECTED' });
    controller.abort();
    await Promise.allSettled(running);
  });

  it('does not leak a goal, prompt or path into log lines', async () => {
    const { plane: p, log } = plane(fakeLauncher({ NEXAR_FAKE_PLANE_RUN: 'failed' }));
    await p.run(codeRequest({ goal: 'SECRET-GOAL-TEXT' }).request, new AbortController().signal);
    const logged = log.lines.join('\n');
    expect(logged).not.toContain('SECRET-GOAL-TEXT');
    expect(logged).not.toContain(dir);
  });
});

describe('plane approvals', () => {
  async function untilPending(p: CodePlane): Promise<void> {
    await expect.poll(() => p.pendingApprovals().length, { timeout: 15_000 }).toBe(1);
  }

  it('registers a pending approval, serves the diff before the decision, and approves it', async () => {
    const { plane: p } = plane(fakeLauncher({ NEXAR_FAKE_PLANE_RUN: 'approve' }));
    const rec = codeRequest();
    const running = p.run(rec.request, new AbortController().signal);
    await untilPending(p);

    const [approval] = p.pendingApprovals();
    expect(approval).toMatchObject({
      id: `apr_${'f'.repeat(32)}`,
      status: 'pending',
      risk: 'medium',
      actionType: 'engineering.commit',
      summary: 'Commit 2 files to branch nexar/task-fake-1; gates passed: 3; review: approve',
      fingerprint: 'a'.repeat(12),
      taskId: 'task_fake_1',
      projectId: DESKTOP_PROJECT,
      source: 'plane',
      sessionId: SESSION,
      turnId: TURN,
      plane: { branch: 'nexar/task-fake-1', files: 2, gatesPassed: 3, reviewVerdict: 'approve' },
    });
    expect(Date.parse(approval?.expiresAt ?? '') - Date.parse(approval?.createdAt ?? '')).toBe(
      60_000,
    );
    expect(p.owns(`apr_${'f'.repeat(32)}`)).toBe(true);
    expect(p.owns(`apr_${'e'.repeat(32)}`)).toBe(false);
    expect(rec.approvals).toEqual([`apr_${'f'.repeat(32)}`]);
    expect(rec.tasks).toEqual(['task_fake_1']);
    // The owner can review the diff while the approval is still pending.
    await expect.poll(() => p.diff(SESSION, TURN) !== undefined).toBe(true);

    const decided = await p.decide(`apr_${'f'.repeat(32)}`, 'approve');
    expect(decided).toMatchObject({ status: 'approved', decidedBy: 'desktop:tester' });
    expect(p.pendingApprovals()).toEqual([]);

    const result = await running;
    expect(result.engineering).toMatchObject({
      status: 'committed',
      approvalId: `apr_${'f'.repeat(32)}`,
      files: 2,
      gatesPassed: 3,
      reviewVerdict: 'approve',
    });
    expect(result.text).toContain('Files changed: 2');
    expect(result.text).toContain('Gates passed: 3');
    expect(result.text).toContain('Review verdict: approve');
    expect(await received()).toContain('decide');
  });

  it('denies a pending approval, which ends not-accepted', async () => {
    const { plane: p } = plane(fakeLauncher({ NEXAR_FAKE_PLANE_RUN: 'approve' }));
    const running = p.run(codeRequest().request, new AbortController().signal);
    await untilPending(p);
    const decided = await p.decide(`apr_${'f'.repeat(32)}`, 'deny');
    expect(decided.status).toBe('denied');
    const result = await running;
    expect(result.engineering.status).toBe('not-accepted');
    expect(result.engineering.approvalId).toBe(`apr_${'f'.repeat(32)}`);
    expect(result.text).toContain('Reason: owner-denied');
  });

  it('decides only a pending approval of an active run, once at a time', async () => {
    const { plane: p } = plane(fakeLauncher({ NEXAR_FAKE_PLANE_RUN: 'approve' }));
    await expect(p.decide(`apr_${'f'.repeat(32)}`, 'approve')).rejects.toMatchObject({
      code: 'VALIDATION_ERROR',
    });
    const running = p.run(codeRequest().request, new AbortController().signal);
    await untilPending(p);
    const id = `apr_${'f'.repeat(32)}`;
    const first = p.decide(id, 'approve');
    await expect(p.decide(id, 'deny')).rejects.toMatchObject({ code: 'CONFLICT' });
    await first;
    // Decided approvals are gone: nothing can be decided twice.
    await expect(p.decide(id, 'approve')).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    await running;
    expect((await received()).filter((t) => t === 'decide')).toHaveLength(1);
  });

  it('forgets a pending approval when its run is cancelled', async () => {
    const { plane: p } = plane(fakeLauncher({ NEXAR_FAKE_PLANE_RUN: 'approve' }));
    const controller = new AbortController();
    const running = p.run(codeRequest().request, controller.signal);
    await untilPending(p);
    controller.abort();
    await running.catch(() => undefined);
    expect(p.pendingApprovals()).toEqual([]);
    await expect(p.decide(`apr_${'f'.repeat(32)}`, 'approve')).rejects.toMatchObject({
      code: 'VALIDATION_ERROR',
    });
  });
});

describe('cancel and shutdown', () => {
  it('sends cancel then shutdown, accepts the cancelled outcome and the process ends', async () => {
    const { plane: p } = plane(fakeLauncher({ NEXAR_FAKE_PLANE_RUN: 'cancel-wait' }));
    const controller = new AbortController();
    const running = p.run(codeRequest().request, controller.signal);
    await expect.poll(async () => (await received()).includes('run')).toBe(true);
    controller.abort();
    const result = await running;
    expect(result.engineering.status).toBe('cancelled');
    const frames = await received();
    expect(frames.slice(-2)).toEqual(['cancel', 'shutdown']);
    await expect.poll(() => spawnedChildren().every((c) => c.exitCode !== null)).toBe(true);
  });

  it('ends the process tree when the plane ignores cancel', async () => {
    const { plane: p } = plane(fakeLauncher({ NEXAR_FAKE_PLANE_RUN: 'ignore-cancel' }), {
      timings: { cancelMs: 300, shutdownMs: 300 },
    });
    const controller = new AbortController();
    const running = p.run(codeRequest().request, controller.signal);
    await expect.poll(async () => (await received()).includes('run')).toBe(true);
    controller.abort();
    await expect(running).rejects.toMatchObject({ code: 'EXECUTION_CANCELLED' });
    await expect
      .poll(() => spawnedChildren().every((c) => c.exitCode !== null || c.signalCode !== null), {
        timeout: 10_000,
      })
      .toBe(true);
  });

  it('cancels during the handshake without sending a run', async () => {
    const { plane: p } = plane(fakeLauncher({ NEXAR_FAKE_PLANE_SCENARIO: 'hang' }));
    const controller = new AbortController();
    const running = p.run(codeRequest().request, controller.signal);
    await expect.poll(async () => (await readLog()).length).toBeGreaterThan(0);
    controller.abort();
    await expect(running).rejects.toMatchObject({ code: 'EXECUTION_CANCELLED' });
    expect(await received()).not.toContain('run');
  });

  it('dispose ends every active plane process', async () => {
    const { plane: p } = plane(fakeLauncher({ NEXAR_FAKE_PLANE_RUN: 'hang-run' }));
    const running = p.run(codeRequest().request, new AbortController().signal);
    await expect.poll(async () => (await received()).includes('run')).toBe(true);
    p.dispose();
    await expect(running).rejects.toMatchObject({ code: 'INTEGRATION_UNAVAILABLE' });
    await expect(p.run(codeRequest().request, new AbortController().signal)).rejects.toMatchObject({
      code: 'INTEGRATION_UNAVAILABLE',
    });
  });
});

describe('diffs', () => {
  it('keeps the bounded diff text and the truncation flag as the plane sent them', async () => {
    const { plane: p } = plane(fakeLauncher({ NEXAR_FAKE_PLANE_DIFF: 'big' }));
    await p.run(codeRequest().request, new AbortController().signal);
    const diff = p.diff(SESSION, TURN);
    expect(diff?.truncated).toBe(true);
    expect(diff?.text.length).toBeGreaterThan(100_000);
    expect(p.diff(SESSION, `turn_${'3'.repeat(32)}`)).toBeUndefined();
    expect(p.diff(`ses_${'3'.repeat(32)}`, TURN)).toBeUndefined();
  });

  it('keeps only the last diffs, oldest first out', async () => {
    const { plane: p } = plane(fakeLauncher());
    const turns = Array.from(
      { length: MAX_STORED_DIFFS + 1 },
      (_unused, index) => `turn_${index.toString(16).padStart(32, '0')}`,
    );
    for (const turnId of turns) {
      await p.run(codeRequest({ turnId }).request, new AbortController().signal);
    }
    expect(p.diff(SESSION, turns[0] as string)).toBeUndefined();
    for (const turnId of turns.slice(1)) expect(p.diff(SESSION, turnId)).toBeDefined();
  }, 120_000);

  it('does not request a diff for a failed run', async () => {
    const { plane: p } = plane(fakeLauncher({ NEXAR_FAKE_PLANE_RUN: 'failed' }));
    await p.run(codeRequest().request, new AbortController().signal);
    expect(await received()).not.toContain('diff');
    expect(p.diff(SESSION, TURN)).toBeUndefined();
  });
});

describe('progress lines', () => {
  it('are built from constants and only identifier-shaped roles', () => {
    expect(
      progressLine({ type: 'step', step: 'commit.created', detail: { path: '/etc/passwd' } }),
    ).toEqual({
      type: 'status',
      message: 'Changes committed',
    });
    expect(
      progressLine({ type: 'lane.started', lane: '/home/x', role: 'review', round: 1 }),
    ).toEqual({ type: 'progress', message: 'Engineering lane started: review' });
    expect(
      progressLine({ type: 'lane.started', lane: 'l', role: 'C:\\secret dir\\x', round: 0 }),
    ).toEqual({ type: 'progress', message: 'Engineering lane started' });
    expect(
      progressLine({
        type: 'awaiting-approval',
        taskId: 't',
        projectId: 'p',
        branch: '/secret/branch',
        baseCommit: 'a'.repeat(40),
        patchSha256: 'a'.repeat(64),
        files: 1,
        gatesPassed: 1,
        reviewVerdict: 'approve',
        ttlMs: 1,
      }),
    ).toEqual({ type: 'status', message: 'Waiting for your approval' });
  });
});

describe('launchers', () => {
  it('launches wsl.exe shell-free with fixed arguments and only SystemRoot in the environment', () => {
    const calls: { file: string; args: readonly string[]; options: Record<string, unknown> }[] = [];
    const fakeSpawn = ((
      file: string,
      args: readonly string[],
      options: Record<string, unknown>,
    ) => {
      calls.push({ file, args, options });
      return {} as ChildProcess;
    }) as unknown as typeof spawn;
    const launcher = createWslLauncher({
      spawnImpl: fakeSpawn,
      systemRoot: 'C:\\Windows',
      platform: 'win32',
    });
    launcher({ distro: 'nexar-plane', command: '/usr/local/bin/nexar' });

    expect(calls).toHaveLength(1);
    const [call] = calls;
    expect(call?.file).toBe('C:\\Windows\\System32\\wsl.exe');
    expect(call?.args).toEqual([
      '-d',
      'nexar-plane',
      '--exec',
      '/usr/local/bin/nexar',
      'plane',
      'serve',
      '--stdio',
    ]);
    expect(call?.options['env']).toEqual({ SystemRoot: 'C:\\Windows' });
    expect(call?.options['shell']).toBe(false);
    expect(call?.options['windowsHide']).toBe(true);
    expect(call?.options['stdio']).toEqual(['pipe', 'pipe', 'pipe']);
    expect(planeLaunchArguments({ distro: 'd', command: '/c' })).toEqual([
      '-d',
      'd',
      '--exec',
      '/c',
      'plane',
      'serve',
      '--stdio',
    ]);
  });

  it('never forwards Desktop environment, WSLENV or credentials', () => {
    process.env['NEXAR_TEST_SECRET'] = 'hunter2';
    process.env['WSLENV'] = 'NEXAR_TEST_SECRET/u';
    try {
      const seen: Record<string, unknown>[] = [];
      const fakeSpawn = ((_f: string, _a: string[], options: Record<string, unknown>) => {
        seen.push(options);
        return {} as ChildProcess;
      }) as unknown as typeof spawn;
      createWslLauncher({ spawnImpl: fakeSpawn, systemRoot: 'C:\\Windows', platform: 'win32' })({
        distro: 'nexar-plane',
        command: '/usr/local/bin/nexar',
      });
      expect(JSON.stringify(seen)).not.toContain('hunter2');
      expect(JSON.stringify(seen)).not.toContain('WSLENV');
      expect(Object.keys(seen[0]?.['env'] as object)).toEqual(['SystemRoot']);
    } finally {
      delete process.env['NEXAR_TEST_SECRET'];
      delete process.env['WSLENV'];
    }
  });

  it('is unavailable off Windows or without an absolute SystemRoot', () => {
    const target = { distro: 'nexar-plane', command: '/usr/local/bin/nexar' };
    expect(() =>
      createWslLauncher({ platform: 'linux', systemRoot: 'C:\\Windows' })(target),
    ).toThrow(NexarError);
    expect(() => createWslLauncher({ platform: 'win32', systemRoot: undefined })(target)).toThrow(
      NexarError,
    );
    expect(() => createWslLauncher({ platform: 'win32', systemRoot: 'Windows' })(target)).toThrow(
      NexarError,
    );
  });

  it('the test-seam launcher passes only SystemRoot and fake-plane selectors', () => {
    const seen: { file: string; args: readonly string[]; env: Record<string, string> }[] = [];
    const fakeSpawn = ((
      file: string,
      args: readonly string[],
      options: { env: Record<string, string> },
    ) => {
      seen.push({ file, args, env: options.env });
      return {} as ChildProcess;
    }) as unknown as typeof spawn;
    createScriptLauncher(
      FAKE_PLANE,
      {
        SystemRoot: 'C:\\Windows',
        NEXAR_FAKE_PLANE_SCENARIO: 'healthy',
        API_KEY: 'secret',
        WSLENV: 'x',
      },
      fakeSpawn,
    )({ distro: 'ignored', command: '/ignored' });
    expect(seen[0]?.file).toBe(process.execPath);
    expect(seen[0]?.args).toEqual([FAKE_PLANE]);
    expect(seen[0]?.env).toEqual({
      ELECTRON_RUN_AS_NODE: '1',
      SystemRoot: 'C:\\Windows',
      NEXAR_FAKE_PLANE_SCENARIO: 'healthy',
    });
  });

  it('the fake plane starts with no credentials of ours in its environment', async () => {
    process.env['NEXAR_TEST_SECRET'] = 'hunter2';
    try {
      const { plane: p } = plane(fakeLauncher());
      await p.refresh();
    } finally {
      delete process.env['NEXAR_TEST_SECRET'];
    }
    const start = (await readLog()).find((e) => e.event === 'start');
    expect(start?.env).not.toContain('NEXAR_TEST_SECRET');
  });
});
