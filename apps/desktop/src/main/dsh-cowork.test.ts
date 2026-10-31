import { existsSync } from 'node:fs';
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { DshLaunch } from '@nexar/integration-deepseek-harness';
import type { Logger } from '@nexar/contracts';
import type { CoworkPermission } from '@nexar/operating';
import { CHANNELS } from '../shared/channels.js';
import { createBridge } from './bridge.js';
import {
  COWORK_REASONS,
  DshCoworkService,
  delegationInstruction,
  isPhysicalScratchEscape,
  type DshCoworkServiceOptions,
} from './dsh-cowork.js';
import {
  alive,
  buildTestRuntime,
  controlKit,
  coworkRequest,
  fakeLaunch,
  readFakeRecord,
  recordingSpawn,
  writeThenAnswer,
  type ControlKitOptions,
  type TestRuntime,
} from './dsh-cowork-test-kit.js';
import { newTask } from './tasks.js';
import { addProject, createHarness, type Harness } from './test-harness.js';

const PROVIDER_KEYS = {
  ANTHROPIC_API_KEY: 'sk-ant-sentinel-dsh-cowork-4417',
  OPENAI_API_KEY: 'sk-openai-sentinel-dsh-cowork-9921',
  DEEPSEEK_API_KEY: 'sk-deepseek-sentinel-dsh-cowork-5503',
};

let runtime: TestRuntime;
let h: Harness;
let projectId: string;
let stateDir: string;
let logs: string[];
const stoppers: (() => Promise<void>)[] = [];

beforeAll(async () => {
  runtime = await buildTestRuntime();
});
afterAll(() => runtime.dispose());

