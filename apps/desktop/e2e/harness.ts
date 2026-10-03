import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  _electron as electron,
  type ElectronApplication,
  type Locator,
  type Page,
} from 'playwright-core';
import { expect } from 'vitest';

/*
 * Launch helpers shared by the Code-lane scenarios: the same robustness as the main desktop
 * scenarios (a failed launch is cleaned up and its output printed, a close waits for the process
 * to exit before the state directory is reused, startup phases are traced).
 */

const MAIN = fileURLToPath(new URL('../dist/main/main.js', import.meta.url));
const EXECUTABLE = process.env['NEXAR_DESKTOP_EXECUTABLE'];
export const POLL = { timeout: 60_000, interval: 200 };

export const text = (locator: Locator): Promise<string> => locator.innerText();
/** Waits until the locator's text contains `needle`. */
export const hasText = (locator: Locator, needle: string): Promise<void> =>
  expect.poll(() => text(locator).catch(() => ''), POLL).toContain(needle);
export const isVisible = (locator: Locator): Promise<void> =>
  expect.poll(() => locator.isVisible().catch(() => false), POLL).toBe(true);

export interface Harness {
  readonly base: string;
  readonly projectDir: string;
  /** A fresh state directory for one scenario. */
  readonly newUserData: (name: string) => string;
  readonly launch: (
    userData: string,
    extraEnv?: Readonly<Record<string, string>>,
  ) => Promise<{ app: ElectronApplication; page: Page }>;
  readonly close: (app: ElectronApplication) => Promise<void>;
  readonly dispose: () => Promise<void>;
}

export async function createHarness(): Promise<Harness> {
  const base = await realpath(await mkdtemp(join(tmpdir(), 'nexar-e2e-code-')));
  const projectDir = join(base, 'code-project');
  await mkdir(projectDir, { recursive: true });
  await writeFile(join(projectDir, 'readme-seed.txt'), 'seeded file content\n');
  const apps: ElectronApplication[] = [];
  let output: string[] = [];

  const launch: Harness['launch'] = async (userData, extraEnv = {}) => {
    const env = Object.fromEntries(
      Object.entries(process.env).filter(
        (entry): entry is [string, string] => entry[1] !== undefined,
      ),
    );
    // Never inherit a plane selection from the caller's shell.
    for (const name of Object.keys(env)) {
      if (
        name.startsWith('NEXAR_FAKE_PLANE_') ||
        name === 'NEXAR_DESKTOP_TEST_PLANE' ||
        name.startsWith('NEXAR_FAKE_OPENWORKER_') ||
        name === 'NEXAR_DESKTOP_TEST_OPENWORKER'
      ) {
        delete env[name];
      }
    }
    env['NEXAR_DESKTOP_USER_DATA'] = userData;
    env['NEXAR_DESKTOP_STARTUP_TRACE'] = '1';
    Object.assign(env, extraEnv);
    if (EXECUTABLE) {
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
      app.process().kill();
      apps.splice(apps.indexOf(app), 1);
      process.stderr.write(
        `desktop e2e launch failed; app output:\n${output.join('').slice(-8000)}\n`,
      );
      throw error;
    }
  };

  const close: Harness['close'] = async (app) => {
    const child = app.process();
    await app.close();
    apps.splice(apps.indexOf(app), 1);
    const deadline = Date.now() + 20_000;
    while (child.exitCode === null && child.signalCode === null && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    if (child.exitCode === null && child.signalCode === null) child.kill();
  };

  return {
    base,
    projectDir,
    newUserData: (name) => join(base, name),
    launch,
    close,
    dispose: async () => {
      // An app that will not close must not hang teardown: give it 15 s, then end its process.
      await Promise.all(
        apps.map((a) =>
          Promise.race([
            a.close().catch(() => undefined),
            new Promise<void>((resolve) => setTimeout(resolve, 15_000)),
          ]).then(() => {
            const child = a.process();
            if (child.exitCode === null && child.signalCode === null) child.kill();
          }),
        ),
      );
      await rm(base, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    },
  };
}

/** Adds the harness project through the (stubbed) native folder dialog. */
export async function addProject(
  app: ElectronApplication,
  page: Page,
  projectDir: string,
): Promise<void> {
  await isVisible(page.getByTestId('open-folder-cta'));
  await app.evaluate(({ dialog }, dir) => {
    dialog.showOpenDialog = () => Promise.resolve({ canceled: false, filePaths: [dir] });
  }, projectDir);
  await page.getByRole('button', { name: 'Open folder as project…' }).first().click();
  await hasText(page.getByTestId('chat-title'), 'code-project');
}
