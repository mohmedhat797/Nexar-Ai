import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { taskId } from '@nexar/contracts';
import type {
  EngineeringWorkspace,
  ExecutionContext,
  ExecutionEvent,
  LaunchSpec,
  Logger,
  NexarTask,
  PreparedLaunch,
  ProcessLauncher,
} from '@nexar/contracts';
import { CodexExecutionAdapter } from '../adapter.js';
import type { CodexAdapterOptions } from '../adapter.js';

export const FAKE_CODEX = fileURLToPath(new URL('./fake-codex.mjs', import.meta.url));

export interface FakeInvocation {
  readonly argv: readonly string[];
  readonly stdin: string;
  readonly cwd: string;
  readonly pid: number;
  readonly env: Readonly<Record<string, string | undefined>>;
}

export const silentLogger: Logger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  child: () => silentLogger,
};

export function task(overrides: Partial<NexarTask['input']> = {}): NexarTask {
  return {
    id: taskId('t-1'),
    kind: 'general',
    input: { prompt: 'PROMPT-SENTINEL', ...overrides },
    requirements: { capabilities: ['text-generation'] },
    origin: { source: 'test' },
    createdAt: '2026-01-01T00:00:00.000Z',
  };
}

export interface FakeLauncher extends ProcessLauncher {
  readonly specs: LaunchSpec[];
  readonly disposed: { count: number };
  readonly prepared: { count: number };
}

/** A launcher that returns the spec's own command (the fake runtime); records everything. */
export function fakeLauncher(
  isolation: 'none' | 'sandbox',
  options: { readonly appliedIsolation?: 'none' | 'sandbox'; readonly prefixArgs?: string[] } = {},
): FakeLauncher {
  const specs: LaunchSpec[] = [];
  const disposed = { count: 0 };
  const prepared = { count: 0 };
  return {
    isolation,
    specs,
    disposed,
    prepared,
    prepare(spec): Promise<PreparedLaunch> {
      prepared.count += 1;
      specs.push(spec);
      return Promise.resolve({
        command: spec.command,
        args: spec.args,
        env: { PATH: process.env['PATH'] ?? '', ...spec.env },
        cwd: spec.workspace,
        workspacePath: '/work',
        isolation: options.appliedIsolation ?? isolation,
        dispose: () => {
          disposed.count += 1;
          return Promise.resolve();
        },
      });
    },
  };
}

export interface Harness {
  readonly adapter: CodexExecutionAdapter;
  readonly events: ExecutionEvent[];
  readonly dir: string;
  readonly pidfile: string;
  context(signal?: AbortSignal, workspace?: EngineeringWorkspace): ExecutionContext;
  workspace(launcher: ProcessLauncher, access: 'read-only' | 'read-write'): EngineeringWorkspace;
  invocations(): FakeInvocation[];
  cleanup(): void;
}

/**
 * An adapter wired to the fake binary. `fake` entries become leading `--fake-*` args (they pick
 * the fake's behavior and survive the adapter's env scrubbing); `env` is the adapter's parent env.
 */
export function harness(
  fake: Readonly<Record<string, string>> = {},
  env: NodeJS.ProcessEnv = {},
  options: Omit<CodexAdapterOptions, 'binary' | 'env'> = {},
): Harness {
  const dir = mkdtempSync(join(tmpdir(), 'nexar-fake-codex-'));
  const record = join(dir, 'record.json');
  const pidfile = join(dir, 'pid');
  const events: ExecutionEvent[] = [];
  const fakeArgs = [`--fake-record=${record}`, `--fake-pidfile=${pidfile}`].concat(
    Object.entries(fake).map(([k, v]) => (v === '' ? `--fake-${k}` : `--fake-${k}=${v}`)),
  );
  const adapter = new CodexExecutionAdapter({
    binary: { command: process.execPath, args: [FAKE_CODEX, ...fakeArgs] },
    env: { PATH: process.env['PATH'], HOME: dir, ...env },
    killGraceMs: 200,
    ...options,
  });
  return {
    adapter,
    events,
    dir,
    pidfile,
    context: (signal = new AbortController().signal, workspace) => ({
      signal,
      logger: silentLogger,
      onEvent: (e) => events.push(e),
      ...(workspace !== undefined ? { workspace } : {}),
    }),
    workspace: (launcher, access) => ({ path: dir, access, launcher }),
    invocations: () =>
      existsSync(record) ? (JSON.parse(readFileSync(record, 'utf8')) as FakeInvocation[]) : [],
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

export async function waitFor<T>(fn: () => T | undefined, timeoutMs = 5000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const v = fn();
    if (v !== undefined) return v;
    if (Date.now() > deadline) throw new Error('waitFor timed out');
    await new Promise((r) => setTimeout(r, 20));
  }
}

export function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
