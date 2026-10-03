import { fileURLToPath } from 'node:url';
import type { ElectronApplication, Page } from 'playwright-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { POLL, addProject, createHarness, hasText, isVisible, type Harness } from './harness.js';

const FAKE_OPENWORKER = fileURLToPath(
  new URL('../../../tests/fixtures/fake-openworker.mjs', import.meta.url),
);
const FAKE_PLANE = fileURLToPath(
  new URL('../../../tests/fixtures/fake-plane.mjs', import.meta.url),
);
/** Never a real key: stored through the same clipboard flow the Providers scenarios use. */
const SENTINEL = 'sk-nexar-operating-layer-e2e-test-key-not-real-Q7m3';
const COMMIT_SHORT = 'c'.repeat(12);
const BRANCH = 'nexar/task-fake-1';
const PROPOSAL = 'Prepare a technical proposal for this project.';
const VERIFY = 'Now verify whether the repository implementation supports this proposal.';
const IMPLEMENT = 'Implement the missing part.';

let harness: Harness;

beforeAll(async () => {
  harness = await createHarness();
});

afterAll(async () => {
  await harness.dispose();
});

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

describe('Nexar Desktop Operating Layer', () => {
  it('carries documentation, review and engineering in one conversation and keeps it after a relaunch', async () => {
    const userData = harness.newUserData('operating-layer');
    // The fake plane holds a change run at the approval; reviews and plans report regardless.
    const env = {
      NEXAR_DESKTOP_TEST_OPENWORKER: FAKE_OPENWORKER,
      NEXAR_DESKTOP_TEST_PLANE: FAKE_PLANE,
      NEXAR_FAKE_PLANE_RUN: 'approve',
    };
    let app: ElectronApplication;
    let page: Page;
    ({ app, page } = await harness.launch(userData, env));
    await addProject(app, page, harness.projectDir);

    // --- Setup: provider key, OpenWorker access ---
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
      // Desktop never stores a key without OS encryption: the flow cannot run here.
      expect(await row.innerText()).toContain('Unavailable');
      await harness.close(app);
      return;
    }
    await app.evaluate(async ({ clipboard }, key) => {
      await clipboard.writeText(key);
    }, SENTINEL);
    await row.getByRole('button', { name: 'Save DeepSeek API key from clipboard' }).click();
    await hasText(row, 'ending in Q7m3');
    const access = page.getByTestId('openworker-access-deepseek');
    await expect.poll(() => access.isDisabled(), POLL).toBe(false);
    await access.click(); // controlled input: state follows main's reply (polled below)
    await expect.poll(() => access.isChecked(), POLL).toBe(true);
    expect(await page.locator('body').innerText()).not.toContain(SENTINEL);

    // --- Setup: map the project to the fake plane project ---
    await page.getByTestId('nav-chat').click();
    await page.getByTestId('mode-code').click();
    const codeBanner = page.getByTestId('code-banner');
    await expect.poll(state(codeBanner), POLL).toBe('project-unmapped');
    await page.getByTestId('plane-project-input').fill('plane-proj');
    await page.getByTestId('plane-project-save').click();
    await waitForReady(page, 'code-banner', 'code-refresh');

    // --- Both lanes ready, then one Cowork conversation ---
    await page.getByTestId('mode-cowork').click();
    await waitForReady(page, 'cowork-banner', 'cowork-refresh');
    await hasText(page.getByTestId('cowork-banner'), 'OpenWorker ready');
    await page.getByTestId('mode-code').click();
    await waitForReady(page, 'code-banner', 'code-refresh');
    await page.getByTestId('mode-cowork').click();
    await page.getByTestId('new-conversation').click();

    const turn = (n: number) => page.getByTestId('turn').nth(n);
    const succeeded = (n: number) =>
      expect.poll(() => turn(n).getAttribute('data-state'), POLL).toBe('succeeded');

    // --- Turn 1: documentation -> Cowork lane, OpenWorker, draft artifact ---
    await send(page, PROPOSAL);
    await succeeded(0);
    const expectDocumentation = async (): Promise<void> => {
      const t = turn(0);
      await hasText(t.getByTestId('lane-effective'), 'Lane: cowork');
      await hasText(t.getByTestId('lane-orchestrator'), 'Orchestrated by OpenWorker');
      expect((await t.getByTestId('result-text').innerText()).trim()).not.toBe('');
      await isVisible(t.getByTestId('artifact-card').first());
      expect(await t.getByTestId('engineering-panel').count()).toBe(0);
      expect(await t.getByTestId('lane-fallback').count()).toBe(0);
    };
    await expectDocumentation();
    const docText = await turn(0).getByTestId('result-text').innerText();
    const docLane = await turn(0).getByTestId('lane-orchestrator').innerText();
    const docArtifact = await turn(0).getByTestId('artifact-card').first().innerText();

    // --- Turn 2: review -> confirm cowork -> code, report only ---
    await send(page, VERIFY);
    await expect.poll(() => page.getByTestId('turn').count(), POLL).toBe(2);
    await isVisible(page.getByTestId('lane-confirm'));
    await page.getByRole('button', { name: 'Run in code lane' }).click();
    await succeeded(1);
    const expectReview = async (): Promise<void> => {
      const t = turn(1);
      await hasText(t.getByTestId('result-text'), 'The repository implementation supports');
      await hasText(t.getByTestId('engineering-panel'), 'Repository review');
      await hasText(t.getByTestId('eng-status'), 'Reported');
      await hasText(t.getByTestId('lane-effective'), 'Lane: code');
      for (const id of ['show-diff', 'eng-approval', 'eng-commit', 'approve-commit']) {
        expect(await t.getByTestId(id).count()).toBe(0);
      }
    };
    await expectReview();
    await page.getByTestId('nav-approvals').click();
    await isVisible(page.getByTestId('approvals-empty'));
    expect(await page.getByTestId('approval-card').count()).toBe(0);
    await page.getByTestId('nav-chat').click();

    // --- Turn 3: coding -> confirm -> engineering run waiting for the commit approval ---
    await send(page, IMPLEMENT);
    await expect.poll(() => page.getByTestId('turn').count(), POLL).toBe(3);
    await isVisible(page.getByTestId('lane-confirm'));
    await page.getByRole('button', { name: 'Run in code lane' }).click();
    const t3 = turn(2);
    await hasText(t3.getByTestId('eng-phase'), 'Waiting for your approval');
    await hasText(t3.getByTestId('eng-approval'), 'Waiting for your decision');
    await hasText(t3.getByTestId('eng-branch'), BRANCH);
    await page.getByTestId('nav-approvals').click();
    await hasText(page.getByTestId('approval-card'), 'engineering.commit');
    expect(await page.getByTestId('approval-card').count()).toBe(1);
    await page.getByTestId('nav-chat').click();
    await page.getByTestId('approve-commit').click();
    await succeeded(2);
    const expectCommit = async (): Promise<void> => {
      const t = turn(2);
      await hasText(t.getByTestId('eng-status'), 'Committed');
      await hasText(t.getByTestId('eng-approval'), 'Approved');
      await hasText(t.getByTestId('eng-branch'), BRANCH);
      await hasText(t.getByTestId('eng-commit'), COMMIT_SHORT);
      await hasText(t.getByTestId('lane-effective'), 'Lane: code');
    };
    await expectCommit();
    await expect.poll(() => page.getByTestId('approve-commit').count(), POLL).toBe(0);
    await page.getByTestId('nav-approvals').click();
    await isVisible(page.getByTestId('approvals-empty'));
    expect(await page.getByTestId('approval-card').count()).toBe(0);
    await page.getByTestId('nav-chat').click();

    // --- One conversation, three turns ---
    expect(await page.getByTestId('turn').count()).toBe(3);
    expect(await page.getByTestId('conversation-item').count()).toBe(1);
    expect(await page.locator('body').innerText()).not.toContain(SENTINEL);

    // --- relaunch: reopen the conversation, everything is still there ---
    await harness.close(app);
    ({ app, page } = await harness.launch(userData, env));
    await page.getByTestId('conversation-item').first().click();
    await expect.poll(() => page.getByTestId('turn').count(), POLL).toBe(3);
    expect(await page.getByTestId('conversation-item').count()).toBe(1);
    await expectDocumentation();
    expect(await turn(0).getByTestId('result-text').innerText()).toBe(docText);
    expect(await turn(0).getByTestId('lane-orchestrator').innerText()).toBe(docLane);
    expect(await turn(0).getByTestId('artifact-card').first().innerText()).toBe(docArtifact);
    await expectReview();
    await expectCommit();
    expect(await page.locator('body').innerText()).not.toContain(SENTINEL);

    await harness.close(app);
  });
});
