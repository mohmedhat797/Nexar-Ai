import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ElectronApplication, Page } from 'playwright-core';
import { afterAll, beforeAll, describe, expect, it, onTestFailed } from 'vitest';
import {
  POLL,
  addProject,
  createHarness,
  hasText,
  dshEnv,
  hasDsh,
  isVisible,
  seedE2EConfig,
  type Harness,
} from './harness.js';
import { SOW_UNITS as SOW_UNIT_SCRIPT, startModel, type FakeModel } from './dsh-model.js';

/*
 * NXR-066 (part a): ADR-027 end to end, offline. Fakes only: OpenAI-compatible model servers on
 * loopback, the real DeepSeek Harness runtime (`NEXAR_DSH_ENTRY`; those scenarios skip without it)
 * and the fake engineering plane. Nothing here calls
 * a real service; the owner's live acceptance is a separate step.
 */

const FAKE_PLANE = fileURLToPath(
  new URL('../../../tests/fixtures/fake-plane.mjs', import.meta.url),
);
const SOW_PROMPT = 'Create a professional SOW using this project.';
const REVIEW_PROMPT = 'Now verify whether the repository implementation supports this proposal.';
const IMPLEMENT_PROMPT = 'Implement the missing part.';
/** What the scripted control model puts in the arguments of a delegated unit (never in a record). */
const FAKE_ARGUMENT = 'Unit extract, working from';
const COMMIT_SHORT = 'c'.repeat(12);
const BRANCH = 'nexar/task-fake-1';
const SOW_UNITS = SOW_UNIT_SCRIPT.map((u) => u.unitId);
const SOW_TIMEOUT = 240_000;

let harness: Harness;
const models: FakeModel[] = [];

beforeAll(async () => {
  harness = await createHarness();
});

afterAll(async () => {
  await Promise.all(models.map((m) => m.close()));
  await harness.dispose();
});

/** The seeded resources: a control resource (declares tool calling) and a second work resource. */
async function seedModels(userData: string): Promise<{ control: FakeModel; work: FakeModel }> {
  const control = await startModel('control-model', { kind: 'sow' }, models);
  const work = await startModel('work-model', undefined, models);
  await seedE2EConfig(userData, [
    { id: 'e2e-control', kind: 'openai-compatible', baseUrl: control.baseUrl, toolCalling: true },
    { id: 'e2e-work', kind: 'openai-compatible', baseUrl: work.baseUrl, toolCalling: false },
  ]);
  return { control, work };
}

// --- persisted records ----------------------------------------------------------------------------

interface RecordedUnit {
  readonly unitId: string;
  readonly resourceId?: string;
  readonly outcome: string;
}

interface RecordedLane {
  readonly role: string;
  readonly resourceId: string;
  readonly executor?: string;
  readonly engine?: string;
  readonly executorReason?: string;
  readonly controlResourceId?: string;
}

interface RecordedTurn {
  readonly text: string;
  readonly state: string;
  readonly lane?: { readonly effectiveLane: string; readonly fallbackReason?: string };
  readonly tasks: readonly {
    readonly taskId: string;
    readonly resourceId?: string;
    readonly policyId?: string;
    readonly control?: {
      readonly path: string;
      readonly resourceId?: string;
      readonly restarts?: number;
    };
    readonly delegations?: readonly RecordedUnit[];
  }[];
  readonly outcome?: {
    readonly engineering?: { readonly status: string; readonly lanes?: readonly RecordedLane[] };
  };
}

/** The turns of the only persisted session under the E2E user-data directory, in order. */
async function recordedTurns(userData: string): Promise<readonly RecordedTurn[]> {
  const dir = join(userData, '.nexar', 'sessions');
  const files = (await readdir(dir)).filter((name) => name.endsWith('.json'));
  expect(files).toHaveLength(1);
  const session = JSON.parse(await readFile(join(dir, files[0] ?? ''), 'utf8')) as {
    turns: RecordedTurn[];
  };
  return session.turns;
}

async function filesUnder(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await filesUnder(path)));
    else out.push(path);
  }
  return out;
}

/**
 * Nothing the owner or an engine handed over may sit in Nexar's records: no permission argument,
 * and no prompt outside the owner's own conversation turns
 * (sessions are the owner's transcript; audit, approvals and telemetry carry ids and codes only).
 */
