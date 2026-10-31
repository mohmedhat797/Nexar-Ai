import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  NexarError,
  taskId,
  type ResourceDescriptor,
  type StrategyLedger,
  type WorkUnit,
} from '@nexar/contracts';
import { ControlModelGateway, IntelligenceBridge } from '@nexar/engine-gateway';
import { createControlModelTurnPorts, engineAllocator } from '@nexar/host';
import { catalogResourceId } from '@nexar/resource-registry';
import { newSessionId, newTurnId } from '@nexar/sessions';
import {
  piCatalogDiscoverySource,
  type PiAssistantMessageLike,
  type PiModelsLike,
  type PiRequestOptionsLike,
} from '@nexar/integration-pi';
import { noopLogger } from '@nexar/telemetry';
import type { ConnectionDto } from '../shared/connections.js';
import { CHANNELS } from '../shared/channels.js';
import { ConfigStore } from './config-store.js';
import { SettingsStore } from './settings-store.js';
import { DesktopKeyStore } from './desktop-key-store.js';
import { ConnectionManager } from './connection-manager.js';
import { ConnectionRuntime } from './connection-runtime.js';
import { createEngineHost, type EngineHost } from './engine-host.js';
import { addProject, createHarness, type Harness } from './test-harness.js';
import { boundedCoworkExecutor } from './cowork-executor.js';
import { DshCoworkService } from './dsh-cowork.js';
import { dshLaunchForEntry } from './dsh-runtime-path.js';
import {
  buildTestRuntime,
  controlKit,
  coworkRequest,
  recordingSpawn,
} from './dsh-cowork-test-kit.js';
import { newTask } from './tasks.js';

const A = 'synthetic-account-A-123456789',
  B = 'synthetic-account-B-123456789',
  C = 'synthetic-rotated-B-123456789';
const barrier = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
};
const reply: PiAssistantMessageLike = {
  content: [{ type: 'text', text: 'synthetic model result' }],
  usage: {
    input: 1,
    output: 1,
    cacheRead: 0,
    cacheWrite: 0,
    cost: { total: 0 },
  },
  stopReason: 'stop',
  model: 'synthetic-model',
  provider: 'openai',
};
let dir: string,
  settings: SettingsStore,
  keys: DesktopKeyStore,
  manager: ConnectionManager,
  publisher: ConnectionRuntime,
  engine: EngineHost,
  h: Harness,
  gateway: ControlModelGateway;
