import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { POLL, addProject, createHarness, hasText, isVisible, type Harness } from './harness.js';

const FAKE_PLANE = fileURLToPath(
  new URL('../../../tests/fixtures/fake-plane.mjs', import.meta.url),
);
const COMMIT_SHORT = 'c'.repeat(12);
const BRANCH = 'nexar/task-fake-1';

let harness: Harness;

beforeAll(async () => {
  harness = await createHarness();
});

afterAll(async () => {
  await harness.dispose();
});

describe('Nexar Desktop Code lane', () => {
  it('runs an engineering turn against the fake plane, from mapping to the commit', async () => {
    const userData = harness.newUserData('with-plane');
    // The fake plane holds the run at the approval, so the owner decides in the window.
    const planeEnv = { NEXAR_DESKTOP_TEST_PLANE: FAKE_PLANE, NEXAR_FAKE_PLANE_RUN: 'approve' };
    let { app, page } = await harness.launch(userData, planeEnv);
    await addProject(app, page, harness.projectDir);

    // --- Code mode: the project is not mapped to a plane project yet ---
    await page.getByTestId('mode-code').click();
    const banner = page.getByTestId('code-banner');
    await expect
      .poll(() => banner.getAttribute('data-state').catch(() => null), POLL)
      .toBe('project-unmapped');
    await hasText(page.getByTestId('code-banner-reason'), 'not mapped');
    await isVisible(page.getByTestId('code-refresh'));
    // The mapping form takes an id only; an invalid one is refused before anything is sent.
    await page.getByTestId('plane-project-input').fill('C:\\some\\path');
    await page.getByTestId('plane-project-save').click();
    await hasText(page.getByRole('alert').filter({ hasText: 'lowercase letters' }), 'lowercase');
    await expect.poll(() => banner.getAttribute('data-state'), POLL).toBe('project-unmapped');

    await page.getByTestId('plane-project-input').fill('plane-proj');
    await page.getByTestId('plane-project-save').click();
    await expect
      .poll(() => banner.getAttribute('data-state').catch(() => null), POLL)
      .toBe('ready');
    await hasText(banner, 'Engineering plane ready');
    await hasText(page.getByTestId('code-banner-version'), '0.0.0-fake');

    // --- Settings -> Code shows the same state, read-only, and the mapping ---
    await page.getByTestId('nav-settings').click();
    await page.getByRole('tab', { name: 'Code' }).click();
    await hasText(page.getByTestId('code-settings'), 'nexar-plane');
    await hasText(page.getByTestId('plane-state'), 'ready');
    await hasText(page.getByTestId('plane-version'), '0.0.0-fake');
    await hasText(page.getByTestId('plane-kernel'), '5.15.0-fake-WSL2');
    await hasText(page.getByTestId('plane-mapping-current'), 'Plane project: plane-proj');
    await page.getByTestId('code-settings-refresh').click();
    await hasText(page.getByTestId('plane-state'), 'ready');
    await page.getByTestId('nav-chat').click();

    // --- an engineering request: progress, then the approval it waits for ---
    await page.getByTestId('new-conversation').click();
    await page.getByLabel('Message').fill('Implement the missing part.');
    await page.getByRole('button', { name: 'Send' }).click();
    const panel = page.getByTestId('engineering-panel');
    await isVisible(panel);
    await hasText(page.getByTestId('eng-goal'), 'Implement the missing part.');
    await hasText(page.getByTestId('eng-lane'), 'code');
    await hasText(page.getByTestId('eng-phase'), 'Waiting for your approval');
    await hasText(page.getByTestId('eng-approval'), 'Waiting for your decision');
    await hasText(page.getByTestId('eng-files'), '2');
    await hasText(page.getByTestId('eng-gates'), '3');
    await hasText(page.getByTestId('eng-verdict'), 'approve');
    await hasText(page.getByTestId('eng-branch'), BRANCH);
    await hasText(page.getByTestId('eng-task'), 'task_fake_1');
    await hasText(
      page.getByTestId('eng-approve-note'),
      'Approving lets Nexar create a local commit on a new branch. Nothing is pushed.',
    );

    // The same approval is listed in the Approvals view.
    await page.getByTestId('nav-approvals').click();
    const card = page.getByTestId('approval-card');
    await hasText(card, 'engineering.commit');
    await hasText(card, `branch ${BRANCH}`);
    await hasText(page.getByTestId('approval-plane-note'), 'Nothing is pushed.');
    await page.getByTestId('nav-chat').click();

    // --- the diff, as text, with its files ---
    await page.getByTestId('show-diff').click();
    await hasText(page.getByTestId('diff-files'), 'src/b.ts');
    await hasText(page.getByTestId('diff-files'), 'a.txt');
    await hasText(page.getByTestId('diff-view'), '+new');
    await hasText(page.getByTestId('diff-view'), '-old');
    expect(await page.getByTestId('diff-view').locator('.diff-add').count()).toBeGreaterThan(0);
    expect(await page.getByTestId('diff-view').locator('.diff-del').count()).toBeGreaterThan(0);
    expect(await page.getByTestId('diff-view').locator('.diff-hunk').count()).toBe(1);

    // --- approve: the commit is created and the turn ends ---
    await page.getByTestId('approve-commit').click();
    const turn = page.getByTestId('turn').first();
    await expect.poll(() => turn.getAttribute('data-state'), POLL).toBe('succeeded');
    await hasText(page.getByTestId('eng-status'), 'Committed');
    await hasText(page.getByTestId('eng-approval'), 'Approved');
    await hasText(page.getByTestId('eng-branch'), BRANCH);
    await hasText(page.getByTestId('eng-commit'), COMMIT_SHORT);
    await hasText(page.getByTestId('eng-gates'), '3');
    await hasText(page.getByTestId('eng-verdict'), 'approve');
    await expect.poll(() => page.getByTestId('approve-commit').count(), POLL).toBe(0);
    await hasText(page.getByTestId('result-text'), 'The engineering changes were committed.');
    await hasText(page.getByTestId('lane-effective'), 'Lane: code');

    // --- a message that is not an engineering request runs direct, and says why ---
    await page.getByLabel('Message').fill('Explain this repository');
    await page.getByRole('button', { name: 'Send' }).click();
    await expect.poll(() => page.getByTestId('turn').count(), POLL).toBe(2);
    await hasText(
      page.getByTestId('lane-fallback'),
      'Only engineering requests run on the engineering plane; this one ran with Nexar direct execution.',
    );
    await hasText(page.getByTestId('lane-effective').nth(1), 'Lane: direct');
    await expect
      .poll(() => page.getByTestId('turn').nth(1).getAttribute('data-state'), POLL)
      .toBe('succeeded');
    expect(await page.getByTestId('engineering-panel').count()).toBe(1);

    // --- relaunch: the engineering summary is still there; the diff is not kept ---
    await harness.close(app);
    ({ app, page } = await harness.launch(userData, planeEnv));
    await expect.poll(() => page.getByTestId('turn').count(), POLL).toBe(2);
    await hasText(page.getByTestId('eng-status'), 'Committed');
    await hasText(page.getByTestId('eng-branch'), BRANCH);
    await hasText(page.getByTestId('eng-commit'), COMMIT_SHORT);
    await hasText(page.getByTestId('eng-approval'), 'Approved');
    expect(await page.getByTestId('engineering-panel').count()).toBe(1);
    await page.getByTestId('show-diff').click();
    await hasText(page.getByTestId('diff-unavailable'), 'Diff unavailable after restart');
    // The mapping survived too: the lane is ready again.
    await expect
      .poll(
        () =>
          page
            .getByTestId('code-banner')
            .getAttribute('data-state')
            .catch(() => null),
        POLL,
      )
      .toBe('ready');

    await harness.close(app);
  });

  it('runs a confirmed review on the plane and keeps the report and panel after a relaunch', async () => {
    const userData = harness.newUserData('review-plane');
    const planeEnv = { NEXAR_DESKTOP_TEST_PLANE: FAKE_PLANE };
    let { app, page } = await harness.launch(userData, planeEnv);
    await addProject(app, page, harness.projectDir);

    // Map the project from Code mode, then work in a Cowork conversation.
    await page.getByTestId('mode-code').click();
    const banner = page.getByTestId('code-banner');
    await expect
      .poll(() => banner.getAttribute('data-state').catch(() => null), POLL)
      .toBe('project-unmapped');
    await page.getByTestId('plane-project-input').fill('plane-proj');
    await page.getByTestId('plane-project-save').click();
    await expect
      .poll(() => banner.getAttribute('data-state').catch(() => null), POLL)
      .toBe('ready');

    await page.getByTestId('mode-cowork').click();
    await page.getByTestId('nav-chat').click();
    await page.getByTestId('new-conversation').click();
    await page
      .getByLabel('Message')
      .fill('Now verify whether the repository implementation supports this proposal.');
    await page.getByRole('button', { name: 'Send' }).click();
    await isVisible(page.getByTestId('lane-confirm'));
    await page.getByRole('button', { name: 'Run in code lane' }).click();

    const turn = page.getByTestId('turn').first();
    await expect.poll(() => turn.getAttribute('data-state'), POLL).toBe('succeeded');
    const expectReview = async (): Promise<void> => {
      await hasText(page.getByTestId('result-text'), 'The repository implementation supports');
      const panel = page.getByTestId('engineering-panel');
      await hasText(panel, 'Repository review');
      await hasText(page.getByTestId('eng-status'), 'Reported');
      await hasText(page.getByTestId('eng-plan'), 'Repository report');
      await hasText(page.getByTestId('eng-resources'), 'report: dsh:deepseek');
      await hasText(page.getByTestId('lane-effective'), 'Lane: code');
      for (const id of [
        'show-diff',
        'eng-files',
        'eng-gates',
        'eng-verdict',
        'eng-approval',
        'eng-branch',
        'eng-commit',
        'approve-commit',
        'deny-commit',
      ]) {
        expect(await page.getByTestId(id).count()).toBe(0);
      }
    };
    await expectReview();
    expect(await page.getByTestId('lane-fallback').count()).toBe(0);

    await page.getByTestId('nav-approvals').click();
    await isVisible(page.getByTestId('approvals-empty'));
    expect(await page.getByTestId('approval-card').count()).toBe(0);
    await page.getByTestId('nav-chat').click();

    // --- relaunch: the report and the panel are still there ---
    await harness.close(app);
    ({ app, page } = await harness.launch(userData, planeEnv));
    await expect.poll(() => page.getByTestId('turn').count(), POLL).toBe(1);
    await expectReview();

    await harness.close(app);
  });

  it('runs the Plan profile: an implementation plan with no approval and no change', async () => {
    const userData = harness.newUserData('plan-profile');
    const planeEnv = { NEXAR_DESKTOP_TEST_PLANE: FAKE_PLANE };
    let { app, page } = await harness.launch(userData, planeEnv);
    await addProject(app, page, harness.projectDir);

    await page.getByTestId('mode-code').click();
    const banner = page.getByTestId('code-banner');
    await expect
      .poll(() => banner.getAttribute('data-state').catch(() => null), POLL)
      .toBe('project-unmapped');
    await page.getByTestId('plane-project-input').fill('plane-proj');
    await page.getByTestId('plane-project-save').click();
    await expect
      .poll(() => banner.getAttribute('data-state').catch(() => null), POLL)
      .toBe('ready');

    // --- Settings -> AI behavior: Code -> Plan; unsupported options are shown disabled ---
    await page.getByTestId('nav-settings').click();
    await page.getByRole('tab', { name: 'AI behavior' }).click();
    await isVisible(page.getByTestId('behavior-settings'));
    expect(await page.getByTestId('behavior-code-auto-edit').isChecked()).toBe(true);
    for (const id of ['ask-before-edits', 'full-auto']) {
      expect(await page.getByTestId(`behavior-code-${id}`).isDisabled()).toBe(true);
    }
    await hasText(page.getByTestId('behavior-code'), 'Not supported yet');
    await hasText(page.getByTestId('behavior-effort'), 'not supported yet');
    await hasText(page.getByTestId('behavior-locked'), 'Every write runs inside the sandbox.');
    await page.getByTestId('behavior-code-plan').click(); // controlled input: state follows main's reply (polled below)
    await expect.poll(() => page.getByTestId('behavior-code-plan').isChecked(), POLL).toBe(true);

    // --- an engineering request becomes an implementation plan ---
    await page.getByTestId('nav-chat').click();
    await page.getByTestId('new-conversation').click();
    await page.getByLabel('Message').fill('Implement the missing part.');
    await page.getByRole('button', { name: 'Send' }).click();
    const turn = page.getByTestId('turn').first();
    await expect.poll(() => turn.getAttribute('data-state'), POLL).toBe('succeeded');
    const expectPlan = async (): Promise<void> => {
      await hasText(page.getByTestId('result-text'), 'Implementation plan');
      await hasText(page.getByTestId('result-text'), 'Files to touch');
      await hasText(page.getByTestId('engineering-panel'), 'Implementation plan');
      await hasText(page.getByTestId('eng-status'), 'Reported');
      await hasText(page.getByTestId('eng-plan'), 'Implementation plan');
      await hasText(page.getByTestId('lane-effective'), 'Lane: code');
      for (const id of [
        'show-diff',
        'eng-approval',
        'eng-branch',
        'eng-commit',
        'approve-commit',
      ]) {
        expect(await page.getByTestId(id).count()).toBe(0);
      }
    };
    await expectPlan();

    await page.getByTestId('nav-approvals').click();
    await isVisible(page.getByTestId('approvals-empty'));
    expect(await page.getByTestId('approval-card').count()).toBe(0);

    // --- relaunch: the choice and the plan are still there ---
    await harness.close(app);
    ({ app, page } = await harness.launch(userData, planeEnv));
    await expect.poll(() => page.getByTestId('turn').count(), POLL).toBe(1);
    await expectPlan();
    await page.getByTestId('nav-settings').click();
    await page.getByRole('tab', { name: 'AI behavior' }).click();
    await expect.poll(() => page.getByTestId('behavior-code-plan').isChecked(), POLL).toBe(true);

    await harness.close(app);
  });
  it('shows why the Code lane cannot run and refuses an engineering request', async () => {
    const userData = harness.newUserData('without-plane');
    const { app, page } = await harness.launch(userData);
    await addProject(app, page, harness.projectDir);

    await page.getByTestId('mode-code').click();
    const banner = page.getByTestId('code-banner');
    await expect
      .poll(() => banner.getAttribute('data-state').catch(() => null), POLL)
      .toBe('wsl-unavailable');
    await hasText(page.getByTestId('code-banner-reason'), 'WSL is not available on this computer');
    await isVisible(page.getByTestId('code-refresh'));
    // Nothing to map while the plane itself is unreachable.
    expect(await page.getByTestId('plane-project-form').count()).toBe(0);

    await page.getByTestId('new-conversation').click();
    await page.getByLabel('Message').fill('Implement the missing part.');
    await page.getByRole('button', { name: 'Send' }).click();
    const refusal = page.getByTestId('turn-refusal');
    await hasText(refusal, 'Code lane');
    await hasText(refusal, 'WSL is not available on this computer');
    expect(await page.getByTestId('engineering-panel').count()).toBe(0);
    expect(await page.getByTestId('result-text').count()).toBe(0);

    await page.getByTestId('nav-settings').click();
    await page.getByRole('tab', { name: 'Code' }).click();
    await hasText(page.getByTestId('plane-state'), 'wsl-unavailable');

    await harness.close(app);
  });
});
