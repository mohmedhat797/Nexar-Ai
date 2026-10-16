import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import type { ElectronApplication, Page } from 'playwright-core';
import { CHANNELS } from '../src/shared/channels.js';

/*
 * Diagnostics for the Providers desktop E2E (test code only; production code is untouched).
 *
 * The scenario once failed after the second "Send" without leaving evidence of whether the turn
 * failed, stalled, or finished in the main process while the renderer did not update. This module
 * measures each turn, summarizes the fixture's IPC timing and egress logs, and on failure writes a
 * bundle under the git-ignored `apps/desktop/.nexar/e2e-diagnostics/`.
 *
 * Everything written holds codes, ids, enum states, counts, timings and hosts only: no turn text,
 * outcome text, prompt, clipboard content or key. Text files are redacted for the test's secret
 * before they are written.
 */

const REDACTED = '[redacted]';
const STEP_MS = 15_000;
const TRACE_MS = 45_000;
const OUTPUT_TAIL = 16_384;
const SESSION_FILE = /^ses_[0-9a-f]{32}\.json$/;
const CODE_AT_END = /\(([A-Z][A-Z0-9_]{1,63})\)\s*$/;

// --- per-turn latency -------------------------------------------------------------------------

export interface TurnTiming {
  readonly turn: number;
  /** Wall clock when the Send click began; correlates with `ipc-timing.jsonl`. */
  readonly clickedAtMs: number;
  readonly elapsedMs: number;
  /** False when the expected result never appeared (the run's own assertion fails the test). */
  readonly reached: boolean;
}

/**
 * Times `run` (the Send click plus the wait for the expected result) and prints one stderr line.
 * It never swallows the outcome: a failing assertion inside `run` still fails the test.
 */
export async function timedTurn(
  turn: number,
  timings: TurnTiming[],
  run: () => Promise<void>,
): Promise<void> {
  const clickedAtMs = Date.now();
  const began = performance.now();
  let reached = false;
  try {
    await run();
    reached = true;
  } finally {
    const elapsedMs = Math.round(performance.now() - began);
    timings.push({ turn, clickedAtMs, elapsedMs, reached });
    process.stderr.write(
      `providers e2e: ${reached ? 'turn' : 'turn-failed'} ${JSON.stringify({ turn, elapsedMs })}\n`,
    );
  }
}

// --- Playwright trace (one per launch) --------------------------------------------------------

const traced = new WeakSet<ElectronApplication>();

/** Starts tracing for one launch; false when this Electron/Playwright pairing cannot trace. */
export async function startTrace(app: ElectronApplication): Promise<boolean> {
  try {
    await app.context().tracing.start({ screenshots: true, snapshots: true });
    traced.add(app);
    return true;
  } catch {
    return false;
  }
}

/** Stops a launch's trace: into `path` on failure, discarded without one. Never throws. */
export async function stopTrace(app: ElectronApplication, path?: string): Promise<boolean> {
  if (!traced.delete(app)) return false;
  try {
    const tracing = app.context().tracing;
    if (path === undefined) await tracing.stop();
    else await tracing.stop({ path });
    return true;
  } catch {
    return false;
  }
}

// --- bounded work -----------------------------------------------------------------------------

class StepTimeout extends Error {
  override name = 'StepTimeout';
}

async function bounded<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new StepTimeout('step timed out')), ms);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/** An error class and code only: messages can carry paths. */
function describeError(error: unknown): string {
  if (!(error instanceof Error)) return 'non-error';
  const code = (error as { code?: unknown }).code;
  return typeof code === 'string' ? `${error.name}:${code.slice(0, 40)}` : error.name;
}

// --- the turn allowlist -----------------------------------------------------------------------

export interface TurnView {
  readonly id: string | undefined;
  readonly index: number | undefined;
  readonly state: string | undefined;
  readonly createdAt: string | undefined;
  readonly updatedAt: string | undefined;
  readonly lane:
    | {
        readonly mode: string | undefined;
        readonly requestedLane: string | undefined;
        readonly effectiveLane: string | undefined;
        readonly fallbackReason: string | undefined;
      }
    | undefined;
  readonly tasks: readonly {
    readonly state: string | undefined;
    readonly resourceId: string | undefined;
    readonly policyId: string | undefined;
    readonly fallback: boolean | undefined;
    readonly control: { readonly path: string | undefined } | undefined;
  }[];
  readonly errorCode: string | undefined;
}

