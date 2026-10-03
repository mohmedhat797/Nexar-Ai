import { execFileSync } from 'node:child_process';
import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ApprovalGate, InMemoryApprovalStore, decide } from '@nexar/approvals';
import { LocalArtifactStore } from '@nexar/artifacts';
import {
  NexarError,
  adapterId,
  measured,
  type ExecutionAdapter,
  type ExecutionContext,
  type ExecutionRequest,
  type ExecutionResult,
  type LaunchSpec,
  type Logger,
  type PreparedLaunch,
  type ProcessLauncher,
  type ResourceDescriptor,
  type ResourceState,
  type TelemetryEvent,
} from '@nexar/contracts';
import { createNexarWithProjects, parseConfig, type NexarRuntime } from '@nexar/core';
import {
  EngineeringRunner,
  PlanCatalog,
  type EngineeringInput,
  type EngineeringRunnerDependencies,
  type EngineeringOutcome,
  type EngineeringRunOptions,
} from './index.js';

export const SHIPPED_PLANS = fileURLToPath(new URL('../../../engineering/plans', import.meta.url));
/** Appears in the goal only: must never reach a record or telemetry. */
export const GOAL_MARKER = 'GOAL-MARKER-9f3a1c';
/** Appears in the default report only: must never reach a record or telemetry. */
export const REPORT_MARKER = 'REPORT-MARKER-77d1e0';
/** Appears in the diff only: must never reach a record or telemetry. */
export const DIFF_MARKER = 'UNIQUE-DIFF-42';

const GIT_ENV = {
  PATH: process.env['PATH'] ?? '/usr/bin:/bin',
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_AUTHOR_NAME: 'Owner',
  GIT_AUTHOR_EMAIL: 'owner@example.invalid',
  GIT_COMMITTER_NAME: 'Owner',
  GIT_COMMITTER_EMAIL: 'owner@example.invalid',
};

/** Runs real git from the test itself (never from library code). */
export function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, env: GIT_ENV, encoding: 'utf8' });
}

export function tempDir(): string {
  return realpathSync(mkdtempSync(join(tmpdir(), 'nexar-eng-test-')));
}

export function cleanup(...dirs: string[]): void {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
}

export interface FakeLauncher extends ProcessLauncher {
  specs: LaunchSpec[];
  disposed: number;
}

/**
 * Stands in for the sandbox: runs the command unsandboxed, maps sandbox paths in env values back to
 * the mounts' host paths, uses the workspace as cwd and gives it a private `HOME`.
 */
export function fakeLauncher(
  home: string,
  isolation: 'none' | 'sandbox' = 'sandbox',
): FakeLauncher {
  const launcher: FakeLauncher = {
    isolation,
    specs: [],
    disposed: 0,
    prepare(spec): Promise<PreparedLaunch> {
      launcher.specs.push(spec);
      const env: Record<string, string> = {};
      for (const [key, value] of Object.entries(spec.env)) {
        let mapped = value;
        for (const mount of spec.mounts ?? []) {
          if (value === mount.sandboxPath || value.startsWith(`${mount.sandboxPath}/`)) {
            mapped = mount.hostPath + value.slice(mount.sandboxPath.length);
          }
        }
        env[key] = mapped;
      }
      env['HOME'] = home;
      env['PATH'] ??= process.env['PATH'] ?? '/usr/bin:/bin';
      return Promise.resolve({
        command: spec.command,
        args: spec.args,
        env,
        cwd: spec.workspace,
        workspacePath: '/work',
        isolation,
        dispose: () => {
          launcher.disposed += 1;
          return Promise.resolve();
        },
      });
    },
  };
  return launcher;
}

export interface LaneCall {
  readonly resourceId: string;
  readonly lane: string;
  readonly round: number;
  readonly prompt: string;
  readonly systemPrompt: string;
  readonly access: 'read-only' | 'read-write' | undefined;
  readonly workspacePath: string | undefined;
  readonly isolation: 'none' | 'sandbox' | undefined;
}

export type LaneHandler = (call: LaneCall, context: ExecutionContext) => string | Promise<string>;

/** A verdict reply: some prose, then the JSON object in a fence. */
export function verdictText(
  verdict: 'approve' | 'request-changes',
  findings: { severity: string; file?: string; message: string }[] = [],
): string {
  return `Review notes.\n\n\`\`\`json\n${JSON.stringify({ verdict, summary: 'done', findings })}\n\`\`\`\n`;
}

