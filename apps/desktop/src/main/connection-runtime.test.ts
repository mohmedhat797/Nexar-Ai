import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { NexarError, taskId, type ResourceDescriptor } from '@nexar/contracts';
import { ControlModelGateway, IntelligenceBridge } from '@nexar/engine-gateway';
import { createControlModelTurnPorts, engineAllocator } from '@nexar/host';
import { catalogResourceId } from '@nexar/resource-registry';
import type {
  PiAssistantMessageLike,
  PiModelsLike,
  PiRequestOptionsLike,
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
const lineage = {
  rootSessionId: 'synthetic-session',
  turnId: 'synthetic-turn',
  correlationId: 'synthetic-correlation',
  depth: 0,
};
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'nexar-connection-runtime-'));
  seen = [];
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
    completeSimple: async (_model, _context, options) => {
      seen.push(options?.apiKey ?? 'missing');
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
    candidates: () => engine.composition().runtime.registry.snapshot(),
    policy: engine.composition().runtime.policy,
    admit: (d) => manager.acquireResource(d),
    validatePin: (id) => publisher.validatePin(id),
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
async function add(label: string, key: string): Promise<ConnectionDto> {
  const result = await h.call<ConnectionDto>(CHANNELS.connectionAdd, {
    provider: 'openai',
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