beforeEach(async () => {
  h = await createHarness();
  projectId = await addProject(h);
  stateDir = join(dirname(h.userData), 'dsh-cowork');
  logs = [];
});
afterEach(async () => {
  await Promise.all(stoppers.splice(0).map((stop) => stop()));
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

interface Setup {
  readonly kit?: Partial<Omit<ControlKitOptions, 'runtime' | 'runtimeDir'>>;
  /** `--fake-*` / `--wrapper-*` settings of the fake DeepSeek Harness. */
  readonly fake?: Record<string, string>;
  /** No launch at all: nothing resolves an entry. */
  readonly noLaunch?: boolean;
  readonly timings?: DshCoworkServiceOptions['timings'];
  readonly env?: NodeJS.ProcessEnv;
  readonly backend?: DshCoworkServiceOptions['backend'];
}

function setup(options: Setup = {}) {
  const kit = controlKit({
    runtime,
    runtimeDir: join(dirname(h.userData), 'bridge-runtime'),
    logger: capture,
    ...options.kit,
  });
  const recordPath = join(dirname(h.userData), `record-${String(stoppers.length)}.json`);
  const spawned = recordingSpawn();
  const launch: DshLaunch = fakeLaunch(runtime, {
    'fake-record': recordPath,
    'fake-unit': '0',
    ...options.fake,
  });
  const created: unknown[] = [];
  const cowork = new DshCoworkService({
    settings: h.deps.settings,
    engine: h.engine,
    logger: capture,
    stateDir,
    ...(options.backend === undefined ? {} : { backend: options.backend }),
    bridgeHost: kit.host,
    controlGateway: kit.gateway,
    controlChild: kit.child,
    relay: kit.relay,
    ...(options.noLaunch === true ? {} : { launch }),
    spawn: spawned.spawn,
    env: { PATH: process.env['PATH'], SystemRoot: process.env['SystemRoot'], ...options.env },
    timings: {
      startupTimeoutMs: 20_000,
      turnTimeoutMs: 30_000,
      probeTimeoutMs: 15_000,
      approvalPollMs: 20,
      approvalTtlMs: 20_000,
      ...options.timings,
    },
    createTask: (request, excluded) => {
      created.push(request.turnId);
      return newTask(
        h.engine,
        {
          projectId: request.projectId,
          kind: request.kind,
          prompt: request.prompt,
          preferredResourceIds: request.preferredResourceIds,
          maxCostUsd: request.maxCostUsd,
          excludedResourceIds: excluded,
        },
        request.turnId,
        { sessionId: request.sessionId, turnId: request.turnId },
      );
    },
  });
  kit.attach((event) => cowork.noteBridgeEvent(event));
  stoppers.push(
    () => cowork.dispose(),
    () => kit.stop(),
  );
  const bridge = createBridge({ ...h.deps, cowork });
  const call = (channel: string, args: unknown = {}) =>
    bridge.invoke(channel, args, () => undefined) as Promise<{ ok: boolean }>;
  return { cowork, kit, recordPath, spawned, created, call };
}

const versionSpawns = (spawned: ReturnType<typeof recordingSpawn>) =>
  spawned.calls.filter((c) => c.args.includes('--version')).length;
const sessionSpawns = (spawned: ReturnType<typeof recordingSpawn>) =>
  spawned.calls.filter((c) => c.args.includes('acp')).length;

const draftPath = (taskId: string, name = 'proposal.md') =>
  join(h.projectDir, '.nexar', 'artifacts', taskId, 'drafts', name);

async function ready(options: Setup = {}) {
  const s = setup(options);
  expect(await s.cowork.refresh()).toMatchObject({ state: 'ready' });
  return s;
}

describe('status', () => {
  it.each([false, true])(
    'withdrawn control immediately invalidates cached readiness (isolated=%s)',
    async (isolated) => {
      const resources: [string, string][] = [['res-a', 'alpha']];
      const { cowork, created } = setup({
        kit: { resources },
        ...(isolated
          ? {
              backend: {
                probe: () => Promise.resolve({ state: 'ready' as const, version: '0.2.1-rc.5' }),
                run: () => Promise.reject(Error('must not run')),
              },
            }
          : {}),
      });
      expect((await cowork.refresh()).state).toBe('ready');
      resources.splice(0);
      // Production isolation still routes to a blocking failure, never a host fallback.
      expect(cowork.available()).toBe(isolated);
      expect((await cowork.status()).state).toBe('configuration-missing');
      expect(cowork.fallbackReason()).toBe('dsh-control-unavailable');
      await expect(
        cowork.run(coworkRequest(projectId).request, new AbortController().signal),
      ).rejects.toMatchObject({ code: 'INTEGRATION_UNAVAILABLE' });
      expect(created).toHaveLength(0);
      resources.push(['res-a', 'alpha']);
      expect((await cowork.status()).state).toBe('ready');
      expect(cowork.available()).toBe(true);
      expect(cowork.fallbackReason()).toBeUndefined();
    },
  );
  it.each([false, true])(
    'new control becomes usable within the runtime cache window (isolated=%s)',
    async (isolated) => {
      const resources: [string, string][] = [];
      const { cowork, spawned } = setup({
        kit: { resources },
        ...(isolated
          ? {
              backend: {
                probe: () => Promise.resolve({ state: 'ready' as const, version: '0.2.1-rc.5' }),
                run: () => Promise.reject(Error('must not run')),
              },
            }
          : {}),
      });
      expect((await cowork.refresh()).state).toBe('configuration-missing');
      const probes = versionSpawns(spawned);
      resources.push(['res-a', 'alpha']);
      expect((await cowork.status()).state).toBe('ready');
      expect(cowork.available()).toBe(true);
      expect(versionSpawns(spawned)).toBe(probes);
    },
  );
  it('keeps an unavailable isolated lane routed to a blocking failure without host execution', async () => {
    const { cowork, spawned, created } = setup({
      backend: {
        probe: () => Promise.resolve({ state: 'startup-failed', reason: 'synthetic unavailable' }),
        run: () => Promise.reject(new Error('must not run')),
      },
    });
    expect((await cowork.refresh()).state).toBe('startup-failed');
    expect(cowork.available()).toBe(true);
    await expect(
      cowork.run(coworkRequest(projectId).request, new AbortController().signal),
    ).rejects.toBeDefined();
    expect(spawned.calls).toHaveLength(0);
    expect(created).toHaveLength(0);
  });
  it('is ready with the pinned version when the runtime probes and a control resource exists', async () => {
    const { cowork } = setup();
    expect(cowork.available()).toBe(false);
    expect(cowork.reason()).toBe(COWORK_REASONS.checking);
    expect(await cowork.refresh()).toEqual({
      state: 'ready',
      reason: 'DeepSeek Harness is ready',
      version: '0.2.1-rc.5',
    });
    expect(cowork.available()).toBe(true);
    expect(cowork.reason()).toBeUndefined();
    expect(cowork.fallbackReason()).toBeUndefined();
    expect(await cowork.effectiveControlResourceId()).toMatch(/^res-[ab]$/);
  });

  it('probes once per cache window, and again on refresh', async () => {
    const { cowork, spawned } = setup();
    await cowork.status();
    await cowork.status();
    expect(versionSpawns(spawned)).toBe(1);
    await cowork.refresh();
    expect(versionSpawns(spawned)).toBe(2);
  });

  it('is dsh-missing when no runtime entry resolves', async () => {
    const { cowork, spawned } = setup({ noLaunch: true });
    expect(await cowork.refresh()).toEqual({
      state: 'dsh-missing',
      reason: 'DeepSeek Harness is not installed',
    });
    expect(cowork.available()).toBe(false);
    expect(cowork.fallbackReason()).toBe('dsh-unavailable');
    expect(spawned.calls).toHaveLength(0);
  });

  it('is unsupported-version for another version and startup-failed when it does not run', async () => {
    const other = setup({ fake: { 'wrapper-version': '9.9.9' } });
    expect(await other.cowork.refresh()).toMatchObject({
      state: 'unsupported-version',
      reason: 'DeepSeek Harness version is not supported',
      version: '9.9.9',
    });
    expect(other.cowork.fallbackReason()).toBe('dsh-unavailable');

    const broken = setup({ fake: { 'wrapper-exit': '3' } });
    expect(await broken.cowork.refresh()).toEqual({
      state: 'startup-failed',
      reason: 'DeepSeek Harness did not start',
    });
  });

  it('is configuration-missing when no control-compatible resource exists', async () => {
    const { cowork } = setup({ kit: { resources: [] } });
    expect(await cowork.refresh()).toMatchObject({
      state: 'configuration-missing',
      reason: 'No control-compatible resource can run Cowork',
    });
    expect(cowork.fallbackReason()).toBe('dsh-control-unavailable');
    expect(await cowork.effectiveControlResourceId()).toBeUndefined();

    const isolatedNoControl = setup({
      kit: { resources: [] },
      backend: {
        probe: () => Promise.resolve({ state: 'ready', version: '0.2.1-rc.5' }),
        run: () => Promise.reject(new Error('must not run')),
      },
    });
    expect(await isolatedNoControl.cowork.refresh()).toEqual({
      state: 'configuration-missing',
      reason: 'No control-compatible resource can run Cowork',
      version: '0.2.1-rc.5',
      placement: 'WSL2_BUBBLEWRAP',
    });

    const isolatedIncompatible = setup({
      backend: {
        probe: () => Promise.resolve({ state: 'unsupported-version', version: '0.2.0-rc.2' }),
        run: () => Promise.reject(new Error('must not run')),
      },
    });
    expect(await isolatedIncompatible.cowork.refresh()).toEqual({
      state: 'unsupported-version',
      reason: 'Isolated Cowork helper or runtime version is not compatible',
      version: '0.2.0-rc.2',
      placement: 'WSL2_BUBBLEWRAP',
    });
  });

  it('fails closed on a damaged orchestration section', async () => {
    await writeFile(
      join(h.userData, 'desktop-settings.json'),
      JSON.stringify({
        theme: 'light',
        density: 'comfortable',
        mode: 'cowork',
        orchestration: { cowork: { controlResource: { mode: 'pinned', fallback: 'auto' } } },
      }),
    );
    const { cowork } = setup();
    expect(await cowork.refresh()).toMatchObject({ state: 'configuration-missing' });
    expect(cowork.fallbackReason()).toBe('dsh-control-unavailable');
  });

  it('refuses a turn while the lane is not ready, with the fixed reason', async () => {
    const { cowork, kit } = setup({ noLaunch: true });
    await expect(cowork.run(coworkRequest(projectId).request, signal())).rejects.toMatchObject({
      code: 'INTEGRATION_UNAVAILABLE',
      message: 'DeepSeek Harness is not installed',
    });
    expect(kit.calls).toEqual([]);
  });
});

const signal = (): AbortSignal => new AbortController().signal;

describe('a turn', () => {
  it('validates the unit limit before any probe, task or grant', async () => {
    const { cowork, kit, spawned, created } = setup();
    const { request, tasks } = coworkRequest(projectId, { maxDelegatedUnits: 0 });
    await expect(cowork.run(request, signal())).rejects.toMatchObject({
      code: 'VALIDATION_ERROR',
    });
    expect(spawned.calls).toHaveLength(0);
    expect(created).toHaveLength(0);
    expect(tasks).toHaveLength(0);
    expect(kit.calls).toEqual([]);
  });

  it('rejects an aborted signal and a disposed service before anything starts', async () => {
    const { cowork, kit, spawned } = setup();
    const controller = new AbortController();
    controller.abort();
    await expect(
      cowork.run(coworkRequest(projectId).request, controller.signal),
    ).rejects.toMatchObject({ code: 'EXECUTION_CANCELLED' });
    await cowork.dispose();
    await expect(cowork.run(coworkRequest(projectId).request, signal())).rejects.toMatchObject({
      code: 'INTEGRATION_UNAVAILABLE',
    });
    expect(spawned.calls).toHaveLength(0);
    expect(kit.calls).toEqual([]);
  });

  it('writes in scratch, imports the draft, and cleans up: one grant, no key, no resume', async () => {
    const { cowork, kit, recordPath, spawned } = await ready({
      env: PROVIDER_KEYS,
      fake: { 'fake-unit': '0' },
    });
    const { request, progress, tasks } = coworkRequest(projectId);
    const result = await cowork.run(request, signal());

    expect(result).toMatchObject({
      text: expect.stringContaining('FINAL-DRAFT-TEXT') as string,
      resourceId: expect.stringMatching(/^res-[ab]$/) as string,
      policyId: 'control@1:auto',
      control: { path: 'gateway', restarts: 0 },
      artifacts: [{ mediaType: 'text/markdown', draft: true }],
    });
    expect(result.control).toMatchObject({ controlDecisionId: expect.any(String) as string });
    expect(result.taskId).toBe(tasks[0]);
    expect(await readFile(draftPath(result.taskId), 'utf8')).toBe('# Proposal\n\nDRAFT-CONTENT\n');
    expect(progress).toContain('status: Running Cowork');

    // ONE gateway grant for the turn, revoked at the end; the model ran only on the pinned resource.
    expect(kit.calls).toEqual(['mint', 'revoke']);
    expect(new Set(kit.turns.map((t) => t.resource))).toEqual(new Set([result.resourceId]));
    expect(kit.turns).toHaveLength(2);

    // DSH's only credential is the grant token; no provider key and no key name reaches its env.
    const [session] = spawned.calls.filter((c) => c.args.includes('acp'));
    expect(session?.env['NEXAR_CONTROL_TOKEN']).toBe(kit.tokens[0]);
    expect(Object.keys(session?.env ?? {}).filter((n) => /KEY|TOKEN|SECRET/i.test(n))).toEqual([
      'NEXAR_CONTROL_TOKEN',
    ]);
    const values = Object.values(session?.env ?? {}).join('\n');
    for (const secret of Object.values(PROVIDER_KEYS)) expect(values).not.toContain(secret);
    const record = (await readFakeRecord(recordPath)) as {
      envKeys: string[];
      tokenLeakedInto: string[];
      requests: { method: string }[];
      cwd: string;
      dshHome: string;
    };
    expect(record.envKeys).not.toEqual(expect.arrayContaining(Object.keys(PROVIDER_KEYS)));
    expect(record.tokenLeakedInto).toEqual([]);
    // B5: a fresh session, never resumed; its scratch and DSH_HOME are gone.
    expect(record.requests.map((r) => r.method)).not.toContain('session/resume');
    expect(existsSync(record.cwd)).toBe(false);
    expect(existsSync(record.dshHome)).toBe(false);
    expect(record.dshHome).toContain(join(stateDir, 'homes'));
    expect(await readdir(join(stateDir, 'homes'))).toEqual([]);
    expect(await readdir(join(stateDir, 'scratch'))).toEqual([]);
    // A13: the gateway's calls are the only model accounting; nothing here logs usage.
    expect(logs.join('\n')).not.toMatch(/usage|cost/i);
    expect(logs.join('\n')).not.toContain(kit.tokens[0]);
  });

  it('records progress as fixed texts and never tool arguments', async () => {
    const { cowork } = await ready({
      fake: { 'fake-scenario': 'ask', 'fake-tool': 'write', 'fake-input': '{"file_path":"x.md"}' },
    });
    const { request, progress } = coworkRequest(projectId);
    await cowork.run(request, signal());
    expect(progress).toEqual([
      'status: Routing the task',
      'status: Running Cowork',
      'progress: Cowork: write',
    ]);
    expect(progress.join('\n')).not.toContain('x.md');
  });

  it('read-only imports nothing and the policy denies a write, recorded with ids only', async () => {
    const normal = await ready();
    const read = await normal.cowork.run(
      coworkRequest(projectId, { permission: 'read-only' }).request,
      signal(),
    );
    expect(read.artifacts).toEqual([]);
    expect(existsSync(join(h.projectDir, '.nexar', 'artifacts'))).toBe(false);

    const asking = await ready({
      fake: { 'fake-scenario': 'ask', 'fake-tool': 'write', 'fake-input': '{"file_path":"a.md"}' },
    });
    await asking.cowork.run(
      coworkRequest(projectId, { permission: 'read-only' }).request,
      signal(),
    );
    const record = (await readFakeRecord(asking.recordPath)) as { permissionLabel: string };
    expect(record.permissionLabel).toBe('reject-once');
    const decisions = (await h.engine.approvals().list()).filter(
      (r) => r.actionType === 'cowork.tool-call',
    );
    expect(decisions).toHaveLength(1);
    expect(decisions[0]).toMatchObject({
      status: 'denied',
      decidedBy: 'policy',
      summary: 'Cowork write: denied by policy',
      metadata: { ruleId: 'read-only', tool: 'write' },
    });
    expect(JSON.stringify(decisions[0])).not.toContain('a.md');
  });

  it('allows a scratch write in drafts-only and records the allowed decision', async () => {
    const { cowork, recordPath } = await ready({
      fake: { 'fake-scenario': 'ask', 'fake-tool': 'write', 'fake-input': '{"file_path":"a.md"}' },
    });
    await cowork.run(coworkRequest(projectId).request, signal());
    expect(
      ((await readFakeRecord(recordPath)) as { permissionLabel: string }).permissionLabel,
    ).toBe('allow-once');
    const [decision] = (await h.engine.approvals().list()).filter(
      (r) => r.actionType === 'cowork.tool-call',
    );
    expect(decision).toMatchObject({
      status: 'consumed',
      summary: 'Cowork write: allowed by policy',
      metadata: { ruleId: 'draft-in-scratch' },
    });
  });

  it.each([
    ['a path outside scratch', { file_path: '../../outside.md' }, 'write', 'outside-scratch'],
    [
      'a sandbox escalation',
      { file_path: 'a.md', sandbox_permissions: 'danger-full-access' },
      'write',
      'escalation-denied',
    ],
    ['a shell command', { command: 'ls' }, 'bash', 'unsupported-tool'],
    ['a missing path', { content: 'x' }, 'write', 'invalid-path'],
  ])('rejects %s and records the decision', async (_name, input, tool, ruleId) => {
    const { cowork, recordPath } = await ready({
      fake: {
        'fake-scenario': 'ask',
        'fake-tool': tool,
        'fake-input': JSON.stringify(input),
      },
    });
    await cowork.run(coworkRequest(projectId).request, signal());
    expect(
      ((await readFakeRecord(recordPath)) as { permissionLabel: string }).permissionLabel,
    ).toBe('reject-once');
    const [decision] = (await h.engine.approvals().list()).filter(
      (r) => r.actionType === 'cowork.tool-call',
    );
    expect(decision).toMatchObject({ status: 'denied', metadata: { ruleId } });
  });

  describe('ask before write', () => {
    const asking = (): Setup => ({
      fake: { 'fake-scenario': 'ask', 'fake-tool': 'write', 'fake-input': '{"file_path":"a.md"}' },
    });
    const ask: CoworkPermission = 'ask-before-write';

    async function pendingWrite() {
      await expect
        .poll(
          async () =>
            (await h.engine.approvals().list({ status: 'pending' })).filter(
              (r) => r.actionType === 'cowork.write',
            ).length,
          { timeout: 20_000 },
        )
        .toBe(1);
      const [request] = (await h.engine.approvals().list({ status: 'pending' })).filter(
        (r) => r.actionType === 'cowork.write',
      );
      return request;
    }

    it('waits for an owner approval, single use, then allows the write', async () => {
      const { cowork, call, recordPath } = await ready(asking());
      const running = cowork.run(coworkRequest(projectId, { permission: ask }).request, signal());
      const request = await pendingWrite();
      expect(request).toMatchObject({
        risk: 'low',
        summary: 'Cowork wants to write the draft file a.md',
      });
      expect((await call(CHANNELS.approvalsApprove, { id: request?.id })).ok).toBe(true);
      await running;
      expect(
        ((await readFakeRecord(recordPath)) as { permissionLabel: string }).permissionLabel,
      ).toBe('allow-once');
      // Consumed by the one write: it cannot be spent again.
      const all = await h.engine.approvals().list();
      expect(all.find((r) => r.id === request?.id)?.status).toBe('consumed');
      expect(all.filter((r) => r.actionType === 'cowork.tool-call')).toEqual([]);
    });

    it('rejects a path replaced by an external junction while owner approval is pending', async () => {
      const { cowork, call, recordPath } = await ready({
        fake: {
          'fake-scenario': 'ask',
          'fake-tool': 'write',
          'fake-input': '{"file_path":"nested/a.md"}',
        },
      });
      const running = cowork.run(coworkRequest(projectId, { permission: ask }).request, signal());
      const request = await pendingWrite();
      const [name] = await readdir(join(stateDir, 'scratch'));
      if (name === undefined) throw new Error('missing turn scratch');
      const outside = join(dirname(h.userData), 'synthetic-outside');
      await mkdir(outside);
      await symlink(outside, join(stateDir, 'scratch', name, 'nested'), 'junction');
      expect((await call(CHANNELS.approvalsApprove, { id: request?.id })).ok).toBe(true);
      await running;
      expect(
        ((await readFakeRecord(recordPath)) as { permissionLabel: string }).permissionLabel,
      ).toBe('reject-once');
      expect(await readdir(outside)).toEqual([]);
    });

    it('denies the write when the owner denies it', async () => {
      const { cowork, call, recordPath } = await ready(asking());
      const running = cowork.run(coworkRequest(projectId, { permission: ask }).request, signal());
      const request = await pendingWrite();
      expect((await call(CHANNELS.approvalsDeny, { id: request?.id })).ok).toBe(true);
      await running;
      expect(
        ((await readFakeRecord(recordPath)) as { permissionLabel: string }).permissionLabel,
      ).toBe('reject-once');
      expect((await h.engine.approvals().list()).find((r) => r.id === request?.id)?.status).toBe(
        'denied',
      );
    });

    it('denies the write when the approval expires', async () => {
      const { cowork, recordPath } = await ready({ ...asking(), timings: { approvalTtlMs: 300 } });
      await cowork.run(coworkRequest(projectId, { permission: ask }).request, signal());
      expect(
        ((await readFakeRecord(recordPath)) as { permissionLabel: string }).permissionLabel,
      ).toBe('reject-once');
      const write = (await h.engine.approvals().list()).find(
        (r) => r.actionType === 'cowork.write',
      );
      expect(write?.status).toBe('expired');
    });

    it('never asks for an escalation outside scratch: policy rejects it first', async () => {
      const { cowork, recordPath } = await ready({
        fake: {
          'fake-scenario': 'ask',
          'fake-tool': 'write',
          'fake-input': '{"file_path":"../../x.md"}',
        },
      });
      await cowork.run(coworkRequest(projectId, { permission: ask }).request, signal());
      expect(
        ((await readFakeRecord(recordPath)) as { permissionLabel: string }).permissionLabel,
      ).toBe('reject-once');
      expect(
        (await h.engine.approvals().list()).filter((r) => r.actionType === 'cowork.write'),
      ).toEqual([]);
    });
  });

  it('cancel stops the child, revokes the grant and removes scratch and home', async () => {
    const { cowork, kit, recordPath } = await ready({ fake: { 'fake-scenario': 'hang' } });
    const controller = new AbortController();
    const running = cowork.run(coworkRequest(projectId).request, controller.signal);
    const settled = running.then(
      () => undefined,
      (error: unknown) => error,
    );
    let pid = 0;
    await expect
      .poll(
        async () => {
          const record = (await readFakeRecord(recordPath)) as
            | {
                pid: number;
                requests: { method: string }[];
              }
            | undefined;
          pid = record?.pid ?? 0;
          return record?.requests.some((r) => r.method === 'session/prompt') === true;
        },
        { timeout: 20_000 },
      )
      .toBe(true);
    controller.abort();
    expect(await settled).toMatchObject({ code: 'EXECUTION_CANCELLED' });
    await expect.poll(() => alive(pid), { timeout: 10_000 }).toBe(false);
    expect(kit.calls).toEqual(['mint', 'revoke']);
    expect(await readdir(join(stateDir, 'scratch'))).toEqual([]);
    expect(await readdir(join(stateDir, 'homes'))).toEqual([]);
    // The turn is over: nothing stays reserved.
    await expect(cowork.dispose()).resolves.toBeUndefined();
  });

  it('limits concurrent turns', async () => {
    const { cowork } = await ready({ fake: { 'fake-scenario': 'hang' } });
    const controllers = Array.from({ length: 4 }, () => new AbortController());
    const turns = controllers.map((c, index) =>
      cowork
        .run(
          coworkRequest(
            projectId,
            {},
            {
              turnId: `turn_${String(index).repeat(32)}`,
              sessionId: `ses_${String(index).repeat(32)}`,
            },
          ).request,
          c.signal,
        )
        .catch((error: unknown) => error),
    );
    await expect(cowork.run(coworkRequest(projectId).request, signal())).rejects.toMatchObject({
      code: 'POLICY_REJECTED',
      message: 'Too many Cowork turns are active',
    });
    for (const c of controllers) c.abort();
    expect(
      (await Promise.all(turns)).every(
        (r) => (r as { code?: string }).code === 'EXECUTION_CANCELLED',
      ),
    ).toBe(true);
  });

  it('maps a runtime failure to a fixed code and text, never upstream text', async () => {
    const { cowork } = await ready({
      fake: {
        'fake-scenario': 'rpc-error',
        'fake-rpc-message': `boom ${PROVIDER_KEYS.ANTHROPIC_API_KEY} C:\\secret\\path`,
      },
    });
    const error = await cowork
      .run(coworkRequest(projectId).request, signal())
      .catch((e: unknown) => e);
    expect(error).toMatchObject({
      code: 'INTEGRATION_UNAVAILABLE',
      message: 'DeepSeek Harness could not complete the request',
    });
    expect(JSON.stringify(error)).not.toContain('secret');
    expect(logs.join('\n')).not.toContain(PROVIDER_KEYS.ANTHROPIC_API_KEY);
  });

  it('fails a turn whose runtime exits mid-turn with a fixed error, and the next turn starts a fresh process', async () => {
    const marker = join(dirname(h.userData), 'exit-once.marker');
    const { cowork, spawned } = await ready({ fake: { 'fake-exit-once': marker } });
    const error = await cowork
      .run(coworkRequest(projectId).request, signal())
      .catch((e: unknown) => e);
    expect(error).toMatchObject({
      code: 'INTEGRATION_UNAVAILABLE',
      message: 'DeepSeek Harness could not complete the request',
    });
    expect(sessionSpawns(spawned)).toBe(1);

    const next = await cowork.run(coworkRequest(projectId).request, signal());
    expect(next.text).not.toBe('');
    expect(sessionSpawns(spawned)).toBe(2);
  });

  describe('delegation', () => {
    it('hands the bridge relay to DSH as the nexar MCP server and records delegated units', async () => {
      const { cowork, kit, recordPath } = await ready({ fake: { 'fake-unit': '1' } });
      const { request, tasks } = coworkRequest(projectId);
      const result = await cowork.run(request, signal());
      expect(result.text).toContain('unit: DELEGATED-ANSWER');
      expect(result.delegations).toEqual([
        { unitId: 'unit-1', resourceId: 'res-a', outcome: 'succeeded' },
      ]);
      expect(tasks).toHaveLength(1);
      const record = (await readFakeRecord(recordPath)) as {
        mcpTools: string[];
        mcpEndpoint: string;
        mcpTokenIsControlToken: boolean;
        requests: {
          method: string;
          params: { prompt?: { text: string }[]; mcpServers?: unknown[] };
        }[];
        mcpPermissions: string[];
      };
      expect(record.mcpTools).toEqual(['nexar.intelligence_status', 'nexar.intelligence_submit']);
      // The relay's token is the turn's grant token, the one grant of the turn.
      expect(record.mcpTokenIsControlToken).toBe(true);
      expect(kit.calls).toEqual(['mint', 'revoke']);
      // The bridge tools are answered by the broker (allow once); the prompt carries the instruction.
      expect(record.mcpPermissions).toEqual(['allow-once', 'allow-once']);
      // Nexar's policy answered them, and recorded each call with ids only.
      const recorded = (await h.engine.approvals().list()).filter(
        (r) => r.actionType === 'cowork.tool-call',
      );
      expect(recorded).toHaveLength(2);
      expect(recorded.every((r) => r.status === 'consumed' && r.decidedBy === 'policy')).toBe(true);
      expect(recorded.map((r) => r.metadata?.['ruleId'])).toEqual(['bridge-tool', 'bridge-tool']);
      const prompt = record.requests.find((r) => r.method === 'session/prompt');
      expect(prompt?.params.prompt?.[0]?.text).toContain(delegationInstruction());
    });

    it.each([
      [1, true],
      [16, false],
    ])('sets the standalone flag only when the unit limit is 1 (limit %i)', async (limit, flag) => {
      const { cowork, recordPath } = await ready();
      await cowork.run(coworkRequest(projectId, { maxDelegatedUnits: limit }).request, signal());
      const record = (await readFakeRecord(recordPath)) as {
        requests: {
          method: string;
          params: { mcpServers: { name: string; env: { name: string }[] }[] };
        }[];
      };
      const created = record.requests.find((r) => r.method === 'session/new');
      const [server] = created?.params.mcpServers ?? [];
      expect(server?.name).toBe('nexar');
      const names = server?.env.map((e) => e.name) ?? [];
      expect(names).toContain('NEXAR_BRIDGE_ENDPOINT');
      expect(names).toContain('NEXAR_BRIDGE_TOKEN');
      expect(names.includes('NEXAR_BRIDGE_STANDALONE_ONLY')).toBe(flag);
    });
  });

  describe('control failure', () => {
    const failFirst = (): NonNullable<ControlKitOptions['turn']> => {
      let failed: string | undefined;
      return (resource, request) => {
        failed ??= resource;
        if (resource === failed) throw new Error('boom');
        return writeThenAnswer(request);
      };
    };

    it('restarts the whole turn once on another resource, keeping one limit and one grant (B2)', async () => {
      const { cowork, kit, spawned } = await ready({ kit: { turn: failFirst() } });
      const { request, progress } = coworkRequest(projectId, { maxDelegatedUnits: 1 });
      const result = await cowork.run(request, signal());

      const [failed, next] = kit.turns.map((t) => t.resource);
      expect(next).not.toBe(failed);
      expect(result).toMatchObject({
        resourceId: next,
        control: { path: 'gateway', restarts: 1 },
        artifacts: [{ mediaType: 'text/markdown', draft: true }],
      });
      expect(kit.calls).toEqual(['mint', 'restart', 'revoke']);
      // One grant carries the one DelegationUnitLimit across both engine turns.
      expect(kit.grants).toHaveLength(1);
      expect(kit.grants[0]).toMatchObject({ maxUnits: 1 });
      expect(sessionSpawns(spawned)).toBe(2);
      // Each engine turn had its own scratch and home; both are gone.
      const homes = spawned.calls
        .filter((c) => c.args.includes('acp'))
        .map((c) => c.env['DSH_HOME']);
      expect(new Set(homes).size).toBe(2);
      expect(await readdir(join(stateDir, 'homes'))).toEqual([]);
      expect(await readdir(join(stateDir, 'scratch'))).toEqual([]);
      expect(progress).toContain('status: Restarting on another control resource');
    });

    it('does not restart with fallback none: control-resource-failed', async () => {
      await h.deps.settings.setCoworkControlResource({
        mode: 'pinned',
        resourceId: 'res-a',
        fallback: 'none',
      });
      const { cowork, kit } = await ready({ kit: { turn: failFirst() } });
      await expect(cowork.run(coworkRequest(projectId).request, signal())).rejects.toMatchObject({
        code: 'PROVIDER_ERROR',
        details: { reason: 'control-resource-failed' },
      });
      expect(kit.turns).toHaveLength(1);
      expect(kit.calls).toEqual(['mint', 'revoke']);
    });

    it('fails after a second control failure', async () => {
      const { cowork, kit } = await ready({
        kit: {
          turn: () => {
            throw new Error('boom');
          },
        },
      });
      await expect(cowork.run(coworkRequest(projectId).request, signal())).rejects.toMatchObject({
        code: 'PROVIDER_ERROR',
        details: { reason: 'control-resource-failed' },
      });
      expect(kit.calls).toEqual(['mint', 'restart', 'revoke']);
      expect(kit.turns).toHaveLength(2);
    });
  });

  describe('isPhysicalScratchEscape', () => {
    it('rejects an unresolved or deleted scratch root', async () => {
      const root = await realpath(await mkdtemp(join(tmpdir(), 'nexar-scratch-test-')));
      await rm(root, { recursive: true, force: true });
      expect(await isPhysicalScratchEscape(root, 'draft.md')).toBe(true);
      expect(await isPhysicalScratchEscape(join(root, 'never-created'), 'draft.md')).toBe(true);
    });

    it('allows normal regular files and relative subdirectories inside scratch', async () => {
      const root = await realpath(await mkdtemp(join(tmpdir(), 'nexar-scratch-test-')));
      try {
        expect(await isPhysicalScratchEscape(root, 'draft.md')).toBe(false);
        expect(await isPhysicalScratchEscape(root, 'sub/nested/file.txt')).toBe(false);
        await writeFile(join(root, 'existing.txt'), 'hello');
        expect(await isPhysicalScratchEscape(root, 'existing.txt')).toBe(false);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });

    it('rejects lexical parent escapes and absolute paths outside scratch', async () => {
      const root = await realpath(await mkdtemp(join(tmpdir(), 'nexar-scratch-test-')));
      try {
        expect(await isPhysicalScratchEscape(root, '../outside.md')).toBe(true);
        expect(await isPhysicalScratchEscape(root, 'sub/../../outside.md')).toBe(true);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });

    it('detects directory junctions or symlinks escaping scratch root', async () => {
      const root = await realpath(await mkdtemp(join(tmpdir(), 'nexar-scratch-test-')));
      const outside = await realpath(await mkdtemp(join(tmpdir(), 'nexar-outside-target-')));
      try {
        const junctionTarget = join(root, 'escape-link');
        await symlink(outside, junctionTarget, 'junction');
        expect(await isPhysicalScratchEscape(root, 'escape-link/secret.txt')).toBe(true);
      } finally {
        await rm(root, { recursive: true, force: true });
        await rm(outside, { recursive: true, force: true });
      }
    });
  });
});