/**
 * The only fields of a turn that reach the bundle, for the stored files and the IPC view alike.
 * Every string is length-capped and anything that is not a plain scalar is dropped.
 */
export function pickTurn(raw: unknown): TurnView {
  const obj = (value: unknown): Record<string, unknown> =>
    typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};
  const str = (value: unknown): string | undefined =>
    typeof value === 'string' ? value.slice(0, 80) : undefined;
  const turn = obj(raw);
  const lane = obj(turn['lane']);
  const outcome = obj(turn['outcome']);
  return {
    id: str(turn['id']),
    index: typeof turn['index'] === 'number' ? turn['index'] : undefined,
    state: str(turn['state']),
    createdAt: str(turn['createdAt']),
    updatedAt: str(turn['updatedAt']),
    lane:
      turn['lane'] === undefined
        ? undefined
        : {
            mode: str(lane['mode']),
            requestedLane: str(lane['requestedLane']),
            effectiveLane: str(lane['effectiveLane']),
            fallbackReason: str(lane['fallbackReason']),
          },
    tasks: (Array.isArray(turn['tasks']) ? (turn['tasks'] as unknown[]) : [])
      .slice(0, 16)
      .map((task) => {
        const link = obj(task);
        return {
          state: str(link['state']),
          resourceId: str(link['resourceId']),
          policyId: str(link['policyId']),
          fallback: typeof link['fallback'] === 'boolean' ? link['fallback'] : undefined,
          control:
            link['control'] === undefined ? undefined : { path: str(obj(link['control'])['path']) },
        };
      }),
    errorCode: str(obj(outcome['error'])['code']),
  };
}

/** What main hands over per turn: ids, states, times and the constant-only objects; no text at all. */
interface MainTurn {
  readonly id?: unknown;
  readonly index?: unknown;
  readonly state?: unknown;
  readonly createdAt?: unknown;
  readonly updatedAt?: unknown;
  readonly lane?: unknown;
  readonly tasks?: unknown;
  readonly outcome?: { readonly error?: { readonly code?: unknown } };
}

interface StoredSession {
  readonly file: string;
  readonly id: string | undefined;
  readonly mode: string | undefined;
  readonly revision: number | undefined;
  readonly turns: readonly TurnView[];
}

type StoredSessionView = StoredSession | { readonly file: string; readonly unreadable: string };

/** The main-process view: every session through the recorded IPC handlers, as the renderer sees it. */
async function readIpcView(app: ElectronApplication): Promise<unknown> {
  return app.evaluate(
    async ({ BrowserWindow }, arg) => {
      const handlers = (
        globalThis as unknown as {
          nexarTestHandlers?: Map<string, (event: unknown, args: unknown) => Promise<unknown>>;
        }
      ).nexarTestHandlers;
      if (handlers === undefined) return { unavailable: 'no-recorded-handlers' };
      const contents = BrowserWindow.getAllWindows()[0]?.webContents;
      if (contents === undefined) return { unavailable: 'no-window' };
      const errors: string[] = [];
      const call = async (channel: string, args: unknown): Promise<unknown> => {
        const handler = handlers.get(channel);
        if (handler === undefined) {
          errors.push(`${channel}:missing`);
          return undefined;
        }
        const result = (await handler(
          { sender: contents, senderFrame: contents.mainFrame },
          args,
        )) as { ok?: boolean; value?: unknown; error?: { code?: unknown } };
        if (result.ok !== true) {
          const code = result.error?.code;
          errors.push(`${channel}:${typeof code === 'string' ? code.slice(0, 40) : 'failed'}`);
          return undefined;
        }
        return result.value;
      };
      const sessions: unknown[] = [];
      const projects = await call(arg.projectsList, {});
      for (const project of Array.isArray(projects) ? projects.slice(0, 16) : []) {
        const projectId = (project as { id?: unknown }).id;
        const listed = await call(arg.sessionsList, { projectId });
        for (const summary of Array.isArray(listed) ? listed.slice(0, 32) : []) {
          const sessionId = (summary as { id?: unknown }).id;
          const session = (await call(arg.sessionsGet, { sessionId })) as
            { id?: unknown; mode?: unknown; turns?: unknown } | undefined;
          if (session === undefined) continue;
          // Copy ids, states, times and the constant-only objects; the turn's text, its outcome
          // text and error message are never read out of main.
          const turns: MainTurn[] = (
            Array.isArray(session.turns) ? (session.turns as MainTurn[]) : []
          )
            .slice(0, 64)
            .map((turn) => ({
              id: turn.id,
              index: turn.index,
              state: turn.state,
              createdAt: turn.createdAt,
              updatedAt: turn.updatedAt,
              lane: turn.lane,
              tasks: turn.tasks,
              outcome: { error: { code: turn.outcome?.error?.code } },
            }));
          sessions.push({ id: session.id, mode: session.mode, turns });
        }
      }
      return { sessions, errors };
    },
    {
      projectsList: CHANNELS.projectsList,
      sessionsList: CHANNELS.sessionsList,
      sessionsGet: CHANNELS.sessionsGet,
    },
  );
}

