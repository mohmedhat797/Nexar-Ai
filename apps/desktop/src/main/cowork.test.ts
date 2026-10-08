import type { ChildProcess } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  NexarError,
  measured,
  type ArtifactRef,
  type Logger,
  type ModelTurnPortRequest,
  type RouteDecision,
} from '@nexar/contracts';
import {
  BridgeHost,
  DelegationUnitLimit,
  type BridgeEvent,
  type BridgeGrantInput,
  type ControlModelGateway,
} from '@nexar/engine-gateway';
import { createFakeControl, okTurn } from '@nexar/engine-gateway/testing';
import type { Turn } from '@nexar/sessions';
import type { BridgeResult, CoworkStatusDto, SessionDto, SubmitTurnResult } from '../shared/api.js';
import { CHANNELS } from '../shared/channels.js';
import type { ProviderRow } from '../shared/providers.js';
import { createBridge } from './bridge.js';
import { ControlGatewayChild } from './control-gateway-child.js';
import type { RelayLaunch } from './bridge-relay-path.js';
import {
  CoworkService,
  DELEGATION_INSTRUCTION,
  createScriptSpawn,
  type CoworkServiceOptions,
  type CoworkTimings,
} from './cowork.js';
import { DesktopKeyStore } from './desktop-key-store.js';
import { createEngineHost, type EngineHost } from './engine-host.js';
import { ProviderService } from './providers.js';
import { newTask } from './tasks.js';
import { addProject, createHarness, type Harness } from './test-harness.js';

const FAKE = fileURLToPath(
  new URL('../../../../tests/fixtures/fake-openworker.mjs', import.meta.url),
);
const SECRET = 'sk-ant-sentinel-cowork-secret-4417';
const OPENAI_SECRET = 'sk-openai-sentinel-cowork-secret-9921';
const GROQ_SECRET = 'gsk-groq-sentinel-cowork-secret-5503';
const SUBMISSION = 'c'.repeat(32);
const TIMINGS: Partial<CoworkTimings> = { startupTimeoutMs: 15_000, turnTimeoutMs: 20_000 };

const model = (
  id: string,
  provider: string,
  name: string,
  credential: string,
): Record<string, unknown> => ({
  id,
  displayName: `${provider}/${id}`,
  kind: { type: 'model', provider, model: name, access: 'api' },
  capabilities: ['text-generation', 'reasoning', 'knowledge-work'],
  runtime: { adapter: 'pi', locality: 'remote' },
  auth: { mode: 'api-key', credential: { source: 'keystore', name: credential } },
  cost: { model: 'unknown' },
  dataLocality: 'third-party',
});

let h: Harness;
let projectId: string;
let keys: DesktopKeyStore;
let engine: EngineHost;
let services: CoworkService[];
let logs: string[];

beforeEach(async () => {
  h = await createHarness();
  projectId = await addProject(h);
  services = [];
  logs = [];
  keys = new DesktopKeyStore({
    userData: h.userData,
    platform: 'win32',
    encryption: {
      isEncryptionAvailable: () => true,
      encryptString: (value) => Buffer.from([...Buffer.from(value)].map((n) => n ^ 0xaa)),
      decryptString: (value) => Buffer.from([...value].map((n) => n ^ 0xaa)).toString(),
    },
  });
  const raw = await h.config.read();
  (raw['resources'] as unknown[]).push(
    model('anthropic-m', 'anthropic', 'claude-sonnet-4-5', 'ANTHROPIC_API_KEY'),
    model('openai-m', 'openai', 'gpt-4o', 'OPENAI_API_KEY'),
    model('groq-m', 'groq', 'llama-3.3-70b-versatile', 'GROQ_API_KEY'),
  );
  await h.config.write(raw);
  engine = await createEngineHost({
    configPath: h.config.path,
    env: {},
    logger: h.deps.logger,
    resolveSecret: keys.resolveSecret,
  });
});

afterEach(async () => {
  await Promise.all(services.map((s) => s.dispose()));
  await h.cleanup();
});

const capture: Logger = (() => {
  const write =
    (level: string) =>
    (msg: string, fields?: unknown): void => {
      logs.push(`${level} ${msg} ${JSON.stringify(fields ?? {})}`);
    };
  const logger: Logger = {
    debug: write('debug'),
    info: write('info'),
    warn: write('warn'),
    error: write('error'),
    child: () => logger,
  };
  return logger;
})();

/** A real BridgeHost (stub allocator and executor) whose calls are logged in order. */
interface Delegation {
  readonly host: Pick<BridgeHost, 'ensureStarted' | 'mint' | 'revoke'>;
  readonly relay: () => RelayLaunch;
  readonly attach: (cowork: CoworkService) => void;
  readonly calls: string[];
  readonly grants: BridgeGrantInput[];
  readonly tokens: string[];
  /** For each revoke: had the fake server already seen the MCP entry deleted? */
  readonly deletedBeforeRevoke: boolean[];
  /** Grants open at once, at most. */
  maxOpen: number;
}

let relayFile: string;
let relayDir: string;
let gatewayFile: string;

beforeAll(async () => {
  relayDir = await mkdtemp(join(tmpdir(), 'nexar-relay-'));
  relayFile = join(relayDir, 'bridge-relay.cjs');
  await build({
    entryPoints: [
      fileURLToPath(
        new URL('../../../../integrations/mcp/src/bridge-relay-main.ts', import.meta.url),
      ),
    ],
    outfile: relayFile,
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node22',
    // The same options as scripts/build.mjs.
    define: { 'import.meta.url': '__importMetaUrl' },
    banner: { js: "const __importMetaUrl = require('node:url').pathToFileURL(__filename).href;" },
    logLevel: 'silent',
  });
  // The loopback translator child, bundled as scripts/build.mjs does.
  gatewayFile = join(relayDir, 'control-gateway.cjs');
  await build({
    entryPoints: [fileURLToPath(new URL('../control-gateway/main.ts', import.meta.url))],
    outfile: gatewayFile,
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node22',
    logLevel: 'silent',
  });
});
afterAll(() => rm(relayDir, { recursive: true, force: true }));

function delegation(): Delegation {
  const runtimeDir = join(dirname(h.userData), 'bridge-runtime');
  let sink: ((event: BridgeEvent) => void) | undefined;
  let n = 0;
  const real = new BridgeHost({
    allocator: {
      allocate: (ledger) =>
        Promise.resolve({
          decision: {
            outcome: 'selected',
            selected: { resourceId: 'res-a' },
          } as unknown as RouteDecision,
          ledger,
        }),
    },
    executor: () =>
      Promise.resolve({
        text: 'DELEGATED-ANSWER',
        resourceId: 'res-a',
        usage: { inputTokens: measured(1), outputTokens: measured(1), costUsd: measured(0) },
      }),
    clock: () => new Date(),
    newId: () => `g${String(++n)}`,
    logger: capture,
    runtimeDir,
    onEvent: (event) => sink?.(event),
  });
  const d: Delegation = {
    calls: [],
    grants: [],
    tokens: [],
    deletedBeforeRevoke: [],
    maxOpen: 0,
    attach: (cowork) => {
      sink = (event) => cowork.noteBridgeEvent(event);
    },
    relay: () => ({
      command: process.execPath,
      args: [relayFile],
      env: { ELECTRON_RUN_AS_NODE: '1' },
    }),
    host: undefined as never,
  };
  let open = 0;
  const host: Delegation['host'] = {
    ensureStarted: () => {
      d.calls.push('ensureStarted');
      return real.ensureStarted();
    },
    mint: (input) => {
      d.calls.push('mint');
      d.grants.push(input);
      const grant = real.mint(input);
      d.tokens.push(grant.token);
      d.maxOpen = Math.max(d.maxOpen, ++open);
      return grant;
    },
    revoke: (grantId) => {
      d.calls.push('revoke');
      open -= 1;
      void readFile(join(dirname(h.userData), 'ow-runtime', 'records.jsonl'), 'utf8')
        .then((text) => d.deletedBeforeRevoke.push(text.includes('mcp-delete')))
        .catch(() => d.deletedBeforeRevoke.push(false));
      real.revoke(grantId);
    },
  };
  Object.assign(d, { host });
  services.push({ dispose: () => real.stop() } as CoworkService);
  return d;
}

/** A real BridgeHost + translator child over a fake control port, with every host call logged. */
interface ControlKit {
  readonly host: NonNullable<CoworkServiceOptions['bridgeHost']>;
  readonly gateway: ControlModelGateway;
  readonly child: ControlGatewayChild;
  readonly relay: () => RelayLaunch;
  readonly attach: (cowork: CoworkService) => void;
  /** Host calls in order (`mint`, `restart`, `revoke`, ...). */
  readonly calls: string[];
  readonly grants: BridgeGrantInput[];
  readonly tokens: string[];
  /** Every model turn the fake port ran, with the resource it ran on. */
  readonly turns: { readonly resource: string; readonly request: ModelTurnPortRequest }[];
  /** For each revoke: had the fake server already seen the MCP entry deleted? */
  readonly deletedBeforeRevoke: boolean[];
  maxOpen: number;
}