/** Edits a file in the lane's workspace, like a real implementer would. */
export function editFile(call: LaneCall, name = 'a.txt', text = `FEATURE-LINE ${DIFF_MARKER}\n`) {
  if (call.access !== 'read-write' || call.workspacePath === undefined) {
    throw new NexarError('POLICY_REJECTED', 'implementer needs a read-write workspace');
  }
  const file = join(call.workspacePath, name);
  mkdirSync(dirname(file), { recursive: true });
  appendFileSync(file, text);
}

/**
 * One adapter standing in for every resource. Default behaviour by lane id: `architecture` returns a
 * plan, `review` approves, `report` returns a short report, anything else edits `a.txt` in the workspace. `queue` overrides the next
 * calls of a lane.
 */
export class ScriptedAdapter implements ExecutionAdapter {
  readonly id = adapterId('fake');
  readonly displayName = 'Scripted';
  readonly calls: LaneCall[] = [];
  private readonly queues = new Map<string, LaneHandler[]>();

  queue(lane: string, ...handlers: LaneHandler[]): void {
    this.queues.set(lane, [...(this.queues.get(lane) ?? []), ...handlers]);
  }

  supports(resource: ResourceDescriptor): boolean {
    return resource.runtime.adapter === this.id;
  }

  probe(): Promise<ResourceState> {
    return Promise.resolve({
      availability: 'available',
      auth: 'not-required',
      observedAt: '2026-10-01T00:00:00.000Z',
    });
  }

  async execute(request: ExecutionRequest, context: ExecutionContext): Promise<ExecutionResult> {
    const meta = (request.task.metadata ?? {}) as { lane?: string; round?: number };
    const call: LaneCall = {
      resourceId: request.resource.id,
      lane: meta.lane ?? 'unknown',
      round: meta.round ?? 0,
      prompt: request.task.input.prompt,
      systemPrompt: request.task.input.systemPrompt ?? '',
      access: context.workspace?.access,
      workspacePath: context.workspace?.path,
      isolation: context.workspace?.launcher.isolation,
    };
    this.calls.push(call);
    const queued = this.queues.get(call.lane)?.shift();
    let text: string;
    if (queued !== undefined) text = await queued(call, context);
    else if (call.lane === 'architecture') text = 'PLAN-TEXT: change a.txt only';
    else if (call.lane === 'review') text = verdictText('approve');
    else if (call.lane === 'report') text = `Summary ${REPORT_MARKER}\n\nFindings\n- a.txt:1-1 ok`;
    else {
      editFile(call);
      text = 'implemented';
    }
    return {
      text,
      artifacts: [],
      usage: {
        inputTokens: measured(10),
        outputTokens: measured(5),
        costUsd: measured(0),
      },
      resolved: { provider: 'fake', model: 'scripted' },
      retries: 0,
    };
  }
}

const resourceJson = (id: string, capabilities: string[]) => ({
  id,
  displayName: id,
  kind: { type: 'agent', agent: 'fake', interface: 'cli' },
  capabilities,
  runtime: { adapter: 'fake', locality: 'local' },
  auth: { mode: 'none' },
  cost: { model: 'free' },
  dataLocality: 'local',
});

export const IMPLEMENTER = ['coding', 'repo-editing'];
export const REVIEWER = ['code-review'];
export const ARCHITECT = ['reasoning'];

/** A gate that passes only when `a.txt` contains the feature line. */
export const FEATURE_GATE = {
  name: 'test',
  command: [
    process.execPath,
    '-e',
    "console.log('gate-output-line'); process.exit(require('node:fs').readFileSync('a.txt','utf8').includes('FEATURE-LINE') ? 0 : 3)",
  ],
  timeoutMs: 30_000,
};

export interface HarnessOptions {
  readonly resources?: readonly { id: string; capabilities: string[] }[];
  /** Merged over the project's engineering settings. */
  readonly engineering?: Record<string, unknown>;
  readonly isolation?: 'none' | 'sandbox';
  readonly approvalMode?: 'deny-all' | 'store';
  readonly newId?: () => string;
}

export const silentLogger: Logger & { warnings: string[] } = {
  warnings: [],
  debug: () => undefined,
  info: () => undefined,
  warn(message) {
    silentLogger.warnings.push(message);
  },
  error: () => undefined,
  child: () => silentLogger,
};

