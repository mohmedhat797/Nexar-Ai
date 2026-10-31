import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { fileURLToPath } from 'node:url';
import type { Page } from 'playwright-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { POLL, createHarness, hasText, isVisible, seedE2EConfig, type Harness } from './harness.js';

const FAKE_PLANE = fileURLToPath(
  new URL('../../../tests/fixtures/fake-plane.mjs', import.meta.url),
);
/** Never a real key: it goes through the clipboard flow and must never reach the page. */
const SENTINEL = 'sk-nexar-orchestration-e2e-not-real-1111';

let harness: Harness;
let model: Server;
let port: number;

beforeAll(async () => {
  harness = await createHarness();
  // Only `GET /v1/models` is served: discovery lists models, nothing is ever generated.
  model = createServer((req, res) => {
    if (req.method === 'GET' && (req.url ?? '').split('?')[0] === '/v1/models') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ object: 'list', data: [{ id: 'e2e-model' }] }));
      return;
    }
    res.writeHead(404).end();
  });
  await new Promise<void>((resolve) => model.listen(0, '127.0.0.1', resolve));
  port = (model.address() as AddressInfo).port;
});

afterAll(async () => {
  await new Promise<void>((resolve) => model.close(() => resolve()));
  await harness.dispose();
});

async function openSettings(page: Page, tab: string): Promise<void> {
  await page.getByTestId('nav-settings').click();
  await page.getByRole('tab', { name: tab, exact: true }).click();
}

/** Option labels of a select, in order. */
const optionTexts = (page: Page, testId: string): Promise<string[]> =>
  page.getByTestId(testId).locator('option').allInnerTexts();