/** The IPC view is pruned in main, then passes the same allowlist as the stored files. */
async function readIpcTurns(app: ElectronApplication): Promise<unknown> {
  const raw = (await readIpcView(app)) as {
    sessions?: { id?: unknown; mode?: unknown; turns?: unknown[] }[];
    errors?: string[];
  };
  if (raw.sessions === undefined) return raw;
  return {
    errors: raw.errors,
    sessions: raw.sessions.map((session) => ({
      id: typeof session.id === 'string' ? session.id : undefined,
      mode: typeof session.mode === 'string' ? session.mode : undefined,
      turns: (session.turns ?? []).map(pickTurn),
    })),
  };
}

/** The stored view: the session files under `userData/.nexar/sessions`, read with the same allowlist. */
async function readSessionFiles(userData: string): Promise<readonly StoredSessionView[]> {
  const dir = join(userData, '.nexar', 'sessions');
  const views: StoredSessionView[] = [];
  for (const name of (await readdir(dir)).filter((entry) => SESSION_FILE.test(entry)).sort()) {
    try {
      const record = JSON.parse(await readFile(join(dir, name), 'utf8')) as {
        id?: unknown;
        mode?: unknown;
        revision?: unknown;
        turns?: unknown;
      };
      views.push({
        file: name,
        id: typeof record.id === 'string' ? record.id : undefined,
        mode: typeof record.mode === 'string' ? record.mode : undefined,
        revision: typeof record.revision === 'number' ? record.revision : undefined,
        turns: (Array.isArray(record.turns) ? (record.turns as unknown[]) : [])
          .slice(0, 64)
          .map(pickTurn),
      });
    } catch (error) {
      views.push({ file: name, unreadable: describeError(error) });
    }
  }
  return views;
}

// --- fixture log summaries (printed for every run) --------------------------------------------

async function readLines(path: string): Promise<readonly Record<string, unknown>[]> {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch {
    return [];
  }
  const rows: Record<string, unknown>[] = [];
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue;
    try {
      const row = JSON.parse(line) as unknown;
      if (typeof row === 'object' && row !== null) rows.push(row as Record<string, unknown>);
    } catch {
      // A line cut short by an exiting process is ignored.
    }
  }
  return rows;
}

function isLoopback(host: string): boolean {
  return (
    host === 'localhost' ||
    host.endsWith('.localhost') ||
    host === '[::1]' ||
    host === '::1' ||
    /^127(\.\d{1,3}){3}$/.test(host)
  );
}

async function printLauncherLogSummaries(
  userData: string,
  emit: (line: string) => void,
): Promise<void> {
  const egress = await readLines(join(userData, 'egress.jsonl'));
  const hosts: Record<string, number> = {};
  let failed = 0;
  for (const row of egress) {
    const host = typeof row['host'] === 'string' ? row['host'].slice(0, 80) : 'unknown';
    hosts[host] = (hosts[host] ?? 0) + 1;
    if (row['ok'] !== true) failed++;
  }
  emit(
    `providers e2e: egress ${JSON.stringify({
      requests: egress.length,
      failed,
      hosts,
      nonLoopback: Object.keys(hosts).filter((host) => !isLoopback(host)),
    })}`,
  );
  const channels: Record<string, { n: number; maxMs: number; notOk: number }> = {};
  for (const row of await readLines(join(userData, 'ipc-timing.jsonl'))) {
    const channel = typeof row['channel'] === 'string' ? row['channel'].slice(0, 80) : 'unknown';
    const entry = (channels[channel] ??= { n: 0, maxMs: 0, notOk: 0 });
    entry.n++;
    if (typeof row['durationMs'] === 'number') {
      entry.maxMs = Math.max(entry.maxMs, row['durationMs']);
    }
    if (row['ok'] !== true) entry.notOk++;
  }
  emit(`providers e2e: ipc ${JSON.stringify(channels)}`);
}

