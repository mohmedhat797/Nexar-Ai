import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Logger } from '@nexar/contracts';
import type { Turn } from '@nexar/sessions';
import type { BridgeResult, CoworkStatusDto, SessionDto, SubmitTurnResult } from '../shared/api.js';
import { CHANNELS } from '../shared/channels.js';
import type { ProviderRow } from '../shared/providers.js';
import { createBridge } from './bridge.js';
import { CoworkService, createScriptSpawn, type CoworkTimings } from './cowork.js';
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

interface Setup {
  readonly allowed?: readonly string[];
  readonly saved?: Readonly<Record<string, string>>;
  readonly env?: Record<string, string>;
  readonly disabled?: boolean;
  readonly timings?: Partial<CoworkTimings>;
  readonly createTaskSpy?: (request: Parameters<typeof newTask>[1], correlation: unknown) => void;
}

async function setup(options: Setup = {}) {
  for (const [name, value] of Object.entries(options.saved ?? { ANTHROPIC_API_KEY: SECRET })) {
    await keys.save(name, value);
  }
  for (const provider of options.allowed ?? ['anthropic']) {
    await h.deps.settings.setOpenWorkerAccess(provider, true);
  }
  const cowork = new CoworkService({
    settings: h.deps.settings,
    engine,
    keys,
    logger: capture,
    stateDir: join(dirname(h.userData), 'ow-runtime'),
    ...(options.disabled === true ? { disabled: true } : {}),
    spawn: createScriptSpawn(FAKE, { ...options.env }),
    timings: { ...TIMINGS, ...options.timings },
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

async function turnOf(call: Awaited<ReturnType<typeof setup>>['call'], text = 'Draft a summary') {
  const created = await call<SessionDto>(CHANNELS.sessionsCreate, { projectId, mode: 'cowork' });
  if (!created.ok) throw new Error('sessions:create failed');
  const sessionId = created.value.id;
  const submitted = await call<SubmitTurnResult>(CHANNELS.sessionsSubmitTurn, {
    sessionId,
    submissionKey: SUBMISSION,
    text,
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
    expect(await cowork.refresh()).toMatchObject({ state: 'ready', version: '0.3.0' });
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
      { kind: 'provider', body: { name: 'anthropic', fields: { api_key: SECRET } } },
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

async function readdirSafe(path: string): Promise<string[]> {
  const { readdir } = await import('node:fs/promises');
  try {
    return await readdir(path);
  } catch {
    return [];
  }
}
