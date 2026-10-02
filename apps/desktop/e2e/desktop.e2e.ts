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
  const page = await app.firstWindow();
  await page.waitForSelector('.app, [data-testid="open-folder-cta"]', { timeout: 60_000 });
  return { app, page };
}

async function close(app: ElectronApplication): Promise<void> {
  await app.close();
  apps.splice(apps.indexOf(app), 1);
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
  await rm(base, { recursive: true, force: true });
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

    // --- Code mode keeps the sidebar and shows the placeholder ---
    await page.getByTestId('nav-chat').click();
    await page.getByTestId('mode-code').click();
    await hasText(page.getByTestId('code-placeholder'), 'NXR-055');
    await isVisible(page.getByTestId('nav-settings'));

    await close(app);
  });
});