/**
 * Prints, for the run that just ended, one line each for egress hosts, IPC timing and the main
 * process's own turn durations (stored `updatedAt - createdAt`). Hosts, channels, counts and
 * milliseconds only. `launcherLogs` is false for a packaged executable, which runs without the
 * fixture launcher and so records no egress or IPC timing. Never throws.
 */
export async function printRunSummaries(
  userData: string,
  launcherLogs: boolean,
  secret: string,
): Promise<void> {
  const emit = (line: string): void => {
    process.stderr.write(`${line.replaceAll(secret, REDACTED)}\n`);
  };
  try {
    if (launcherLogs) await printLauncherLogSummaries(userData, emit);
    else emit('providers e2e: egress and ipc not observed (no fixture launcher)');
    const mainMs: unknown[] = [];
    for (const session of await readSessionFiles(userData)) {
      if ('unreadable' in session) continue;
      for (const turn of session.turns) {
        const began = Date.parse(turn.createdAt ?? '');
        const ended = Date.parse(turn.updatedAt ?? '');
        mainMs.push({
          index: turn.index,
          state: turn.state,
          mainMs: Number.isFinite(began) && Number.isFinite(ended) ? ended - began : null,
        });
      }
    }
    emit(`providers e2e: main-turns ${JSON.stringify(mainMs)}`);
  } catch (error) {
    emit(`providers e2e: summary unavailable ${describeError(error)}`);
  }
}

// --- the failure bundle -----------------------------------------------------------------------

export interface BundleInput {
  readonly app: ElectronApplication | undefined;
  readonly page: Page | undefined;
  /** The fixture's state directory, when the test got far enough to create it. */
  readonly userData: string | undefined;
  /** The fixture root, scrubbed from the output tail. */
  readonly base: string | undefined;
  readonly output: readonly string[];
  /** Arrival time (epoch ms) of each `output` entry. */
  readonly outputTimes: readonly number[];
  readonly secret: string;
  readonly turnTimings: readonly TurnTiming[];
  readonly consoleCounts: Readonly<Record<string, number>>;
  /** `apps/desktop/.nexar/e2e-diagnostics`. */
  readonly bundlesRoot: string;
  readonly repoRoot: string;
}

