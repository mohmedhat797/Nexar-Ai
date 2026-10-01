import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
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
  ResourceDescriptor,
} from '@nexar/contracts';
import { DelegateSkillsExecutionAdapter } from '../adapter.js';
import type { DelegateSkillsAdapterOptions } from '../adapter.js';
import { delegateSkillsCodexResource } from '../resource.js';

export const FAKE_RELAY = fileURLToPath(new URL('./fake-relay.mjs', import.meta.url));
export const FAKE_RELAY_SHA256 = createHash('sha256')
  .update(readFileSync(FAKE_RELAY))
  .digest('hex');

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
    input: { prompt: 'BRIEF-SENTINEL', ...overrides },
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

/**
 * A launcher that runs the spec's command unsandboxed (the fake relay) after rewriting the sandbox
 * paths in the args to their host paths, and records every spec. `extraEnv` is what the real
 * launcher would add (PATH) plus the fake relay's controls; the adapter's own env is `spec.env`.
 */
export function fakeLauncher(
  isolation: 'none' | 'sandbox',
  extraEnv: Readonly<Record<string, string>> = {},
  options: { readonly appliedIsolation?: 'none' | 'sandbox' } = {},
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
      const map: [string, string][] = [
        ...(spec.mounts ?? []).map((m): [string, string] => [m.sandboxPath, m.hostPath]),
        ['/work', spec.workspace],
      ];
      const rewrite = (arg: string): string => {
        for (const [from, to] of map) {
          if (arg === from || arg.startsWith(`${from}/`)) return to + arg.slice(from.length);
        }
        return arg;
      };
      return Promise.resolve({
        command: spec.command,
        args: spec.args.map(rewrite),
        env: { PATH: process.env['PATH'] ?? '', ...spec.env, ...extraEnv },
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
  readonly adapter: DelegateSkillsExecutionAdapter;
  readonly events: ExecutionEvent[];
  /** Workspace, state and home live here. */
  readonly dir: string;
  readonly stateDir: string;
  readonly codexHome: string;
  readonly pidfile: string;
  /** A resource pointing at the fake relay; `options` extend/override the defaults. */
  resource(options?: Record<string, unknown>): ResourceDescriptor;
  /** A launcher that sets the fake relay's scenario. */
  launcher(
    scenario: string,
    isolation?: 'none' | 'sandbox',
    options?: { readonly appliedIsolation?: 'none' | 'sandbox' },
  ): FakeLauncher;
  context(signal?: AbortSignal, workspace?: EngineeringWorkspace): ExecutionContext;
  workspace(launcher: ProcessLauncher, access?: 'read-only' | 'read-write'): EngineeringWorkspace;
  invocation(): FakeInvocation | undefined;
  runDirs(): string[];
  cleanup(): void;
}

export function harness(
  env: NodeJS.ProcessEnv = {},
  options: Partial<DelegateSkillsAdapterOptions> = {},
): Harness {
  const dir = mkdtempSync(join(tmpdir(), 'nexar-fake-relay-'));
  const stateDir = join(dir, 'state');
  const codexHome = join(dir, 'codex-home');
  mkdirSync(codexHome);
  const workspacePath = join(dir, 'work');
  mkdirSync(workspacePath);
  const record = join(dir, 'record.json');
  const pidfile = join(dir, 'pid');
  const events: ExecutionEvent[] = [];
  const adapter = new DelegateSkillsExecutionAdapter({
    stateDir,
    env: { PATH: process.env['PATH'], HOME: dir, ...env },
    killGraceMs: 200,
    ...options,
  });
  return {
    adapter,
    events,
    dir,
    stateDir,
    codexHome,
    pidfile,
    resource: (overrides = {}) =>
      delegateSkillsCodexResource({
        runtime: {
          adapter: adapter.id,
          locality: 'local',
          options: {
            relay: 'codex',
            relayPath: FAKE_RELAY,
            relaySha256: FAKE_RELAY_SHA256,
            nodePath: process.execPath,
            codexHome,
            ...overrides,
          },
        },
      }),
    launcher: (scenario, isolation = 'sandbox', launcherOptions = {}) =>
      fakeLauncher(
        isolation,
        {
          FAKE_RELAY_SCENARIO: scenario,
          FAKE_RELAY_RECORD: record,
          FAKE_RELAY_PIDFILE: pidfile,
        },
        launcherOptions,
      ),
    context: (signal = new AbortController().signal, workspace) => ({
      signal,
      logger: silentLogger,
      onEvent: (e) => events.push(e),
      ...(workspace !== undefined ? { workspace } : {}),
    }),
    workspace: (launcher, access = 'read-write') => ({ path: workspacePath, access, launcher }),
    invocation: () =>
      existsSync(record) ? (JSON.parse(readFileSync(record, 'utf8')) as FakeInvocation) : undefined,
    runDirs: () => (existsSync(stateDir) ? readdirSync(stateDir) : []),
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