/** A model turn that asks for the `scratch_note` tool first, then answers (an agent loop). */
function loopTurn(request: ModelTurnPortRequest, finalText = 'FINAL-DRAFT-TEXT') {
  const last = request.messages.at(-1);
  return last?.role === 'tool'
    ? okTurn(finalText)
    : {
        ...okTurn(),
        text: '',
        toolCalls: [{ id: 'call_1', name: 'scratch_note', arguments: { text: 'note' } }],
        finishReason: 'tool-calls' as const,
      };
}

function controlKit(options: {
  readonly resources?: readonly string[];
  readonly turn?: (request: ModelTurnPortRequest) => ReturnType<typeof loopTurn>;
}): ControlKit {
  const runtimeDir = join(dirname(h.userData), 'bridge-runtime');
  const hostRef: { current?: BridgeHost } = {};
  let sink: ((event: BridgeEvent) => void) | undefined;
  const fake = createFakeControl({
    ...(options.resources === undefined ? {} : { resources: options.resources }),
    turn: options.turn ?? loopTurn,
    retries: 0,
    onEvent: (event) => hostRef.current?.noteControlEvent(event),
  });
  let n = 0;
  const real = new BridgeHost({
    allocator: {
      allocate: (ledger) =>
        Promise.resolve({
          decision: {
            outcome: 'selected',
            selected: { resourceId: 'res-a' },
          } as unknown as RouteDecision,
          ledger,
        }),
    },
    executor: () =>
      Promise.resolve({
        text: 'DELEGATED-ANSWER',
        resourceId: 'res-a',
        usage: { inputTokens: measured(1), outputTokens: measured(1), costUsd: measured(0) },
      }),
    clock: () => new Date(),
    newId: () => `g${String(++n)}`,
    logger: capture,
    runtimeDir,
    gateway: fake.gateway,
    onEvent: (event) => sink?.(event),
  });
  hostRef.current = real;
  const child = new ControlGatewayChild({
    endpoint: () => real.ensureStarted(),
    logger: capture,
    launch: { command: process.execPath, args: [gatewayFile], env: { ELECTRON_RUN_AS_NODE: '1' } },
  });
  const kit: ControlKit = {
    gateway: fake.gateway,
    child,
    calls: [],
    grants: [],
    tokens: [],
    turns: fake.calls,
    deletedBeforeRevoke: [],
    maxOpen: 0,
    attach: (cowork) => {
      sink = (event) => cowork.noteBridgeEvent(event);
    },
    relay: () => ({
      command: process.execPath,
      args: [relayFile],
      env: { ELECTRON_RUN_AS_NODE: '1' },
    }),
    host: undefined as never,
  };
  let open = 0;
  Object.assign(kit, {
    host: {
      ensureStarted: () => real.ensureStarted(),
      mint: (...args: Parameters<BridgeHost['mint']>) => {
        kit.calls.push('mint');
        kit.grants.push(args[0]);
        const grant = real.mint(...args);
        kit.tokens.push(grant.token);
        kit.maxOpen = Math.max(kit.maxOpen, ++open);
        return grant;
      },
      revoke: (grantId: string) => {
        kit.calls.push('revoke');
        open -= 1;
        void readFile(join(dirname(h.userData), 'ow-runtime', 'records.jsonl'), 'utf8')
          .then((text) => kit.deletedBeforeRevoke.push(text.includes('mcp-delete')))
          .catch(() => kit.deletedBeforeRevoke.push(false));
        real.revoke(grantId);
      },
      restartControl: (grantId: string) => {
        kit.calls.push('restart');
        return real.restartControl(grantId);
      },
      controlFailed: (grantId: string) => real.controlFailed(grantId),
    } satisfies ControlKit['host'],
  });
  services.push({
    dispose: async () => {
      await child.stop();
      await real.stop();
    },
  } as CoworkService);
  return kit;
}

interface Setup {
  readonly control?: ControlKit;
  readonly allowed?: readonly string[];
  readonly saved?: Readonly<Record<string, string>>;
  readonly env?: Record<string, string>;
  readonly disabled?: boolean;
  readonly timings?: Partial<CoworkTimings>;
  readonly createTaskSpy?: (request: Parameters<typeof newTask>[1], correlation: unknown) => void;
  readonly onSpawn?: (args: readonly string[], child: ChildProcess) => void;
  readonly delegation?: Delegation;
  readonly openWorkerScratchBase?: string | undefined;
}

async function setup(options: Setup = {}) {
  for (const [name, value] of Object.entries(options.saved ?? { ANTHROPIC_API_KEY: SECRET })) {
    await keys.save(name, value);
  }
  for (const provider of options.allowed ?? ['anthropic']) {
    await h.deps.settings.setOpenWorkerAccess(provider, true);
  }
  const scriptSpawn = createScriptSpawn(FAKE, { ...options.env });
  const spawn = ((command: string, args: readonly string[], spawnOptions: object) => {
    const child = (scriptSpawn as (...a: unknown[]) => ChildProcess)(command, args, spawnOptions);
    options.onSpawn?.(args, child);
    return child;
  }) as unknown as typeof scriptSpawn;
  const cowork = new CoworkService({
    settings: h.deps.settings,
    engine,
    keys,
    logger: capture,
    stateDir: join(dirname(h.userData), 'ow-runtime'),
    ...(options.openWorkerScratchBase === undefined
      ? {}
      : { openWorkerScratchBase: options.openWorkerScratchBase }),
    ...(options.disabled === true ? { disabled: true } : {}),
    spawn,
    timings: { ...TIMINGS, ...options.timings },
    ...(options.delegation === undefined
      ? {}
      : { bridgeHost: options.delegation.host, relay: options.delegation.relay }),
    ...(options.control === undefined
      ? {}
      : {
          bridgeHost: options.control.host,
          controlGateway: options.control.gateway,
          controlChild: options.control.child,
          relay: options.control.relay,
        }),
    createTask: (request, excludedResourceIds) => {
      options.createTaskSpy?.(request, request.correlation);
      return newTask(
        engine,
        {
          projectId: request.projectId,
          kind: request.kind,
          prompt: request.prompt,
          preferredResourceIds: request.preferredResourceIds,
          maxCostUsd: request.maxCostUsd,
          excludedResourceIds,
        },
        request.turnId,
        { sessionId: request.sessionId, turnId: request.turnId },
      );
    },
  });
  services.push(cowork);
  options.delegation?.attach(cowork);
  options.control?.attach(cowork);
  const providers = new ProviderService({
    keys,
    config: h.config,
    engine,
    settings: h.deps.settings,
    clipboard: { readText: () => '', clear: () => undefined },
  });
  const bridge = createBridge({ ...h.deps, engine, cowork, providers });
  const call = <T = unknown>(channel: string, args: unknown = {}) =>
    bridge.invoke(channel, args, (event) => h.events.push(event)) as Promise<BridgeResult<T>>;
  return { cowork, call, providers };
}

async function turnOf(
  call: Awaited<ReturnType<typeof setup>>['call'],
  text = 'Draft a summary',
  maxDelegatedUnits?: number,
) {
  const created = await call<SessionDto>(CHANNELS.sessionsCreate, { projectId, mode: 'cowork' });
  if (!created.ok) throw new Error('sessions:create failed');
  const sessionId = created.value.id;
  const submitted = await call<SubmitTurnResult>(CHANNELS.sessionsSubmitTurn, {
    sessionId,
    submissionKey: SUBMISSION,
    text,
    ...(maxDelegatedUnits === undefined ? {} : { maxDelegatedUnits }),
  });
  if (!submitted.ok) throw new Error(`submit failed: ${submitted.error.code}`);
  return { sessionId, turnId: submitted.value.turn.id };
}

async function settled(sessionId: string): Promise<Turn> {
  await expect
    .poll(async () => (await h.sessionStore.get(sessionId))?.activeTurnId ?? null, {
      timeout: 25_000,
    })
    .toBeNull();
  const turn = (await h.sessionStore.get(sessionId))?.turns[0];
  if (turn === undefined) throw new Error('no turn');
  return turn;
}

const records = async (): Promise<Record<string, unknown>[]> =>
  (await readFile(join(dirname(h.userData), 'ow-runtime', 'records.jsonl'), 'utf8'))
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line) as Record<string, unknown>);