async function expectCleanRecords(userData: string, prompts: readonly string[]): Promise<void> {
  const state = join(userData, '.nexar');
  const files = await filesUnder(state);
  expect(files.length).toBeGreaterThan(0);
  for (const file of files) {
    const content = await readFile(file, 'utf8');
    expect(content).not.toContain(FAKE_ARGUMENT);
    if (!file.startsWith(join(state, 'sessions'))) {
      for (const prompt of prompts) expect(content).not.toContain(prompt);
    }
  }
}

// --- UI helpers -----------------------------------------------------------------------------------

const state = (locator: ReturnType<Page['getByTestId']>) => () =>
  locator.getAttribute('data-state').catch(() => null);

/** Banners are cached in main for a minute: Refresh re-probes after a settings change. */
async function waitForReady(page: Page, banner: string, refresh: string): Promise<void> {
  const locator = page.getByTestId(banner);
  await expect
    .poll(async () => {
      const current = await state(locator)();
      if (current !== 'ready' && (await page.getByTestId(refresh).count()) > 0) {
        await page.getByTestId(refresh).click();
      }
      return current;
    }, POLL)
    .toBe('ready');
}

async function send(page: Page, message: string): Promise<void> {
  await page.getByLabel('Message').fill(message);
  await page.getByRole('button', { name: 'Send' }).click();
}

const turnAt = (page: Page, n: number) => page.getByTestId('turn').nth(n);
const succeeded = (page: Page, n: number) =>
  expect.poll(() => turnAt(page, n).getAttribute('data-state'), POLL).toBe('succeeded');

/** Maps the harness project to the fake plane's project and waits for the Code banner. */
async function mapPlaneProject(page: Page): Promise<void> {
  await page.getByTestId('mode-code').click();
  await expect.poll(state(page.getByTestId('code-banner')), POLL).toBe('project-unmapped');
  await page.getByTestId('plane-project-input').fill('plane-proj');
  await page.getByTestId('plane-project-save').click();
  await waitForReady(page, 'code-banner', 'code-refresh');
}

async function pageText(page: Page): Promise<string> {
  return page.locator('body').innerText();
}

/** Cowork SOW turn: lane, gateway control, draft card, on the seeded control resource. */
async function expectSowTurn(page: Page, n: number): Promise<void> {
  const t = turnAt(page, n);
  await hasText(t.getByTestId('lane-effective'), 'Lane: cowork');
  await hasText(t.getByTestId('lane-orchestrator'), 'Orchestrated by DeepSeek Harness');
  await hasText(t.getByTestId('lane-control'), 'Control: Nexar gateway on local.e2e-control');
  await isVisible(t.getByTestId('artifact-card').first());
  expect(await t.getByTestId('lane-fallback').count()).toBe(0);
  expect(await t.getByTestId('engineering-panel').count()).toBe(0);
}

/** The recorded decisions of a SOW turn: the gateway control decision and the four units. */
function expectSowRecords(turn: RecordedTurn): void {
  expect(turn.state).toBe('succeeded');
  expect(turn.lane).toMatchObject({ effectiveLane: 'cowork' });
  expect(turn.lane?.fallbackReason).toBeUndefined();
  const task = turn.tasks[0];
  expect(task?.control?.path).toBe('gateway');
  expect(task?.control?.resourceId).toContain('local.e2e-control');
  expect(task?.control?.restarts).toBe(0);
  expect(task?.policyId).toBe('control@1:auto');
  const units = task?.delegations ?? [];
  expect(units.map((u) => u.unitId)).toEqual(SOW_UNITS);
  for (const unit of units) {
    expect(unit.outcome).toBe('succeeded');
    expect(unit.resourceId).toMatch(/\S/);
  }
}

interface TelemetryEvent {
  readonly type: string;
  readonly decision?: { readonly outcome: string; readonly policy?: { readonly name: string } };
  readonly record?: {
    readonly origin: string;
    readonly taskKind: string;
    readonly resourceId: string;
    readonly outcome: string;
    readonly routing?: { readonly policy: string; readonly reasonCodes: readonly string[] };
  };
}

