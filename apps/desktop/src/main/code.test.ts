import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type {
  ApprovalDto,
  CodeDiffDto,
  DesktopSettings,
  PlaneStatusDto,
  SessionDto,
  SubmitTurnResult,
  TurnDto,
} from '../shared/api.js';
import { CHANNELS } from '../shared/channels.js';
import { createBridge } from './bridge.js';
import { CodePlane, PLANE_REASONS, type PlaneTimings } from './code-plane.js';
import { fakePlaneLauncher, type FakePlaneLauncher } from './fake-plane-launcher.js';
import { addProject, createHarness, type Harness } from './test-harness.js';

const KEYS = ['a', 'b', 'c', 'd', 'e', 'f'].map((c) => c.repeat(32));
const APPROVAL = `apr_${'f'.repeat(32)}`;
const TIMINGS: Partial<PlaneTimings> = {
  handshakeMs: 15_000,
  shutdownMs: 1_500,
  cancelMs: 1_500,
  requestMs: 4_000,
};

let h: Harness;
let projectId: string;
let launchers: FakePlaneLauncher[];

beforeEach(async () => {
  h = await createHarness();
  projectId = await addProject(h);
  launchers = [];
});

afterEach(async () => {
  for (const launcher of launchers) {
    for (const child of launcher.children) if (child.exitCode === null) child.kill('SIGKILL');
  }
  await h.cleanup();
});

/** A second bridge over the harness' dependencies with a Code lane on the fake plane. */
async function withPlane(
  env: Record<string, string> = {},
  options: { mapped?: boolean } = {},
): Promise<{
  readonly call: Harness['call'];
  readonly codePlane: CodePlane;
  readonly launcher: FakePlaneLauncher;
}> {
  if (options.mapped !== false) await h.deps.settings.setPlaneProject(projectId, 'plane-proj');
  const launcher = fakePlaneLauncher(env);
  launchers.push(launcher);
  const codePlane = new CodePlane({
    settings: h.deps.settings,
    launcher,
    logger: h.deps.logger,
    decider: 'desktop:test',
    timings: TIMINGS,
  });
  const bridge = createBridge({ ...h.deps, codePlane });
  return {
    codePlane,
    launcher,
    call: (channel, args = {}) =>
      bridge.invoke(channel, args, (event) => h.events.push(event)) as Promise<never>,
  };
}

async function createSession(call: Harness['call'], mode: 'code' | 'cowork'): Promise<SessionDto> {
  const result = await call<SessionDto>(CHANNELS.sessionsCreate, { projectId, mode });
  if (!result.ok) throw new Error(`sessions:create failed: ${result.error.code}`);
  return result.value;
}

async function submit(
  call: Harness['call'],
  sessionId: string,
  text: string,
  key: string = KEYS[0] as string,
) {
  return call<SubmitTurnResult>(CHANNELS.sessionsSubmitTurn, {
    sessionId,
    submissionKey: key,
    text,
  });
}

async function fetchSession(call: Harness['call'], sessionId: string): Promise<SessionDto> {
  const result = await call<SessionDto>(CHANNELS.sessionsGet, { sessionId });
  if (!result.ok) throw new Error(`sessions:get failed: ${result.error.code}`);
  return result.value;
}

async function settled(call: Harness['call'], sessionId: string): Promise<SessionDto> {
  await expect
    .poll(async () => (await fetchSession(call, sessionId)).active, { timeout: 20_000 })
    .toBe(false);
  return fetchSession(call, sessionId);
}

const listApprovals = async (call: Harness['call']): Promise<readonly ApprovalDto[]> => {
  const result = await call<readonly ApprovalDto[]>(CHANNELS.approvalsList);
  if (!result.ok) throw new Error('approvals:list failed');
  return result.value;
};

const turnOf = (session: SessionDto, index = 0): TurnDto => session.turns[index] as TurnDto;