describe('Cowork lane', () => {
  it('runs a turn through OpenWorker, imports the draft and records the policy decisions', async () => {
    const { cowork, call } = await setup();
    expect(await cowork.refresh()).toMatchObject({ state: 'ready', version: '0.3.1' });
    const { sessionId } = await turnOf(call);
    const turn = await settled(sessionId);

    expect(turn).toMatchObject({
      state: 'succeeded',
      outcome: { text: 'Cowork done' },
      lane: { requestedLane: 'cowork', effectiveLane: 'cowork' },
      tasks: [{ state: 'succeeded', resourceId: 'anthropic-m' }],
    });
    expect(turn.lane?.fallbackReason).toBeUndefined();

    const taskId = turn.tasks[0]?.taskId as string;
    const draft = join(h.projectDir, '.nexar', 'artifacts', taskId, 'drafts', 'draft.md');
    expect(await readFile(draft, 'utf8')).toBe('DRAFT-CONTENT');
    expect(turn.artifacts).toHaveLength(1);

    const approvals = await engine.approvals().list();
    const coworkRecords = approvals.filter((r) => r.actionType === 'cowork.tool-call');
    expect(coworkRecords.map((r) => r.summary).sort()).toEqual([
      'Cowork run_shell: denied by policy',
      'Cowork write_file: allowed by policy',
    ]);
    expect(coworkRecords.every((r) => r.taskId === taskId && r.projectId === projectId)).toBe(true);
    // The scratch directory is removed after the import.
    expect(await readdirSafe(join(dirname(h.userData), 'ow-runtime', 'scratch'))).toEqual([]);
  });

  it('imports an OpenWorker conversation workspace draft, rejecting outside files and ignoring unrelated files', async () => {
    const scratchBase = await mkdtemp(join(tmpdir(), 'ow-scratch-base-'));
    const outside = await mkdtemp(join(tmpdir(), 'ow-outside-'));
    try {
      const { cowork } = await setup({
        openWorkerScratchBase: scratchBase,
        env: { COWORKER_SCRATCH_BASE: scratchBase },
      });
      const task = newTask(
        engine,
        {
          projectId,
          kind: 'documentation',
          prompt: 'Create a professional SOW using this project.',
        },
        'turn_sow_123',
        { sessionId: 'ses_test', turnId: 'turn_sow_123' },
      );
      const request = {
        sessionId: 'ses_test',
        turnId: 'turn_sow_123',
        projectId,
        prompt: 'Create a professional SOW using this project.',
        kind: 'documentation',
        permission: 'drafts-only' as const,
        correlation: {},
        onProgress: () => undefined,
        onTask: () => Promise.resolve(),
      };

      // Set up conversation workspace for turn_sow_123
      const wsDir = join(scratchBase, 'turn_sow_123');
      await mkdir(wsDir, { recursive: true });

      // Valid SOW draft in conversation workspace (Criterion F)
      const sowFile = join(wsDir, 'statement-of-work-live.md');
      await writeFile(sowFile, '# Statement of Work\nLive validation');

      // Unrelated files that must NOT be imported (Criterion H):
      // 1. tool-output log file
      await mkdir(join(wsDir, 'tool-output'), { recursive: true });
      await writeFile(join(wsDir, 'tool-output', '0011-read_file-content.txt'), 'internal log');
      // 2. worker directory file
      await mkdir(join(wsDir, 'workers'), { recursive: true });
      await writeFile(join(wsDir, 'workers', 'worker.md'), 'worker subtask');
      // 3. hidden file
      await writeFile(join(wsDir, '.hidden.md'), 'hidden');
      // 4. non-draft extension
      await writeFile(join(wsDir, 'script.py'), 'print(1)');

      // Symlink pointing outside the trusted workspace boundary (Criterion G)
      await writeFile(join(outside, 'outside-secret.md'), 'SECRET');
      try {
        await symlink(
          join(outside, 'outside-secret.md'),
          join(wsDir, 'symlink-outside.md'),
          'file',
        );
      } catch {
        /* Windows without symlink privileges */
      }

      // Legacy scratch directory with a draft (Criterion J)
      const scratchDir = await mkdtemp(join(tmpdir(), 'ow-scratch-dir-'));
      await writeFile(join(scratchDir, 'legacy-scratch-draft.md'), 'LEGACY-DRAFT');

      // Record source project file before import (Criterion I)
      const projectReadme = join(h.projectDir, 'README.md');
      await writeFile(projectReadme, '# Original Project');
      const readmeBefore = await readFile(projectReadme, 'utf8');

      // Import drafts
      const imported = await (
        cowork as unknown as {
          importDrafts: (
            r: typeof request,
            t: typeof task,
            s: string,
            sid?: string,
          ) => Promise<readonly ArtifactRef[]>;
        }
      ).importDrafts(request, task, scratchDir, 'turn_sow_123');

      // Criteria verification:
      // F: SOW draft in conversation workspace imported correctly!
      expect(imported).toHaveLength(2);
      const labels = imported
        .map((r: ArtifactRef) => (r.label ?? r.uri).replace(/\\/g, '/'))
        .sort();
      expect(labels.some((l) => l.endsWith('statement-of-work-live.md'))).toBe(true);

      // J: Legacy scratch directory draft imported!
      expect(labels.some((l) => l.endsWith('legacy-scratch-draft.md'))).toBe(true);

      // H: Unrelated files are NOT imported!
      expect(labels.some((l) => l.includes('0011-read_file-content.txt'))).toBe(false);
      expect(labels.some((l) => l.includes('worker.md'))).toBe(false);
      expect(labels.some((l) => l.includes('.hidden.md'))).toBe(false);
      expect(labels.some((l) => l.includes('script.py'))).toBe(false);

      // G: Draft outside boundary is NOT imported!
      expect(labels.some((l) => l.includes('symlink-outside.md'))).toBe(false);
      expect(labels.some((l) => l.includes('outside-secret.md'))).toBe(false);

      // I: Source project files remain unchanged!
      const readmeAfter = await readFile(projectReadme, 'utf8');
      expect(readmeAfter).toBe(readmeBefore);

      await rm(scratchDir, { recursive: true, force: true });
    } finally {
      await rm(scratchBase, { recursive: true, force: true });
      await rm(outside, { recursive: true, force: true });
    }
  });

  it('sends only the chosen provider key, with the provider:model, to the private server', async () => {
    const { cowork, call } = await setup({
      allowed: ['anthropic'],
      saved: {
        ANTHROPIC_API_KEY: SECRET,
        OPENAI_API_KEY: OPENAI_SECRET,
        GROQ_API_KEY: GROQ_SECRET,
      },
    });
    await cowork.refresh();
    const { sessionId } = await turnOf(call);
    const turn = await settled(sessionId);
    expect(turn.state).toBe('succeeded');

    const seen = await records();
    const providers = seen.filter((r) => r['kind'] === 'provider');
    expect(providers).toEqual([
      { kind: 'provider', body: { name: 'anthropic', fields: { api_key: SECRET, base_url: '' } } },
    ]);
    const message = seen.find((r) => r['kind'] === 'user_message');
    expect((message?.['body'] as { model?: string }).model).toBe('anthropic:claude-sonnet-4-5');

    const everything = JSON.stringify([
      logs,
      h.events,
      h.sessionEvents,
      await h.sessionStore.get(sessionId),
      await call(CHANNELS.coworkStatus),
      await call(CHANNELS.providersList),
      await engine.approvals().list(),
    ]);
    for (const secret of [SECRET, OPENAI_SECRET, GROQ_SECRET]) {
      expect(everything).not.toContain(secret);
    }
  });

  it('lets only allowed, keyed, supported providers be routed (never groq)', async () => {
    const { cowork } = await setup({
      allowed: ['anthropic', 'openai', 'groq'],
      saved: { ANTHROPIC_API_KEY: SECRET, GROQ_API_KEY: GROQ_SECRET },
    });
    expect((await cowork.usable()).map((r) => r.resourceId)).toEqual(['anthropic-m']);
    const excluded = await cowork.excluded();
    expect([...excluded].sort()).toEqual(['groq-m', 'local-echo', 'openai-m']);
  });

  it('keeps an owner preference for an excluded resource from selecting it', async () => {
    const { cowork, call } = await setup({
      allowed: ['anthropic'],
      saved: { ANTHROPIC_API_KEY: SECRET, OPENAI_API_KEY: OPENAI_SECRET },
    });
    await cowork.refresh();
    const created = await call<SessionDto>(CHANNELS.sessionsCreate, { projectId, mode: 'cowork' });
    if (!created.ok) throw new Error('create failed');
    const submitted = await call<SubmitTurnResult>(CHANNELS.sessionsSubmitTurn, {
      sessionId: created.value.id,
      submissionKey: SUBMISSION,
      text: 'Draft a summary',
      preferredResourceIds: ['openai-m', 'local-echo'],
    });
    expect(submitted.ok).toBe(true);
    const turn = await settled(created.value.id);
    expect(turn.tasks[0]?.resourceId).toBe('anthropic-m');
  });

  it('fails with NO_ELIGIBLE_RESOURCE when the NRC finds nothing for Cowork', async () => {
    const { cowork, call } = await setup({ allowed: ['anthropic'] });
    await cowork.refresh();
    // The only usable resource is rejected by a hard filter (a cost ceiling no resource meets).
    const created = await call<SessionDto>(CHANNELS.sessionsCreate, { projectId, mode: 'cowork' });
    if (!created.ok) throw new Error('create failed');
    await call(CHANNELS.sessionsSubmitTurn, {
      sessionId: created.value.id,
      submissionKey: SUBMISSION,
      text: 'Draft a summary',
      maxCostUsd: 0,
    });
    const turn = await settled(created.value.id);
    // An unknown-cost resource cannot satisfy a ceiling of zero.
    expect(turn).toMatchObject({
      state: 'failed',
      outcome: { error: { code: 'NO_ELIGIBLE_RESOURCE' } },
    });
  });

  it('mints a depth 1 openworker correlation for the task', async () => {
    const seen: unknown[] = [];
    const { cowork, call } = await setup({ createTaskSpy: (_r, c) => seen.push(c) });
    await cowork.refresh();
    const { sessionId, turnId } = await turnOf(call);
    await settled(sessionId);
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({
      depth: 1,
      chain: ['nexar', 'openworker'],
      currentOrchestrator: 'openworker',
      correlationId: turnId,
    });
  });

  describe('unavailable lane falls back to direct', () => {
    const cases: [string, Setup, CoworkStatusDto['state'], string][] = [
      [
        'OpenWorker is missing',
        { disabled: true },
        'openworker-missing',
        'OpenWorker is not installed',
      ],
      [
        'the version is unsupported',
        { env: { NEXAR_FAKE_OPENWORKER_VERSION: '0.4.0' } },
        'unsupported-version',
        'OpenWorker version is not supported',
      ],
      [
        'startup fails',
        { env: { NEXAR_FAKE_OPENWORKER_NEVER_READY: '1' }, timings: { startupTimeoutMs: 1_200 } },
        'startup-failed',
        'OpenWorker did not start',
      ],
      [
        'no provider is allowed',
        { allowed: [] },
        'configuration-missing',
        'No allowed provider with a saved key can run Cowork',
      ],
      [
        'an allowed provider has no key',
        { allowed: ['anthropic'], saved: { OPENAI_API_KEY: OPENAI_SECRET } },
        'configuration-missing',
        'No allowed provider with a saved key can run Cowork',
      ],
    ];
    it.each(cases)('when %s', async (_name, options, state, reason) => {
      const { cowork, call } = await setup(options);
      expect(await cowork.refresh()).toMatchObject({ state, reason });
      expect(await call(CHANNELS.coworkStatus)).toMatchObject({
        ok: true,
        value: { state, reason },
      });
      const { sessionId } = await turnOf(call);
      const turn = await settled(sessionId);
      expect(turn).toMatchObject({
        state: 'succeeded',
        lane: {
          requestedLane: 'cowork',
          effectiveLane: 'direct',
          fallbackReason: 'openworker-unavailable',
        },
      });
      expect(turn.tasks[0]?.resourceId).toBe('local-echo');
    });
  });

  describe('failures map to fixed codes', () => {
    it('cancels a running turn', async () => {
      const { cowork, call } = await setup({ env: { NEXAR_FAKE_OPENWORKER_SCENARIO: 'hang' } });
      await cowork.refresh();
      const { sessionId, turnId } = await turnOf(call);
      await expect
        .poll(async () => (await h.sessionStore.get(sessionId))?.turns[0]?.tasks.length, {
          timeout: 20_000,
        })
        .toBe(1);
      // Wait until the turn reached OpenWorker (the draft scratch directory exists).
      await expect
        .poll(
          async () =>
            (await readdirSafe(join(dirname(h.userData), 'ow-runtime', 'scratch'))).length,
        )
        .toBe(1);
      expect(await call(CHANNELS.sessionsCancel, { sessionId, turnId })).toMatchObject({
        ok: true,
      });
      const turn = await settled(sessionId);
      expect(turn.state).toBe('cancelled');
      expect(turn.tasks[0]?.state).toBe('cancelled');
    });

    it('times out a turn that never finishes', async () => {
      const { cowork, call } = await setup({
        env: { NEXAR_FAKE_OPENWORKER_SCENARIO: 'hang' },
        timings: { turnTimeoutMs: 1_000 },
      });
      await cowork.refresh();
      const { sessionId } = await turnOf(call);
      expect(await settled(sessionId)).toMatchObject({
        state: 'failed',
        outcome: {
          error: { code: 'EXECUTION_TIMEOUT', message: 'OpenWorker did not finish in time' },
        },
      });
    });

    it('fails a malformed frame with a fixed code and text', async () => {
      const { cowork, call } = await setup({
        env: { NEXAR_FAKE_OPENWORKER_SCENARIO: 'malformed' },
      });
      await cowork.refresh();
      const { sessionId } = await turnOf(call);
      expect(await settled(sessionId)).toMatchObject({
        state: 'failed',
        outcome: {
          error: { code: 'INTEGRATION_UNAVAILABLE', message: 'OpenWorker sent an invalid message' },
        },
      });
    });

    it('never echoes upstream error text', async () => {
      const { cowork, call } = await setup({ env: { NEXAR_FAKE_OPENWORKER_SCENARIO: 'error' } });
      await cowork.refresh();
      const { sessionId } = await turnOf(call);
      const turn = await settled(sessionId);
      expect(turn.state).toBe('failed');
      expect(JSON.stringify([turn, logs, h.sessionEvents])).not.toContain('SECRET-UPSTREAM-DETAIL');
    });
  });

  it('stops the supervised server on dispose and refuses later turns', async () => {
    const { cowork } = await setup();
    await cowork.refresh();
    const supervisor = (
      cowork as unknown as {
        supervisor: { value: { status(): { state: string }; client(): unknown } };
      }
    ).supervisor.value;
    expect(supervisor.client()).toBeDefined();
    await cowork.dispose();
    expect(supervisor.client()).toBeUndefined();
    expect(cowork.available()).toBe(false);
  });

  it('ends a server that is still starting on dispose, without waiting for the startup bound', async () => {
    const servers: ChildProcess[] = [];
    const { cowork } = await setup({
      env: { NEXAR_FAKE_OPENWORKER_NEVER_READY: '1' },
      onSpawn: (args, child) => {
        if (args[0] === '--host') servers.push(child);
      },
    });
    // The probe waits for a health check that never passes (bound: 15 s).
    const probing = cowork.refresh();
    await vi.waitFor(() => expect(servers).toHaveLength(1), { timeout: 10_000 });
    const server = servers[0]!;
    const disposedAt = Date.now();
    await cowork.dispose();
    expect(Date.now() - disposedAt).toBeLessThan(5_000);
    expect((await probing).state).not.toBe('ready');
    await vi.waitFor(
      () => expect(server.exitCode !== null || server.signalCode !== null).toBe(true),
      { timeout: 5_000 },
    );
    expect(servers).toHaveLength(1);
  });
});