let seen: string[], hook: (options: PiRequestOptionsLike | undefined) => Promise<void>;
let toolCatalogs: readonly object[][];
const lineage = {
  rootSessionId: 'synthetic-session',
  turnId: 'synthetic-turn',
  correlationId: 'synthetic-correlation',
  depth: 0,
};
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'nexar-connection-runtime-'));
  seen = [];
  toolCatalogs = [];
  hook = async () => {};
  const encrypted = new Map<string, string>();
  let cipher = 0;
  keys = new DesktopKeyStore({
    userData: dir,
    encryption: {
      isEncryptionAvailable: () => true,
      getSelectedStorageBackend: () => 'gnome_libsecret',
      encryptString: (value) => {
        const id = `cipher-${++cipher}`;
        encrypted.set(id, value);
        return Buffer.from(id);
      },
      decryptString: (value) => {
        const text = encrypted.get(value.toString());
        if (text === undefined) throw Error('synthetic cipher');
        return text;
      },
    },
  });
  settings = new SettingsStore(join(dir, 'settings.json'));
  const host: { current?: EngineHost } = {};
  manager = new ConnectionManager({
    settingsStore: settings,
    keyStore: keys,
    onChange: async () => {
      await host.current?.reload();
    },
  });
  await manager.initialize();
  publisher = new ConnectionRuntime(manager, {
    listModels: () =>
      Promise.resolve([
        {
          id: 'synthetic-model',
          contextWindow: 32000,
          maxTokens: 1000,
          inputPerMillionTokens: 1,
          outputPerMillionTokens: 1,
        },
      ]),
  });
  const models: PiModelsLike = {
    getModel: (provider, id) => ({ provider, id, api: 'openai-completions' }),
    completeSimple: async (_model, context, options) => {
      seen.push(options?.apiKey ?? 'missing');
      toolCatalogs = [...toolCatalogs, context.tools ?? []];
      await hook(options);
      return reply;
    },
  };
  const config = new ConfigStore(join(dir, 'nexar.config.json'));
  await config.ensure();
  await config.update((raw) => {
    raw.discovery = { enabled: false };
  });
  host.current = await createEngineHost({
    configPath: config.path,
    env: {},
    logger: noopLogger,
    resolveSecret: keys.resolveSecret,
    extraResources: () => publisher.descriptors(),
    inventoryGuard: publisher.guard(),
    piModels: models,
  });
  engine = host.current;
  h = await createHarness({
    engine,
    config,
    settings,
    connectionManager: manager,
  });
  gateway = new ControlModelGateway({
    ports: createControlModelTurnPorts(
      { env: {}, cwd: dir },
      {
        resolveSecret: keys.resolveSecret,
        piModels: models,
        validateResource: (d) => manager.validateResource(d),
      },
    ),
    candidates: () => publisher.filterCandidates(engine.composition().runtime.registry.snapshot()),
    policy: engine.composition().runtime.policy,
    admit: (d) => manager.acquireResource(d),
    validatePin: (id) => publisher.validatePin(id, engine.composition().runtime.registry.list()),
    logger: noopLogger,
    clock: () => new Date(),
    newId: randomUUID,
  });
});
afterEach(async () => {
  await h?.cleanup();
  await rm(dir, {
    recursive: true,
    force: true,
    maxRetries: 10,
    retryDelay: 50,
  });
});
async function add(label: string, key: string, provider = 'openai'): Promise<ConnectionDto> {
  const result = await h.call<ConnectionDto>(CHANNELS.connectionAdd, {
    provider,
    label,
    apiKey: key,
  });
  expect(result.ok).toBe(true);
  if (!result.ok) throw Error('synthetic Add failed');
  return result.value;
}
async function resource(id: string): Promise<ResourceDescriptor> {
  const snapshots = await engine.snapshots(true);
  const r = snapshots.find(
    (s) => (s.descriptor.metadata?.['connection'] as { id?: string } | undefined)?.id === id,
  )?.descriptor;
  expect(r).toBeDefined();
  return r!;
}
function begin(r: ResourceDescriptor) {
  return gateway.begin('dsh', { mode: 'pinned', resourceId: r.id, fallback: 'auto' }, lineage);
}
function turn(id: string, signal = new AbortController().signal) {
  return gateway.turn(
    {
      engine: 'dsh',
      lineage,
      controlDecisionId: id,
      messages: [{ role: 'user', content: 'synthetic request' }],
    },
    signal,
  );
}

