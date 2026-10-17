import type { Page } from 'playwright-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  FAKE_SUB,
  startFakeAuthServer,
  type FakeAuthServer,
} from '@nexar/integration-openai-account/testing';
import { startFakeResponsesServer, type FakeResponsesServer } from '@nexar/integration-pi/testing';
import { POLL, createHarness, hasText, isVisible, type Harness } from './harness.js';

/*
 * Connect a ChatGPT plan end to end (NXR-067): the real app and the real callback child, with a fake
 * auth server standing in for auth.openai.com and a fake Responses server for the Responses route.
 * Nothing here contacts OpenAI.
 */

let harness: Harness;
let auth: FakeAuthServer;
let responses: FakeResponsesServer;

beforeAll(async () => {
  harness = await createHarness();
  auth = await startFakeAuthServer();
  responses = await startFakeResponsesServer();
});

afterAll(async () => {
  await auth.close();
  await responses.close();
  await harness.dispose();
});

async function openSettings(page: Page, tab: string): Promise<void> {
  await page.getByTestId('nav-settings').click();
  await page.getByRole('tab', { name: tab, exact: true }).click();
}

/** The control candidates (option values) Cowork's control dropdown offers. */
const controlValues = async (page: Page, testId = 'orch-cowork-control'): Promise<string[]> => {
  const options = await page.getByTestId(testId).locator('option').all();
  return Promise.all(options.map(async (option) => (await option.getAttribute('value')) ?? ''));
};

// Nothing of the sign-in may reach the page: no token, code, subject, client id or loopback address.
const SENTINELS = [
  'access-token-sentinel',
  'refresh-token-sentinel',
  'code-sentinel',
  FAKE_SUB,
  'oaiapp_',
  '127.0.0.1',
  'code_verifier',
];

