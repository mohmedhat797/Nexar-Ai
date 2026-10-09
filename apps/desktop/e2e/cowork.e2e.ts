import { readdir, readFile } from 'node:fs/promises';
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

const FAKE_OPENWORKER = fileURLToPath(
  new URL('../../../tests/fixtures/fake-openworker.mjs', import.meta.url),
);
/** Never a real key: stored through the same clipboard flow the Providers scenarios use. */
const SENTINEL = 'sk-nexar-cowork-e2e-test-key-not-real-Z4k2';
const REQUEST = 'Draft a project status note';

let harness: Harness;

beforeAll(async () => {
  harness = await createHarness();
});

afterAll(async () => {
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

describe('Nexar Desktop Cowork lane', () => {
  it('orchestrates a documentation request through the fake OpenWorker and keeps it after a relaunch', async () => {
    const userData = harness.newUserData('with-openworker');
    const env = { NEXAR_DESKTOP_TEST_OPENWORKER: FAKE_OPENWORKER };
    let app: ElectronApplication;
    let page: Page;
    ({ app, page } = await harness.launch(userData, env));
    await addProject(app, page, harness.projectDir);

    // Without an allowed key the lane says what is missing and where to fix it.
    await expect.poll(bannerState(page), POLL).toBe('configuration-missing');
    await hasText(page.getByTestId('cowork-banner-hint'), 'Allow OpenWorker to use a provider key');
    await isVisible(page.getByTestId('cowork-refresh'));

    // --- Settings -> Providers: store a test key and allow OpenWorker to use it ---
    await page.getByTestId('nav-settings').click();
    await page.getByRole('tab', { name: 'Providers' }).click();
    const row = page.getByTestId('provider-deepseek');
    await isVisible(row);
    await expect
      .poll(
        () => row.getByRole('button', { name: 'Save DeepSeek API key from clipboard' }).count(),
        POLL,
      )
      .toBe(1);
    const secure = await app.evaluate(
      ({ safeStorage }) =>
        safeStorage.isEncryptionAvailable() &&
        (process.platform !== 'linux' ||
          ['gnome_libsecret', 'kwallet', 'kwallet5', 'kwallet6'].includes(
            safeStorage.getSelectedStorageBackend(),
          )),
    );
    if (!secure) {
      // The Providers scenarios stop here too: Desktop never stores a key without OS encryption.
      expect(await row.innerText()).toContain('Unavailable');
      await harness.close(app);
      return;
    }
    // Unsupported providers say so and have no toggle; the key itself is never shown.
    await hasText(page.getByTestId('openworker-unsupported-groq'), 'Not available to OpenWorker');
    expect(await page.getByTestId('openworker-access-groq').count()).toBe(0);
    const access = page.getByTestId('openworker-access-deepseek');
    await hasText(row, 'Allow OpenWorker to use this key');
    expect(await access.isChecked()).toBe(false);

    await app.evaluate(async ({ clipboard }, key) => {
      await clipboard.writeText(key);
    }, SENTINEL);
    await row.getByRole('button', { name: 'Save DeepSeek API key from clipboard' }).click();
    await hasText(row, 'ending in Z4k2');
    await expect.poll(() => access.isDisabled(), POLL).toBe(false);
    // A controlled checkbox: it reflects main's answer after the IPC round trip, so click and poll.
    await access.click();
    await expect.poll(() => access.isChecked(), POLL).toBe(true);
    await hasText(page.getByTestId('provider-status'), 'OpenWorker access allowed');
    expect(await page.locator('body').innerText()).not.toContain(SENTINEL);

    // --- Settings -> Cowork: the same state, read-only, with the fixed note ---
    await page.getByRole('tab', { name: 'Cowork' }).click();
    await hasText(
      page.getByTestId('cowork-note'),
      "Nexar runs its own private OpenWorker. Its executable is set in the owner's desktop settings file.",
    );
    await page.getByTestId('cowork-settings-refresh').click();
    await hasText(page.getByTestId('cowork-state'), 'ready');
    await hasText(page.getByTestId('cowork-version'), '0.');

    // --- Cowork conversation: the banner is ready, the turn is orchestrated by OpenWorker ---
    await page.getByTestId('nav-chat').click();
    await page.getByTestId('mode-cowork').click();
    await waitForReady(page);
    await hasText(banner(page), 'OpenWorker ready');
    await isVisible(page.getByTestId('cowork-banner-version'));

    await newCoworkTurn(page);
    const turn = page.getByTestId('turn').first();
    await expect.poll(() => turn.getAttribute('data-state'), POLL).toBe('succeeded');
    const expectOrchestrated = async (): Promise<void> => {
      await hasText(page.getByTestId('lane-effective'), 'Lane: cowork');
      await hasText(page.getByTestId('lane-orchestrator'), 'Orchestrated by OpenWorker');
      await hasText(page.getByTestId('lane-orchestrator'), 'using ');
      expect((await page.getByTestId('result-text').innerText()).trim()).not.toBe('');
      await isVisible(page.getByTestId('artifact-card'));
      expect(await page.getByTestId('lane-fallback').count()).toBe(0);
      expect(await page.getByTestId('engineering-panel').count()).toBe(0);
    };
    await expectOrchestrated();
    const resultText = await page.getByTestId('result-text').innerText();
    const laneText = await page.getByTestId('lane-orchestrator').innerText();
    const artifactText = await page.getByTestId('artifact-card').first().innerText();
    expect(await page.locator('body').innerText()).not.toContain(SENTINEL);

    // --- relaunch: the turn, its lane and the draft are still there ---
    await harness.close(app);
    ({ app, page } = await harness.launch(userData, env));
    await expect.poll(() => page.getByTestId('turn').count(), POLL).toBe(1);
    await expectOrchestrated();
    expect(await page.getByTestId('result-text').innerText()).toBe(resultText);
    expect(await page.getByTestId('lane-orchestrator').innerText()).toBe(laneText);
    expect(await page.getByTestId('artifact-card').first().innerText()).toBe(artifactText);

    await harness.close(app);
  });

  it('runs a read only Cowork turn: discuss mode, no draft', async () => {
    const userData = harness.newUserData('read-only-openworker');
    const env = { NEXAR_DESKTOP_TEST_OPENWORKER: FAKE_OPENWORKER };
    const { app, page } = await harness.launch(userData, env);
    await addProject(app, page, harness.projectDir);

    await page.getByTestId('nav-settings').click();
    await page.getByRole('tab', { name: 'Providers' }).click();
    const row = page.getByTestId('provider-deepseek');
    await isVisible(row);
    await expect
      .poll(
        () => row.getByRole('button', { name: 'Save DeepSeek API key from clipboard' }).count(),
        POLL,
      )
      .toBe(1);
    const secure = await app.evaluate(
      ({ safeStorage }) =>
        safeStorage.isEncryptionAvailable() &&
        (process.platform !== 'linux' ||
          ['gnome_libsecret', 'kwallet', 'kwallet5', 'kwallet6'].includes(
            safeStorage.getSelectedStorageBackend(),
          )),
    );
    if (!secure) {
      // Same as the other scenarios: no OS encryption, no stored key, no Cowork turn.
      await harness.close(app);
      return;
    }
    await app.evaluate(async ({ clipboard }, key) => {
      await clipboard.writeText(key);
    }, SENTINEL);
    await row.getByRole('button', { name: 'Save DeepSeek API key from clipboard' }).click();
    await hasText(row, 'ending in Z4k2');
    const access = page.getByTestId('openworker-access-deepseek');
    await expect.poll(() => access.isDisabled(), POLL).toBe(false);
    await access.click(); // controlled input: state follows main's reply (polled below)
    await expect.poll(() => access.isChecked(), POLL).toBe(true);

    // --- Settings -> AI behavior: Cowork -> Read only ---
    await page.getByRole('tab', { name: 'AI behavior' }).click();
    await isVisible(page.getByTestId('behavior-settings'));
    expect(await page.getByTestId('behavior-cowork-drafts-only').isChecked()).toBe(true);
    await page.getByTestId('behavior-cowork-read-only').click(); // controlled input: state follows main's reply (polled below)
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
    expect(await page.locator('body').innerText()).not.toContain(SENTINEL);

    await harness.close(app);
  });
  it('delegates a unit from the OpenWorker turn through the bridge relay to a Nexar resource', async () => {
    const userData = harness.newUserData('delegating-openworker');
    const env = {
      NEXAR_DESKTOP_TEST_OPENWORKER: FAKE_OPENWORKER,
      NEXAR_FAKE_OPENWORKER_SCENARIO: 'delegate',
    };
    const { app, page } = await harness.launch(userData, env);
    await addProject(app, page, harness.projectDir);

    await page.getByTestId('nav-settings').click();
    await page.getByRole('tab', { name: 'Providers' }).click();
    const row = page.getByTestId('provider-deepseek');
    await isVisible(row);
    await expect
      .poll(
        () => row.getByRole('button', { name: 'Save DeepSeek API key from clipboard' }).count(),
        POLL,
      )
      .toBe(1);
    const secure = await app.evaluate(
      ({ safeStorage }) =>
        safeStorage.isEncryptionAvailable() &&
        (process.platform !== 'linux' ||
          ['gnome_libsecret', 'kwallet', 'kwallet5', 'kwallet6'].includes(
            safeStorage.getSelectedStorageBackend(),
          )),
    );
    if (!secure) {
      // Same as the other scenarios: no OS encryption, no stored key, no Cowork turn.
      await harness.close(app);
      return;
    }
    await app.evaluate(async ({ clipboard }, key) => {
      await clipboard.writeText(key);
    }, SENTINEL);
    await row.getByRole('button', { name: 'Save DeepSeek API key from clipboard' }).click();
    await hasText(row, 'ending in Z4k2');
    const access = page.getByTestId('openworker-access-deepseek');
    await expect.poll(() => access.isDisabled(), POLL).toBe(false);
    await access.click(); // controlled input: state follows main's reply (polled below)
    await expect.poll(() => access.isChecked(), POLL).toBe(true);

    await page.getByTestId('nav-chat').click();
    await page.getByTestId('mode-cowork').click();
    await waitForReady(page);
    await newCoworkTurn(page);
    const turn = page.getByTestId('turn').first();
    await expect.poll(() => turn.getAttribute('data-state'), POLL).toBe('succeeded');
    await hasText(page.getByTestId('lane-effective'), 'Lane: cowork');
    await hasText(page.getByTestId('lane-orchestrator'), 'Orchestrated by OpenWorker');
    await isVisible(page.getByTestId('artifact-card'));
    expect(await page.locator('body').innerText()).not.toContain(SENTINEL);

    // The delegated unit ran on a Nexar resource (the echo test double): its answer is the draft.
    const artifacts = join(harness.projectDir, '.nexar', 'artifacts');
    const drafts: string[] = [];
    for (const task of await readdir(artifacts)) {
      const file = join(artifacts, task, 'drafts', 'draft.md');
      drafts.push(await readFile(file, 'utf8').catch(() => ''));
    }
    expect(drafts.some((text) => text.includes('Draft a short project status note.'))).toBe(true);

    await harness.close(app);
  });

  it('runs the control loop through Nexar on a local model-turn resource, with no provider key', async () => {
    // A tiny OpenAI-compatible server: the first completion is a tool call, the second is text.
    const seen: { method: string; path: string; tools: boolean; roles: string[] }[] = [];
    const sse = (delta: object, finish: string | null): string =>
      `data: ${JSON.stringify({
        id: 'c1',
        object: 'chat.completion.chunk',
        created: 1,
        model: 'e2e-model',
        choices: [{ index: 0, delta, finish_reason: finish }],
      })}\n\n`;
    const model: Server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (chunk: Buffer) => chunks.push(chunk));
      req.on('end', () => {
        const path = (req.url ?? '').split('?')[0] ?? '';
        if (req.method === 'GET' && path === '/v1/models') {
          seen.push({ method: 'GET', path, tools: false, roles: [] });
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ object: 'list', data: [{ id: 'e2e-model' }] }));
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
        const roles = body.messages.map((m) => m.role);
        seen.push({ method: 'POST', path, tools: body.tools !== undefined, roles });
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        if (roles.at(-1) === 'tool') {
          res.write(sse({ role: 'assistant', content: 'Status note: ' }, null));
          res.write(sse({ content: 'all on track.' }, null));
          res.write(sse({}, 'stop'));
        } else {
          res.write(
            sse(
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
          res.write(sse({}, 'tool_calls'));
        }
        res.end('data: [DONE]\n\n');
      });
    });
    await new Promise<void>((resolve) => model.listen(0, '127.0.0.1', resolve));
    try {
      const port = (model.address() as AddressInfo).port;
      const userData = harness.newUserData('control-gateway');
      await seedE2EConfig(userData, [
        {
          id: 'e2e-local',
          kind: 'openai-compatible',
          baseUrl: `http://127.0.0.1:${String(port)}/v1`,
          // The owner's declaration: only then does the endpoint get the `model-turn` capability.
          toolCalling: true,
        },
      ]);
      const env = {
        NEXAR_DESKTOP_TEST_OPENWORKER: FAKE_OPENWORKER,
        NEXAR_FAKE_OPENWORKER_SCENARIO: 'control-loop',
      };
      const { app, page } = await harness.launch(userData, env);
      await addProject(app, page, harness.projectDir);

      // No provider key was saved or allowed: the lane is ready on the Nexar control resource alone.
      await page.getByTestId('mode-cowork').click();
      await waitForReady(page);
      await newCoworkTurn(page);
      const turn = page.getByTestId('turn').first();
      await expect.poll(() => turn.getAttribute('data-state'), POLL).toBe('succeeded');
      await hasText(page.getByTestId('lane-effective'), 'Lane: cowork');
      await hasText(page.getByTestId('lane-orchestrator'), 'Orchestrated by OpenWorker');
      await hasText(page.getByTestId('lane-control'), 'Control: Nexar gateway on');
      await isVisible(page.getByTestId('artifact-card'));
      expect(await page.getByTestId('lane-fallback').count()).toBe(0);
      expect(await page.getByTestId('engineering-panel').count()).toBe(0);

      // The loop ran on the model server: a tool call, then the answer, replayed from one history.
      const completions = seen.filter((entry) => entry.method === 'POST');
      expect(completions.map((entry) => entry.roles.at(-1))).toEqual(['user', 'tool']);
      expect(completions.every((entry) => entry.tools)).toBe(true);
      // The draft is the model's final text.
      const artifacts = join(harness.projectDir, '.nexar', 'artifacts');
      const drafts: string[] = [];
      for (const task of await readdir(artifacts)) {
        drafts.push(
          await readFile(join(artifacts, task, 'drafts', 'draft.md'), 'utf8').catch(() => ''),
        );
      }
      expect(drafts).toContain('Status note: all on track.');

      await harness.close(app);
    } finally {
      await new Promise<void>((resolve) => model.close(() => resolve()));
    }
  });

  it('shows why OpenWorker is unavailable and runs the request with Nexar direct execution', async () => {
    const userData = harness.newUserData('without-openworker');
    const { app, page } = await harness.launch(userData);
    await addProject(app, page, harness.projectDir);

    await expect.poll(bannerState(page), POLL).toBe('openworker-missing');
    await hasText(page.getByTestId('cowork-banner-reason'), 'OpenWorker is not installed');
    await isVisible(page.getByTestId('cowork-refresh'));

    await newCoworkTurn(page);
    const turn = page.getByTestId('turn').first();
    await expect.poll(() => turn.getAttribute('data-state'), POLL).toBe('succeeded');
    await hasText(
      page.getByTestId('lane-fallback'),
      'OpenWorker unavailable. Using Nexar direct execution.',
    );
    await hasText(page.getByTestId('lane-effective'), 'Lane: direct');
    expect(await page.getByTestId('lane-orchestrator').count()).toBe(0);
    expect(await page.getByTestId('engineering-panel').count()).toBe(0);

    await page.getByTestId('nav-settings').click();
    await page.getByRole('tab', { name: 'Cowork' }).click();
    await hasText(page.getByTestId('cowork-state'), 'openworker-missing');
    await hasText(page.getByTestId('cowork-reason'), 'OpenWorker is not installed');

    await harness.close(app);
  });
});
