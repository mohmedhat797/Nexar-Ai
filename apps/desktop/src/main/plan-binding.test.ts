import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { noopLogger } from '@nexar/telemetry';
import {
  adapterId,
  resourceId,
  taskId,
  type PersistentConnectionRecord,
  type ResourceDescriptor,
  type StrategyLedger,
  type WorkUnit,
} from '@nexar/contracts';
import { materializeInventory } from '@nexar/resource-registry';
import {
  allocateNext,
  reviewIdentityOf,
  DeterministicRoutingPolicy,
  DEFAULT_TASK_KIND_RULES,
} from '@nexar/resource-controller';
import {
  createOpenAiAccountClient,
  type OpenAiAccountClient,
} from '@nexar/integration-openai-account';
import {
  FAKE_SUB,
  startFakeAuthServer,
  type FakeAuthServer,
} from '@nexar/integration-openai-account/testing';
import { ChatGptPlanService } from './chatgpt-plan.js';
import { ConnectionManager } from './connection-manager.js';
import { DesktopKeyStore } from './desktop-key-store.js';
import { SettingsStore } from './settings-store.js';
import { SigninCallbackSupervisor } from './signin-callback-child.js';
import { bundleSigninChild } from './signin-test-kit.js';

let kit: Awaited<ReturnType<typeof bundleSigninChild>>,
  dir: string,
  fake: FakeAuthServer,
  keys: DesktopKeyStore,
  manager: ConnectionManager,
  service: ChatGptPlanService,
  client: OpenAiAccountClient;