describe('Cowork AI behavior (NXR-053)', () => {
  const modes = async (): Promise<unknown[]> =>
    (await records()).filter((r) => r['kind'] === 'set_mode').map((r) => r['body']);

  it('drafts only (the default) keeps the scratch write allowed and sends interactive mode', async () => {
    const { cowork, call } = await setup();
    await cowork.refresh();
    const { sessionId } = await turnOf(call);
    const turn = await settled(sessionId);
    expect(turn.artifacts).toHaveLength(1);
    expect(await modes()).toEqual([{ type: 'set_mode', mode: 'interactive' }]);
    expect((await engine.approvals().list()).some((r) => r.actionType === 'cowork.write')).toBe(
      false,
    );
  });

  it('read only: discuss mode, every write denied by policy, no draft imported', async () => {
    const { cowork, call } = await setup();
    await h.deps.settings.setBehavior({ cowork: { permission: 'read-only' } });
    await cowork.refresh();
    const { sessionId } = await turnOf(call);
    const turn = await settled(sessionId);

    expect(turn).toMatchObject({ state: 'succeeded', outcome: { text: 'Cowork done' } });
    expect(turn.artifacts).toHaveLength(0);
    expect(await modes()).toEqual([{ type: 'set_mode', mode: 'discuss' }]);
    const taskId = turn.tasks[0]?.taskId as string;
    const policy = (await engine.approvals().list()).filter(
      (r) => r.actionType === 'cowork.tool-call',
    );
    expect(policy.map((r) => r.summary).sort()).toEqual([
      'Cowork run_shell: denied by policy',
      'Cowork write_file: denied by policy',
    ]);
    expect(policy.every((r) => r.metadata?.['ruleId'] === 'cowork.read-only.deny')).toBe(true);
    await expect(
      readFile(join(h.projectDir, '.nexar', 'artifacts', taskId, 'drafts', 'draft.md')),
    ).rejects.toThrow();
  });

  it('ask before write: a scratch write waits for an owner approval, then the draft is imported', async () => {
    const { cowork, call } = await setup({
      timings: { approvalPollMs: 20, approvalTtlMs: 20_000 },
    });
    await h.deps.settings.setBehavior({ cowork: { permission: 'ask-before-write' } });
    await cowork.refresh();
    const { sessionId } = await turnOf(call);

    const pending = await expect
      .poll(
        async () =>
          (await engine.approvals().list({ status: 'pending' })).filter(
            (r) => r.actionType === 'cowork.write',
          ),
        { timeout: 20_000 },
      )
      .toHaveLength(1)
      .then(async () =>
        (await engine.approvals().list({ status: 'pending' })).filter(
          (r) => r.actionType === 'cowork.write',
        ),
      );
    const request = pending[0];
    expect(request).toMatchObject({
      risk: 'low',
      summary: 'Cowork wants to write the draft file draft.md',
    });
    // Still waiting: nothing is imported and the turn is running.
    expect((await h.sessionStore.get(sessionId))?.activeTurnId).not.toBeNull();

    const approved = await call(CHANNELS.approvalsApprove, { id: request?.id });
    expect(approved.ok).toBe(true);
    const turn = await settled(sessionId);
    expect(turn.state).toBe('succeeded');
    expect(turn.artifacts).toHaveLength(1);
    const taskId = turn.tasks[0]?.taskId as string;
    expect(
      await readFile(
        join(h.projectDir, '.nexar', 'artifacts', taskId, 'drafts', 'draft.md'),
        'utf8',
      ),
    ).toBe('DRAFT-CONTENT');
    // The approval was single use; the shell request was still denied by policy.
    const all = await engine.approvals().list();
    expect(all.find((r) => r.id === request?.id)?.status).toBe('consumed');
    expect(all.filter((r) => r.actionType === 'cowork.tool-call').map((r) => r.summary)).toEqual([
      'Cowork run_shell: denied by policy',
    ]);
  });

  it('ask before write: a denial denies the write and no draft is imported', async () => {
    const { cowork, call } = await setup({
      timings: { approvalPollMs: 20, approvalTtlMs: 20_000 },
    });
    await h.deps.settings.setBehavior({ cowork: { permission: 'ask-before-write' } });
    await cowork.refresh();
    const { sessionId } = await turnOf(call);
    await expect
      .poll(async () => (await engine.approvals().list({ status: 'pending' })).length, {
        timeout: 20_000,
      })
      .toBe(1);
    const [request] = await engine.approvals().list({ status: 'pending' });
    expect((await call(CHANNELS.approvalsDeny, { id: request?.id })).ok).toBe(true);
    const turn = await settled(sessionId);
    expect(turn.state).toBe('succeeded');
    expect(turn.artifacts).toHaveLength(0);
    expect((await engine.approvals().list()).find((r) => r.id === request?.id)?.status).toBe(
      'denied',
    );
  });

  it('ask before write: an expired approval denies the write', async () => {
    const { cowork, call } = await setup({ timings: { approvalPollMs: 20, approvalTtlMs: 300 } });
    await h.deps.settings.setBehavior({ cowork: { permission: 'ask-before-write' } });
    await cowork.refresh();
    const { sessionId } = await turnOf(call);
    const turn = await settled(sessionId);
    expect(turn.state).toBe('succeeded');
    expect(turn.artifacts).toHaveLength(0);
    const write = (await engine.approvals().list()).find((r) => r.actionType === 'cowork.write');
    expect(write?.status).toBe('expired');
  });
});
describe('providers:setOpenWorkerAccess', () => {
  it('lists support and opt-in flags and toggles access without touching keys', async () => {
    const { call } = await setup({ allowed: [] });
    const before = await call<ProviderRow[]>(CHANNELS.providersList);
    if (!before.ok) throw new Error('list failed');
    const flags = Object.fromEntries(
      before.value.map((row) => [row.provider, [row.openWorkerSupported, row.openWorkerAllowed]]),
    );
    expect(flags).toMatchObject({
      anthropic: [true, false],
      google: [true, false],
      groq: [false, false],
    });

    const allowed = await call<ProviderRow>(CHANNELS.providersSetOpenWorkerAccess, {
      provider: 'anthropic',
      allowed: true,
    });
    expect(allowed).toMatchObject({
      ok: true,
      value: { openWorkerAllowed: true, status: 'saved' },
    });
    expect(keys.metadata('ANTHROPIC_API_KEY')).toMatchObject({ present: true });
    expect(await h.deps.settings.getCowork()).toEqual({
      valid: true,
      value: { allowedProviders: ['anthropic'] },
    });

    const revoked = await call<ProviderRow>(CHANNELS.providersSetOpenWorkerAccess, {
      provider: 'anthropic',
      allowed: false,
    });
    expect(revoked).toMatchObject({ ok: true, value: { openWorkerAllowed: false } });
  });

  it('rejects unknown providers, extra fields, wrong types and unsupported providers', async () => {
    const { call } = await setup({ allowed: [] });
    const bad: unknown[] = [
      { provider: 'bogus', allowed: true },
      { provider: 'anthropic' },
      { provider: 'anthropic', allowed: 'yes' },
      { provider: 'anthropic', allowed: true, key: SECRET },
      { provider: 'anthropic', allowed: true, executable: '/bin/sh' },
      { provider: '__proto__', allowed: true },
      { allowed: true },
    ];
    for (const args of bad) {
      const result = await call(CHANNELS.providersSetOpenWorkerAccess, args);
      expect(result.ok, JSON.stringify(args)).toBe(false);
      if (!result.ok) expect(result.error.code).toBe('VALIDATION_ERROR');
    }
    // groq is a valid provider id but OpenWorker cannot use it: refused, nothing stored.
    const groq = await call(CHANNELS.providersSetOpenWorkerAccess, {
      provider: 'groq',
      allowed: true,
    });
    expect(groq.ok).toBe(false);
    expect(await h.deps.settings.getCowork()).toEqual({
      valid: true,
      value: { allowedProviders: [] },
    });
  });

  it('exposes cowork:status and cowork:refresh with strict empty arguments', async () => {
    const { call } = await setup({ allowed: [] });
    expect((await call(CHANNELS.coworkStatus, { path: '/x' })).ok).toBe(false);
    expect((await call(CHANNELS.coworkRefresh, { executable: '/bin/sh' })).ok).toBe(false);
    const status = await call<CoworkStatusDto>(CHANNELS.coworkRefresh);
    expect(status).toMatchObject({ ok: true, value: { state: 'configuration-missing' } });
  });
});