describe('production persisted connection → registry → NRC → transport', () => {
  it.skipIf(!process.env['NEXAR_DSH_ENTRY'])(
    'runs real managed DSH ACP through persisted A/B credentials and retains the active connection lease',
    async () => {
      const a = await add('Actual DSH account A', A);
      const b = await add('Actual DSH account B', B);
      const ar = await resource(a.id),
        br = await resource(b.id);
      const runtime = await buildTestRuntime();
      const kit = controlKit({ runtime, runtimeDir: join(dir, 'actual-dsh-bridge'), gateway });
      const launch = dshLaunchForEntry(process.env['NEXAR_DSH_ENTRY']!);
      if (launch === undefined) throw Error('Invalid test runtime entry');
      const entered = barrier(),
        resume = barrier();
      const spawned = recordingSpawn();
      const foreignHome = join(dir, 'synthetic-foreign-runtime-home');
      const cowork = new DshCoworkService({
        settings,
        engine,
        logger: noopLogger,
        stateDir: join(dir, 'actual-dsh-private-state'),
        bridgeHost: kit.host,
        controlGateway: gateway,
        controlChild: kit.child,
        relay: kit.relay,
        launch,
        spawn: spawned.spawn,
        env: {
          ...process.env,
          OPENAI_API_KEY: 'synthetic-ambient-key-must-not-be-used',
          DSH_HOME: foreignHome,
          DSH_AGENTS_HOME: 'synthetic-owner-agents-home',
        },
        timings: { startupTimeoutMs: 90000, turnTimeoutMs: 120000, probeTimeoutMs: 60000 },
        createTask: (request, excluded) =>
          newTask(
            engine,
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
          ),
      });
      kit.attach((event) => cowork.noteBridgeEvent(event));
      try {
        const projectId = await addProject(h);
        await settings.setCoworkControlResource({
          mode: 'pinned',
          resourceId: ar.id,
          fallback: 'none',
        });
        expect(await cowork.refresh()).toMatchObject({ state: 'ready' });
        const ids = () => ({ sessionId: newSessionId(), turnId: newTurnId() });
        const first = await cowork.run(
          coworkRequest(projectId, {}, ids()).request,
          new AbortController().signal,
        );
        expect(first.text).toContain('synthetic model result');
        expect(seen).toEqual([A]);
        expect(manager.getActiveExecutionCount(a.id)).toBe(0);

        await settings.setCoworkControlResource({
          mode: 'pinned',
          resourceId: br.id,
          fallback: 'none',
        });
        hook = async () => {
          entered.resolve();
          await resume.promise;
        };
        const active = cowork.run(
          coworkRequest(projectId, {}, ids()).request,
          new AbortController().signal,
        );
        await Promise.race([
          entered.promise,
          active.then(() => {
            throw Error('Turn ended before the held provider request');
          }),
        ]);
        try {
          expect(seen).toEqual([A, B]);
          expect(manager.getActiveExecutionCount(b.id)).toBe(1);
          await expect(
            manager.rotateCredential({ connectionId: b.id, apiKey: C, sameAccount: true }),
          ).rejects.toMatchObject({ details: { reason: 'connection.active' } });
          await manager.disableConnection({ connectionId: b.id });
          expect(() => begin(br)).toThrow();
        } finally {
          resume.resolve();
        }
        expect((await active).text).toContain('synthetic model result');
        expect(manager.getActiveExecutionCount(b.id)).toBe(0);
        expect(seen).toEqual([A, B]);
        expect(toolCatalogs).toHaveLength(2);
        expect(toolCatalogs[0]?.length).toBeGreaterThan(0);
        const acpChildren = spawned.calls.filter((call) => call.args.includes('acp'));
        expect(acpChildren).toHaveLength(2);
        for (const child of acpChildren) {
          expect(child.env['OPENAI_API_KEY']).toBeUndefined();
          expect(child.env['DSH_HOME']).not.toBe(foreignHome);
          expect(child.env['DSH_AGENTS_HOME']).toBe(join(child.env['DSH_HOME']!, 'agents'));
          expect(JSON.stringify(child.env)).not.toContain(A);
          expect(JSON.stringify(child.env)).not.toContain(B);
        }
        const tools = JSON.stringify(toolCatalogs);
        for (const denied of ['working_directory', 'web_fetch', 'web_search', 'create_worktree']) {
          expect(tools).not.toContain(`"name":"${denied}"`);
        }
      } finally {
        resume.resolve();
        await cowork.dispose();
        await kit.stop();
        await runtime.dispose();
      }
    },
    240000,
  );

  it.each(['connection', 'provider'] as const)(
    'TST-42 preserves actual account identity through Forget/re-entry and enforces %s diversity at execution',
    async (dimension) => {
      const a = await add('Review account A', A),
        b = await add('Review account B', B, dimension === 'provider' ? 'anthropic' : 'openai');
      const ar = await resource(a.id),
        br = await resource(b.id);
      const { controller, nexar } = engine.composition().runtime;
      const writer: WorkUnit = {
        unitId: 'implementation',
        task: {
          id: taskId('implementation'),
          kind: 'general',
          requirements: { capabilities: ['text-generation'], preferredResourceIds: [ar.id] },
        },
      };
      const reviewer: WorkUnit = {
        unitId: 'review',
        reviewOf: writer.unitId,
        task: {
          id: taskId('review'),
          kind: 'general',
          requirements: { capabilities: ['text-generation'], preferredResourceIds: [br.id] },
        },
      };
      const initial: StrategyLedger = {
        graphId: 'actual-connections',
        reviewDiversity: 'preferred',
        reviewDimensions: { [dimension]: 'required' },
        spentUsd: 0,
        allocations: [],
      };
      const written = await controller.allocate(initial, writer);
      expect(written.decision).toMatchObject({
        outcome: 'selected',
        selected: { resourceId: ar.id },
      });
      const writeTask = nexar.createTask({
        kind: 'general',
        prompt: 'synthetic implementation',
        requirements: writer.task.requirements,
      });
      if (!written.strategy) throw Error('missing production strategy');
      const actual = await nexar.run(writeTask, {
        strategy: { planned: written.strategy, unit: writer },
      });
      expect(actual.strategyAllocation?.reviewIdentity).toMatchObject({
        connectionId: a.id,
        host: 'desktop',
        provider: 'openai',
      });
      const ledger = { ...written.ledger, allocations: [actual.strategyAllocation!] };
      await manager.forgetCredential({ connectionId: a.id });
      await manager.rotateCredential({ connectionId: a.id, apiKey: A, sameAccount: true });
      expect((await resource(a.id)).id).toBe(ar.id);
      const reviewed = await engine.composition().runtime.controller.allocate(ledger, reviewer);
      expect(reviewed.decision).toMatchObject({
        outcome: 'selected',
        selected: { resourceId: br.id },
      });
      expect(reviewed.strategy?.reviewContext?.reviewed).toEqual(
        actual.strategyAllocation?.reviewIdentity,
      );
      if (!reviewed.strategy) throw Error('missing review strategy');
      const reviewTask = () =>
        nexar.createTask({
          kind: 'general',
          prompt: 'synthetic review',
          requirements: reviewer.task.requirements,
        });
      const result = await engine.composition().runtime.nexar.run(reviewTask(), {
        strategy: { planned: reviewed.strategy, unit: reviewer },
      });
      expect(result.record.resourceId).toBe(br.id);
      expect(seen).toEqual([A, B]);
      await manager.disableConnection({ connectionId: b.id });
      await expect(
        engine.composition().runtime.nexar.run(reviewTask(), {
          strategy: { planned: reviewed.strategy, unit: reviewer },
        }),
      ).rejects.toMatchObject({
        code: 'NO_ELIGIBLE_RESOURCE',
        details: { reasonCodes: [`strategy.diversity.${dimension}.unavailable`] },
      });
      expect(seen).toEqual([A, B]);
      expect(ledger.allocations[0]?.reviewIdentity?.connectionId).toBe(a.id);
      expect(JSON.stringify(ledger)).not.toContain(A);
      expect(JSON.stringify(reviewed)).not.toContain(B);
    },
  );

  it('carries a host-approved review constraint through the actual IntelligenceBridge, bounded executor and EngineHost', async () => {
    const a = await add('Writer', A);
    const ar = await resource(a.id),
      projectId = await addProject(h);
    const entered = barrier(),
      resume = barrier();
    hook = async (options) => {
      if (options?.apiKey === A) {
        entered.resolve();
        await resume.promise;
      }
    };
    const bridge = new IntelligenceBridge({
      allocator: engineAllocator(engine),
      executor: boundedCoworkExecutor(engine),
      clock: () => new Date(),
      newId: randomUUID,
      logger: noopLogger,
    });
    const grant = 'diverse-production-grant';
    bridge.open({
      grantId: grant,
      sessionId: lineage.rootSessionId,
      turnId: lineage.turnId,
      projectId,
      engine: 'dsh',
      access: 'read-only',
      maxUnits: 2,
      reviewDimensions: { connection: 'required' },
      expiresAt: new Date(Date.now() + 60000).toISOString(),
    });
    const input = {
      lineage: { ...lineage, chain: ['nexar', 'dsh'] },
      kind: 'general' as const,
      input: 'synthetic work',
      access: 'read-only' as const,
    };
    try {
      const writer = bridge.submit(grant, {
        ...input,
        unitId: 'write',
        requirements: { capabilities: ['text-generation'] },
      });
      await expect.poll(() => seen).toEqual([A]);
      const b = await add('Reviewer', B);
      const reviewer = bridge.submit(grant, {
        ...input,
        unitId: 'review',
        reviewOf: 'write',
        requirements: { capabilities: ['text-generation'] },
      });
      // Disabling B while the real writer is still executing leaves only A eligible.
      await manager.disableConnection({ connectionId: b.id });
      expect(seen).toEqual([A]);
      resume.resolve();
      await expect
        .poll(() => bridge.status(grant, writer.jobId))
        .toMatchObject({ state: 'done', result: { outcome: 'succeeded', resourceId: ar.id } });
      await expect
        .poll(() => bridge.status(grant, reviewer.jobId))
        .toMatchObject({
          state: 'done',
          result: { outcome: 'failed', reasonCodes: ['strategy.diversity.connection.unavailable'] },
        });
      expect(seen).toEqual([A]);
      expect(manager.getActiveExecutionCount(a.id)).toBe(0);
    } finally {
      resume.resolve();
      bridge.close(grant);
    }
  });

  it('validates legacy built-in pins against current authority without substituting another account', async () => {
    await add('Account B', A);
    await manager.enterBuiltinApiCredential('deepseek', B);
    const connection = await manager.getConnection('deepseek.api');
    if (!connection) throw Error('fixture');
    const [legacy] = await piCatalogDiscoverySource({
      providers: ['deepseek'],
      connection,
      credentialName: 'DEEPSEEK_API_KEY',
      credentialSource: 'keystore',
      listModels: () =>
        Promise.resolve([
          {
            id: 'synthetic-model',
            contextWindow: 32000,
            maxTokens: 1000,
            inputPerMillionTokens: 1,
            outputPerMillionTokens: 1,
          },
        ]),
    }).discover({ now: new Date(), signal: new AbortController().signal });
    if (!legacy) throw Error('fixture');
    expect(legacy.id).toBe('pi.deepseek.synthetic-model');
    expect(() => publisher.validatePin(legacy.id, [legacy])).not.toThrow();
    await manager.forgetCredential({ connectionId: 'deepseek.api' });
    expect(() => publisher.validatePin(legacy.id, [legacy])).toThrow();
    expect(() => new ConnectionRuntime(manager).validatePin(legacy.id, [legacy])).toThrow();
    // A different eligible account remains available; the old pin still cannot redirect to it.
    expect(gateway.preview('dsh', undefined)).toBeDefined();
    expect(() => publisher.validatePin(legacy.id, [])).toThrow();
    expect(seen).toHaveLength(0);
  });
  it('filters stale registry snapshots using current credential authority before NRC preview', async () => {
    const a = await add('Account A', A),
      r = await resource(a.id);
    const stale = engine.composition().runtime.registry.snapshot();
    expect(publisher.filterCandidates(stale).some((s) => s.descriptor.id === r.id)).toBe(true);
    await manager.forgetCredential({ connectionId: a.id });
    expect(publisher.filterCandidates(stale).some((s) => s.descriptor.id === r.id)).toBe(false);
    expect(gateway.preview('dsh', undefined)).toBeUndefined();
  });
  it('publishes two bridge-created accounts, routes their own keys, and preserves identity through lifecycle/restart', async () => {
    const a = await add('Account A', A),
      b = await add('Account B', B);
    const ar = await resource(a.id),
      br = await resource(b.id);
    expect(ar.id).not.toBe(br.id);
    expect(ar.kind).toEqual(br.kind);
    const record = await manager.getConnection(a.id);
    expect(ar.id).toBe(catalogResourceId(record!, 'openai', 'synthetic-model'));
    for (const r of [ar, br]) {
      const decision = begin(r);
      try {
        await turn(decision.controlDecisionId);
      } finally {
        gateway.end(decision.controlDecisionId);
      }
    }
    expect(seen).toEqual([A, B]);
    const fresh = new ConnectionManager({
      settingsStore: new SettingsStore(join(dir, 'settings.json')),
      keyStore: keys,
    });
    await fresh.initialize();
    const restarted = new ConnectionRuntime(fresh, {
      listModels: () =>
        Promise.resolve([
          {
            id: 'synthetic-model',
            contextWindow: 32000,
            maxTokens: 1000,
            inputPerMillionTokens: 1,
            outputPerMillionTokens: 1,
          },
        ]),
    });
    expect((await restarted.descriptors()).map((r) => r.id).sort()).toEqual([ar.id, br.id].sort());
    await manager.disableConnection({ connectionId: a.id });
    await engine.snapshots(true);
    expect(() => begin(ar)).toThrow();
    expect(
      gateway.preview('dsh', { mode: 'pinned', resourceId: ar.id, fallback: 'auto' }),
    ).toBeUndefined();
    const onlyB = begin(await resource(b.id));
    await turn(onlyB.controlDecisionId);
    gateway.end(onlyB.controlDecisionId);
    await manager.rotateCredential({
      connectionId: b.id,
      apiKey: C,
      sameAccount: true,
    });
    const rotated = await resource(b.id);
    expect(rotated.id).toBe(br.id);
    const next = begin(rotated);
    await turn(next.controlDecisionId);
    gateway.end(next.controlDecisionId);
    expect(seen.at(-1)).toBe(C);
    await manager.forgetCredential({ connectionId: b.id });
    expect(() => begin(rotated)).toThrow();
    await manager.rotateCredential({
      connectionId: b.id,
      apiKey: B,
      sameAccount: true,
    });
    expect((await resource(b.id)).id).toBe(br.id);
    await manager.removeConnection({ connectionId: a.id });
    expect(() => begin(ar)).toThrow();
    await manager.restoreConnection({ connectionId: a.id });
    expect((await resource(a.id)).id).toBe(ar.id);
    expect(JSON.stringify(h.events)).not.toContain(A);
    expect(JSON.stringify(h.events)).not.toContain(B);
  });

  it('protects a whole real Control turn, drains Disable, denies new pinned turns, and releases only after end', async () => {
    const a = await add('Account A', A);
    const r = await resource(a.id);
    const decision = begin(r);
    await turn(decision.controlDecisionId);
    expect(manager.getActiveExecutionCount(a.id)).toBe(1);
    for (const action of [
      () =>
        manager.rotateCredential({
          connectionId: a.id,
          apiKey: C,
          sameAccount: true,
        }),
      () => manager.forgetCredential({ connectionId: a.id }),
      () => manager.removeConnection({ connectionId: a.id }),
    ])
      await expect(action()).rejects.toMatchObject({
        details: { reason: 'connection.active' },
      });
    await manager.disableConnection({ connectionId: a.id });
    expect(() => begin(r)).toThrow();
    await turn(decision.controlDecisionId);
    expect(seen).toEqual([A, A]);
    gateway.end(decision.controlDecisionId);
    await manager.listConnections();
    expect(manager.getActiveExecutionCount(a.id)).toBe(0);
    await manager.enableConnection({ connectionId: a.id });
    expect((await resource(a.id)).id).toBe(r.id);
  });

  it('keeps a lease while an ended request is still settling and releases on provider failure/cancellation', async () => {
    const a = await add('Account A', A);
    const r = await resource(a.id),
      entered = barrier(),
      resume = barrier();
    hook = async () => {
      entered.resolve();
      await resume.promise;
    };
    const decision = begin(r);
    const pending = turn(decision.controlDecisionId);
    await entered.promise;
    gateway.end(decision.controlDecisionId);
    await expect(manager.forgetCredential({ connectionId: a.id })).rejects.toMatchObject({
      details: { reason: 'connection.active' },
    });
    resume.resolve();
    await pending;
    await manager.listConnections();
    expect(manager.getActiveExecutionCount(a.id)).toBe(0);
    hook = () => Promise.reject(new NexarError('EXECUTION_TIMEOUT', 'Synthetic timeout'));
    const failed = begin(r);
    await expect(turn(failed.controlDecisionId)).rejects.toThrow();
    await manager.listConnections();
    expect(manager.getActiveExecutionCount(a.id)).toBe(0);
    gateway.end(failed.controlDecisionId);
    hook = async () => {};
    const aborted = begin(r),
      controller = new AbortController();
    controller.abort();
    await expect(turn(aborted.controlDecisionId, controller.signal)).rejects.toMatchObject({
      code: 'EXECUTION_CANCELLED',
    });
    gateway.end(aborted.controlDecisionId);
    await manager.listConnections();
    expect(manager.getActiveExecutionCount(a.id)).toBe(0);
  });

  it('protects the actual direct adapter during Desktop execution', async () => {
    const a = await add('Account A', A),
      r = await resource(a.id),
      entered = barrier(),
      resume = barrier();
    hook = async () => {
      entered.resolve();
      await resume.promise;
    };
    const projectId = await addProject(h);
    const pending = h.call(CHANNELS.tasksRun, {
      requestId: 'synthetic-direct',
      projectId,
      kind: 'general',
      prompt: 'synthetic task',
      preferredResourceIds: [r.id],
    });
    await entered.promise;
    expect(manager.getActiveExecutionCount(a.id)).toBe(1);
    await expect(
      manager.rotateCredential({
        connectionId: a.id,
        apiKey: C,
        sameAccount: true,
      }),
    ).rejects.toMatchObject({ details: { reason: 'connection.active' } });
    resume.resolve();
    expect((await pending).ok).toBe(true);
    expect(manager.getActiveExecutionCount(a.id)).toBe(0);
  });

  it('protects an actual IntelligenceBridge delegated unit using the production bounded executor and NRC allocator', async () => {
    const a = await add('Account A', A);
    await resource(a.id);
    const entered = barrier(),
      resume = barrier();
    hook = async () => {
      entered.resolve();
      await resume.promise;
    };
    const projectId = await addProject(h);
    const bridge = new IntelligenceBridge({
      allocator: engineAllocator(engine),
      executor: boundedCoworkExecutor(engine),
      clock: () => new Date(),
      newId: randomUUID,
      logger: noopLogger,
    });
    bridge.open({
      grantId: 'synthetic-grant',
      sessionId: lineage.rootSessionId,
      turnId: lineage.turnId,
      projectId,
      engine: 'dsh',
      access: 'read-only',
      maxUnits: 2,
      expiresAt: new Date(Date.now() + 60000).toISOString(),
    });
    const job = bridge.submit('synthetic-grant', {
      lineage: { ...lineage, chain: ['nexar', 'dsh'] },
      unitId: 'synthetic-unit',
      kind: 'general',
      requirements: { capabilities: ['text-generation'] },
      input: 'synthetic bounded work',
      access: 'read-only',
    });
    await entered.promise;
    expect(manager.getActiveExecutionCount(a.id)).toBe(1);
    await expect(manager.forgetCredential({ connectionId: a.id })).rejects.toMatchObject({
      details: { reason: 'connection.active' },
    });
    resume.resolve();
    await expect
      .poll(() => bridge.status('synthetic-grant', job.jobId))
      .toMatchObject({ state: 'done', result: { outcome: 'succeeded' } });
    expect(seen).toEqual([A]);
    expect(manager.getActiveExecutionCount(a.id)).toBe(0);
    bridge.close('synthetic-grant');
  });

  it('rejects A→B/built-in/missing/invalid scopes, provider forgery, stale generation and host substitution at the real guarded adapter', async () => {
    const a = await add('Account A', A),
      b = await add('Account B', B),
      r = await resource(a.id);
    const record = await manager.getConnection(b.id);
    if (record?.credentialScope.kind !== 'keystore') throw Error('fixture');
    const adapter = engine.composition().runtime.adapters.get(r.runtime.adapter);
    expect(adapter).toBeDefined();
    const bad: ResourceDescriptor[] = [
      {
        ...r,
        auth: {
          mode: 'api-key',
          credential: { source: 'keystore', name: record.credentialScope.name },
        },
      },
      {
        ...r,
        auth: {
          mode: 'api-key',
          credential: { source: 'keystore', name: 'OPENAI_API_KEY' },
        },
      },
      { ...r, auth: { mode: 'none' } },
      {
        ...r,
        auth: {
          mode: 'api-key',
          credential: { source: 'keystore', name: 'INVALID_SCOPE' },
        },
      },
      {
        ...r,
        kind: {
          type: 'model',
          access: 'api',
          provider: 'anthropic',
          model: 'synthetic-model',
        },
      },
      { ...r, metadata: { ...r.metadata, connectionGeneration: 0 } },
      { ...r, metadata: { ...r.metadata, connectionHost: 'plane' } },
    ];
    for (const resource of bad)
      await expect(
        adapter!.execute(
          {
            resource,
            task: {
              id: taskId('synthetic-forged'),
              kind: 'general',
              input: { prompt: 'synthetic' },
              requirements: { capabilities: ['text-generation'] },
              origin: { source: 'test' },
              createdAt: '2026-10-17T12:00:00.000Z',
            },
          },
          { signal: new AbortController().signal, logger: noopLogger },
        ),
      ).rejects.toThrow();
    expect(seen).toHaveLength(0);
  });

  it('discards a late static catalog result after Disable and refuses Remove/Rotate while refresh is bound', async () => {
    const a = await add('Account A', A),
      entered = barrier(),
      resume = barrier();
    const late = new ConnectionRuntime(manager, {
      listModels: async () => {
        entered.resolve();
        await resume.promise;
        return [
          {
            id: 'synthetic-model',
            contextWindow: 1000,
            maxTokens: 100,
            inputPerMillionTokens: 1,
            outputPerMillionTokens: 1,
          },
        ];
      },
    });
    const pending = late.descriptors();
    await entered.promise;
    await expect(manager.removeConnection({ connectionId: a.id })).rejects.toMatchObject({
      details: { reason: 'connection.active' },
    });
    await manager.disableConnection({ connectionId: a.id });
    resume.resolve();
    expect(await pending).toEqual([]);
    expect(manager.getActiveExecutionCount(a.id)).toBe(0);
  });
});
