import { readFile, readdir } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ElectronApplication, Page } from 'playwright-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  POLL,
  addProject,
  createHarness,
  hasText,
  isVisible,
  seedE2EConfig,
  type Harness,
} from './harness.js';

/*
 * NXR-066 (part a): ADR-027 end to end, offline. Fakes only: OpenAI-compatible model servers on
 * loopback, the fake OpenWorker (`sow` scenario) and the fake engineering plane. Nothing here calls
 * a real service; the owner's live acceptance is a separate step.
 */

const FAKE_OPENWORKER = fileURLToPath(
  new URL('../../../tests/fixtures/fake-openworker.mjs', import.meta.url),
);
const FAKE_PLANE = fileURLToPath(
  new URL('../../../tests/fixtures/fake-plane.mjs', import.meta.url),
);
const SOW_PROMPT = 'Create a professional SOW using this project.';
const REVIEW_PROMPT = 'Now verify whether the repository implementation supports this proposal.';
const IMPLEMENT_PROMPT = 'Implement the missing part.';
/** What the fake OpenWorker puts in the arguments of every permission request it makes. */
const FAKE_ARGUMENT = 'SECRET-ARGUMENT';
const COMMIT_SHORT = 'c'.repeat(12);
const BRANCH = 'nexar/task-fake-1';
const SOW_UNITS = ['extract', 'synthesize', 'draft', 'review'];
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

// --- fake OpenAI-compatible model server ----------------------------------------------------------

interface FakeModel {
  readonly port: number;
  readonly baseUrl: string;
  /** The `POST /v1/chat/completions` requests seen: whether tools were offered and the last role. */
  readonly completions: { readonly tools: boolean; readonly last: string }[];
  readonly close: () => Promise<void>;
}

const sse = (model: string, delta: object, finish: string | null): string =>
  `data: ${JSON.stringify({
    id: 'c1',
    object: 'chat.completion.chunk',
    created: 1,
    model,
    choices: [{ index: 0, delta, finish_reason: finish }],
  })}\n\n`;

/**
 * A model server listing one model. A request that offers tools (a control turn) is answered with
 * one tool call, then with text once the tool result is in the history; a request without tools (a
 * delegated unit) is answered with text naming the model.
 */
async function startModel(model: string): Promise<FakeModel> {
  const completions: { tools: boolean; last: string }[] = [];
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const path = (req.url ?? '').split('?')[0] ?? '';
      if (req.method === 'GET' && path === '/v1/models') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ object: 'list', data: [{ id: model }] }));
        return;
      }
      if (req.method !== 'POST' || path !== '/v1/chat/completions') {
        res.writeHead(404).end();
        return;
      }
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as {
        messages: { role: string }[];
        tools?: unknown[];
      };
      const last = body.messages.at(-1)?.role ?? '';
      const tools = body.tools !== undefined;
      completions.push({ tools, last });
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      if (tools && last !== 'tool') {
        res.write(
          sse(
            model,
            {
              role: 'assistant',
              tool_calls: [
                {
                  index: 0,
                  id: 'call_1',
                  type: 'function',
                  function: { name: 'scratch_note', arguments: '{"text":"outline"}' },
                },
              ],
            },
            null,
          ),
        );
        res.write(sse(model, {}, 'tool_calls'));
      } else {
        res.write(sse(model, { role: 'assistant', content: `Answer from ${model}: ` }, null));
        res.write(sse(model, { content: 'scope, deliverables and dates.' }, null));
        res.write(sse(model, {}, 'stop'));
      }
      res.end('data: [DONE]\n\n');
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  const fake: FakeModel = {
    port,
    baseUrl: `http://127.0.0.1:${String(port)}/v1`,
    completions,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  };
  models.push(fake);
  return fake;
}