describe('Nexar Desktop ChatGPT plan', () => {
  it('connects, offers the plan as a Cowork control candidate, and disconnects', async () => {
    const userData = harness.newUserData('chatgpt-plan');
    const { app, page } = await harness.launch(userData, {
      NEXAR_DESKTOP_TEST_CHATGPT_ISSUER: auth.issuer,
      NEXAR_DESKTOP_TEST_RESPONSES_URL: responses.url,
    });
    const encrypted = await app.evaluate(({ safeStorage }) => safeStorage.isEncryptionAvailable());
    if (!encrypted) {
      // Sign-in refuses without secure storage; the fixed refusal is the behavior to see.
      await openSettings(page, 'Providers');
      await page.getByRole('button', { name: 'Connect ChatGPT plan', exact: true }).click();
      await hasText(page.getByTestId('chatgpt-plan-status'), 'Secure credential storage');
      process.stderr.write(
        'chatgpt-plan e2e: secure storage unavailable, checked the refusal only\n',
      );
      await harness.close(app);
      return;
    }

    // --- Providers → OpenAI: the ChatGPT plan method, signed out ---
    await openSettings(page, 'Providers');
    const method = page.getByTestId('chatgpt-plan');
    await isVisible(method);
    await hasText(page.getByTestId('chatgpt-plan-state'), 'Not connected');
    await hasText(method, 'ChatGPT plan (Sign in with ChatGPT)');
    await hasText(
      method,
      "Uses your ChatGPT plan's usage. Manage limits or revoke access in ChatGPT settings.",
    );
    await openSettings(page, 'AI behavior');
    await isVisible(page.getByTestId('orch-cowork-control'));
    expect((await controlValues(page)).some((v) => v.startsWith('inventory:'))).toBe(false);

    // --- Connect: the fake browser follows the authorize redirect to the real callback child ---
    await openSettings(page, 'Providers');
    await page.getByRole('button', { name: 'Connect ChatGPT plan', exact: true }).click();
    await hasText(page.getByTestId('chatgpt-plan-state'), 'Connected');
    expect(
      await page.getByRole('button', { name: 'Connect ChatGPT plan', exact: true }).isDisabled(),
    ).toBe(true);
    expect(auth.tokenRequests[0]).toMatchObject({ grant_type: 'authorization_code' });

    // --- The plan is a model-turn resource and a Cowork control candidate ---
    await openSettings(page, 'AI behavior');
    await expect
      .poll(async () => (await controlValues(page)).some((v) => v.startsWith('inventory:')), POLL)
      .toBe(true);
    const originalId = (await controlValues(page)).find((v) => v.startsWith('inventory:'))!;
    const control = page.getByTestId('orch-cowork-control');
    await control.selectOption(originalId);
    await expect.poll(() => control.inputValue(), POLL).toBe(originalId);
    await control.selectOption('');
    await expect.poll(() => control.inputValue(), POLL).toBe('');
    await page.getByTestId('nav-resources').click();
    await isVisible(page.getByTestId('resources-table'));
    await hasText(page.getByTestId('resources-table'), 'New account model');
    // Probing and listing never call the model.
    expect(responses.requests).toHaveLength(0);
    expect(responses.modelRequests.length).toBeGreaterThan(0);

    // An authoritative catalog refresh replaces candidates without running inference.
    responses.setModels([
      { slug: 'gpt-another-returned-model', displayName: 'Another account model' },
    ]);
    await openSettings(page, 'Providers');
    await page.getByRole('button', { name: 'Refresh chatgpt-plan models', exact: true }).click();
    await hasText(page.getByTestId('inventory-chatgpt-plan'), 'Another account model');
    await openSettings(page, 'AI behavior');
    await expect
      .poll(async () => (await controlValues(page)).includes(originalId), POLL)
      .toBe(false);
    await expect
      .poll(async () => (await controlValues(page)).some((v) => v.startsWith('inventory:')), POLL)
      .toBe(true);
    responses.setModels([]);
    await openSettings(page, 'Providers');
    await page.getByRole('button', { name: 'Refresh chatgpt-plan models', exact: true }).click();
    await hasText(page.getByTestId('inventory-chatgpt-plan'), 'No explicit models verified');
    await openSettings(page, 'AI behavior');
    await expect
      .poll(async () => (await controlValues(page)).some((v) => v.startsWith('inventory:')), POLL)
      .toBe(false);
    responses.setModels([{ slug: 'gpt-new-not-static', displayName: 'New account model' }]);
    await openSettings(page, 'Providers');
    await page.getByRole('button', { name: 'Refresh chatgpt-plan models', exact: true }).click();
    await openSettings(page, 'AI behavior');
    await expect
      .poll(async () => (await controlValues(page)).includes(originalId), POLL)
      .toBe(true);
    await expect
      .poll(
        async () => (await controlValues(page, 'behavior-cowork-resource')).includes(originalId),
        POLL,
      )
      .toBe(true);

    // --- Nothing of the sign-in is in the page ---
    for (const where of ['Providers', 'AI behavior']) {
      await openSettings(page, where);
      const body = await page.locator('body').innerText();
      for (const sentinel of SENTINELS) expect(body).not.toContain(sentinel);
    }

    // --- Disconnect removes the candidate ---
    await openSettings(page, 'Providers');
    await page.getByRole('button', { name: 'Disconnect ChatGPT plan', exact: true }).click();
    await isVisible(page.getByRole('dialog', { name: 'Confirm connection action' }));
    await page.getByLabel('Connection name confirmation').fill('ChatGPT Plan');
    await page.getByRole('button', { name: 'Confirm connection action', exact: true }).click();
    await hasText(page.getByTestId('chatgpt-plan-state'), 'Not connected');
    await openSettings(page, 'AI behavior');
    await expect
      .poll(async () => (await controlValues(page)).some((v) => v.startsWith('inventory:')), POLL)
      .toBe(false);
    await page.getByTestId('nav-resources').click();
    await isVisible(page.getByTestId('resources-table'));
    // Opening the page reloads the list asynchronously; the previous rows show until it arrives.
    await expect
      .poll(
        async () =>
          (await page.getByTestId('resources-table').innerText()).includes('New account model'),
        POLL,
      )
      .toBe(false);
    expect(responses.requests).toHaveLength(0);
    // Sequential replacement creates a different identity; only a new owner sign-in can bind it.
    await openSettings(page, 'Providers');
    await page
      .getByRole('article', { name: 'ChatGPT Plan', exact: true })
      .getByRole('button', { name: 'Replace Plan account', exact: true })
      .click();
    await isVisible(page.getByRole('dialog', { name: 'Confirm connection action' }));
    await page.getByRole('button', { name: 'Confirm connection action', exact: true }).click();
    await hasText(
      page.getByRole('article', { name: 'ChatGPT Plan retired', exact: true }),
      'Permanently retired',
    );
    {
      auth.idClaims = { sub: 'synthetic-replacement-subject' };
      try {
        await page.getByRole('button', { name: 'Connect ChatGPT plan', exact: true }).click();
        await hasText(page.getByTestId('chatgpt-plan-state'), 'Connected');
        await openSettings(page, 'AI behavior');
        await expect
          .poll(
            async () =>
              (await controlValues(page)).some(
                (v) => v.startsWith('inventory:') && v !== originalId,
              ),
            POLL,
          )
          .toBe(true);
        expect(await controlValues(page)).not.toContain(originalId);
        expect(await page.locator('body').innerText()).not.toContain(
          'synthetic-replacement-subject',
        );
      } finally {
        auth.idClaims = {};
      }
    }
    await harness.close(app);
  }, 180_000);
});
