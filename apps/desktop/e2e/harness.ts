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
import { finishProcess, waitForMainProcessExit } from './process-lifecycle.js';
import {
  STATE_GUARD_TRACE_EVENT,
  type WindowsStateProcessEvent,
} from '../src/main/private-state-process.js';

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

/** Read only the test-gated main-process metadata, after early launch stderr was consumed. */
export async function mainProcessIdentity(app: ElectronApplication) {
  const identity = await app.evaluate(({ app: main }) => {
    const metric = main.getAppMetrics().find((item) => item.pid === process.pid);
    return {
      pid: process.pid,
      parentPid: process.ppid,
      createdAtEpochMs: metric?.creationTime,
      nodeVersion: process.versions.node,
      electronVersion: process.versions.electron,
      uvVersion: process.versions.uv,
    };
  });
  const launcherPid = app.process().pid;
  // Playwright 1.63 launches through a shell on Windows: its ChildProcess PID is the
  // launcher, not necessarily Electron's PID. Verify the direct parent link, not equality.
  expect(Number.isInteger(identity.pid) && identity.pid > 0).toBe(true);
  expect([identity.pid, identity.parentPid]).toContain(launcherPid);
  return { ...identity, launcherPid };
}

export async function stateProcessObservation(
  app: ElectronApplication,
): Promise<WindowsStateProcessEvent[]> {
  const events = (await app.evaluate(({ app: main }, eventName) => {
    let observations: unknown;
    const delivered = main.emit(eventName, (value: unknown) => {
      observations = value;
    });
    if (!delivered) throw new Error('Startup process observation unavailable');
    return observations;
  }, STATE_GUARD_TRACE_EVENT)) as WindowsStateProcessEvent[];
  expect(events).toHaveLength(2);
  const identity = await mainProcessIdentity(app);
  expect(events.every((event) => event.parentPid === identity.pid)).toBe(true);
  expect(events.map((event) => event.event)).toEqual(['request', 'result']);
  if (process.env['NEXAR_E2E_STATE_PROCESS_TRACE'] === '1')
    process.stdout.write(`desktop e2e process identity ${JSON.stringify(identity)}\n`);
  return events;
}

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

export async function createHarness(
  registerFailure: (callback: () => void) => void = onTestFailed,
  launchApplication: typeof electron.launch = (options) => electron.launch(options),
): Promise<Harness> {
  const base = await realpath(await mkdtemp(join(tmpdir(), 'nexar-e2e-code-')));
  const projectDir = join(base, 'code-project');
  await mkdir(projectDir, { recursive: true });
  await writeFile(join(projectDir, 'readme-seed.txt'), 'seeded file content\n');
  const apps: ElectronApplication[] = [];
  const identities = new WeakMap<
    ElectronApplication,
    Awaited<ReturnType<typeof mainProcessIdentity>>
  >();
  const profiles = new Map<ElectronApplication, string>();
  const reservedProfiles = new Set<string>();
  let failed = false;

  const launch: Harness['launch'] = async (userData, extraEnv = {}) => {
    if (reservedProfiles.has(userData))
      throw new Error('E2E profile still owned by an application; restart refused');
    // Reserve before seeding or awaiting the launcher. Failed/unknown launches do not
    // authorize a retry against potentially still-owned state within this fixture.
    reservedProfiles.add(userData);
    const output: string[] = [];
    // Launch can reject before it returns an owned process handle; retain its seeded evidence too.
    registerFailure(() => {
      failed = true;
      process.stderr.write(`desktop e2e failed; app output:\n${output.join('').slice(-8000)}\n`);
    });
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
        name === 'NEXAR_DESKTOP_TEST_WSL_COWORK' ||
        name === 'NEXAR_DSH_ENTRY'
      ) {
        delete env[name];
      }
    }
    env['NEXAR_DESKTOP_USER_DATA'] = userData;
    env['NEXAR_DESKTOP_TEST_LOCAL_COWORK'] = '1';
    env['NEXAR_DESKTOP_STARTUP_TRACE'] = '1';
    Object.assign(env, extraEnv);
    if (EXECUTABLE) {
      delete env['NEXAR_WORKFLOWS_DIR'];
      delete env['NEXAR_ENGINEERING_PLANS_DIR'];
    }
    const app = await launchApplication({
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
    profiles.set(app, userData);
    const capture = (chunk: Buffer): void => {
      output.push(chunk.toString());
      if (output.length > 200) output.shift();
    };
    app.process().stdout?.on('data', capture);
    app.process().stderr?.on('data', capture);
    try {
      identities.set(app, await mainProcessIdentity(app));
      if (process.platform === 'win32' && process.env['NEXAR_E2E_STATE_PROCESS_TRACE'] === '1') {
        const events = await stateProcessObservation(app);
        process.stdout.write(`desktop e2e state process ${JSON.stringify(events)}\n`);
      }
      // Cold starts run under antivirus scanning on CI runners: a packaged or source build can take
      // well over 30 s before its first window (Windows: engine-config alone has taken 15 s).
      const page = await app.firstWindow({ timeout: 90_000 });
      await page.waitForSelector('.app, [data-testid="open-folder-cta"]', { timeout: 60_000 });
      return { app, page };
    } catch (error) {
      try {
        await close(app);
      } catch (cleanupError) {
        throw new AggregateError([error, cleanupError], 'E2E launch and cleanup failed', {
          cause: cleanupError,
        });
      } finally {
        process.stderr.write(
          `desktop e2e launch failed; app output:\n${output.join('').slice(-8000)}\n`,
        );
      }
      throw error;
    }
  };

  const close: Harness['close'] = async (app) => {
    if (!apps.includes(app)) return;
    const child = app.process();
    const identity = identities.get(app);
    const result = await finishProcess(child, () => app.close(), {
      verifyExit: () => {
        if (!identity)
          return Promise.reject(
            new Error('E2E main process identity unavailable; profile retained'),
          );
        return waitForMainProcessExit(identity);
      },
    });
    if (process.env['NEXAR_E2E_PHASE_TRACE'] === '1')
      process.stderr.write(`desktop e2e exit ${JSON.stringify({ pid: child.pid, ...result })}\n`);
    const index = apps.indexOf(app);
    if (index >= 0) apps.splice(index, 1);
    const userData = profiles.get(app);
    if (userData !== undefined) reservedProfiles.delete(userData);
    profiles.delete(app);
  };

  return {
    base,
    projectDir,
    newUserData: (name) => join(base, name),
    launch,
    close,
    dispose: async () => {
      // A failed exit retains its profile and process handle for diagnosis; never race rm/relaunch.
      const failures: unknown[] = [];
      for (const app of [...apps]) {
        try {
          await close(app);
        } catch (error) {
          failures.push(error);
        }
      }
      if (failures.length > 0)
        throw new AggregateError(failures, 'E2E cleanup incomplete; profiles retained');
      if (failed) {
        process.stderr.write(`desktop e2e failed fixture retained: ${base}\n`);
        return;
      }
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
