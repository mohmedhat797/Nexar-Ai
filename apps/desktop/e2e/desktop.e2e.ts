import { mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  _electron as electron,
  type ElectronApplication,
  type Locator,
  type Page,
} from 'playwright-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const MAIN = fileURLToPath(new URL('../dist/main/main.js', import.meta.url));
const EXECUTABLE = process.env['NEXAR_DESKTOP_EXECUTABLE'];

let base: string;
let userData: string;
let projectDir: string;
const apps: ElectronApplication[] = [];
/** Recent stdout/stderr of the apps this file launched, printed when a launch fails. */
let output: string[] = [];
const POLL = { timeout: 60_000, interval: 200 };

const text = (locator: Locator): Promise<string> => locator.innerText();
/** Waits until the locator's text contains `needle`. */
const hasText = (locator: Locator, needle: string): Promise<void> =>
  expect.poll(() => text(locator).catch(() => ''), POLL).toContain(needle);
const isVisible = (locator: Locator): Promise<void> =>
  expect.poll(() => locator.isVisible().catch(() => false), POLL).toBe(true);

/** Chromium flags are for the root-in-container test environment only; production keeps its sandbox. */
async function launch(): Promise<{ app: ElectronApplication; page: Page }> {
  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] => entry[1] !== undefined,
    ),
  );
  env['NEXAR_DESKTOP_USER_DATA'] = userData;
  env['NEXAR_DESKTOP_STARTUP_TRACE'] = '1';
  if (EXECUTABLE) {
    // Prove the installed layout finds its own catalogs, with no repository-path override.
    delete env['NEXAR_WORKFLOWS_DIR'];
    delete env['NEXAR_ENGINEERING_PLANS_DIR'];
  }
  const app = await electron.launch({
    ...(EXECUTABLE ? { executablePath: EXECUTABLE } : {}),
    args: [
      ...(EXECUTABLE ? [] : [MAIN]),
      ...(process.platform === 'linux' ? ['--no-sandbox'] : []),
      '--disable-gpu',
      '--disable-dev-shm-usage',
      // No X server (and no `xvfb-run`): fall back to Chromium's display-less platform.
      ...(process.platform === 'linux' && !process.env['DISPLAY']
        ? ['--ozone-platform=headless']
        : []),
    ],
    env,
  });
  apps.push(app);
  output = [];
  const capture = (chunk: Buffer): void => {
    output.push(chunk.toString());
    if (output.length > 200) output.shift();
  };
  app.process().stdout?.on('data', capture);
  app.process().stderr?.on('data', capture);
  try {
    // A freshly packaged app is cold-started under antivirus scanning on CI runners.
    const page = await app.firstWindow({ timeout: EXECUTABLE ? 90_000 : 30_000 });
    await page.waitForSelector('.app, [data-testid="open-folder-cta"]', { timeout: 60_000 });
    return { app, page };
  } catch (error) {
    // A launch that never shows its window must not keep running into the next scenario, where it
    // would still hold the sessions lease and the shared state directory.
    app.process().kill();
    apps.splice(apps.indexOf(app), 1);
    process.stderr.write(
      `desktop e2e launch failed; app output:\n${output.join('').slice(-8000)}\n`,
    );
    throw error;
  }
}