describe('Code lane channels: schemas', () => {
  it('rejects anything but ids: no distro, command, args, env or paths', async () => {
    const bad: [string, unknown][] = [
      [CHANNELS.codeStatus, { distro: 'evil' }],
      [CHANNELS.codeStatus, { command: '/bin/sh' }],
      [CHANNELS.codeStatus, { projectId: 'p', args: ['-c', 'x'] }],
      [CHANNELS.codeStatus, { projectId: 5 }],
      [CHANNELS.codeRefresh, { env: { WSLENV: 'x' } }],
      [CHANNELS.codeRefresh, { projectId: '../x' }],
      [CHANNELS.codeSetPlaneProject, { projectId }],
      [CHANNELS.codeSetPlaneProject, { projectId, planeProject: '../../etc/passwd' }],
      [CHANNELS.codeSetPlaneProject, { projectId, planeProject: 'C:\\repo' }],
      [CHANNELS.codeSetPlaneProject, { projectId, planeProject: '/home/me/repo' }],
      [CHANNELS.codeSetPlaneProject, { projectId, planeProject: 'has space' }],
      [CHANNELS.codeSetPlaneProject, { projectId, planeProject: 'ok', distro: 'x' }],
      [CHANNELS.codeSetPlaneProject, { projectId, planeProject: 'ok', command: '/bin/sh' }],
      [CHANNELS.codeSetPlaneProject, { projectId, planeProject: 'ok', path: '/tmp' }],
      [CHANNELS.codeSetPlaneProject, { projectId: 'Bad Id', planeProject: 'ok' }],
      [CHANNELS.codeSetPlaneProject, { projectId, planeProject: 'a'.repeat(129) }],
      [CHANNELS.codeDiff, { sessionId: 'ses_x', turnId: `turn_${'1'.repeat(32)}` }],
      [CHANNELS.codeDiff, { sessionId: `ses_${'1'.repeat(32)}`, turnId: '../../x' }],
      [
        CHANNELS.codeDiff,
        { sessionId: `ses_${'1'.repeat(32)}`, turnId: `turn_${'1'.repeat(32)}`, path: '/etc' },
      ],
    ];
    const { call, launcher } = await withPlane();
    for (const [channel, args] of bad) {
      const result = await call(channel, args);
      expect(result.ok, `${channel} ${JSON.stringify(args)}`).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('VALIDATION_ERROR');
        expect(result.error.message).not.toContain('/etc/passwd');
      }
    }
    expect(launcher.launches).toBe(0);
  });

  it('reports a clear error when the Code lane is not wired into this session', async () => {
    for (const [channel, args] of [
      [CHANNELS.codeStatus, {}],
      [CHANNELS.codeRefresh, {}],
      [CHANNELS.codeSetPlaneProject, { projectId, planeProject: 'p' }],
      [CHANNELS.codeDiff, { sessionId: `ses_${'1'.repeat(32)}`, turnId: `turn_${'1'.repeat(32)}` }],
    ] as const) {
      const result = await h.call(channel, args);
      expect(result).toMatchObject({ ok: false, error: { code: 'CONFLICT' } });
    }
  });
});