export interface Harness {
  readonly base: string;
  readonly repo: string;
  readonly stateDir: string;
  readonly worktreesDir: string;
  readonly adapter: ScriptedAdapter;
  readonly launcher: FakeLauncher;
  readonly runtime: NexarRuntime;
  readonly runner: EngineeringRunner;
  readonly store: InMemoryApprovalStore;
  readonly gate: ApprovalGate;
  readonly events: TelemetryEvent[];
  readonly headBefore: string;
  /** Another runner over the same fixture, with some dependencies replaced. */
  makeRunner(overrides?: Partial<EngineeringRunnerDependencies>): EngineeringRunner;
  run(
    input?: Partial<EngineeringInput>,
    options?: EngineeringRunOptions,
  ): Promise<EngineeringOutcome>;
  /** Decides the next pending approval as soon as it exists; resolves with its id. */
  decideNext(decision: 'approve' | 'deny'): Promise<string>;
  dispose(): void;
}

/** A real owner repo, real worktrees, real git, a fake sandbox launcher and scripted resources. */
export async function createHarness(options: HarnessOptions = {}): Promise<Harness> {
  const base = tempDir();
  const root = join(base, 'work');
  const repo = join(root, 'repo');
  mkdirSync(repo, { recursive: true });
  git(repo, 'init', '-q', '-b', 'main');
  writeFileSync(join(repo, 'a.txt'), 'one\n');
  writeFileSync(join(repo, '.gitignore'), 'node_modules/\n');
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', 'init');
  const headBefore = git(repo, 'rev-parse', 'HEAD').trim();

  const stateDir = join(base, 'state');
  const worktreesDir = join(base, 'worktrees');
  const home = join(base, 'home');
  mkdirSync(home);

  const resources = options.resources ?? [
    { id: 'impl', capabilities: IMPLEMENTER },
    { id: 'reviewer', capabilities: REVIEWER },
    { id: 'architect', capabilities: ARCHITECT },
  ];
  const config = parseConfig(
    {
      version: 1,
      resources: resources.map((r) => resourceJson(r.id, r.capabilities)),
      routing: { policy: 'deterministic' },
      projects: [
        {
          id: 'demo',
          displayName: 'Demo',
          roots: ['work'],
          engineering: {
            repository: 'repo',
            baseBranch: 'main',
            gates: [FEATURE_GATE],
            ...options.engineering,
          },
        },
      ],
    },
    'test',
    { baseDir: base },
  );
  const events: TelemetryEvent[] = [];
  const telemetry = { emit: (event: TelemetryEvent) => void events.push(event) };
  const adapter = new ScriptedAdapter();
  const runtime = await createNexarWithProjects(config, {
    adapters: [adapter],
    telemetry,
    logger: silentLogger,
  });
  const launcher = fakeLauncher(home, options.isolation ?? 'sandbox');
  const store = new InMemoryApprovalStore();
  const gate = new ApprovalGate({
    mode: options.approvalMode ?? 'store',
    store,
    pollIntervalMs: 5,
  });
  const dependencies: EngineeringRunnerDependencies = {
    nexar: runtime.nexar,
    projects: runtime.projects,
    plans: await PlanCatalog.load(SHIPPED_PLANS),
    launcher,
    approvals: gate,
    artifacts: new LocalArtifactStore({ projects: runtime.projects }),
    telemetry,
    logger: silentLogger,
    stateDir,
    worktreesDir,
    author: { name: 'Nexar', email: 'nexar@localhost' },
    ...(options.newId === undefined ? {} : { newId: options.newId }),
  };
  const runner = new EngineeringRunner(dependencies);

  return {
    base,
    repo,
    stateDir,
    worktreesDir,
    adapter,
    launcher,
    runtime,
    runner,
    store,
    gate,
    events,
    headBefore,
    makeRunner: (overrides = {}) => new EngineeringRunner({ ...dependencies, ...overrides }),
    run: (input = {}, runOptions = {}) =>
      runner.run(
        { projectId: 'demo', goal: `Add the feature. ${GOAL_MARKER}`, ...input },
        runOptions,
      ),
    async decideNext(decision) {
      for (let i = 0; i < 2000; i++) {
        const [pending] = await store.list({ status: 'pending' });
        if (pending !== undefined) {
          await decide(store, pending.id, decision, { by: 'owner' });
          return pending.id;
        }
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      throw new Error('no approval became pending');
    },
    dispose: () => cleanup(base),
  };
}