/**
 * The route decision behind every delegated unit, from telemetry (ids, codes and kinds, no
 * content), and the permission records the turn left.
 */
async function expectSowTelemetry(userData: string, controlRequests: number): Promise<void> {
  const lines = (await readFile(join(userData, '.nexar', 'telemetry.jsonl'), 'utf8')).split('\n');
  const events = lines.filter((l) => l !== '').map((l) => JSON.parse(l) as TelemetryEvent);
  const runs = events.flatMap((e) =>
    e.type === 'execution.finished' && e.record?.origin === 'control-plane' ? [e.record] : [],
  );
  const unitRuns = runs.filter((r) => r.taskKind !== 'control-model-turn');
  const controlRuns = runs.filter((r) => r.taskKind === 'control-model-turn');
  // The control model and delegated work are independently accounted, once per actual request.
  expect(controlRuns).toHaveLength(controlRequests);
  expect(controlRequests).toBeGreaterThan(SOW_UNITS.length * 2);
  for (const run of controlRuns) {
    expect(run.resourceId).toContain('local.e2e-control');
    expect(run.outcome).toBe('succeeded');
    expect(run.routing?.policy).toBe('resource-intelligence');
    expect(run.routing?.reasonCodes.length).toBeGreaterThan(0);
  }
  expect(unitRuns.map((r) => r.taskKind)).toEqual([
    'analysis',
    'analysis',
    'documentation',
    'analysis',
  ]);
  for (const run of unitRuns) {
    expect(run.outcome).toBe('succeeded');
    expect(run.routing?.policy).toBe('resource-intelligence');
    expect(run.routing?.reasonCodes.length).toBeGreaterThan(0);
  }
  const selected = events.filter(
    (e) => e.type === 'route.decided' && e.decision?.outcome === 'selected',
  );
  expect(selected.length).toBeGreaterThanOrEqual(SOW_UNITS.length);

  // Nexar's own policy decided every permission request DeepSeek Harness made (none by a person).
  // The runtime does not ask before an MCP tool call: the bridge grant and its events bound those.
  const dir = join(userData, '.nexar', 'approvals');
  const records = await Promise.all(
    (await filesUnder(dir)).map(
      async (f) =>
        JSON.parse(await readFile(f, 'utf8')) as { actionType: string; decidedBy: string },
    ),
  );
  expect(
    records
      .filter((r) => r.actionType === 'cowork.tool-call')
      .every((r) => r.decidedBy === 'policy'),
  ).toBe(true);
}

/** Strategy diversity: the unit that reviews the draft ran on another resource than the draft. */
function expectReviewApartFromDraft(turn: RecordedTurn): void {
  const units = turn.tasks[0]?.delegations ?? [];
  const draft = units.find((u) => u.unitId === 'draft');
  const review = units.find((u) => u.unitId === 'review');
  expect(draft?.resourceId).toMatch(/\S/);
  expect(review?.resourceId).not.toBe(draft?.resourceId);
}

const SOW_ENV = dshEnv;