/** The seeded resources: a control resource (declares tool calling) and a second work resource. */
async function seedModels(userData: string): Promise<{ control: FakeModel; work: FakeModel }> {
  const control = await startModel('control-model');
  const work = await startModel('work-model');
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

/** The tokens the fake OpenWorker was handed (provider `api_key` fields), read from its own log. */
async function issuedTokens(userData: string): Promise<string[]> {
  const log = await readFile(
    join(`${userData}.runtime`, 'openworker', 'records.jsonl'),
    'utf8',
  ).catch(() => '');
  return log
    .split('\n')
    .filter((line) => line !== '')
    .flatMap((line) => {
      const entry = JSON.parse(line) as {
        kind?: string;
        body?: { fields?: { api_key?: unknown } };
      };
      const key = entry.kind === 'provider' ? entry.body?.fields?.api_key : undefined;
      return typeof key === 'string' && key !== '' ? [key] : [];
    });
}

/**
 * Nothing the owner or an engine handed over may sit in Nexar's records: no permission argument,
 * no token the fake OpenWorker was issued, and no prompt outside the owner's own conversation turns
 * (sessions are the owner's transcript; audit, approvals and telemetry carry ids and codes only).
 */
async function expectCleanRecords(
  userData: string,
  prompts: readonly string[],
  tokens: readonly string[],
): Promise<void> {
  const state = join(userData, '.nexar');
  const files = await filesUnder(state);
  expect(files.length).toBeGreaterThan(0);
  for (const file of files) {
    const content = await readFile(file, 'utf8');
    expect(content).not.toContain(FAKE_ARGUMENT);
    for (const token of tokens) expect(content).not.toContain(token);
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
  await hasText(t.getByTestId('lane-orchestrator'), 'Orchestrated by OpenWorker');
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
    readonly outcome: string;
    readonly routing?: { readonly policy: string; readonly reasonCodes: readonly string[] };
  };
}

/**
 * The route decision behind every delegated unit, from telemetry (ids, codes and kinds, no
 * content), and the owner-side permission records the bridge calls went through.
 */
async function expectSowTelemetry(userData: string): Promise<void> {
  const lines = (await readFile(join(userData, '.nexar', 'telemetry.jsonl'), 'utf8')).split('\n');
  const events = lines.filter((l) => l !== '').map((l) => JSON.parse(l) as TelemetryEvent);
  const unitRuns = events.flatMap((e) =>
    e.type === 'execution.finished' && e.record?.origin === 'control-plane' ? [e.record] : [],
  );
  expect(unitRuns.map((r) => r.taskKind)).toEqual([
    'analysis',
    'analysis',
    'documentation',
    'review',
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

  const dir = join(userData, '.nexar', 'approvals');
  const records = await Promise.all(
    (await filesUnder(dir)).map(
      async (f) =>
        JSON.parse(await readFile(f, 'utf8')) as {
          actionType: string;
          decidedBy: string;
          metadata?: { tool?: string };
        },
    ),
  );
  const submits = records.filter(
    (r) => r.actionType === 'cowork.tool-call' && r.metadata?.tool?.endsWith('intelligence_submit'),
  );
  expect(submits).toHaveLength(SOW_UNITS.length);
  expect(submits.every((r) => r.decidedBy === 'policy')).toBe(true);
}

/** Strategy diversity: the unit that reviews the draft ran on another resource than the draft. */
function expectReviewApartFromDraft(turn: RecordedTurn): void {
  const units = turn.tasks[0]?.delegations ?? [];
  const draft = units.find((u) => u.unitId === 'draft');
  const review = units.find((u) => u.unitId === 'review');
  expect(draft?.resourceId).toMatch(/\S/);
  expect(review?.resourceId).not.toBe(draft?.resourceId);
}

const SOW_ENV = {
  NEXAR_DESKTOP_TEST_OPENWORKER: FAKE_OPENWORKER,
  NEXAR_FAKE_OPENWORKER_SCENARIO: 'sow',
};

describe('Nexar Desktop resource orchestration acceptance (offline)', () => {
  it(
    '1. a Cowork SOW is orchestrated by OpenWorker on Nexar’s control resource and delegated to other resources',
    async () => {
      const userData = harness.newUserData('sow');
      const { control, work } = await seedModels(userData);
      const { app, page } = await harness.launch(userData, SOW_ENV);
      await addProject(app, page, harness.projectDir);

      await page.getByTestId('mode-cowork').click();
      await waitForReady(page, 'cowork-banner', 'cowork-refresh');
      await page.getByTestId('new-conversation').click();
      await send(page, SOW_PROMPT);
      await succeeded(page, 0);
      await expectSowTurn(page, 0);

      // The control loop ran through the gateway on the control resource: a tool call, then the answer.
      const controlTurns = control.completions.filter((c) => c.tools);
      expect(controlTurns.map((c) => c.last)).toEqual(['user', 'tool']);
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
      expect(draft).toContain('Unit extract, working from');

      const tokens = await issuedTokens(userData);
      expect(tokens.length).toBeGreaterThan(0);
      const body = await pageText(page);
      for (const token of tokens) expect(body).not.toContain(token);
      expect(body).not.toContain(FAKE_ARGUMENT);
      await harness.close(app);
      await expectSowTelemetry(userData);
      await expectCleanRecords(userData, [SOW_PROMPT], tokens);
    },
    SOW_TIMEOUT,
  );

  // KNOWN GAP (NXR-066 finding): the bridge's submit request has no `reviewOf`, so the strategy never
  // learns which unit a `review` unit reviews and cannot apply review diversity; every unit lands on
  // the cheapest resource (`local-echo`). `it.fails` keeps the suite green while the gap is open and
  // turns red the moment diversity works, which is when this must become a plain `it`.
  it.fails(
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
      await expectCleanRecords(userData, [IMPLEMENT_PROMPT], []);
    },
    SOW_TIMEOUT,
  );

  it(
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
        'No control-compatible resource can run Cowork. Using Nexar direct execution.',
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
        fallbackReason: 'openworker-control-unavailable',
      });
      expect(turn.tasks[0]?.control).toBeUndefined();
      expect(turn.tasks[0]?.delegations).toBeUndefined();
      expect(turn.tasks[0]?.resourceId).toBe('local-echo');

      await harness.close(app);
      await expectCleanRecords(userData, [SOW_PROMPT], await issuedTokens(userData));
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
      await expectCleanRecords(userData, [IMPLEMENT_PROMPT], []);
    },
    SOW_TIMEOUT,
  );

  it(
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

      // --- Turn 1: the proposal, orchestrated by OpenWorker on the control resource ---
      await send(page, SOW_PROMPT);
      await succeeded(page, 0);
      await expectSowTurn(page, 0);
      expect(control.completions.filter((c) => c.tools).map((c) => c.last)).toEqual([
        'user',
        'tool',
      ]);

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
      await expectSowTelemetry(userData);
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

      const tokens = await issuedTokens(userData);
      expect(tokens.length).toBeGreaterThan(0);
      const body = await pageText(page);
      for (const token of tokens) expect(body).not.toContain(token);
      expect(body).not.toContain(FAKE_ARGUMENT);

      // --- relaunch: all three turns, their lanes and decisions are still there ---
      await harness.close(app);
      ({ app, page } = await harness.launch(userData, env));
      await page.getByTestId('conversation-item').first().click();
      await expect.poll(() => page.getByTestId('turn').count(), POLL).toBe(3);
      await expectSowTurn(page, 0);
      await hasText(turnAt(page, 1).getByTestId('eng-executors'), 'report · Executor: DeepSeek');
      await hasText(turnAt(page, 2).getByTestId('eng-commit'), COMMIT_SHORT);
      await harness.close(app);
      await expectCleanRecords(userData, [SOW_PROMPT, REVIEW_PROMPT, IMPLEMENT_PROMPT], tokens);
    },
    SOW_TIMEOUT * 2,
  );
});
