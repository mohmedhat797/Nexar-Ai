import { execFileSync } from 'node:child_process';
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createServer, request, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { ApprovalGate, InMemoryApprovalStore, decide } from '@nexar/approvals';
import { LocalArtifactStore } from '@nexar/artifacts';
import {
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
import { createNexarWithProjects, parseConfig } from '@nexar/core';
import {
  EngineeringRunner,
  PlanCatalog,
  readEngineeringRecord,
  type EngineeringProgress,
  type LaneEngine,
  type LaneEngineSession,
} from '@nexar/engineering';
import {
  CODING_PROFILE,
  DeepSeekHarnessExecutionAdapter,
  deepseekHarnessResource,
  type DeepSeekHarnessAdapterOptions,
} from '@nexar/integration-deepseek-harness';
import { SANDBOX_GATEWAY_PORT } from '@nexar/sandbox';
import { PlaneLaneEngine } from './lane-engine.js';

const TASK = 'eng-0123456789ab';
const FEATURE_LINE = 'FEATURE-LINE host-integration';
const UNIT_TEXT = 'UNIT-RESULT-text-0001';
const REQUIRED_CONTEXT_MARKER = 'REQUIRED-CONTEXT-MARKER-7';
const REQUIRED_CONTEXT = `Project memory (owner-confirmed; binding for this turn):\n- [decision] ${REQUIRED_CONTEXT_MARKER}`;
const SHIPPED_PLANS = fileURLToPath(new URL('../../../engineering/plans', import.meta.url));
const RELAY_BUILD = fileURLToPath(
  new URL('../../../apps/cli/scripts/build-relay.mjs', import.meta.url),
);
const FAKE_DSH = fileURLToPath(
  new URL('../../../integrations/deepseek-harness/src/test/fake-dsh-acp.mjs', import.meta.url),
);

const GIT_ENV = {
  PATH: process.env['PATH'] ?? '/usr/bin:/bin',
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_AUTHOR_NAME: 'Owner',
  GIT_AUTHOR_EMAIL: 'owner@example.invalid',
  GIT_COMMITTER_NAME: 'Owner',
  GIT_COMMITTER_EMAIL: 'owner@example.invalid',
};
const git = (cwd: string, ...args: string[]): string =>
  execFileSync('git', args, { cwd, env: GIT_ENV, encoding: 'utf8' });

const FEATURE_GATE = {
  name: 'test',
  command: [
    process.execPath,
    '-e',
    "process.exit(require('node:fs').readFileSync('a.txt','utf8').includes('FEATURE-LINE') ? 0 : 3)",
  ],
  timeoutMs: 30_000,
};

const silent: Logger & { lines: string[] } = {
  lines: [],
  debug: () => undefined,
  info(message, fields) {
    silent.lines.push(JSON.stringify([message, fields]));
  },
  warn(message, fields) {
    silent.lines.push(JSON.stringify([message, fields]));
  },
  error(message, fields) {
    silent.lines.push(JSON.stringify([message, fields]));
  },
  child: () => silent,
};

/** Stands in for every non-DSH resource; counts what ran where. */
class FakeAdapter implements ExecutionAdapter {
  readonly id = adapterId('fake');
  readonly displayName = 'Fake';
  readonly executed: { resourceId: string; input: string }[] = [];
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
  execute(request: ExecutionRequest, context: ExecutionContext): Promise<ExecutionResult> {
    const id = String(request.resource.id);
    this.executed.push({ resourceId: id, input: request.task.input.prompt });
    let text = 'PLAN-TEXT: change a.txt only';
    if (id === 'reviewer') {
      text = `Review notes.\n\n\`\`\`json\n${JSON.stringify({ verdict: 'approve', summary: 'done', findings: [] })}\n\`\`\`\n`;
    } else if (id === 'sub-unit') {
      text = UNIT_TEXT;
    } else if (id === 'native-impl') {
      appendFileSync(join(context.workspace?.path ?? '', 'a.txt'), `${FEATURE_LINE}\n`);
      text = 'implemented';
    }
    return Promise.resolve({
      text,
      artifacts: [],
      usage: { inputTokens: measured(1), outputTokens: measured(1), costUsd: measured(0) },
      resolved: { provider: 'fake', model: 'fake' },
      retries: 0,
    });
  }
}

/** The real DSH adapter (against the fake DSH), whose probe does not run the fake with `--version`. */
class ProbedDsh extends DeepSeekHarnessExecutionAdapter {
  constructor(
    options: DeepSeekHarnessAdapterOptions,
    private readonly availability: ResourceState['availability'],
  ) {
    super(options);
  }
  override probe(): Promise<ResourceState> {
    return Promise.resolve({
      availability: this.availability,
      auth: 'not-required',
      observedAt: '2026-10-01T00:00:00.000Z',
    });
  }
}

/** A loopback HTTP hop to `gateway.sock`, standing in for the sandbox's socat bridge (Host as in-sandbox). */
function startGatewayHop(socketPath: string): Promise<Server> {
  const server = createServer((req, res) => {
    const upstream = request(
      {
        socketPath,
        method: req.method,
        path: req.url,
        headers: { ...req.headers, host: `127.0.0.1:${String(SANDBOX_GATEWAY_PORT)}` },
      },
      (answer) => {
        res.writeHead(answer.statusCode ?? 502, answer.headers);
        answer.pipe(res);
      },
    );
    upstream.on('error', () => res.destroy());
    req.pipe(upstream);
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

/**
 * Claims the sandbox's isolation (the fixture pattern: the command runs unsandboxed, sandbox paths in
 * environment values and arguments map back to the mounts' host paths) and, for `spec.services`,
 * reports where the services appear: a loopback port for the gateway, host paths for the rest.
 */
class ServiceLauncher implements ProcessLauncher {
  readonly isolation = 'sandbox' as const;
  readonly specs: LaunchSpec[] = [];
  constructor(private readonly home: string) {}

  async prepare(spec: LaunchSpec): Promise<PreparedLaunch> {
    this.specs.push(spec);
    const toHost = (value: string): string => {
      for (const mount of spec.mounts ?? []) {
        if (value === mount.sandboxPath || value.startsWith(`${mount.sandboxPath}/`)) {
          return mount.hostPath + value.slice(mount.sandboxPath.length);
        }
      }
      return value;
    };
    const env: Record<string, string> = {};
    for (const [key, value] of Object.entries(spec.env)) env[key] = toHost(value);
    env['HOME'] = this.home;
    env['PATH'] ??= process.env['PATH'] ?? '/usr/bin:/bin';

    let hop: Server | undefined;
    let services: PreparedLaunch['services'];
    const { services: wanted } = spec;
    if (wanted !== undefined) {
      const reported: { gatewayBaseUrl?: string; bridgeEndpoint?: string; relayPath?: string } = {};
      if (wanted.gateway) {
        hop = await startGatewayHop(join(wanted.dir, 'gateway.sock'));
        const address = hop.address();
        const port = typeof address === 'object' && address !== null ? address.port : 0;
        reported.gatewayBaseUrl = `http://127.0.0.1:${String(port)}/v1`;
      }
      if (wanted.bridge) {
        reported.bridgeEndpoint = join(wanted.dir, 'bridge.sock');
        if (wanted.relayScript !== undefined) reported.relayPath = wanted.relayScript;
      }
      services = reported;
    }
    const closing = hop;
    return {
      command: spec.command,
      args: spec.args.map(toHost),
      env,
      cwd: spec.workspace,
      workspacePath: '/work',
      isolation: 'sandbox',
      ...(services === undefined ? {} : { services }),
      dispose: () =>
        new Promise<void>((resolve) => {
          if (closing === undefined) return resolve();
          closing.close(() => resolve());
          closing.closeAllConnections();
        }),
    };
  }
}

const capabilities = (...names: string[]) => names;
const fakeResource = (id: string, caps: string[]) => ({
  id,
  displayName: id,
  kind: { type: 'agent', agent: 'fake', interface: 'cli' },
  capabilities: caps,
  runtime: { adapter: 'fake', locality: 'local' },
  auth: { mode: 'none' },
  cost: { model: 'free' },
  dataLocality: 'local',
});

interface Fixture {
  readonly base: string;
  readonly repo: string;
  readonly stateDir: string;
  readonly planeDir: string;
  readonly dshRecord: string;
  readonly fake: FakeAdapter;
  readonly launcher: ServiceLauncher;
  readonly turns: { resourceId: string; tools: number; messages: number }[];
  readonly sessions: LaneEngineSession[];
  readonly events: TelemetryEvent[];
  readonly headBefore: string;
  readonly progress: EngineeringProgress[];
  run(requiredContext?: string): Promise<Awaited<ReturnType<EngineeringRunner['run']>>>;
  decideNext(): Promise<string>;
}

let fixtures: Fixture[] = [];
let relayScript = '';

interface FixtureOptions {
  /** A `model-turn` resource the plane may pin as the control resource. */
  readonly control: boolean;
  readonly dsh: 'available' | 'unavailable';
}

async function createFixture(options: FixtureOptions): Promise<Fixture> {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'nexar-dsh-it-')));
  const repo = join(base, 'work', 'repo');
  mkdirSync(repo, { recursive: true });
  git(repo, 'init', '-q', '-b', 'main');
  writeFileSync(join(repo, 'a.txt'), 'one\n');
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', 'init');
  const headBefore = git(repo, 'rev-parse', 'HEAD').trim();
  const home = join(base, 'home');
  mkdirSync(home);
  const stateDir = join(base, 'state');
  const planeDir = join(base, 'plane');
  const dshRecord = join(base, 'dsh-record.json');

  const dsh = deepseekHarnessResource({
    capabilities: ['text-generation', 'coding', 'repo-editing', 'tool-use', 'shell-execution'],
  });
  const resources: unknown[] = [
    dsh,
    fakeResource('architect', capabilities('reasoning')),
    fakeResource('reviewer', capabilities('code-review')),
    {
      ...fakeResource('sub-unit', capabilities('text-generation', 'web-research')),
      cost: { model: 'subscription' },
    },
  ];
  if (options.control) {
    resources.push({
      id: 'control-model',
      displayName: 'control-model',
      kind: { type: 'model', provider: 'anthropic', model: 'm', access: 'api' },
      capabilities: ['text-generation', 'model-turn'],
      runtime: { adapter: 'fake', locality: 'remote' },
      auth: { mode: 'none' },
      cost: { model: 'unknown' },
      dataLocality: 'third-party',
    });
  } else {
    resources.push(fakeResource('native-impl', capabilities('coding', 'repo-editing')));
  }
  const config = parseConfig(
    {
      version: 1,
      resources,
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
          },
        },
      ],
    },
    'test',
    { baseDir: base },
  );

  const events: TelemetryEvent[] = [];
  const telemetry = { emit: (event: TelemetryEvent) => void events.push(event) };
  const store = new InMemoryApprovalStore();
  const gate = new ApprovalGate({ mode: 'store', store, pollIntervalMs: 5 });
  const fake = new FakeAdapter();
  const dshAdapter = new ProbedDsh(
    {
      // Absolute `node`: the relay runs under the same Node as the (fake) DSH.
      binary: {
        command: process.execPath,
        args: [FAKE_DSH, `--fake-record=${dshRecord}`, '--fake-unit-capability=web-research'],
      },
      stateDir: join(base, 'dsh-state'),
      env: { PATH: process.env['PATH'] },
      approvals: { gate, store },
      initializeTimeoutMs: 10_000,
      defaultTimeoutMs: 60_000,
    },
    options.dsh,
  );
  const runtime = await createNexarWithProjects(config, {
    adapters: [dshAdapter, fake],
    telemetry,
    logger: silent,
  });
  await runtime.registry.refresh();

  const turns: Fixture['turns'] = [];
  const planeEngine = new PlaneLaneEngine({
    runtime,
    io: { env: {}, cwd: base },
    logger: silent,
    stateDir: planeDir,
    ttlMs: 120_000,
    relayScript,
    ports: (descriptor) =>
      descriptor.id === 'control-model'
        ? {
            turn: (turn) => {
              turns.push({
                resourceId: String(descriptor.id),
                tools: turn.tools?.length ?? 0,
                messages: turn.messages.length,
              });
              const answered = turn.messages.some((m) => m.role === 'tool');
              return Promise.resolve({
                ...(answered ? { text: 'implemented' } : {}),
                toolCalls: answered
                  ? []
                  : [
                      {
                        id: 'call_1',
                        name: 'write_file',
                        arguments: { path: 'a.txt', content: `one\n${FEATURE_LINE}\n` },
                      },
                    ],
                finishReason: answered ? ('stop' as const) : ('tool-calls' as const),
                usage: { inputTokens: measured(2), outputTokens: measured(1) },
              });
            },
          }
        : undefined,
  });
  // Keeps every session the plane opens so the test can look for its token everywhere else.
  const sessions: LaneEngineSession[] = [];
  const laneEngine: LaneEngine = {
    async open(lane) {
      const opened = await planeEngine.open(lane);
      if (!('unavailable' in opened)) sessions.push(opened);
      return opened;
    },
  };

  const launcher = new ServiceLauncher(home);
  const runner = new EngineeringRunner({
    nexar: runtime.nexar,
    projects: runtime.projects,
    plans: await PlanCatalog.load(SHIPPED_PLANS),
    launcher,
    approvals: gate,
    artifacts: new LocalArtifactStore({ projects: runtime.projects }),
    telemetry,
    logger: silent,
    stateDir,
    worktreesDir: join(base, 'worktrees'),
    author: { name: 'Nexar', email: 'nexar@localhost' },
    newId: () => TASK,
    laneEngine,
  });
  const progress: EngineeringProgress[] = [];
  const fixture: Fixture = {
    base,
    repo,
    stateDir,
    planeDir,
    dshRecord,
    fake,
    launcher,
    turns,
    sessions,
    events,
    headBefore,
    progress,
    run: (requiredContext) =>
      runner.run(
        {
          projectId: 'demo',
          goal: 'Add the feature.',
          ...(requiredContext === undefined ? {} : { requiredContext }),
        },
        { onProgress: (event) => progress.push(event) },
      ),
    async decideNext() {
      for (let i = 0; i < 4000; i++) {
        const [pending] = await store.list({ status: 'pending' });
        if (pending !== undefined) {
          await decide(store, pending.id, 'approve', { by: 'owner' });
          return pending.id;
        }
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      throw new Error('no approval became pending');
    },
  };
  fixtures.push(fixture);
  return fixture;
}