describe('Nexar Desktop resource orchestration acceptance (offline)', () => {
  it.skipIf(!hasDsh)(
    '1. a Cowork SOW is orchestrated by DeepSeek Harness on Nexar’s control resource and delegated to other resources',
    async () => {
      const userData = harness.newUserData('sow');
      const { control, work } = await seedModels(userData);
      onTestFailed(async () => {
        try {
          const turns = await recordedTurns(userData);
          process.stderr.write(
            `sow e2e progress ${JSON.stringify({
              at: Date.now(),
              turns: turns.map((turn) => ({
                state: turn.state,
                tasks: turn.tasks.map((task) => ({
                  controlPath: task.control?.path,
                  delegations: task.delegations?.map((unit) => ({
                    unitId: unit.unitId,
                    outcome: unit.outcome,
                  })),
                })),
              })),
              controlRequests: control.completions.length,
              workRequests: work.completions.length,
              recentControl: control.completions.slice(-12),
            })}\n`,
          );
        } catch {
          process.stderr.write('sow e2e progress unavailable\n');
        }
      });
      const { app, page } = await harness.launch(userData, SOW_ENV);
      await addProject(app, page, harness.projectDir);

      await page.getByTestId('mode-cowork').click();
      await waitForReady(page, 'cowork-banner', 'cowork-refresh');
      await page.getByTestId('new-conversation').click();
      await send(page, SOW_PROMPT);
      await succeeded(page, 0);
      await expectSowTurn(page, 0);

      // The control loop ran through the gateway on the control resource: the request, then one
      // tool call after another (four units, each submitted and polled), then the answer.
      const controlTurns = control.completions.filter((c) => c.tools);
      expect(controlTurns.at(0)?.last).toBe('user');
      expect(controlTurns.length).toBeGreaterThan(SOW_UNITS.length * 2);
      expect(controlTurns.slice(1).every((c) => c.last === 'tool')).toBe(true);
      // Units ran on resources Nexar chose, never as control turns.
      expect(
        [...control.completions, ...work.completions].filter((c) => !c.tools).length,
      ).toBeLessThanOrEqual(SOW_UNITS.length);

      const turns = await recordedTurns(userData);
      expect(turns).toHaveLength(1);
      expectSowRecords(turns[0] as RecordedTurn);
      // The draft is the delegated draft unit's text, imported as an artifact of this task.
      const taskId = turns[0]?.tasks[0]?.taskId ?? '';
      const draft = await readFile(
        join(harness.projectDir, '.nexar', 'artifacts', taskId, 'drafts', 'draft.md'),
        'utf8',
      );
      expect(draft).toContain('Unit draft, working from');

      expect(await pageText(page)).not.toContain(FAKE_ARGUMENT);
      await harness.close(app);
      await expectSowTelemetry(userData, controlTurns.length);
      await expectCleanRecords(userData, [SOW_PROMPT]);
    },
    SOW_TIMEOUT,
  );

  it.skipIf(!hasDsh)(
    '1b. the review unit runs on a different resource than the draft unit',
    async () => {
      const userData = harness.newUserData('sow-diversity');
      await seedModels(userData);
      const { app, page } = await harness.launch(userData, SOW_ENV);
      await addProject(app, page, harness.projectDir);
      await page.getByTestId('mode-cowork').click();
      await waitForReady(page, 'cowork-banner', 'cowork-refresh');
      await page.getByTestId('new-conversation').click();
      await send(page, SOW_PROMPT);
      await succeeded(page, 0);
      await harness.close(app);
      const [turn] = (await recordedTurns(userData)) as [RecordedTurn];
      expectReviewApartFromDraft(turn);
    },
    SOW_TIMEOUT,
  );

  it(
    '2. a Code change shows its executors, control resource and lane diversity, then commits after approval',
    async () => {
      const userData = harness.newUserData('code-change');
      const log = join(harness.base, 'plane-code-change.jsonl');
      const { app, page } = await harness.launch(userData, {
        NEXAR_DESKTOP_TEST_PLANE: FAKE_PLANE,
        NEXAR_FAKE_PLANE_RUN: 'approve',
        NEXAR_FAKE_PLANE_ACCEPTANCE: 'engine',
        NEXAR_FAKE_PLANE_RESOURCES: '1',
        NEXAR_FAKE_PLANE_CONTROL: '1',
        NEXAR_FAKE_PLANE_LOG: log,
      });
      await addProject(app, page, harness.projectDir);
      await mapPlaneProject(page);
      await page.getByTestId('new-conversation').click();

      await send(page, IMPLEMENT_PROMPT);
      const t = turnAt(page, 0);
      await hasText(t.getByTestId('eng-phase'), 'Waiting for your approval');
      await hasText(t.getByTestId('eng-approval'), 'Waiting for your decision');
      await hasText(t.getByTestId('eng-approve-note'), 'Nothing is pushed.');
      await page.getByTestId('nav-approvals').click();
      await hasText(page.getByTestId('approval-card'), 'engineering.commit');
      await page.getByTestId('nav-chat').click();
      await page.getByTestId('approve-commit').click();
      await succeeded(page, 0);

      await hasText(t.getByTestId('lane-effective'), 'Lane: code');
      await hasText(t.getByTestId('eng-status'), 'Committed');
      await hasText(t.getByTestId('eng-approval'), 'Approved');
      await hasText(t.getByTestId('eng-branch'), BRANCH);
      await hasText(t.getByTestId('eng-commit'), COMMIT_SHORT);
      await hasText(t.getByTestId('eng-verdict'), 'approve');
      await hasText(t.getByTestId('eng-gates'), '3');
      await hasText(t.getByTestId('eng-resources'), 'feature: dsh:deepseek');
      await hasText(t.getByTestId('eng-resources'), 'review: claude-code:sonnet');
      await hasText(
        t.getByTestId('eng-executors'),
        'feature · Executor: DeepSeek Harness (control: pi:deepseek-chat)',
      );
      await hasText(
        t.getByTestId('eng-executors'),
        'review · Executor: native (the engine was not selected for this lane)',
      );
      expect(await t.getByTestId('lane-fallback').count()).toBe(0);

      const turns = await recordedTurns(userData);
      expect(turns).toHaveLength(1);
      const [turn] = turns as [RecordedTurn];
      expect(turn.lane).toMatchObject({ effectiveLane: 'code' });
      expect(turn.outcome?.engineering?.status).toBe('committed');
      const lanes = turn.outcome?.engineering?.lanes ?? [];
      expect(lanes.map((l) => l.role)).toEqual(['feature', 'review']);
      expect(lanes[0]).toMatchObject({
        executor: 'engine',
        engine: 'dsh',
        controlResourceId: 'pi:deepseek-chat',
      });
      expect(lanes[1]).toMatchObject({ executor: 'native' });
      expect(lanes[1]?.resourceId).not.toBe(lanes[0]?.resourceId);

      // Nexar only ever asked the plane to run, decide and diff: there is no push request.
      const frames = (await readFile(log, 'utf8'))
        .split('\n')
        .filter((line) => line !== '')
        .map((line) => (JSON.parse(line) as { event: string; type?: string }).type)
        .filter((type): type is string => type !== undefined);
      expect(frames).toContain('decide');
      expect(frames.filter((type) => /push|remote|publish/i.test(type))).toEqual([]);

      await harness.close(app);
      await expectCleanRecords(userData, [IMPLEMENT_PROMPT]);
    },
    SOW_TIMEOUT,
  );

  it.skipIf(!hasDsh)(
    '3a. without a control resource a Cowork turn says so and runs with Nexar direct execution',
    async () => {
      const userData = harness.newUserData('no-control');
      // Only the echo test double: it takes no caller tools, so nothing can run the control loop.
      const { app, page } = await harness.launch(userData, SOW_ENV);
      await addProject(app, page, harness.projectDir);

      await page.getByTestId('mode-cowork').click();
      await expect
        .poll(async () => {
          if ((await page.getByTestId('cowork-refresh').count()) > 0) {
            await page.getByTestId('cowork-refresh').click();
          }
          return state(page.getByTestId('cowork-banner'))();
        }, POLL)
        .toBe('configuration-missing');
      await hasText(
        page.getByTestId('cowork-banner'),
        'No control-compatible resource can run Cowork',
      );

      await page.getByTestId('new-conversation').click();
      await send(page, SOW_PROMPT);
      await succeeded(page, 0);
      const t = turnAt(page, 0);
      await hasText(t.getByTestId('lane-effective'), 'Lane: direct');
      await hasText(
        t.getByTestId('lane-fallback'),
        'No control-compatible resource for DeepSeek Harness. Using Nexar direct execution.',
      );
      expect(await t.getByTestId('lane-orchestrator').count()).toBe(0);
      expect(await t.getByTestId('lane-control').count()).toBe(0);
      expect((await t.getByTestId('result-text').innerText()).trim()).not.toBe('');

      const turns = await recordedTurns(userData);
      expect(turns).toHaveLength(1);
      const [turn] = turns as [RecordedTurn];
      expect(turn.state).toBe('succeeded');
      expect(turn.lane).toMatchObject({
        requestedLane: 'cowork',
        effectiveLane: 'direct',
        fallbackReason: 'dsh-control-unavailable',
      });
      expect(turn.tasks[0]?.control).toBeUndefined();
      expect(turn.tasks[0]?.delegations).toBeUndefined();
      expect(turn.tasks[0]?.resourceId).toBe('local-echo');

      await harness.close(app);
      await expectCleanRecords(userData, [SOW_PROMPT]);
    },
    SOW_TIMEOUT,
  );

  it(
    '3b. a Code lane that could not use its engine is shown as native with the reason',
    async () => {
      const userData = harness.newUserData('native-lane');
      const { app, page } = await harness.launch(userData, {
        NEXAR_DESKTOP_TEST_PLANE: FAKE_PLANE,
        NEXAR_FAKE_PLANE_RUN: 'approve',
        NEXAR_FAKE_PLANE_ACCEPTANCE: 'native',
        NEXAR_FAKE_PLANE_RESOURCES: '1',
      });
      await addProject(app, page, harness.projectDir);
      await mapPlaneProject(page);
      await page.getByTestId('new-conversation').click();

      await send(page, IMPLEMENT_PROMPT);
      await hasText(turnAt(page, 0).getByTestId('eng-approval'), 'Waiting for your decision');
      await page.getByTestId('approve-commit').click();
      await succeeded(page, 0);
      const t = turnAt(page, 0);
      await hasText(t.getByTestId('eng-commit'), COMMIT_SHORT);
      await hasText(
        t.getByTestId('eng-executors'),
        'feature · Executor: native (no resource can run the engine’s control loop)',
      );
      expect(await t.getByTestId('eng-executors').innerText()).not.toContain('DeepSeek Harness');

      const [turn] = (await recordedTurns(userData)) as [RecordedTurn];
      const feature = turn.outcome?.engineering?.lanes?.find((l) => l.role === 'feature');
      expect(feature).toMatchObject({ executor: 'native', executorReason: 'control-unavailable' });
      expect(feature?.engine).toBeUndefined();
      expect(feature?.controlResourceId).toBeUndefined();

      await harness.close(app);
      await expectCleanRecords(userData, [IMPLEMENT_PROMPT]);
    },
    SOW_TIMEOUT,
  );

  it.skipIf(!hasDsh)(
    '4. one conversation carries proposal, repository review and implementation with Auto everywhere',
    async () => {
      const userData = harness.newUserData('integrated');
      const { control } = await seedModels(userData);
      const log = join(harness.base, 'plane-integrated.jsonl');
      const env = {
        ...SOW_ENV,
        NEXAR_DESKTOP_TEST_PLANE: FAKE_PLANE,
        NEXAR_FAKE_PLANE_RUN: 'approve',
        NEXAR_FAKE_PLANE_ACCEPTANCE: 'engine',
        NEXAR_FAKE_PLANE_LANE_FACTS: '1',
        NEXAR_FAKE_PLANE_RESOURCES: '1',
        NEXAR_FAKE_PLANE_CONTROL: '1',
        NEXAR_FAKE_PLANE_LOG: log,
      };
      let app: ElectronApplication;
      let page: Page;
      ({ app, page } = await harness.launch(userData, env));
      await addProject(app, page, harness.projectDir);

      // Auto everywhere: no control resource is pinned and none is chosen for a turn.
      await page.getByTestId('nav-settings').click();
      await page.getByRole('tab', { name: 'AI behavior', exact: true }).click();
      await isVisible(page.getByTestId('orch-cowork-control'));
      await expect.poll(() => page.getByTestId('orch-cowork-control').inputValue(), POLL).toBe('');
      await page.getByTestId('nav-chat').click();

      await mapPlaneProject(page);
      await page.getByTestId('mode-cowork').click();
      await waitForReady(page, 'cowork-banner', 'cowork-refresh');
      await page.getByTestId('new-conversation').click();

      // --- Turn 1: the proposal, orchestrated by DeepSeek Harness on the control resource ---
      await send(page, SOW_PROMPT);
      await succeeded(page, 0);
      await expectSowTurn(page, 0);
      const controlTurns = control.completions.filter((c) => c.tools);
      expect(controlTurns.at(0)?.last).toBe('user');
      expect(controlTurns.slice(1).every((c) => c.last === 'tool')).toBe(true);

      // --- Turn 2: repository review, report only, on the Code lane after confirmation ---
      await send(page, REVIEW_PROMPT);
      await expect.poll(() => page.getByTestId('turn').count(), POLL).toBe(2);
      await isVisible(page.getByTestId('lane-confirm'));
      await page.getByRole('button', { name: 'Run in code lane' }).click();
      await succeeded(page, 1);
      const review = turnAt(page, 1);
      await hasText(review.getByTestId('result-text'), 'The repository implementation supports');
      await hasText(review.getByTestId('lane-effective'), 'Lane: code');
      await hasText(review.getByTestId('engineering-panel'), 'Repository review');
      await hasText(
        review.getByTestId('eng-executors'),
        'report · Executor: DeepSeek Harness (control: pi:deepseek-chat)',
      );
      for (const id of ['show-diff', 'eng-approval', 'eng-commit', 'approve-commit']) {
        expect(await review.getByTestId(id).count()).toBe(0);
      }

      // --- Turn 3: implementation, waits for the approval, then a local commit ---
      await send(page, IMPLEMENT_PROMPT);
      await expect.poll(() => page.getByTestId('turn').count(), POLL).toBe(3);
      await isVisible(page.getByTestId('lane-confirm'));
      await page.getByRole('button', { name: 'Run in code lane' }).click();
      const change = turnAt(page, 2);
      await hasText(change.getByTestId('eng-approval'), 'Waiting for your decision');
      await page.getByTestId('approve-commit').click();
      await succeeded(page, 2);
      await hasText(change.getByTestId('lane-effective'), 'Lane: code');
      await hasText(change.getByTestId('eng-commit'), COMMIT_SHORT);
      await hasText(change.getByTestId('eng-branch'), BRANCH);
      await hasText(
        change.getByTestId('eng-executors'),
        'feature · Executor: DeepSeek Harness (control: pi:deepseek-chat)',
      );
      await hasText(
        change.getByTestId('eng-executors'),
        'review · Executor: native (the engine was not selected for this lane)',
      );

      // One conversation, three turns; no resource was chosen by hand.
      expect(await page.getByTestId('conversation-item').count()).toBe(1);
      expect(await page.getByTestId('turn').count()).toBe(3);

      const turns = await recordedTurns(userData);
      expect(turns).toHaveLength(3);
      const [proposal, repository, implementation] = turns as [
        RecordedTurn,
        RecordedTurn,
        RecordedTurn,
      ];
      expectSowRecords(proposal);
      await expectSowTelemetry(userData, controlTurns.length);
      expect(repository.lane).toMatchObject({ effectiveLane: 'code' });
      expect(repository.outcome?.engineering).toMatchObject({ status: 'reported' });
      expect(repository.outcome?.engineering?.lanes?.[0]).toMatchObject({
        role: 'report',
        executor: 'engine',
        engine: 'dsh',
        controlResourceId: 'pi:deepseek-chat',
      });
      expect(implementation.lane).toMatchObject({ effectiveLane: 'code' });
      expect(implementation.outcome?.engineering?.status).toBe('committed');
      const lanes = implementation.outcome?.engineering?.lanes ?? [];
      expect(lanes.map((l) => l.role)).toEqual(['feature', 'review']);
      expect(lanes[1]?.resourceId).not.toBe(lanes[0]?.resourceId);

      const frames = (await readFile(log, 'utf8'))
        .split('\n')
        .filter((line) => line !== '')
        .map((line) => (JSON.parse(line) as { type?: string }).type ?? '');
      expect(frames.filter((type) => /push|remote|publish/i.test(type))).toEqual([]);

      expect(await pageText(page)).not.toContain(FAKE_ARGUMENT);

      // --- relaunch: all three turns, their lanes and decisions are still there ---
      await harness.close(app);
      ({ app, page } = await harness.launch(userData, env));
      await page.getByTestId('conversation-item').first().click();
      await expect.poll(() => page.getByTestId('turn').count(), POLL).toBe(3);
      await expectSowTurn(page, 0);
      await hasText(turnAt(page, 1).getByTestId('eng-executors'), 'report · Executor: DeepSeek');
      await hasText(turnAt(page, 2).getByTestId('eng-commit'), COMMIT_SHORT);
      await harness.close(app);
      await expectCleanRecords(userData, [SOW_PROMPT, REVIEW_PROMPT, IMPLEMENT_PROMPT]);
    },
    SOW_TIMEOUT * 2,
  );
});
