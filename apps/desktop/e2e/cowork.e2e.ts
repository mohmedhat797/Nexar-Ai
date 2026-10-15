import { readdir, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import type { ElectronApplication, Page } from 'playwright-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startModel, type FakeModel } from './dsh-model.js';
import {
  POLL,
  addProject,
  createHarness,
  dshEnv,
  hasDsh,
  hasText,
  isVisible,
  seedE2EConfig,
  type Harness,
} from './harness.js';

/*
 * The Cowork lane on the real DeepSeek Harness runtime (ADR-030). The control model is a fake
 * OpenAI-compatible server on loopback, declared by the owner as a tool-calling local endpoint and
 * selected by the NRC through the Control Model Gateway. When `NEXAR_DSH_ENTRY` is not set the
 * scenarios that need the runtime skip (CI always sets it, see `scripts/install-dsh-runtime.mjs`).
 */

const REQUEST = 'Write a short solution proposal for the Acme onboarding portal.';
const SKIP_REASON =
  'NEXAR_DSH_ENTRY is not set: the real DeepSeek Harness runtime is not installed';
const TURN_TIMEOUT = 240_000;

let harness: Harness;
const models: FakeModel[] = [];

beforeAll(async () => {
  if (!hasDsh) process.stderr.write(`cowork e2e: runtime scenarios skipped (${SKIP_REASON})\n`);
  harness = await createHarness();
});

afterAll(async () => {
  await Promise.all(models.map((m) => m.close()));
  await harness.dispose();
});

const banner = (page: Page) => page.getByTestId('cowork-banner');
const bannerState = (page: Page) => () =>
  banner(page)
    .getAttribute('data-state')
    .catch(() => null);

/** The Cowork banner is cached in main for a minute: Refresh re-probes after a settings change. */
async function waitForReady(page: Page): Promise<void> {
  await expect
    .poll(async () => {
      const state = await bannerState(page)();
      if (state !== 'ready' && (await page.getByTestId('cowork-refresh').count()) > 0) {
        await page.getByTestId('cowork-refresh').click();
      }
      return state;
    }, POLL)
    .toBe('ready');
}

async function newCoworkTurn(page: Page): Promise<void> {
  await page.getByTestId('new-conversation').click();
  await page.getByLabel('Message').fill(REQUEST);
  await page.getByRole('button', { name: 'Send' }).click();
}

/** A seeded config with one tool-calling local endpoint: the control resource the NRC selects. */
async function seedControl(userData: string, model: FakeModel): Promise<void> {
  await seedE2EConfig(userData, [
    { id: 'e2e-control', kind: 'openai-compatible', baseUrl: model.baseUrl, toolCalling: true },
  ]);
}

/** A scenario starts with no artifacts in the shared harness project. */
async function freshProject(): Promise<void> {
  await rm(join(harness.projectDir, '.nexar'), { recursive: true, force: true });
}

/** Every draft file of every task of the harness project, by file name. */
async function drafts(): Promise<Record<string, string>> {
  const root = join(harness.projectDir, '.nexar', 'artifacts');
  const found: Record<string, string> = {};
  for (const task of await readdir(root).catch(() => [])) {
    const dir = join(root, task, 'drafts');
    for (const name of await readdir(dir).catch(() => [])) {
      found[name] = await readFile(join(dir, name), 'utf8');
    }
  }
  return found;
}

describe('Nexar Desktop Cowork lane (DeepSeek Harness)', () => {
  it.skipIf(!hasDsh)(
    'writes a solution proposal through the real runtime and keeps the draft after a relaunch',
    async () => {
      const control = await startModel('control-model', undefined, models);
      await freshProject();
      const userData = harness.newUserData('proposal');
      await seedControl(userData, control);
      let app: ElectronApplication;
      let page: Page;
      ({ app, page } = await harness.launch(userData, dshEnv));
      await addProject(app, page, harness.projectDir);

      // --- Settings -> Cowork: the same state, read-only, with the fixed note ---
      await page.getByTestId('nav-settings').click();
      await page.getByRole('tab', { name: 'Cowork' }).click();
      await hasText(
        page.getByTestId('cowork-note'),
        'Isolated Cowork requires the configured WSL2 sandbox and its pinned DeepSeek Harness runtime.',
      );
      await page.getByTestId('cowork-settings-refresh').click();
      await hasText(page.getByTestId('cowork-state'), 'ready');
      await hasText(page.getByTestId('cowork-version'), '0.');
      await hasText(page.getByTestId('cowork-runtime'), 'DeepSeek Harness 0.');

      // --- Cowork conversation: the banner is ready, the turn is orchestrated by DeepSeek Harness ---
      await page.getByTestId('nav-chat').click();
      await page.getByTestId('mode-cowork').click();
      await waitForReady(page);
      await hasText(banner(page), 'DeepSeek Harness ready');
      await isVisible(page.getByTestId('cowork-banner-version'));

      await newCoworkTurn(page);
      const turn = page.getByTestId('turn').first();
      await expect.poll(() => turn.getAttribute('data-state'), POLL).toBe('succeeded');
      const expectProposal = async (): Promise<void> => {
        await hasText(page.getByTestId('lane-effective'), 'Lane: cowork');
        await hasText(page.getByTestId('lane-orchestrator'), 'Orchestrated by DeepSeek Harness');
        await hasText(
          page.getByTestId('lane-control'),
          'Control: Nexar gateway on local.e2e-control',
        );
        await hasText(page.getByTestId('result-text'), 'Wrote proposal.md.');
        await hasText(page.getByTestId('artifact-card'), 'proposal.md');
        expect(await page.getByTestId('lane-fallback').count()).toBe(0);
        expect(await page.getByTestId('engineering-panel').count()).toBe(0);
      };
      await expectProposal();

      // The control loop ran through Nexar on the owner's resource: a tool call, then the answer.
      expect(control.completions.filter((c) => c.tools).map((c) => c.last)).toEqual([
        'user',
        'tool',
      ]);
      // The draft is the model's file, imported as an artifact (never written into the project tree).
      expect(await drafts()).toEqual({
        'proposal.md': '# Solution proposal\n\nScope, deliverables and dates.\n',
      });
      expect(await readdir(harness.projectDir)).toEqual(['.nexar', 'readme-seed.txt']);
      const resultText = await page.getByTestId('result-text').innerText();
      const artifactText = await page.getByTestId('artifact-card').first().innerText();

      // --- relaunch: the turn, its lane and the draft are still there ---
      await harness.close(app);
      ({ app, page } = await harness.launch(userData, dshEnv));
      await expect.poll(() => page.getByTestId('turn').count(), POLL).toBe(1);
      await expectProposal();
      expect(await page.getByTestId('result-text').innerText()).toBe(resultText);
      expect(await page.getByTestId('artifact-card').first().innerText()).toBe(artifactText);

      await harness.close(app);
    },
    TURN_TIMEOUT,
  );

  it.skipIf(!hasDsh)(
    'runs a read only Cowork turn: the write is denied by policy and no draft is imported',
    async () => {
      const control = await startModel('control-model', undefined, models);
      await freshProject();
      const userData = harness.newUserData('read-only');
      await seedControl(userData, control);
      const { app, page } = await harness.launch(userData, dshEnv);
      await addProject(app, page, harness.projectDir);

      // --- Settings -> AI behavior: Cowork -> Read only ---
      await page.getByTestId('nav-settings').click();
      await page.getByRole('tab', { name: 'AI behavior' }).click();
      await isVisible(page.getByTestId('behavior-settings'));
      expect(await page.getByTestId('behavior-cowork-drafts-only').isChecked()).toBe(true);
      await page.getByTestId('behavior-cowork-read-only').click(); // controlled input: polled below
      await expect
        .poll(() => page.getByTestId('behavior-cowork-read-only').isChecked(), POLL)
        .toBe(true);

      await page.getByTestId('nav-chat').click();
      await page.getByTestId('mode-cowork').click();
      await waitForReady(page);
      await newCoworkTurn(page);
      const turn = page.getByTestId('turn').first();
      await expect.poll(() => turn.getAttribute('data-state'), POLL).toBe('succeeded');
      await hasText(page.getByTestId('lane-effective'), 'Lane: cowork');
      expect((await page.getByTestId('result-text').innerText()).trim()).not.toBe('');
      // Read only: the turn completes and no draft card appears.
      expect(await page.getByTestId('artifact-card').count()).toBe(0);
      expect(await drafts()).toEqual({});

      await harness.close(app);
    },
    TURN_TIMEOUT,
  );

  it.skipIf(!hasDsh)(
    'delegates a unit from the DeepSeek Harness turn through the bridge relay to a Nexar resource',
    async () => {
      const control = await startModel('control-model', { kind: 'delegate' }, models);
      const work = await startModel('work-model', undefined, models);
      await freshProject();
      const userData = harness.newUserData('delegating');
      await seedE2EConfig(userData, [
        {
          id: 'e2e-control',
          kind: 'openai-compatible',
          baseUrl: control.baseUrl,
          toolCalling: true,
        },
        { id: 'e2e-work', kind: 'openai-compatible', baseUrl: work.baseUrl, toolCalling: false },
      ]);
      const { app, page } = await harness.launch(userData, dshEnv);
      await addProject(app, page, harness.projectDir);

      await page.getByTestId('mode-cowork').click();
      await waitForReady(page);
      await newCoworkTurn(page);
      const turn = page.getByTestId('turn').first();
      await expect.poll(() => turn.getAttribute('data-state'), POLL).toBe('succeeded');
      await hasText(page.getByTestId('lane-effective'), 'Lane: cowork');
      await hasText(page.getByTestId('lane-orchestrator'), 'Orchestrated by DeepSeek Harness');
      await isVisible(page.getByTestId('artifact-card'));

      // The delegated unit ran on a resource Nexar allocated (here the echo test double): its answer is\n      // the draft the control model wrote.
      expect((await drafts())['draft.md']).toContain('Unit draft, working from');
      // The control turns never carried the unit: units are requests without tools.
      const controlTurns = control.completions.filter((c) => c.tools);
      expect(controlTurns.at(0)?.last).toBe('user');
      expect(controlTurns.slice(1).every((c) => c.last === 'tool')).toBe(true);

      await harness.close(app);
    },
    TURN_TIMEOUT,
  );

  it.skipIf(!hasDsh)(
    'says no control-compatible resource can run Cowork and falls back to Nexar direct execution',
    async () => {
      const userData = harness.newUserData('no-control');
      // Only the echo test double: it takes no caller tools, so nothing can run the control loop.
      const { app, page } = await harness.launch(userData, dshEnv);
      await addProject(app, page, harness.projectDir);

      await page.getByTestId('mode-cowork').click();
      await expect
        .poll(async () => {
          if ((await page.getByTestId('cowork-refresh').count()) > 0) {
            await page.getByTestId('cowork-refresh').click();
          }
          return bannerState(page)();
        }, POLL)
        .toBe('configuration-missing');
      await hasText(banner(page), 'No control-compatible resource can run Cowork');

      await newCoworkTurn(page);
      const turn = page.getByTestId('turn').first();
      await expect.poll(() => turn.getAttribute('data-state'), POLL).toBe('succeeded');
      await hasText(
        page.getByTestId('lane-fallback'),
        'No control-compatible resource for DeepSeek Harness. Using Nexar direct execution.',
      );
      await hasText(page.getByTestId('lane-effective'), 'Lane: direct');
      expect(await page.getByTestId('lane-orchestrator').count()).toBe(0);

      await harness.close(app);
    },
    TURN_TIMEOUT,
  );

  it('shows why DeepSeek Harness is unavailable and runs the request with Nexar direct execution', async () => {
    const userData = harness.newUserData('without-dsh');
    const { app, page } = await harness.launch(userData);
    await addProject(app, page, harness.projectDir);

    await expect.poll(bannerState(page), POLL).toBe('dsh-missing');
    await hasText(page.getByTestId('cowork-banner-reason'), 'DeepSeek Harness is not installed');
    await isVisible(page.getByTestId('cowork-refresh'));

    await newCoworkTurn(page);
    const turn = page.getByTestId('turn').first();
    await expect.poll(() => turn.getAttribute('data-state'), POLL).toBe('succeeded');
    await hasText(
      page.getByTestId('lane-fallback'),
      'DeepSeek Harness unavailable. Using Nexar direct execution.',
    );
    await hasText(page.getByTestId('lane-effective'), 'Lane: direct');
    expect(await page.getByTestId('lane-orchestrator').count()).toBe(0);
    expect(await page.getByTestId('engineering-panel').count()).toBe(0);

    await page.getByTestId('nav-settings').click();
    await page.getByRole('tab', { name: 'Cowork' }).click();
    await hasText(page.getByTestId('cowork-state'), 'dsh-missing');
    await hasText(page.getByTestId('cowork-reason'), 'DeepSeek Harness is not installed');

    await harness.close(app);
  });
});