const barrier = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
};
beforeAll(async () => {
  kit = await bundleSigninChild();
}, 60000);
afterAll(async () => {
  await rm(kit.dir, { recursive: true, force: true });
});
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'nexar-plan-binding-'));
  fake = await startFakeAuthServer();
  const values = new Map<string, string>();
  let n = 0;
  keys = new DesktopKeyStore({
    userData: dir,
    encryption: {
      isEncryptionAvailable: () => true,
      getSelectedStorageBackend: () => 'gnome_libsecret',
      encryptString: (s) => {
        const id = `cipher-${++n}`;
        values.set(id, s);
        return Buffer.from(id);
      },
      decryptString: (b) => {
        const s = values.get(b.toString());
        if (s === undefined) throw Error('synthetic encryption');
        return s;
      },
    },
  });
  manager = new ConnectionManager({
    settingsStore: new SettingsStore(join(dir, 'settings.json')),
    keyStore: keys,
  });
  await manager.initialize();
  client = createOpenAiAccountClient({ issuer: fake.issuer, timeoutMs: 3000 });
  service = make();
});
function make(custom = client): ChatGptPlanService {
  return new ChatGptPlanService({
    keys,
    authority: manager,
    client: custom,
    callback: new SigninCallbackSupervisor({ launch: kit.launch }),
    openExternal: async (url) => {
      await fetch(url);
    },
    installationId: () => Promise.resolve('00000000-0000-4000-8000-000000000001'),
    logger: noopLogger,
  });
}
afterEach(async () => {
  vi.restoreAllMocks();
  service.dispose();
  await service.cancel();
  await fake.close();
  await rm(dir, {
    recursive: true,
    force: true,
    maxRetries: 10,
    retryDelay: 50,
  });
});
describe('Plan retained identity and sequential replacement with real fake-IdP verification', () => {
  it('TST-42 retains historical review identity across verified re-entry and permanent sequential replacement', async () => {
    await service.connect();
    const before = await manager.currentPlan();
    const materialize = (plan: PersistentConnectionRecord): ResourceDescriptor => {
      const template: ResourceDescriptor = {
        id: resourceId('template-only'),
        displayName: 'Plan',
        kind: { type: 'model', provider: 'openai', model: 'synthetic', access: 'subscription' },
        capabilities: ['text-generation', 'model-turn'],
        runtime: { adapter: adapterId('fake'), locality: 'remote' },
        auth: { mode: 'none' },
        cost: { model: 'subscription' },
        dataLocality: 'third-party',
        metadata: {
          connection: {
            id: plan.id,
            provider: plan.provider,
            method: plan.method,
            authClass: plan.authClass,
            support: plan.support,
          },
          connectionHost: plan.machine,
        },
      };
      return materializeInventory(
        {
          identity: {
            provider: plan.provider,
            connectionId: plan.id,
            runtimeId: 'openai-account',
            routeId: 'plan',
            machine: plan.machine,
          },
          generation: plan.credentialGeneration,
          status: 'fresh',
          source: 'live-runtime',
          auth: 'authenticated',
          observedAt: new Date().toISOString(),
          entries: [
            {
              selection: { kind: 'model', id: 'synthetic' },
              displayName: 'Synthetic',
              availability: 'available',
              compatibility: 'model-turn',
            },
          ],
        },
        template,
      )[0]!;
    };
    const descriptor = materialize(before);
    const retained = reviewIdentityOf(descriptor);
    const ledger: StrategyLedger = {
      graphId: 'plan-history',
      reviewDiversity: 'preferred',
      reviewDimensions: { connection: 'required' },
      spentUsd: 0,
      allocations: [{ unitId: 'write', resourceId: descriptor.id, reviewIdentity: retained }],
    };
    const review: WorkUnit = {
      unitId: 'review',
      reviewOf: 'write',
      task: {
        id: taskId('review'),
        kind: 'general',
        requirements: { capabilities: ['text-generation'] },
      },
    };
    const allocate = (d: ResourceDescriptor) =>
      allocateNext({
        ledger,
        unit: review,
        candidates: [
          {
            descriptor: d,
            state: {
              availability: 'available',
              auth: 'authenticated',
              observedAt: new Date().toISOString(),
            },
          },
        ],
        policy: new DeterministicRoutingPolicy({ taskKinds: DEFAULT_TASK_KIND_RULES }),
        now: new Date(),
      });
    await manager.forgetCredential({ connectionId: before.id });
    await service.connect();
    expect(reviewIdentityOf(materialize(await manager.currentPlan()))).toEqual(retained);
    expect(allocate(materialize(await manager.currentPlan())).decision).toMatchObject({
      outcome: 'no-eligible-resource',
      reasons: [{ code: 'strategy.diversity.connection.unavailable' }],
    });
    const replacement = await manager.replacePlanAccount();
    fake.idClaims = { sub: 'synthetic-new-plan-account' };
    await service.connect();
    expect(replacement.id).not.toBe(before.id);
    const next = materialize(await manager.currentPlan());
    expect(next.id).not.toBe(descriptor.id);
    expect(allocate(next).decision).toMatchObject({
      outcome: 'selected',
      selected: { resourceId: next.id },
    });
    expect(ledger.allocations[0]?.reviewIdentity).toEqual(retained);
    expect((await manager.getConnection(before.id))?.retirement).toBe('replaced');
    await expect(manager.restoreConnection({ connectionId: before.id })).rejects.toThrow();
    expect(JSON.stringify(ledger)).not.toContain(FAKE_SUB);
    expect(JSON.stringify(ledger)).not.toContain('synthetic-new-plan-account');
  });
  it('re-enters an ordinarily removed Plan with the same account before explicit Restore, without reactivation', async () => {
    const plan = await manager.replacePlanAccount();
    await service.connect();
    await manager.removeConnection({ connectionId: plan.id });
    await manager.forgetCredential({ connectionId: plan.id });
    await expect(manager.restoreConnection({ connectionId: plan.id })).rejects.toThrow();
    fake.idClaims = { sub: 'different-removed-account' };
    await expect(service.connect()).rejects.toThrow();
    fake.idClaims = {};
    await service.connect();
    expect((await manager.getConnection(plan.id))?.lifecycleState).toBe('TOMBSTONED');
    await expect(manager.acquireExecution(plan.id)).rejects.toThrow();
    await manager.restoreConnection({ connectionId: plan.id });
    expect((await manager.currentPlan()).id).toBe(plan.id);
    expect((await service.status()).state).toBe('connected');
  });
  it('does not display verified assurance without private binding evidence', async () => {
    const plan = await manager.currentPlan();
    expect(
      manager.toDto({ ...plan, identityAssurance: 'VERIFIED_SAME_ACCOUNT' }).identityAssurance,
    ).toBe('IDENTITY_UNKNOWN');
    await service.connect();
    expect(manager.toDto(await manager.currentPlan()).identityAssurance).toBe(
      'VERIFIED_SAME_ACCOUNT',
    );
    await manager.forgetCredential({ connectionId: plan.id });
    expect(manager.toDto(await manager.currentPlan()).identityAssurance).toBe(
      'VERIFIED_SAME_ACCOUNT',
    );
    await keys.saveBlob(
      'chatgpt-plan:binding',
      Buffer.from(JSON.stringify({ v: 1, sub: '', unexpected: true })).toString('base64url'),
    );
    expect(manager.toDto(await manager.currentPlan()).identityAssurance).toBe('IDENTITY_UNKNOWN');
  });
  it('journals expired-token deletion while retaining the verified private binding', async () => {
    await service.connect();
    const before = await manager.currentPlan(),
      binding = keys.readBlob('chatgpt-plan:binding');
    fake.tokenReply = (form) =>
      form['grant_type'] === 'refresh_token'
        ? { status: 400, body: { error: 'invalid_grant' } }
        : undefined;
    await expect(service.accessToken({ refresh: true })).rejects.toThrow();
    expect(keys.readBlob('chatgpt-plan')).toBeUndefined();
    expect(keys.readBlob('chatgpt-plan:binding')).toBe(binding);
    expect((await manager.currentPlan()).credentialGeneration).toBe(
      before.credentialGeneration + 1,
    );
    expect(keys.readBlob('connection-transaction')).toBeUndefined();
  });
  it('retains binding across Forget, rejects a different account, and permits verified same-account re-entry', async () => {
    await service.connect();
    expect((await manager.currentPlan()).identityAssurance).toBe('VERIFIED_SAME_ACCOUNT');
    const binding = keys.readBlob('chatgpt-plan:binding');
    expect(binding).toBeDefined();
    await manager.forgetCredential({ connectionId: 'openai.chatgpt-plan' });
    expect(keys.readBlob('chatgpt-plan')).toBeUndefined();
    expect(keys.readBlob('chatgpt-plan:binding')).toBe(binding);
    fake.idClaims = { sub: 'synthetic-different-subject' };
    await expect(service.connect()).rejects.toMatchObject({
      code: 'POLICY_REJECTED',
    });
    expect(keys.readBlob('chatgpt-plan')).toBeUndefined();
    fake.idClaims = {};
    await expect(service.connect()).resolves.toMatchObject({
      state: 'connected',
    });
    const surface =
      JSON.stringify(await service.status()) + (await readFile(join(dir, 'settings.json'), 'utf8'));
    expect(surface).not.toContain(FAKE_SUB);
    expect(surface).not.toContain('access-token-sentinel');
  });
  it('blocks Replace during real sign-in and refresh, then permanently retires the old ID', async () => {
    const entered = barrier(),
      resume = barrier();
    service = make({
      ...client,
      exchangeCode: async (input) => {
        entered.resolve();
        await resume.promise;
        return client.exchangeCode(input);
      },
    });
    const connecting = service.connect();
    await entered.promise;
    await expect(manager.replacePlanAccount()).rejects.toMatchObject({
      details: { reason: 'connection.active' },
    });
    resume.resolve();
    await connecting;
    const refreshing = barrier(),
      finish = barrier();
    service.dispose();
    service = make({
      ...client,
      refresh: async (input) => {
        refreshing.resolve();
        await finish.promise;
        return client.refresh(input);
      },
    });
    const refresh = service.accessToken({ refresh: true });
    await refreshing.promise;
    await expect(manager.replacePlanAccount()).rejects.toMatchObject({
      details: { reason: 'connection.active' },
    });
    finish.resolve();
    await refresh;
    const next = await manager.replacePlanAccount();
    expect(next.id).not.toBe('openai.chatgpt-plan');
    expect(keys.readBlob('chatgpt-plan')).toBeUndefined();
    expect(keys.readBlob('chatgpt-plan:binding')).toBeUndefined();
    await expect(
      manager.restoreConnection({ connectionId: 'openai.chatgpt-plan' }),
    ).rejects.toThrow();
    expect(
      (await manager.listConnections()).filter(
        (r) => r.authClass === 'official-account' && r.lifecycleState !== 'TOMBSTONED',
      ),
    ).toHaveLength(1);
  });
  it('does not establish a binding from an invalid signed token', async () => {
    fake.idClaims = { aud: 'wrong-client' };
    await expect(service.connect()).rejects.toThrow();
    expect(keys.readBlob('chatgpt-plan')).toBeUndefined();
    expect(keys.readBlob('chatgpt-plan:binding')).toBeUndefined();
    expect((await manager.currentPlan()).identityAssurance).toBe('IDENTITY_UNKNOWN');
  });
  it('rejects verified different-account refresh without overwriting the established tokens', async () => {
    await service.connect();
    const original = keys.readBlob('chatgpt-plan'),
      binding = keys.readBlob('chatgpt-plan:binding');
    fake.includeRefreshIdToken = true;
    fake.idClaims = { sub: 'different-refresh-subject' };
    await expect(service.accessToken({ refresh: true })).rejects.toThrow();
    expect(keys.readBlob('chatgpt-plan')).toBe(original);
    expect(keys.readBlob('chatgpt-plan:binding')).toBe(binding);
  });
  it('compares legacy verified subject when the separate binding is missing', async () => {
    await service.connect();
    await keys.removeBlob('chatgpt-plan:binding');
    const original = keys.readBlob('chatgpt-plan');
    fake.idClaims = { sub: 'different-legacy-subject' };
    await expect(service.connect()).rejects.toThrow();
    expect(keys.readBlob('chatgpt-plan')).toBe(original);
    expect(keys.readBlob('chatgpt-plan:binding')).toBeUndefined();
  });
  it('recovers replacement after settings failure and refuses success on token deletion failure', async () => {
    await service.connect();
    const settings = new SettingsStore(join(dir, 'settings.json'));
    manager = new ConnectionManager({ settingsStore: settings, keyStore: keys });
    await manager.initialize();
    const failed = vi.spyOn(keys, 'batch').mockRejectedValueOnce(Error('synthetic token deletion'));
    await expect(manager.replacePlanAccount()).rejects.toThrow();
    expect(keys.readBlob('chatgpt-plan')).toBeDefined();
    failed.mockRestore();
    vi.spyOn(settings, 'saveConnections').mockRejectedValueOnce(
      Error('synthetic settings failure'),
    );
    await expect(manager.replacePlanAccount()).rejects.toThrow();
    expect(keys.readBlob('chatgpt-plan')).toBeUndefined();
    expect(keys.readBlob('connection-transaction')).toBeDefined();
    vi.restoreAllMocks();
    manager = new ConnectionManager({
      settingsStore: new SettingsStore(join(dir, 'settings.json')),
      keyStore: keys,
    });
    await manager.initialize();
    const next = await manager.currentPlan();
    expect(next.id).not.toBe('openai.chatgpt-plan');
    expect(next.identityAssurance).toBe('IDENTITY_UNKNOWN');
    expect(keys.readBlob('connection-transaction')).toBeUndefined();
    expect((await manager.getConnection('openai.chatgpt-plan'))?.retirement).toBe('replaced');
    await manager.initialize();
    expect((await manager.currentPlan()).id).toBe(next.id);
  });
});