describe('Cowork delegation through the Intelligence Bridge (NXR-059b)', () => {
  const DELEGATE = { NEXAR_FAKE_OPENWORKER_SCENARIO: 'delegate' };
  const names = async (): Promise<string[]> => (await records()).map((r) => String(r['kind']));

  it('propagates the owner one-unit restriction through IPC, Operating and a delegation-owned grant', async () => {
    const delegating = delegation();
    const { cowork, call } = await setup({ env: DELEGATE, delegation: delegating });
    await cowork.refresh();
    const { sessionId } = await turnOf(call, 'Review exactly one unit', 1);
    expect((await settled(sessionId)).tasks[0]?.delegations).toEqual([
      { unitId: 'u1', resourceId: 'res-a', outcome: 'succeeded' },
    ]);
    expect(delegating.grants).toHaveLength(1);
    expect(delegating.grants[0]).toMatchObject({
      maxUnits: 1,
      unitLimit: expect.any(DelegationUnitLimit) as DelegationUnitLimit,
    });
    expect(delegating.calls).toEqual(['ensureStarted', 'mint', 'revoke']);
    const replay = await call<SubmitTurnResult>(CHANNELS.sessionsSubmitTurn, {
      sessionId,
      submissionKey: SUBMISSION,
      text: 'Review exactly one unit',
      maxDelegatedUnits: 16,
    });
    expect(replay).toMatchObject({ ok: true, value: { created: false } });
    expect(delegating.grants).toHaveLength(1);
  });

  it('registers the relay, delegates a unit, imports the draft and cleans up in order', async () => {
    const delegating = delegation();
    const { cowork, call } = await setup({ env: DELEGATE, delegation: delegating });
    await cowork.refresh();
    const { sessionId, turnId } = await turnOf(call);
    const turn = await settled(sessionId);

    expect(turn).toMatchObject({
      state: 'succeeded',
      outcome: { text: 'Delegated unit done' },
      tasks: [
        {
          state: 'succeeded',
          delegations: [{ unitId: 'u1', resourceId: 'res-a', outcome: 'succeeded' }],
        },
      ],
    });
    const taskId = turn.tasks[0]?.taskId as string;
    const draft = join(h.projectDir, '.nexar', 'artifacts', taskId, 'drafts', 'draft.md');
    expect(await readFile(draft, 'utf8')).toBe('DELEGATED-ANSWER');

    // The grant: draft access, the turn's lineage, the unit cap and the turn timeout as ttl.
    expect(delegating.grants).toEqual([
      {
        sessionId,
        turnId,
        correlationId: turnId,
        projectId,
        engine: 'openworker',
        access: 'draft',
        maxUnits: 16,
        unitLimit: expect.any(DelegationUnitLimit) as DelegationUnitLimit,
        ttlMs: 20_000,
      },
    ]);
    // Register, then (after the turn) delete, then revoke.
    expect(delegating.calls).toEqual(['ensureStarted', 'mint', 'revoke']);
    expect(delegating.grants[0]?.unitLimit?.admit()).toBe(false);
    expect(await names()).toEqual(expect.arrayContaining(['mcp-register', 'mcp-delete']));
    const seen = await records();
    expect(seen.find((r) => r['kind'] === 'mcp-register')?.['body']).toEqual({
      name: 'nexar',
      envNames: ['ELECTRON_RUN_AS_NODE', 'NEXAR_BRIDGE_ENDPOINT', 'NEXAR_BRIDGE_TOKEN'],
    });
    const kinds = await names();
    expect(kinds.indexOf('mcp-register')).toBeLessThan(kinds.indexOf('user_message'));
    expect(kinds.indexOf('mcp-delete')).toBeGreaterThan(kinds.indexOf('user_message'));
    await expect.poll(() => delegating.deletedBeforeRevoke).toEqual([true]);

    // The fixed Nexar line follows the request, outside it.
    const message = seen.find((r) => r['kind'] === 'user_message');
    const text = (message?.['body'] as { text: string }).text;
    expect(text.endsWith(`\n\n${DELEGATION_INSTRUCTION}`)).toBe(true);
    expect(text.split(DELEGATION_INSTRUCTION)).toHaveLength(2);
    expect(text.indexOf('</untrusted-input>')).toBeLessThan(text.indexOf(DELEGATION_INSTRUCTION));

    // Policy: the two exact bridge tools were allowed and recorded under cowork.delegation.
    const policy = (await engine.approvals().list()).filter(
      (r) => r.actionType === 'cowork.tool-call',
    );
    expect(policy.map((r) => r.summary).sort()).toEqual([
      'Cowork mcp__nexar__nexar_intelligence_status: allowed by policy',
      'Cowork mcp__nexar__nexar_intelligence_submit: allowed by policy',
    ]);
    expect(policy.every((r) => r.metadata?.['ruleId'] === 'cowork.delegation')).toBe(true);

    // The token is only ever in the private registration: nowhere Nexar logs or records.
    const everything = JSON.stringify([
      logs,
      h.events,
      h.sessionEvents,
      await h.sessionStore.get(sessionId),
      await engine.approvals().list(),
      seen,
    ]);
    for (const token of delegating.tokens) expect(everything).not.toContain(token);
    expect(everything).not.toContain('SECRET-ARGUMENT');
  });

  it('read only: the grant is read only, the delegated unit runs, no draft is imported', async () => {
    await h.deps.settings.setBehavior({ cowork: { permission: 'read-only' } });
    const delegating = delegation();
    const { cowork, call } = await setup({ env: DELEGATE, delegation: delegating });
    await cowork.refresh();
    const { sessionId } = await turnOf(call);
    const turn = await settled(sessionId);

    expect(delegating.grants.map((g) => g.access)).toEqual(['read-only']);
    expect(turn.state).toBe('succeeded');
    expect(turn.artifacts).toHaveLength(0);
    expect(turn.tasks[0]?.delegations).toEqual([
      { unitId: 'u1', resourceId: 'res-a', outcome: 'succeeded' },
    ]);
  });

  it('deletes the MCP entry and revokes the grant when the turn fails', async () => {
    const delegating = delegation();
    const { cowork, call } = await setup({
      env: { NEXAR_FAKE_OPENWORKER_SCENARIO: 'error' },
      delegation: delegating,
    });
    await cowork.refresh();
    const { sessionId } = await turnOf(call);
    expect((await settled(sessionId)).state).toBe('failed');
    expect(delegating.calls).toEqual(['ensureStarted', 'mint', 'revoke']);
    expect(await names()).toContain('mcp-delete');
    await expect.poll(() => delegating.deletedBeforeRevoke).toEqual([true]);
  });

  it('deletes the MCP entry and revokes the grant when the turn is cancelled', async () => {
    const delegating = delegation();
    const { cowork, call } = await setup({
      env: { NEXAR_FAKE_OPENWORKER_SCENARIO: 'hang' },
      delegation: delegating,
    });
    await cowork.refresh();
    const { sessionId, turnId } = await turnOf(call);
    await expect.poll(async () => (await names()).includes('user_message')).toBe(true);
    expect(await call(CHANNELS.sessionsCancel, { sessionId, turnId })).toMatchObject({ ok: true });
    expect((await settled(sessionId)).state).toBe('cancelled');
    expect(delegating.calls).toEqual(['ensureStarted', 'mint', 'revoke']);
    expect(await names()).toContain('mcp-delete');
    await expect.poll(() => delegating.deletedBeforeRevoke).toEqual([true]);
  });

  it('serializes concurrent turns: one grant and one MCP entry at a time', async () => {
    const delegating = delegation();
    const { cowork, call } = await setup({ env: DELEGATE, delegation: delegating });
    await cowork.refresh();
    const first = await turnOf(call);
    const second = await turnOf(call, 'Draft another summary');
    expect((await settled(first.sessionId)).state).toBe('succeeded');
    expect((await settled(second.sessionId)).state).toBe('succeeded');
    expect(delegating.maxOpen).toBe(1);
    expect(delegating.calls).toEqual([
      'ensureStarted',
      'mint',
      'revoke',
      'ensureStarted',
      'mint',
      'revoke',
    ]);
    expect((await names()).filter((k) => k === 'mcp-register')).toHaveLength(2);
  });

  it('runs the turn without delegation when the bridge cannot start', async () => {
    const delegating = delegation();
    const failing: Delegation = {
      ...delegating,
      host: {
        ...delegating.host,
        ensureStarted: () => Promise.reject(new Error('SECRET-PIPE-DETAIL')),
      },
    };
    const { cowork, call } = await setup({ delegation: failing });
    await cowork.refresh();
    const { sessionId } = await turnOf(call);
    const turn = await settled(sessionId);
    expect(turn).toMatchObject({ state: 'succeeded', outcome: { text: 'Cowork done' } });
    expect(turn.tasks[0]?.delegations).toBeUndefined();
    expect(await names()).not.toContain('mcp-register');
    expect(logs.join('\n')).not.toContain('SECRET-PIPE-DETAIL');
    expect(logs.join('\n')).toContain('cowork delegation unavailable');
  });

  it('changes nothing without a bridge host', async () => {
    const { cowork, call } = await setup();
    await cowork.refresh();
    const { sessionId } = await turnOf(call);
    const turn = await settled(sessionId);
    expect(turn).toMatchObject({ state: 'succeeded', outcome: { text: 'Cowork done' } });
    expect(turn.tasks[0]?.delegations).toBeUndefined();
    const seen = await records();
    expect(seen.map((r) => r['kind'])).not.toContain('mcp-register');
    const message = seen.find((r) => r['kind'] === 'user_message');
    const text = (message?.['body'] as { text: string }).text;
    expect(text).toContain('Draft a summary');
    expect(text).not.toContain('Nexar: delegate');
    // Delegation tools are denied by policy when no grant was opened.
    const policy = (await engine.approvals().list()).filter(
      (r) => r.actionType === 'cowork.tool-call',
    );
    expect(policy.some((r) => r.summary.includes('nexar'))).toBe(false);
  });
});