afterEach(() => {
  for (const f of fixtures) rmSync(f.base, { recursive: true, force: true });
  fixtures = [];
  silent.lines.length = 0;
});

// The pipeline runs harvest's /bin/sh and unix sockets: POSIX only (CI runs it on ubuntu).
describe.skipIf(process.platform === 'win32')('a DSH write lane on the engine gateway', () => {
  beforeAll(() => {
    const out = mkdtempSync(join(tmpdir(), 'nexar-relay-'));
    relayScript = join(out, 'bridge-relay.cjs');
    // The real relay, bundled exactly as the CLI build does.
    execFileSync(process.execPath, [RELAY_BUILD, relayScript], { stdio: 'pipe', timeout: 60_000 });
  }, 90_000);

  it('runs the lane on the control gateway, delegates one unit, and commits through the usual gates', async () => {
    const f = await createFixture({ control: true, dsh: 'available' });
    const approved = f.decideNext();
    const outcome = await f.run(REQUIRED_CONTEXT);
    const approvalId = await approved;

    expect(outcome).toMatchObject({ taskId: TASK, status: 'committed', branch: `nexar/${TASK}` });
    // The change went through the normal pipeline: an approved, fingerprint-bound commit on a task branch.
    expect(git(f.repo, 'rev-parse', 'HEAD').trim()).toBe(f.headBefore);
    expect(git(f.repo, 'show', `nexar/${TASK}:a.txt`)).toContain(FEATURE_LINE);
    expect(git(f.repo, 'log', '-1', '--format=%B', `nexar/${TASK}`)).toContain(
      `Nexar-Approval: ${approvalId}`,
    );

    const record = await readEngineeringRecord(f.stateDir, TASK);
    const feature = record?.lanes.find((l) => l.laneId === 'feature');
    expect(feature).toMatchObject({
      outcome: 'succeeded',
      resourceId: 'deepseek-harness',
      executor: 'engine',
      engine: 'dsh',
      controlResourceId: 'control-model',
    });
    expect(feature?.executorReason).toBeUndefined();
    expect(f.sessions).toHaveLength(1);
    expect(feature?.controlDecisionId).toBe(f.sessions[0]?.gateway.controlDecisionId);
    expect(record?.reviews[0]).toMatchObject({ resourceId: 'reviewer', verdict: 'approve' });

    // The loop's turns hit the pinned control resource, with the loop's tool offered.
    expect(f.turns.length).toBeGreaterThanOrEqual(2);
    expect(f.turns.every((t) => t.resourceId === 'control-model' && t.tools === 1)).toBe(true);

    // One bridge unit ran on the fake subscription resource, and its text reached the engine.
    expect(f.fake.executed.filter((e) => e.resourceId === 'sub-unit')).toHaveLength(1);
    expect(f.fake.executed.some((e) => e.resourceId === 'control-model')).toBe(false);
    const dsh = JSON.parse(readFileSync(f.dshRecord, 'utf8')) as {
      overlay: string;
      envTelemetryDisabled?: string;
      envKeys: string[];
      mcpTools: string[];
      mcpUnit: { outcome: string; resourceId: string; textLength: number };
      mcpPermissions: string[];
    };
    expect(dsh.mcpTools).toEqual(['nexar.intelligence_status', 'nexar.intelligence_submit']);
    expect(dsh.mcpUnit).toMatchObject({
      outcome: 'succeeded',
      resourceId: 'sub-unit',
      textLength: UNIT_TEXT.length,
    });
    expect(dsh.mcpPermissions.length).toBeGreaterThanOrEqual(2);
    expect(new Set(dsh.mcpPermissions)).toEqual(new Set(['allow-once']));
    // No DSH credential of its own, only the lane token.
    expect(dsh.envKeys).toContain('NEXAR_CONTROL_TOKEN');
    expect(dsh.envKeys).not.toContain('DEEPSEEK_API_KEY');
    // The lane's DSH launch got the Coding overlay with the owner's required context in its prompt
    // suffix, and DSH telemetry off.
    expect(dsh.overlay).toContain(`    personaPrefix: ${JSON.stringify(CODING_PROFILE.persona)}`);
    expect(dsh.overlay).toContain(REQUIRED_CONTEXT_MARKER);
    expect(dsh.envTelemetryDisabled).toBe('1');
    // ...and nowhere that persists or is shown.
    const shownContext = JSON.stringify([record, f.events, silent.lines, f.progress, outcome]);
    expect(shownContext).not.toContain(REQUIRED_CONTEXT_MARKER);

    const spec = f.launcher.specs.find((s) => s.services !== undefined);
    expect(spec?.services).toMatchObject({ gateway: true, bridge: true, relayScript });
    expect(spec?.network).toMatchObject({ mode: 'proxy' });

    // The token appears nowhere that persists or is shown: records, telemetry, logs, progress.
    const token = f.sessions[0]?.gateway.token ?? '';
    expect(token.length).toBeGreaterThan(16);
    const shown = JSON.stringify([record, f.events, silent.lines, f.progress, outcome]);
    expect(shown).not.toContain(token);
    expect(readFileSync(f.dshRecord, 'utf8')).not.toContain(token);

    // The lane's service directory is gone.
    expect(readdirSync(join(f.planeDir, 'lanes'))).toEqual([]);
  }, 120_000);

  it('runs the lane natively, and says so, when no control resource exists', async () => {
    const f = await createFixture({ control: false, dsh: 'unavailable' });
    const approved = f.decideNext();
    const outcome = await f.run();
    await approved;

    expect(outcome.status).toBe('committed');
    const record = await readEngineeringRecord(f.stateDir, TASK);
    expect(record?.lanes.find((l) => l.laneId === 'feature')).toMatchObject({
      resourceId: 'native-impl',
      executor: 'native',
      executorReason: 'control-unavailable',
    });
    expect(f.sessions).toHaveLength(0);
    expect(f.turns).toHaveLength(0);
    expect(f.launcher.specs.every((s) => s.services === undefined)).toBe(true);
    expect(existsSync(f.dshRecord)).toBe(false);
    expect(git(f.repo, 'show', `nexar/${TASK}:a.txt`)).toContain(FEATURE_LINE);
  }, 120_000);
});
