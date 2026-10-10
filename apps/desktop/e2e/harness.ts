import { access, mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  _electron as electron,
  type ElectronApplication,
  type Locator,
  type Page,
} from 'playwright-core';
import { defaultConfig } from '@nexar/core';
import { expect, onTestFailed } from 'vitest';

/*
 * Launch helpers shared by the Code-lane scenarios: the same robustness as the main desktop
 * scenarios (a failed launch is cleaned up and its output printed, a close waits for the process
 * to exit before the state directory is reused, startup phases are traced).
 */

const MAIN = fileURLToPath(new URL('../dist/main/main.js', import.meta.url));
const EXECUTABLE = process.env['NEXAR_DESKTOP_EXECUTABLE'];
export const POLL = { timeout: 60_000, interval: 200 };

/**
 * The real DeepSeek Harness runtime for the Cowork scenarios: scripts/e2e.mjs passes
 * NEXAR_DSH_ENTRY on as NEXAR_DESKTOP_TEST_DSH_ENTRY (CI always sets it). Without it those
 * scenarios skip; a launch only gets the runtime when it spreads dshEnv. A packaged executable
 * (NEXAR_DESKTOP_EXECUTABLE) is never given an entry: it only opts its own bundled runtime in, so
 * the runtime is resolved from `resources/dsh-runtime` exactly as in production.
 */
export const DSH_ENTRY = EXECUTABLE ? undefined : process.env['NEXAR_DESKTOP_TEST_DSH_ENTRY'];
export const dshEnv: Readonly<Record<string, string>> = EXECUTABLE
  ? { NEXAR_DESKTOP_TEST_DSH_RUNTIME: 'packaged' }
  : DSH_ENTRY === undefined || DSH_ENTRY === ''
    ? {}
    : { NEXAR_DESKTOP_TEST_DSH_ENTRY: DSH_ENTRY };
export const hasDsh = Object.keys(dshEnv).length > 0;

export const text = (locator: Locator): Promise<string> => locator.innerText();
/** Waits until the locator's text contains `needle`. */
export const hasText = (locator: Locator, needle: string): Promise<void> =>
  expect.poll(() => text(locator).catch(() => ''), POLL).toContain(needle);
export const isVisible = (locator: Locator): Promise<void> =>
  expect.poll(() => locator.isVisible().catch(() => false), POLL).toBe(true);

/** Native runtimes a developer may have signed in on PATH: E2E must never route to them. */
const REAL_RUNTIMES = ['claude-code', 'codex', 'antigravity', 'deepseek-harness'];

/**
 * The offline E2E config: Desktop's first run configures no resource, so scenarios that execute
 * turns get the built-in echo test double explicitly, as the default. The `e2e` tag keeps it apart
 * from the legacy first-run shape (which Desktop migrates away). Discovery stays on (provider keys
 * add pi catalog resources) but never yields a developer's real signed-in CLIs.
 */
export async function seedE2EConfig(
  userData: string,
  /** Owner-listed local endpoints (NXR-063 E2E): discovery lists them as pi resources. */
  localEndpoints: readonly {
    readonly id: string;
    readonly kind: 'openai-compatible';
    readonly baseUrl: string;
    readonly toolCalling: boolean;
  }[] = [],
): Promise<void> {
  const path = join(userData, 'nexar.config.json');
  const exists = await access(path).then(
    () => true,
    () => false,
  );
  if (exists) return;
  await mkdir(userData, { recursive: true });
  const echo = JSON.parse(JSON.stringify(defaultConfig().resources[0])) as Record<string, unknown>;
  await writeFile(
    path,
    JSON.stringify({
      version: 1,
      resources: [{ ...echo, tags: ['e2e'] }],
      routing: { policy: 'resource-intelligence', defaultResourceId: 'local-echo' },
      telemetry: { jsonlPath: '.nexar/telemetry.jsonl' },
      discovery: {
        enabled: true,
        excludeIds: REAL_RUNTIMES,
        ...(localEndpoints.length === 0
          ? {}
          : { sources: { localEndpoints: { enabled: true, endpoints: localEndpoints } } }),
      },
      projects: [],
    }),
  );
}

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
    await seedE2EConfig(userData);
    const env = Object.fromEntries(
      Object.entries(process.env).filter(
        (entry): entry is [string, string] => entry[1] !== undefined,
      ),
    );
    // Never inherit a plane or runtime selection from the caller's shell: scenarios opt in.
    for (const name of Object.keys(env)) {
      if (
        name.startsWith('NEXAR_FAKE_PLANE_') ||
        name === 'NEXAR_DESKTOP_TEST_PLANE' ||
        name === 'NEXAR_DESKTOP_TEST_DSH_ENTRY' ||
        name === 'NEXAR_DESKTOP_TEST_DSH_RUNTIME' ||
        name === 'NEXAR_DSH_ENTRY'
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
    // A step without its own timeout (close, evaluate) only surfaces as the test timeout: print
    // this launch's startup trace and output so the failing run says where the app stopped.
    const launched = output;
    onTestFailed(() => {
      process.stderr.write(`desktop e2e failed; app output:\n${launched.join('').slice(-8000)}\n`);
    });
    try {
      // Cold starts run under antivirus scanning on CI runners: a packaged or source build can take
      // well over 30 s before its first window (Windows: engine-config alone has taken 15 s).
      const page = await app.firstWindow({ timeout: 90_000 });
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
    // Bounded like `dispose`: an app that will not close is ended below instead of hanging the test.
    const closed = await Promise.race([
      app.close().then(
        () => true,
        () => true,
      ),
      new Promise<false>((resolve) => setTimeout(() => resolve(false), 20_000)),
    ]);
    if (!closed) process.stderr.write('desktop e2e: app.close() did not finish within 20 s\n');
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
        apps.map((a) => {
          // Take the process handle first: it is unavailable once the app connection closes.
          const child = a.process();
          return Promise.race([
            a.close().catch(() => undefined),
            new Promise<void>((resolve) => setTimeout(resolve, 15_000)),
          ]).then(() => {
            if (child.exitCode === null && child.signalCode === null) child.kill();
          });
        }),
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