describe('Code lane channels: status and mapping', () => {
  it('reports the plane status and the per-project state', async () => {
    const { call, launcher } = await withPlane();
    const status = await call<PlaneStatusDto>(CHANNELS.codeStatus, { projectId });
    expect(status).toMatchObject({
      ok: true,
      value: {
        state: 'ready',
        reason: PLANE_REASONS.ready,
        planeVersion: '0.0.0-fake',
        projects: ['plane-proj'],
        project: { projectId, state: 'ready', planeProject: 'plane-proj' },
      },
    });
    // Cached for the window; `code:refresh` forces a new probe.
    await call(CHANNELS.codeStatus, {});
    expect(launcher.launches).toBe(1);
    await call(CHANNELS.codeRefresh, { projectId });
    expect(launcher.launches).toBe(2);
    // No path, distro or command anywhere in what the renderer receives.
    const text = JSON.stringify(status);
    expect(text).not.toContain('nexar-plane');
    expect(text).not.toContain('/usr/local/bin');
  });

  it('answers an unmapped or unknown project with the specific state and reason', async () => {
    const { call } = await withPlane({}, { mapped: false });
    expect(await call(CHANNELS.codeStatus, { projectId })).toMatchObject({
      ok: true,
      value: {
        state: 'ready',
        project: { state: 'project-unmapped', reason: PLANE_REASONS['project-unmapped'] },
      },
    });
    const mapped = await call<PlaneStatusDto>(CHANNELS.codeSetPlaneProject, {
      projectId,
      planeProject: 'ghost',
    });
    expect(mapped).toMatchObject({
      ok: true,
      value: { project: { state: 'project-unknown-to-plane', planeProject: 'ghost' } },
    });
    const ready = await call<PlaneStatusDto>(CHANNELS.codeSetPlaneProject, {
      projectId,
      planeProject: 'plane-proj',
    });
    expect(ready).toMatchObject({ ok: true, value: { project: { state: 'ready' } } });
    const removed = await call<PlaneStatusDto>(CHANNELS.codeSetPlaneProject, {
      projectId,
      planeProject: null,
    });
    expect(removed).toMatchObject({ ok: true, value: { project: { state: 'project-unmapped' } } });
  });

  it('rejects an unknown Desktop project', async () => {
    const { call } = await withPlane();
    expect(await call(CHANNELS.codeStatus, { projectId: 'nope' })).toMatchObject({ ok: false });
    expect(
      await call(CHANNELS.codeSetPlaneProject, { projectId: 'nope', planeProject: 'p' }),
    ).toMatchObject({ ok: false });
  });

  it('persists only the mapping: the owner-written distro and command stay as written', async () => {
    const path = join(h.userData, 'desktop-settings.json');
    await mkdir(h.userData, { recursive: true });
    await writeFile(
      path,
      JSON.stringify({
        theme: 'forest',
        density: 'compact',
        mode: 'code',
        codePlane: { distro: 'my-distro', command: '/opt/nexar/bin/nexar', projects: {} },
      }),
    );
    const { call, launcher } = await withPlane({}, { mapped: false });
    await call(CHANNELS.codeSetPlaneProject, { projectId, planeProject: 'plane-proj' });
    expect(JSON.parse(await readFile(path, 'utf8'))).toEqual({
      theme: 'forest',
      density: 'compact',
      mode: 'code',
      codePlane: {
        distro: 'my-distro',
        command: '/opt/nexar/bin/nexar',
        projects: { [projectId]: 'plane-proj' },
      },
    });
    await call(CHANNELS.codeRefresh, {});
    expect(launcher.targets.length).toBeGreaterThan(0);
    for (const target of launcher.targets) {
      expect(target).toEqual({ distro: 'my-distro', command: '/opt/nexar/bin/nexar' });
    }

    // The renderer's own settings never expose the section and cannot change it.
    const settings = await call<DesktopSettings>(CHANNELS.settingsGet);
    expect(settings).toEqual({
      ok: true,
      value: { theme: 'forest', density: 'compact', mode: 'code' },
    });
    await call(CHANNELS.settingsSet, { theme: 'dark' });
    expect(JSON.parse(await readFile(path, 'utf8'))).toMatchObject({
      theme: 'dark',
      codePlane: { distro: 'my-distro', command: '/opt/nexar/bin/nexar' },
    });
    expect(await call(CHANNELS.settingsSet, { codePlane: { distro: 'x' } })).toMatchObject({
      ok: false,
      error: { code: 'VALIDATION_ERROR' },
    });
  });

  it('fails closed on a damaged owner section and never rewrites it', async () => {
    const path = join(h.userData, 'desktop-settings.json');
    await mkdir(h.userData, { recursive: true });
    const damaged = JSON.stringify({
      theme: 'light',
      density: 'comfortable',
      mode: 'cowork',
      codePlane: { distro: 'bad distro; rm -rf', command: 'relative/nexar' },
    });
    await writeFile(path, damaged);
    const { call, launcher } = await withPlane({}, { mapped: false });
    expect(await call(CHANNELS.codeStatus, {})).toMatchObject({
      ok: true,
      value: { state: 'plane-missing', reason: PLANE_REASONS['settings-invalid'] },
    });
    expect(
      await call(CHANNELS.codeSetPlaneProject, { projectId, planeProject: 'p' }),
    ).toMatchObject({ ok: false, error: { code: 'CONFIGURATION_ERROR' } });
    expect(launcher.launches).toBe(0);
    await call(CHANNELS.settingsSet, { theme: 'dark' });
    expect(JSON.parse(await readFile(path, 'utf8'))).toMatchObject({
      codePlane: { distro: 'bad distro; rm -rf', command: 'relative/nexar' },
    });
  });

  it('serves no diff before any run', async () => {
    const { call } = await withPlane();
    expect(
      await call(CHANNELS.codeDiff, {
        sessionId: `ses_${'1'.repeat(32)}`,
        turnId: `turn_${'1'.repeat(32)}`,
      }),
    ).toMatchObject({ ok: false, error: { code: 'VALIDATION_ERROR' } });
  });
});