describe('Nexar Desktop providers and orchestration', () => {
  it('shows provider cards, the plane resources, the control choice and the resource details', async () => {
    const userData = harness.newUserData('orchestration');
    const baseUrl = `http://127.0.0.1:${String(port)}/v1`;
    await seedE2EConfig(userData, [
      { id: 'e2e-tools', kind: 'openai-compatible', baseUrl, toolCalling: true },
      { id: 'e2e-plain', kind: 'openai-compatible', baseUrl, toolCalling: false },
    ]);
    const { app, page } = await harness.launch(userData, {
      NEXAR_DESKTOP_TEST_PLANE: FAKE_PLANE,
      NEXAR_FAKE_PLANE_RESOURCES: '1',
      NEXAR_FAKE_PLANE_CONTROL: '1',
    });

    // --- Providers: one card per provider, with its methods ---
    await openSettings(page, 'Providers');
    for (const id of ['anthropic', 'openai', 'google', 'deepseek', 'mistral', 'openrouter']) {
      await isVisible(page.getByTestId(`provider-card-${id}`));
    }
    await isVisible(page.getByTestId('provider-card-local'));
    const anthropic = page.getByTestId('provider-card-anthropic');
    await hasText(anthropic, 'Subscription · Claude Code');
    await hasText(anthropic, 'API key');
    await hasText(page.getByTestId('provider-card-openai'), 'Subscription · Codex');
    await hasText(page.getByTestId('provider-card-deepseek'), 'API key');
    expect(await page.getByTestId('provider-card-deepseek').innerText()).not.toContain(
      'Subscription',
    );
    await hasText(page.getByTestId('provider-card-local'), 'Local / Custom servers');

    // --- Engineering plane: the plane's resources, read-only ---
    const plane = page.getByTestId('plane-resources');
    await hasText(plane, 'Engineering plane');
    await expect.poll(() => page.getByTestId('plane-resource-row').count(), POLL).toBe(2);
    await hasText(plane, 'pi:deepseek-chat');
    await hasText(plane, 'claude-code');
    await hasText(plane, 'DeepSeek Harness');
    expect(await plane.locator('button, input, select, a').count()).toBe(0);

    // --- AI behavior: the control dropdown lists only model-turn resources ---
    await openSettings(page, 'AI behavior');
    const control = page.getByTestId('orch-cowork-control');
    await isVisible(control);
    await hasText(page.getByTestId('orch-cowork-engine'), 'DeepSeek Harness');
    await hasText(page.getByTestId('orch-code-engine'), 'DeepSeek Harness');
    await expect
      .poll(() => optionTexts(page, 'orch-cowork-control').then((o) => o.length), POLL)
      .toBe(2);
    const options = await optionTexts(page, 'orch-cowork-control');
    expect(options[0]).toContain('Auto');
    expect(options.join('|')).not.toContain('e2e-plain');
    const pinnable = await control.locator('option').nth(1).getAttribute('value');
    expect(pinnable).not.toBeNull();
    expect(pinnable).not.toContain('e2e-plain');

    // Pinning round-trips: select, leave the tab, come back, still pinned; then back to Auto.
    await control.selectOption(pinnable as string);
    await expect.poll(() => control.inputValue(), POLL).toBe(pinnable);
    await openSettings(page, 'Appearance');
    await openSettings(page, 'AI behavior');
    await expect
      .poll(() => page.getByTestId('orch-cowork-control').inputValue(), POLL)
      .toBe(pinnable);
    await page.getByTestId('orch-cowork-control').selectOption('');
    await expect.poll(() => page.getByTestId('orch-cowork-control').inputValue(), POLL).toBe('');
    await page.getByTestId('orch-cowork-fallback').selectOption('none');
    await expect
      .poll(() => page.getByTestId('orch-cowork-fallback').inputValue(), POLL)
      .toBe('none');
    await page.getByTestId('orch-cowork-fallback').selectOption('auto');
    await expect
      .poll(() => page.getByTestId('orch-cowork-fallback').inputValue(), POLL)
      .toBe('auto');

    // Code control is read-only and says why.
    expect(await page.getByTestId('orch-code-control').isDisabled()).toBe(true);
    expect(await page.getByTestId('orch-code-fallback').isDisabled()).toBe(true);
    // The plane reported its policy, so there is no reason to give; its DSH-capable resources are listed.
    expect(await page.getByTestId('orch-code-reason').count()).toBe(0);
    expect(await optionTexts(page, 'orch-code-control')).toContain('pi:deepseek-chat');

    // --- AI resources: the advanced view ---
    await page.getByTestId('nav-resources').click();
    await isVisible(page.getByTestId('resources-table'));
    expect(await page.getByTestId('resource-details').count()).toBe(0);
    await page.getByTestId('resources-details-toggle').click();
    await expect.poll(() => page.getByTestId('resource-details').count(), POLL).toBeGreaterThan(0);
    await hasText(page.getByTestId('resources-table'), 'model-turn');
    await hasText(page.getByTestId('resources-table'), 'local · official');
    await hasText(page.getByTestId('resources-table'), 'DeepSeek Harness');

    // --- No secret reaches any of these pages ---
    const saved = await app.evaluate(async ({ clipboard, safeStorage }, key) => {
      if (!safeStorage.isEncryptionAvailable()) return false;
      const before = await clipboard.readText();
      await clipboard.writeText(key);
      (globalThis as unknown as { nexarClipboardBefore?: string }).nexarClipboardBefore = before;
      return true;
    }, SENTINEL);
    if (saved) {
      await openSettings(page, 'Providers');
      await page.getByRole('button', { name: 'Save DeepSeek API key from clipboard' }).click();
      await hasText(page.getByTestId('provider-card-deepseek'), 'ending in 1111');
      await app.evaluate(async ({ clipboard }) => {
        const holder = globalThis as unknown as { nexarClipboardBefore?: string };
        await clipboard.writeText(holder.nexarClipboardBefore ?? '');
        delete holder.nexarClipboardBefore;
      });
      expect(await page.locator('body').innerText()).not.toContain(SENTINEL);
      await openSettings(page, 'AI behavior');
      await isVisible(page.getByTestId('orch-cowork-control'));
      expect(await page.locator('body').innerText()).not.toContain(SENTINEL);
      await page.getByTestId('nav-resources').click();
      await page.getByTestId('resources-details-toggle').click();
      expect(await page.locator('body').innerText()).not.toContain(SENTINEL);
      await openSettings(page, 'Providers');
      await page.getByRole('button', { name: 'Remove DeepSeek API key' }).click();
      await isVisible(page.getByRole('dialog', { name: 'Confirm connection action' }));
      await page.getByLabel('Connection name confirmation').fill('DeepSeek (API)');
      await page.getByRole('button', { name: 'Confirm connection action', exact: true }).click();
      await hasText(page.getByTestId('provider-card-deepseek'), 'Not saved');
    }
    await harness.close(app);
  });
});