async function readdirSafe(path: string): Promise<string[]> {
  const { readdir } = await import('node:fs/promises');
  try {
    return await readdir(path);
  } catch {
    return [];
  }
}

describe('Cowork control loop through Nexar (NXR-063b)', () => {
  const LOOP = { NEXAR_FAKE_OPENWORKER_SCENARIO: 'control-loop' };
  const BASE_URL = /^http:\/\/127\.0\.0\.1:[1-9]\d{0,4}\/v1$/;
  const RESOURCES = ['res-a', 'res-b'] as const;
  const providerEntries = async () =>
    (await records())
      .filter((r) => r['kind'] === 'provider')
      .map((r) => r['body'] as { name: string; fields: Record<string, string> });
  const userMessages = async () =>
    (await records()).filter((r) => r['kind'] === 'user_message').length;

  async function runDirect(
    cowork: CoworkService,
    signal = new AbortController().signal,
    maxDelegatedUnits?: number,
  ) {
    const turnId = 'turn-direct-1';
    return cowork.run(
      {
        sessionId: 'sess-direct-1',
        turnId,
        projectId,
        kind: 'general',
        prompt: 'Draft a summary',
        correlation: {
          rootSessionId: 'sess-direct-1',
          turnId,
          rootOrchestrator: 'nexar',
          chain: ['nexar', 'openworker'],
          currentOrchestrator: 'openworker',
          depth: 1,
          correlationId: turnId,
        },
        permission: 'drafts-only',
        ...(maxDelegatedUnits === undefined ? {} : { maxDelegatedUnits }),
        onTask: () => Promise.resolve(),
        onProgress: () => undefined,
      },
      signal,
    );
  }

  const failFirstResource = (): ((r: ModelTurnPortRequest) => ReturnType<typeof loopTurn>) => {
    let failed: string | undefined;
    return (r) => {
      failed ??= r.descriptor.id;
      if (r.descriptor.id === failed) throw new NexarError('PROVIDER_ERROR', 'boom');
      return loopTurn(r);
    };
  };

  it('auto: drives the whole loop on one pinned resource, with no saved key in OpenWorker', async () => {
    const kit = controlKit({ resources: RESOURCES });
    const { cowork, call } = await setup({ env: LOOP, control: kit });
    expect(await cowork.refresh()).toMatchObject({ state: 'ready' });
    // A status probe previews the selection: it never mints a grant or records a decision.
    expect(kit.calls).toEqual([]);
    const { sessionId } = await turnOf(call);
    const turn = await settled(sessionId);

    expect(turn).toMatchObject({
      state: 'succeeded',
      outcome: { text: 'Control loop done' },
      lane: { requestedLane: 'cowork', effectiveLane: 'cowork' },
    });
    expect(turn.lane?.fallbackReason).toBeUndefined();
    const taskId = turn.tasks[0]?.taskId as string;
    const draft = join(h.projectDir, '.nexar', 'artifacts', taskId, 'drafts', 'draft.md');
    expect(await readFile(draft, 'utf8')).toBe('FINAL-DRAFT-TEXT');

    // Two model turns (tool call, then the answer) on the same resource, from the standard shapes.
    const resource = kit.turns[0]?.resource ?? '';
    expect(RESOURCES).toContain(resource);
    expect(kit.turns.map((t) => t.resource)).toEqual([resource, resource]);
    expect(turn.tasks[0]?.resourceId).toBe(resource);
    expect(kit.turns[0]?.request.tools?.map((t) => t.name)).toEqual(['scratch_note']);
    expect(kit.turns[1]?.request.messages.at(-1)).toMatchObject({
      role: 'tool',
      toolCallId: 'call_1',
    });

    // OpenWorker's `openai` provider is the translator, keyed by the turn's grant token.
    const entries = await providerEntries();
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ name: 'openai' });
    expect(Object.keys(entries[0]?.fields ?? {}).sort()).toEqual(['api_key', 'base_url']);
    expect(entries[0]?.fields['api_key']).toBe(kit.tokens[0]);
    expect(entries[0]?.fields['base_url']).toMatch(BASE_URL);
    const message = (await records()).find((r) => r['kind'] === 'user_message');
    expect((message?.['body'] as { model?: string }).model).toBe('openai:nexar-control');
    // No saved key value reaches OpenWorker.
    expect(JSON.stringify(await records())).not.toContain(SECRET);

    // One grant for the turn: it outlives a restart (two attempts), and is revoked after the MCP entry.
    expect(kit.calls).toEqual(['mint', 'revoke']);
    expect(kit.grants).toHaveLength(1);
    expect(kit.grants[0]).toMatchObject({ ttlMs: 40_000, access: 'draft', engine: 'openworker' });
    await expect.poll(() => kit.deletedBeforeRevoke).toEqual([true]);
    // OpenWorker stores provider fields: the turn's token and endpoint are forgotten after the turn.
    expect((await records()).filter((r) => r['kind'] === 'provider-removed')).toEqual([
      { kind: 'provider-removed', body: { name: 'openai' } },
    ]);

    const everything = JSON.stringify([
      logs,
      h.events,
      h.sessionEvents,
      await h.sessionStore.get(sessionId),
      await call(CHANNELS.coworkStatus),
      await engine.approvals().list(),
    ]);
    expect(everything).not.toContain(kit.tokens[0]);
    expect(everything).not.toContain(SECRET);
    expect(everything).not.toContain('FINAL-DRAFT-TEXT');
  });

  it('reports how the control loop ran, on the gateway path', async () => {
    const kit = controlKit({ resources: RESOURCES });
    const { cowork } = await setup({ env: LOOP, control: kit });
    await cowork.refresh();
    const result = await runDirect(cowork);
    expect(RESOURCES).toContain(result.resourceId);
    expect(result).toMatchObject({
      resourceId: kit.turns[0]?.resource,
      policyId: 'control@1:auto',
      control: { path: 'gateway', restarts: 0 },
    });
    expect(result.control).toHaveProperty('controlDecisionId');
  });

  it('shares the restriction when gateway setup falls back to a delegation-owned grant', async () => {
    const kit = controlKit({ resources: RESOURCES });
    const mint = kit.host.mint.bind(kit.host);
    vi.spyOn(kit.host, 'mint').mockImplementationOnce((input) => {
      const grant = mint(input);
      // Missing Control metadata makes gateway setup fail before the loop starts.
      return { grantId: grant.grantId, token: grant.token };
    });
    const { cowork, call } = await setup({
      env: { NEXAR_FAKE_OPENWORKER_SCENARIO: 'delegate' },
      control: kit,
    });
    await cowork.refresh();
    const { sessionId } = await turnOf(call, 'Review one unit after setup fallback', 1);
    const turn = await settled(sessionId);
    expect(turn.state).toBe('succeeded');
    expect(turn.tasks[0]?.delegations).toEqual([
      { unitId: 'u1', resourceId: 'res-a', outcome: 'succeeded' },
    ]);
    expect(kit.grants).toHaveLength(2);
    expect(kit.grants.map((g) => g.maxUnits)).toEqual([1, 1]);
    expect(kit.grants[1]?.unitLimit).toBe(kit.grants[0]?.unitLimit);
    expect(kit.maxOpen).toBe(1);
    expect(kit.turns).toHaveLength(0);
    expect(kit.calls).toEqual(['mint', 'revoke', 'mint', 'revoke']);
  });

  it('pinned: the owner-pinned resource drives the loop', async () => {
    await h.deps.settings.setCoworkControlResource({
      mode: 'pinned',
      resourceId: 'res-b',
      fallback: 'none',
    });
    const kit = controlKit({ resources: RESOURCES });
    const { cowork, call } = await setup({ env: LOOP, control: kit });
    await cowork.refresh();
    const { sessionId } = await turnOf(call);
    const turn = await settled(sessionId);
    expect(turn.state).toBe('succeeded');
    expect(turn.tasks[0]?.resourceId).toBe('res-b');
    expect(kit.turns.map((t) => t.resource)).toEqual(['res-b', 'res-b']);
  });

  it('restarts the whole turn once on another resource after a control failure (fallback auto)', async () => {
    const kit = controlKit({ resources: RESOURCES, turn: failFirstResource() });
    const { cowork } = await setup({ env: LOOP, control: kit });
    await cowork.refresh();
    const result = await runDirect(cowork, undefined, 1);

    const [failed, next, again] = kit.turns.map((t) => t.resource);
    expect(next).not.toBe(failed);
    expect(again).toBe(next);
    expect(kit.turns).toHaveLength(3);
    // The replay starts from the original prompt, not from the failed loop's messages.
    expect(kit.turns[1]?.request.messages).toHaveLength(2);
    expect(result).toMatchObject({
      resourceId: next,
      control: { path: 'gateway', restarts: 1 },
      artifacts: [{ mediaType: 'text/markdown', draft: true }],
    });
    // One grant and one token across the restart; one restart; revoked at the end.
    expect(kit.calls).toEqual(['mint', 'restart', 'revoke']);
    expect(kit.grants).toHaveLength(1);
    expect(kit.grants[0]).toMatchObject({
      maxUnits: 1,
      unitLimit: expect.any(DelegationUnitLimit) as DelegationUnitLimit,
    });
    expect(await userMessages()).toBe(2);
    expect(await providerEntries()).toHaveLength(1);
    expect(await readdirSafe(join(dirname(h.userData), 'ow-runtime', 'scratch'))).toEqual([]);
  });

  it('does not restart with fallback none: the turn fails with control-resource-failed', async () => {
    await h.deps.settings.setCoworkControlResource({
      mode: 'pinned',
      resourceId: 'res-a',
      fallback: 'none',
    });
    const kit = controlKit({ resources: RESOURCES, turn: failFirstResource() });
    const { cowork } = await setup({ env: LOOP, control: kit });
    await cowork.refresh();
    await expect(runDirect(cowork)).rejects.toMatchObject({
      code: 'PROVIDER_ERROR',
      details: { reason: 'control-resource-failed' },
    });
    expect(kit.turns).toHaveLength(1);
    expect(kit.calls).toEqual(['mint', 'revoke']);
  });

  it('fails after a second control failure and after a failed restart', async () => {
    const both = controlKit({
      resources: RESOURCES,
      turn: () => {
        throw new NexarError('PROVIDER_ERROR', 'boom');
      },
    });
    const first = await setup({ env: LOOP, control: both });
    await first.cowork.refresh();
    await expect(runDirect(first.cowork)).rejects.toMatchObject({
      code: 'PROVIDER_ERROR',
      details: { reason: 'control-resource-failed' },
    });
    expect(both.calls).toEqual(['mint', 'restart', 'revoke']);
    expect(both.turns).toHaveLength(2);

    const one = controlKit({ resources: ['res-a'], turn: failFirstResource() });
    const second = await setup({ env: LOOP, control: one });
    await second.cowork.refresh();
    await expect(runDirect(second.cowork)).rejects.toMatchObject({
      code: 'PROVIDER_ERROR',
      details: { reason: 'control-resource-failed' },
    });
    expect(one.calls).toEqual(['mint', 'restart', 'revoke']);
    expect(one.turns).toHaveLength(1);
  });

  it('never restarts for a failure the gateway did not attribute to the control resource', async () => {
    const kit = controlKit({ resources: RESOURCES });
    const { cowork, call } = await setup({
      env: { NEXAR_FAKE_OPENWORKER_SCENARIO: 'error' },
      control: kit,
    });
    await cowork.refresh();
    const { sessionId } = await turnOf(call);
    expect((await settled(sessionId)).state).toBe('failed');
    expect(kit.calls).toEqual(['mint', 'revoke']);
    expect(kit.turns).toHaveLength(0);
    expect(await userMessages()).toBe(1);
    await expect.poll(() => kit.deletedBeforeRevoke).toEqual([true]);
  });

  it('deletes the MCP entry and revokes the grant when the turn is cancelled', async () => {
    const kit = controlKit({ resources: RESOURCES });
    const { cowork, call } = await setup({
      env: { NEXAR_FAKE_OPENWORKER_SCENARIO: 'hang' },
      control: kit,
    });
    await cowork.refresh();
    const { sessionId, turnId } = await turnOf(call);
    await expect.poll(async () => (await userMessages()) > 0).toBe(true);
    expect(await call(CHANNELS.sessionsCancel, { sessionId, turnId })).toMatchObject({ ok: true });
    expect((await settled(sessionId)).state).toBe('cancelled');
    expect(kit.calls).toEqual(['mint', 'revoke']);
    await expect.poll(() => kit.deletedBeforeRevoke).toEqual([true]);
  });

  it('delegation reuses the turn grant: one mint, units recorded, draft imported', async () => {
    const kit = controlKit({ resources: RESOURCES });
    const { cowork, call } = await setup({
      env: { NEXAR_FAKE_OPENWORKER_SCENARIO: 'delegate' },
      control: kit,
    });
    await cowork.refresh();
    const { sessionId } = await turnOf(call);
    const turn = await settled(sessionId);
    expect(turn).toMatchObject({
      state: 'succeeded',
      outcome: { text: 'Delegated unit done' },
      tasks: [{ delegations: [{ unitId: 'u1', resourceId: 'res-a', outcome: 'succeeded' }] }],
    });
    expect(kit.calls).toEqual(['mint', 'revoke']);
    expect(kit.maxOpen).toBe(1);
    expect((await records()).find((r) => r['kind'] === 'mcp-register')?.['body']).toEqual({
      name: 'nexar',
      envNames: ['ELECTRON_RUN_AS_NODE', 'NEXAR_BRIDGE_ENDPOINT', 'NEXAR_BRIDGE_TOKEN'],
    });
    await expect.poll(() => kit.deletedBeforeRevoke).toEqual([true]);
  });

  it('falls back to the interim direct key when no control resource qualifies, and says so', async () => {
    const kit = controlKit({ resources: [] });
    const { cowork, call } = await setup({ control: kit });
    expect(await cowork.refresh()).toMatchObject({ state: 'ready' });
    const { sessionId } = await turnOf(call);
    const turn = await settled(sessionId);
    expect(turn).toMatchObject({
      state: 'succeeded',
      lane: { requestedLane: 'cowork', effectiveLane: 'cowork' },
      tasks: [{ resourceId: 'anthropic-m' }],
    });
    expect(await providerEntries()).toEqual([
      { name: 'anthropic', fields: { api_key: SECRET, base_url: '' } },
    ]);
    expect(kit.turns).toHaveLength(0);
    // The direct path keeps the owner's provider profile.
    expect((await records()).some((r) => r['kind'] === 'provider-removed')).toBe(false);
  });

  it('reports the direct-key path on the result', async () => {
    const kit = controlKit({ resources: [] });
    const { cowork } = await setup({ control: kit });
    await cowork.refresh();
    expect(await runDirect(cowork)).toMatchObject({
      resourceId: 'anthropic-m',
      control: { path: 'direct-key' },
    });
  });

  it('is unavailable with control-unavailable when neither path can run, and falls back to direct', async () => {
    const kit = controlKit({ resources: [] });
    const { cowork, call } = await setup({ allowed: [], saved: {}, control: kit });
    expect(await cowork.refresh()).toMatchObject({
      state: 'configuration-missing',
      reason: 'No control-compatible resource can run Cowork',
    });
    expect(cowork.fallbackReason()).toBe('openworker-control-unavailable');
    const { sessionId } = await turnOf(call);
    expect(await settled(sessionId)).toMatchObject({
      state: 'succeeded',
      lane: {
        requestedLane: 'cowork',
        effectiveLane: 'direct',
        fallbackReason: 'openworker-control-unavailable',
      },
    });
    await expect(runDirect(cowork)).rejects.toMatchObject({
      code: 'INTEGRATION_UNAVAILABLE',
      message: 'No control-compatible resource can run Cowork',
    });
    expect(kit.calls).toEqual([]);
  });

  it('keeps openworker-unavailable when OpenWorker itself is missing', async () => {
    const kit = controlKit({ resources: RESOURCES });
    const { cowork } = await setup({ disabled: true, control: kit });
    await cowork.refresh();
    expect(cowork.fallbackReason()).toBeUndefined();
  });

  it('fails closed on a damaged orchestration section (gateway path unavailable)', async () => {
    await writeFile(
      join(h.userData, 'desktop-settings.json'),
      JSON.stringify({
        theme: 'light',
        density: 'comfortable',
        mode: 'cowork',
        orchestration: { cowork: { controlResource: { mode: 'pinned', fallback: 'auto' } } },
      }),
    );
    const kit = controlKit({ resources: RESOURCES });
    const none = await setup({ allowed: [], saved: {}, control: kit });
    expect(await none.cowork.refresh()).toMatchObject({
      state: 'configuration-missing',
      reason: 'No control-compatible resource can run Cowork',
    });
  });

  it('uses a usable direct key when the orchestration section is damaged', async () => {
    await writeFile(
      join(h.userData, 'desktop-settings.json'),
      JSON.stringify({
        theme: 'light',
        density: 'comfortable',
        mode: 'cowork',
        orchestration: 'broken',
      }),
    );
    const kit = controlKit({ resources: RESOURCES });
    const { cowork } = await setup({ control: kit });
    await cowork.refresh();
    expect(await runDirect(cowork)).toMatchObject({ control: { path: 'direct-key' } });
    expect(kit.turns).toHaveLength(0);
  });
});