describe('Code lane through sessions', () => {
  it('runs a coding turn on the plane and records the engineering outcome and the diff', async () => {
    const { call, codePlane, launcher } = await withPlane();
    await codePlane.refresh();
    const session = await createSession(call, 'code');
    const sent = await submit(call, session.id, 'Please implement the retry logic.');
    expect(sent).toMatchObject({ ok: true, value: { action: 'run' } });
    const done = await settled(call, session.id);
    const turn = turnOf(done);

    expect(turn.state).toBe('succeeded');
    expect(turn.lane).toMatchObject({ requestedLane: 'code', effectiveLane: 'code' });
    expect(turn.tasks).toEqual([{ taskId: 'task_fake_1', state: 'succeeded' }]);
    expect(turn.outcome?.engineering).toEqual({
      planeTaskId: 'task_fake_1',
      status: 'committed',
      branch: 'nexar/task-fake-1',
      commit: 'c'.repeat(40),
    });
    expect(turn.outcome?.text).toContain('The engineering changes were committed.');
    expect(turn.outcome?.text).not.toContain('diff --git');
    expect(launcher.launches).toBeGreaterThanOrEqual(2); // the probe and the run

    const diff = await call<CodeDiffDto>(CHANNELS.codeDiff, {
      sessionId: session.id,
      turnId: turn.id,
    });
    expect(diff).toMatchObject({
      ok: true,
      value: { truncated: false, files: ['a.txt', 'src/b.ts'] },
    });
    // Another turn's diff is not available.
    expect(
      await call(CHANNELS.codeDiff, { sessionId: session.id, turnId: `turn_${'7'.repeat(32)}` }),
    ).toMatchObject({ ok: false, error: { code: 'VALIDATION_ERROR' } });
    // The goal reached the plane as the context prompt (untrusted wrapper), with the manifest recorded.
    const stored = await h.sessionStore.get(session.id);
    expect(stored?.turns[0]?.context?.policy).toBe('context@1/code-goal:context');
  });

  it('shows plane approvals in the Approvals surface and decides them on the plane', async () => {
    const { call, codePlane } = await withPlane({ NEXAR_FAKE_PLANE_RUN: 'approve' });
    await codePlane.refresh();
    const session = await createSession(call, 'code');
    await submit(call, session.id, 'Please implement the retry logic.');

    await expect
      .poll(async () => (await listApprovals(call)).filter((a) => a.source === 'plane').length, {
        timeout: 20_000,
      })
      .toBe(1);
    const approval = (await listApprovals(call)).find((a) => a.source === 'plane') as ApprovalDto;
    expect(approval).toMatchObject({
      id: APPROVAL,
      status: 'pending',
      actionType: 'engineering.commit',
      source: 'plane',
      sessionId: session.id,
      projectId,
      plane: { files: 2, gatesPassed: 3, reviewVerdict: 'approve' },
    });
    // The owner's own approval store never holds it.
    expect(await h.engine.approvals().list()).toEqual([]);
    // The turn links it, and its diff can be reviewed before deciding.
    const turnId = approval.turnId as string;
    await expect
      .poll(async () => (await h.sessionStore.get(session.id))?.turns[0]?.approvalIds)
      .toEqual([APPROVAL]);
    await expect
      .poll(async () => (await call(CHANNELS.codeDiff, { sessionId: session.id, turnId })).ok)
      .toBe(true);

    const approved = await call<ApprovalDto>(CHANNELS.approvalsApprove, { id: APPROVAL });
    expect(approved).toMatchObject({
      ok: true,
      value: { status: 'approved', source: 'plane', decidedBy: 'desktop:test' },
    });
    const turn = turnOf(await settled(call, session.id));
    expect(turn.state).toBe('succeeded');
    expect(turn.outcome?.engineering).toMatchObject({ status: 'committed', approvalId: APPROVAL });
    expect(await listApprovals(call)).toEqual([]);
    // Decided exactly once; a second decision finds nothing to decide.
    expect(await call(CHANNELS.approvalsApprove, { id: APPROVAL })).toMatchObject({ ok: false });
  });

  it('denies a plane approval through approvals:deny: the turn ends not accepted', async () => {
    const { call, codePlane } = await withPlane({ NEXAR_FAKE_PLANE_RUN: 'approve' });
    await codePlane.refresh();
    const session = await createSession(call, 'code');
    await submit(call, session.id, 'Please implement the retry logic.');
    await expect.poll(async () => (await listApprovals(call)).length, { timeout: 20_000 }).toBe(1);
    expect(await call<ApprovalDto>(CHANNELS.approvalsDeny, { id: APPROVAL })).toMatchObject({
      ok: true,
      value: { status: 'denied' },
    });
    const turn = turnOf(await settled(call, session.id));
    expect(turn.state).toBe('failed');
    expect(turn.outcome?.error).toEqual({
      code: 'POLICY_REJECTED',
      message: 'The engineering changes were not accepted',
    });
    expect(turn.outcome?.engineering?.status).toBe('not-accepted');
    expect(turn.tasks[0]?.state).toBe('failed');
  });

  it('leaves unknown approval ids to Desktop’s own store', async () => {
    const { call } = await withPlane();
    const result = await call(CHANNELS.approvalsApprove, { id: `apr_${'1'.repeat(32)}` });
    expect(result.ok).toBe(false);
  });

  it('refuses an engineering write with the specific reason when the project is unmapped', async () => {
    const { call, codePlane } = await withPlane({}, { mapped: false });
    await codePlane.refresh();
    const session = await createSession(call, 'code');
    const sent = await submit(call, session.id, 'Please implement the retry logic.');
    expect(sent).toMatchObject({ ok: true, value: { action: 'refuse' } });
    const turn = turnOf(await fetchSession(call, session.id));
    expect(turn.state).toBe('failed');
    expect(turn.outcome?.error).toEqual({
      code: 'SANDBOX_UNAVAILABLE',
      message: `Engineering changes need the Code lane (WSL2 engineering plane), which is not available yet. (${PLANE_REASONS['project-unmapped']})`,
    });
  });

  it.each([
    ['hardening-drift', PLANE_REASONS['hardening-drift']],
    ['sandbox-unavailable', PLANE_REASONS['sandbox-unavailable']],
  ] as const)('refuses with the plane-level reason (%s)', async (scenario, reason) => {
    const { call, codePlane } = await withPlane({ NEXAR_FAKE_PLANE_SCENARIO: scenario });
    await codePlane.refresh();
    const session = await createSession(call, 'code');
    await submit(call, session.id, 'Please implement the retry logic.');
    const turn = turnOf(await fetchSession(call, session.id));
    expect(turn.outcome?.error?.message).toMatch(new RegExp(`\\(${reason}\\)$`));
  });

  it('keeps the router message when the lane is still being checked', async () => {
    const { call } = await withPlane({ NEXAR_FAKE_PLANE_SCENARIO: 'hang' });
    const session = await createSession(call, 'code');
    await submit(call, session.id, 'Please implement the retry logic.');
    const turn = turnOf(await fetchSession(call, session.id));
    expect(turn.outcome?.error?.code).toBe('SANDBOX_UNAVAILABLE');
    expect(turn.outcome?.error?.message).toContain(PLANE_REASONS.checking);
  });

  it('never turns a non-engineering turn into an engineering write', async () => {
    const { call, codePlane, launcher } = await withPlane();
    await codePlane.refresh();
    const before = launcher.launches;
    const session = await createSession(call, 'code');
    await submit(call, session.id, 'Explain how the retry works');
    const turn = turnOf(await settled(call, session.id));
    expect(turn.state).toBe('succeeded');
    expect(turn.tasks[0]?.resourceId).toBeDefined(); // the NRC-routed direct task
    expect(launcher.launches).toBe(before); // the plane was never launched
  });

  it('confirming a lane changes nothing about permissions or the session mode', async () => {
    const { call, codePlane } = await withPlane();
    await codePlane.refresh();
    const session = await createSession(call, 'cowork');
    const sent = await submit(call, session.id, 'Please implement the retry logic.');
    expect(sent).toMatchObject({ ok: true, value: { action: 'confirm' } });
    const pending = (sent as { value: SubmitTurnResult }).value.turn;
    expect(pending.state).toBe('pending-confirmation');
    expect((await listApprovals(call)).length).toBe(0);

    const confirmed = await call<TurnDto>(CHANNELS.sessionsConfirmLane, {
      sessionId: session.id,
      turnId: pending.id,
      decision: 'confirm',
    });
    expect(confirmed.ok).toBe(true);
    const done = await settled(call, session.id);
    expect(done.mode).toBe('cowork');
    expect(turnOf(done).lane).toMatchObject({ confirmed: true, effectiveLane: 'code' });
    // The plane still ran the write plan; the only approval is the plane's own (none pending here:
    // the fake commits without one) and Desktop's store gained nothing.
    expect(await h.engine.approvals().list()).toEqual([]);
  });

  it('cancels a running plane turn: cancel frame, turn cancelled, process gone', async () => {
    const { call, codePlane, launcher } = await withPlane({ NEXAR_FAKE_PLANE_RUN: 'cancel-wait' });
    await codePlane.refresh();
    const session = await createSession(call, 'code');
    const sent = await submit(call, session.id, 'Please implement the retry logic.');
    const turnId = (sent as { value: SubmitTurnResult }).value.turn.id;
    // The run frame has been handled once the plane's first progress line arrives.
    await expect
      .poll(() => h.sessionEvents.some((e) => e.message === 'Engineering task started'), {
        timeout: 20_000,
      })
      .toBe(true);
    expect(await call(CHANNELS.sessionsCancel, { sessionId: session.id, turnId })).toMatchObject({
      ok: true,
      value: { cancelled: true },
    });
    const turn = turnOf(await settled(call, session.id));
    expect(turn.state).toBe('cancelled');
    await expect
      .poll(() => launcher.children.every((child) => child.exitCode !== null), { timeout: 10_000 })
      .toBe(true);
  });

  it('runs a review turn direct, recorded as such, while report-only plans do not exist', async () => {
    const { call, codePlane } = await withPlane();
    await codePlane.refresh();
    const session = await createSession(call, 'code');
    const sent = await submit(call, session.id, 'Review the code in this repository.');
    expect(sent).toMatchObject({ ok: true, value: { action: 'run' } });
    const turn = turnOf(await settled(call, session.id));
    expect(turn.state).toBe('succeeded');
    expect(turn.lane).toMatchObject({
      requestedLane: 'code',
      effectiveLane: 'direct',
      fallbackReason: 'code-report-unavailable',
    });
    expect(turn.outcome?.engineering).toBeUndefined();
  });

  it('fails the turn when the plane process crashes mid-run', async () => {
    const { call, codePlane } = await withPlane({ NEXAR_FAKE_PLANE_RUN: 'crash' });
    await codePlane.refresh();
    const session = await createSession(call, 'code');
    await submit(call, session.id, 'Please implement the retry logic.');
    const turn = turnOf(await settled(call, session.id));
    expect(turn.state).toBe('failed');
    expect(turn.outcome?.error?.code).toBe('INTEGRATION_UNAVAILABLE');
    expect(await listApprovals(call)).toEqual([]);
  });

  it('a second submission with the same key starts no second plane run', async () => {
    const { call, codePlane, launcher } = await withPlane();
    await codePlane.refresh();
    const session = await createSession(call, 'code');
    await submit(call, session.id, 'Please implement the retry logic.');
    await settled(call, session.id);
    const launches = launcher.launches;
    const again = await submit(call, session.id, 'Please implement the retry logic.');
    expect(again).toMatchObject({ ok: true, value: { created: false } });
    expect(launcher.launches).toBe(launches);
  });
});