/** Writes the bundle; prints its repository-relative path. Never throws: diagnostics must not mask the failure. */
export async function writeFailureBundle(input: BundleInput): Promise<string | undefined> {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const dir = join(input.bundlesRoot, `providers-${stamp}`);
  const steps: Record<string, string> = {};
  const redacted: string[] = [];
  try {
    await mkdir(dir, { recursive: true });
  } catch (error) {
    process.stderr.write(`providers e2e: failure bundle not written ${describeError(error)}\n`);
    return undefined;
  }

  /** Every text file passes through here: the secret is checked for and redacted before writing. */
  const writeText = async (name: string, text: string): Promise<void> => {
    if (text.includes(input.secret)) {
      redacted.push(name);
      text = text.replaceAll(input.secret, REDACTED);
    }
    await writeFile(join(dir, name), text, { mode: 0o600 });
  };
  const step = async (
    name: string,
    work: () => Promise<string | void>,
    ms: number = STEP_MS,
  ): Promise<void> => {
    try {
      steps[name] = (await bounded(work(), ms)) ?? 'ok';
    } catch (error) {
      steps[name] = describeError(error);
    }
  };

  const { app, page, userData } = input;

  // Copies first: the reads below call recorded handlers, which append to these logs themselves.
  if (userData !== undefined) {
    for (const name of ['ipc-timing.jsonl', 'egress.jsonl']) {
      await step(name, async () => {
        const text = await readFile(join(userData, name), 'utf8').catch((error: unknown) => {
          if ((error as NodeJS.ErrnoException).code === 'ENOENT') return '';
          throw error;
        });
        await writeText(name, text);
      });
    }
  }

  await step('app-output.txt', async () => {
    // Each entry leads with its arrival time (epoch ms) to line up with ui.json's turn timings.
    // The secret and the fixture path are scrubbed before the tail is cut, so a cut cannot leave
    // half of either behind.
    let text = input.output
      .map((entry, i) => `[${input.outputTimes[i] ?? '?'}] ${entry.trimEnd()}`)
      .join('\n')
      .replaceAll(input.secret, REDACTED);
    if (input.base !== undefined) {
      text = text
        .replaceAll(input.base, '<fixture>')
        .replaceAll(input.base.replaceAll('\\', '/'), '<fixture>');
    }
    await writeText('app-output.txt', text.slice(-OUTPUT_TAIL));
  });

  if (page !== undefined) {
    await step('ui.json', async () => {
      const count = (id: string): Promise<number> => page.getByTestId(id).count();
      const texts = async (id: string): Promise<string[]> => {
        const locator = page.getByTestId(id);
        const out: string[] = [];
        for (let i = 0; i < Math.min(await locator.count(), 16); i++) {
          out.push(await locator.nth(i).innerText({ timeout: 2_000 }));
        }
        return out;
      };
      const turnLocator = page.getByTestId('turn');
      const states: (string | null)[] = [];
      for (let i = 0; i < Math.min(await turnLocator.count(), 16); i++) {
        states.push(await turnLocator.nth(i).getAttribute('data-state', { timeout: 2_000 }));
      }
      const optional = async <T>(work: Promise<T>): Promise<T | null> => work.catch(() => null);
      const ui = {
        capturedAt: new Date().toISOString(),
        pageClosed: page.isClosed(),
        counts: {
          resultText: await count('result-text'),
          conversationItem: await count('conversation-item'),
          turn: await count('turn'),
          turnError: await count('turn-error'),
          turnRefusal: await count('turn-refusal'),
          turnState: await count('turn-state'),
          chatError: await count('chat-error'),
          laneFallback: await count('lane-fallback'),
          running: await page.locator('.running').count(),
        },
        turnDataStates: states,
        // Fixed labels only ("Interrupted: ..."); never a message.
        turnStateLabels: await texts('turn-state'),
        // Codes parsed from "<message> (CODE)"; the message text is dropped.
        turnErrorCodes: (await texts('turn-error')).map(
          (text) => CODE_AT_END.exec(text)?.[1] ?? null,
        ),
        chatErrorCodes: (await texts('chat-error')).map(
          (text) => CODE_AT_END.exec(text)?.[1] ?? null,
        ),
        sendButtonEnabled: await optional(
          page.getByRole('button', { name: 'Send', exact: true }).isEnabled({ timeout: 2_000 }),
        ),
        messageBoxLength: await optional(
          page
            .getByLabel('Message')
            .inputValue({ timeout: 2_000 })
            .then((value) => value.length),
        ),
        rendererConsole: input.consoleCounts,
        turnTimings: input.turnTimings,
      };
      await writeText('ui.json', `${JSON.stringify(ui, null, 2)}\n`);
    });
    await step('screenshot.png', async () => {
      // The chat header shows the project root (a fixture path under the owner's profile): mask it.
      const paths = page.locator('.mono', input.base === undefined ? {} : { hasText: input.base });
      await page.screenshot({ path: join(dir, 'screenshot.png'), mask: [paths], timeout: 10_000 });
    });
  }

  if (app !== undefined) {
    await step('turns.json', async () => {
      const ipc = await readIpcTurns(app);
      const files = userData === undefined ? [] : await readSessionFiles(userData);
      await writeText(
        'turns.json',
        `${JSON.stringify(
          {
            capturedAt: new Date().toISOString(),
            note: 'ipc: main-process handlers (the renderer view, no lane.mode); files: stored sessions',
            ipc,
            files,
          },
          null,
          2,
        )}\n`,
      );
    });
    await step(
      'trace.zip',
      async () => ((await stopTrace(app, join(dir, 'trace.zip'))) ? 'ok' : 'no-active-trace'),
      TRACE_MS,
    );
  }

  await step('collection.json', async () => {
    await writeText(
      'collection.json',
      `${JSON.stringify(
        {
          steps,
          redactedFiles: redacted,
          appProcess:
            app === undefined
              ? null
              : { exitCode: app.process().exitCode, signalCode: app.process().signalCode },
        },
        null,
        2,
      )}\n`,
    );
  });
  const shown = relative(input.repoRoot, dir).split(sep).join('/');
  process.stderr.write(`providers e2e: failure diagnostics written to ${shown}\n`);
  return dir;
}