/** Closes the app and waits until its process has exited before the state is reused. */
async function close(app: ElectronApplication): Promise<void> {
  const child = app.process();
  await app.close();
  apps.splice(apps.indexOf(app), 1);
  const deadline = Date.now() + 20_000;
  while (child.exitCode === null && child.signalCode === null && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  if (child.exitCode === null && child.signalCode === null) child.kill();
}

beforeAll(async () => {
  base = await realpath(await mkdtemp(join(tmpdir(), 'nexar-e2e-')));
  userData = join(base, 'userData');
  projectDir = join(base, 'my-project with spaces');
  await mkdir(join(projectDir, 'notes'), { recursive: true });
  await writeFile(join(projectDir, 'readme-seed.txt'), 'seeded file content\n');
});

afterAll(async () => {
  await Promise.all(apps.map((a) => a.close().catch(() => undefined)));
  // A just-ended app can briefly hold browser files on Windows; the async rm retries (bounded).
  await rm(base, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
});

describe('Nexar Desktop', () => {
  it('runs the first-run scenario and persists state across a relaunch', async () => {
    let { app, page } = await launch();
    expect(await app.evaluate(({ app: running }) => running.isPackaged)).toBe(Boolean(EXECUTABLE));

    // Loading through the public bridge proves the workflow catalog is included and resolved.
    const catalog = await page.evaluate(async () => {
      const api = (globalThis as unknown as { nexar: { listWorkflows: () => Promise<unknown> } })
        .nexar;
      return api.listWorkflows();
    });
    expect(catalog).toMatchObject({ ok: true });
    expect(Array.isArray((catalog as { value: unknown }).value)).toBe(true);
    expect((catalog as { value: unknown[] }).value.length).toBeGreaterThan(0);

    // --- window hardening, asserted from the main process and from inside the page ---
    const prefs = await app.evaluate(({ BrowserWindow }) => {
      // Present at run time, absent from the bundled type definitions.
      const contents = BrowserWindow.getAllWindows()[0]?.webContents as unknown as
        { getLastWebPreferences?: () => Record<string, unknown> } | undefined;
      const p = contents?.getLastWebPreferences?.() ?? {};
      return {
        sandbox: p['sandbox'],
        contextIsolation: p['contextIsolation'],
        nodeIntegration: p['nodeIntegration'],
      };
    });
    expect(prefs).toEqual({ sandbox: true, contextIsolation: true, nodeIntegration: false });
    expect(
      await page.evaluate(() => {
        const w = globalThis as unknown as Record<string, unknown>;
        return {
          require: typeof w['require'],
          process: typeof w['process'],
          bridge: Object.keys(w['nexar'] as object).includes('onTaskEvent'),
        };
      }),
    ).toEqual({ require: 'undefined', process: 'undefined', bridge: true });

    // --- first run: call to action, then add a project through the (stubbed) native dialog ---
    await isVisible(page.getByTestId('open-folder-cta'));
    await app.evaluate(({ dialog }, dir) => {
      dialog.showOpenDialog = () => Promise.resolve({ canceled: false, filePaths: [dir] });
    }, projectDir);
    await page.getByRole('button', { name: 'Open folder as project…' }).first().click();
    await hasText(page.getByTestId('chat-title'), 'my-project');

    // --- files panel lists the seeded file and previews it ---
    const files = page.getByTestId('files-panel');
    await isVisible(files.getByText('readme-seed.txt'));
    await files.getByText('readme-seed.txt').click();
    await hasText(page.getByTestId('file-preview'), 'seeded file content');

    // --- send a prompt: routing card, result text, draft artifact ---
    await page.getByLabel('Message').fill('Say hello to the project');
    await page.getByRole('button', { name: 'Send' }).click();
    await hasText(page.getByTestId('routing-resource'), 'local-echo');
    await expect
      .poll(() => text(page.getByTestId('result-text')).catch(() => ''), POLL)
      .not.toBe('');
    await hasText(page.getByTestId('artifact-card'), 'result.md');
    await page.getByRole('button', { name: 'Why this choice?' }).click();
    await hasText(page.locator('.candidates'), 'local-echo');
    await hasText(page.getByTestId('today-card'), 'Tasks');

    // The draft really is inside the project, under .nexar/artifacts (ADR-013).
    const artifactsRoot = join(projectDir, '.nexar', 'artifacts');
    const tasks = await readdir(artifactsRoot);
    expect(tasks).toHaveLength(1);
    const stored = await readFile(
      join(artifactsRoot, tasks[0] ?? '', 'drafts', 'result.md'),
      'utf8',
    );
    expect(stored.length).toBeGreaterThan(0);

    // --- theme: Settings → Appearance → Dark ---
    await page.getByTestId('nav-settings').click();
    await page.getByTestId('theme-dark').click();
    await expect.poll(() => page.locator('html').getAttribute('data-theme'), POLL).toBe('dark');

    // --- relaunch: theme persisted, project still listed ---
    await close(app);
    ({ app, page } = await launch());
    await expect.poll(() => page.locator('html').getAttribute('data-theme'), POLL).toBe('dark');
    await hasText(page.getByTestId('project-list'), 'my-project');

    // --- AI resources lists local-echo ---
    await page.getByTestId('nav-resources').click();
    await hasText(page.getByTestId('resources-table'), 'local-echo');

    // --- Approvals is empty ---
    await page.getByTestId('nav-approvals').click();
    await isVisible(page.getByTestId('approvals-empty'));

    // --- Code mode keeps the conversation and sidebar; without a plane the banner says why ---
    await page.getByTestId('nav-chat').click();
    await page.getByTestId('mode-code').click();
    await hasText(page.getByTestId('code-banner-reason'), 'WSL is not available on this computer');
    await isVisible(page.getByTestId('code-refresh'));
    await isVisible(page.getByLabel('Message'));
    expect(await page.getByTestId('code-placeholder').count()).toBe(0);
    await isVisible(page.getByTestId('nav-settings'));

    await close(app);
    // Chromium runtime data stays out of the ACL-guarded state tree: the guard visits every entry
    // at startup, and browser caches grow without bound.
    expect(
      (await readdir(userData)).filter((name) => /cache|storage|crashpad|blob/i.test(name)),
    ).toEqual([]);
    expect((await readdir(`${userData}.runtime`)).length).toBeGreaterThan(0);
  });

  it('keeps a conversation across turns and a relaunch', async () => {
    let { app, page } = await launch();
    // The first scenario left the app in Code mode; conversations live in Cowork.
    await page.getByTestId('mode-cowork').click();
    await page.getByTestId('nav-chat').click();
    await hasText(page.getByTestId('project-list'), 'my-project');

    const turns = page.getByTestId('turn');
    const results = page.getByTestId('result-text');
    const send = async (prompt: string, expected: number): Promise<void> => {
      await page.getByLabel('Message').fill(prompt);
      await page.getByRole('button', { name: 'Send' }).click();
      await expect.poll(() => results.count(), POLL).toBe(expected);
      await hasText(results.nth(expected - 1), prompt);
    };

    // The earlier scenario's conversation is listed; a new one starts empty.
    const conversations = page.getByTestId('conversation-item');
    await expect.poll(() => conversations.count(), POLL).toBe(1);
    await page.getByTestId('new-conversation').click();
    await expect.poll(() => conversations.count(), POLL).toBe(2);
    await expect.poll(() => turns.count(), POLL).toBe(0);

    await send('Plan the first milestone', 1);
    await send('Now plan the second milestone', 2);
    await expect.poll(() => turns.count(), POLL).toBe(2);
    await hasText(turns.nth(0), 'Plan the first milestone');
    await hasText(turns.nth(1), 'Now plan the second milestone');
    await expect.poll(() => page.getByTestId('artifact-card').count(), POLL).toBe(2);
    await hasText(page.getByTestId('conversation-list'), 'Plan the first milestone');

    // Sessions are private owner state under the app's state tree, never in the project.
    const sessionsDir = join(userData, '.nexar', 'sessions');
    const files = (await readdir(sessionsDir)).filter((name) => name.endsWith('.json'));
    expect(files).toHaveLength(2);
    const stored = await Promise.all(files.map((f) => readFile(join(sessionsDir, f), 'utf8')));
    expect(stored.some((json) => json.includes('Now plan the second milestone'))).toBe(true);
    expect(await readdir(projectDir)).not.toContain('sessions');

    // --- relaunch: the conversation is listed and both turns are still there ---
    await close(app);
    ({ app, page } = await launch());
    await page.getByTestId('mode-cowork').click();
    await page.getByTestId('nav-chat').click();
    await expect.poll(() => page.getByTestId('conversation-item').count(), POLL).toBe(2);
    await page
      .getByTestId('conversation-item')
      .filter({ hasText: 'Plan the first milestone' })
      .click();
    await expect.poll(() => page.getByTestId('turn').count(), POLL).toBe(2);
    await hasText(page.getByTestId('turn').nth(0), 'Plan the first milestone');
    await hasText(page.getByTestId('turn').nth(1), 'Now plan the second milestone');
    await expect.poll(() => page.getByTestId('turn-state').count(), POLL).toBe(0);

    // --- a third turn continues the same conversation ---
    await page.getByLabel('Message').fill('Plan the third milestone');
    await page.getByRole('button', { name: 'Send' }).click();
    await expect.poll(() => page.getByTestId('result-text').count(), POLL).toBe(3);
    await expect.poll(() => page.getByTestId('turn').count(), POLL).toBe(3);
    await hasText(page.getByTestId('result-text').nth(2), 'Plan the third milestone');

    await close(app);
  });

  it('asks before switching lane, shows the fallback and refuses engineering writes', async () => {
    const { app, page } = await launch();
    await page.getByTestId('mode-cowork').click();
    await page.getByTestId('nav-chat').click();
    await hasText(page.getByTestId('project-list'), 'my-project');
    await page.getByTestId('new-conversation').click();

    const turns = page.getByTestId('turn');
    const results = page.getByTestId('result-text');
    await expect.poll(() => turns.count(), POLL).toBe(0);
    await isVisible(page.getByTestId('session-mode-cowork'));
    const send = async (prompt: string): Promise<void> => {
      await page.getByLabel('Message').fill(prompt);
      await page.getByRole('button', { name: 'Send' }).click();
    };

    // A repository check looks like Code work in a Cowork conversation: Nexar asks first.
    await send('Now verify whether the repository implementation supports this proposal.');
    const card = page.getByTestId('lane-confirm');
    await isVisible(card);
    await hasText(
      card,
      'This request looks like code work, but this conversation is in cowork mode.',
    );
    await hasText(
      card,
      'It grants no extra permissions; sandbox, review and approvals still apply.',
    );
    await expect.poll(() => results.count(), POLL).toBe(0);
    await expect
      .poll(() => page.getByRole('button', { name: 'Send' }).isDisabled(), POLL)
      .toBe(true);
    await page.getByRole('button', { name: 'Run in code lane' }).click();

    await expect.poll(() => results.count(), POLL).toBe(1);
    await expect.poll(() => card.count(), POLL).toBe(0);
    await hasText(page.getByTestId('lane-line'), 'Lane: direct');
    await hasText(
      page.getByTestId('lane-fallback'),
      'Code lane (DeepSeek Harness) unavailable. Using Nexar direct execution.',
    );
    // Confirming does not change the conversation's mode.
    await expect
      .poll(() => page.getByTestId('session-mode-cowork').getAttribute('aria-checked'), POLL)
      .toBe('true');

    // An engineering write cannot run without the Code lane: a notice, no model output, no task.
    await send('Implement the missing part.');
    await hasText(page.getByTestId('turn-refusal'), 'Code lane');
    await expect.poll(() => turns.count(), POLL).toBe(2);
    await expect.poll(() => results.count(), POLL).toBe(1);
    await expect.poll(() => page.getByTestId('routing-resource').count(), POLL).toBe(1);

    // The conversation stays usable.
    await send('Plan the next step');
    await expect.poll(() => results.count(), POLL).toBe(2);
    await expect.poll(() => turns.count(), POLL).toBe(3);
    await hasText(results.nth(1), 'Plan the next step');

    await close(app);
  });
});
