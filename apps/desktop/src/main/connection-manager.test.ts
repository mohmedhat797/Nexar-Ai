import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { CHANNELS } from '../shared/channels.js';
import type { ConnectionDto } from '../shared/connections.js';
import { createHarness, type Harness } from './test-harness.js';
import { DesktopKeyStore, type DesktopEncryption } from './desktop-key-store.js';
import { SettingsStore } from './settings-store.js';
import { ConnectionManager } from './connection-manager.js';

let dir: string;
let settingsPath: string;
let settingsStore: SettingsStore;
let keyStore: DesktopKeyStore;
let manager: ConnectionManager;
let onChange: Mock<() => void>;

function fakeEncryption(): DesktopEncryption {
  const secrets = new Map<string, string>();
  let next = 0;
  return {
    isEncryptionAvailable: () => true,
    getSelectedStorageBackend: () => 'gnome_libsecret',
    encryptString: (value: string) => {
      const cipher = `cipher-${++next}`;
      secrets.set(cipher, value);
      return Buffer.from(cipher);
    },
    decryptString: (value: Buffer) => {
      const secret = secrets.get(value.toString());
      if (secret === undefined) throw new Error('cipher unavailable');
      return secret;
    },
  };
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'nexar-conn-mgr-test-'));
  settingsPath = join(dir, 'desktop-settings.json');
  settingsStore = new SettingsStore(settingsPath);
  keyStore = new DesktopKeyStore({ userData: dir, encryption: fakeEncryption() });
  onChange = vi.fn<() => void>();
  manager = new ConnectionManager({
    settingsStore,
    keyStore,
    onChange,
    now: () => '2026-10-17T12:00:00.000Z',
  });
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

describe('ConnectionManager', () => {
  describe('listConnections & built-ins', () => {
    it('returns all 5 canonical built-ins with default metadata when settings is clean', async () => {
      const list = await manager.listConnections();
      expect(list.length).toBe(5);

      const ids = list.map((c) => c.id).sort();
      expect(ids).toEqual([
        'anthropic.subscription',
        'deepseek.api',
        'google.subscription',
        'openai.chatgpt-plan',
        'openai.subscription',
      ]);

      for (const record of list) {
        expect(record.builtIn).toBe(true);
        expect(record.enabled).toBe(true);
        expect(record.lifecycleState).toBe('ACTIVE');
        expect(record.credentialGeneration).toBe(1);
      }

      const planRecord = list.find((c) => c.id === 'openai.chatgpt-plan')!;
      expect(planRecord.identityAssurance).toBe('IDENTITY_UNKNOWN');

      const claudeRecord = list.find((c) => c.id === 'anthropic.subscription')!;
      expect(claudeRecord.identityAssurance).toBe('IDENTITY_UNKNOWN');
    });

    it('getConnection returns individual connection or undefined', async () => {
      const dsh = await manager.getConnection('deepseek.api');
      expect(dsh).toBeDefined();
      expect(dsh?.provider).toBe('deepseek');

      const nonExistent = await manager.getConnection('unknown.api');
      expect(nonExistent).toBeUndefined();
    });
  });

  describe('addApiConnection', () => {
    it('adds a new API connection, saves key securely, and persists to settings', async () => {
      const record = await manager.addApiConnection({
        provider: 'anthropic',
        label: 'My Anthropic Work Key',
        apiKey: 'sk-ant-api03-test-secret-key-1234',
      });

      expect(record.id).toMatch(/^anthropic\.api\.c[a-z0-9]{10}$/);
      expect(record.provider).toBe('anthropic');
      expect(record.method).toBe('api');
      expect(record.authClass).toBe('official-api');
      expect(record.support).toBe('official');
      expect(record.machine).toBe('desktop');
      expect(record.label).toBe('My Anthropic Work Key');
      expect(record.enabled).toBe(true);
      expect(record.builtIn).toBe(false);
      expect(record.credentialGeneration).toBe(1);
      expect(record.identityAssurance).toBe('IDENTITY_UNKNOWN');
      expect(record.lifecycleState).toBe('ACTIVE');
      expect(record.createdAt).toBe('2026-10-17T12:00:00.000Z');
      expect(record.updatedAt).toBe('2026-10-17T12:00:00.000Z');

      // Credential scope is keystore and format is <PROVIDER>_API_KEY__C<SUFFIX>
      expect(record.credentialScope.kind).toBe('keystore');
      if (record.credentialScope.kind === 'keystore') {
        expect(record.credentialScope.name).toMatch(/^ANTHROPIC_API_KEY__C[A-Z0-9]{10}$/);
        // Verify key is stored in DesktopKeyStore
        expect(keyStore.resolveSecret(record.credentialScope.name)).toBe(
          'sk-ant-api03-test-secret-key-1234',
        );
      }

      expect(onChange).toHaveBeenCalledTimes(1);

      // Verify connection appears in listConnections
      const list = await manager.listConnections();
      expect(list.some((c) => c.id === record.id)).toBe(true);
    });

    it('validates provider name and key constraints', async () => {
      await expect(
        manager.addApiConnection({
          provider: 'invalid provider',
          label: 'Test',
          apiKey: 'sk-test-valid-length-key-1234',
        }),
      ).rejects.toThrow();

      await expect(
        manager.addApiConnection({
          provider: 'openai',
          label: 'Test',
          apiKey: 'too-short',
        }),
      ).rejects.toThrow();
    });
  });

  describe('disableConnection & enableConnection', () => {
    it('disables an active connection and allows enabling it back', async () => {
      const added = await manager.addApiConnection({
        provider: 'openai',
        label: 'My OpenAI Key',
        apiKey: 'sk-openai-test-secret-key-1234',
      });

      const disabled = await manager.disableConnection({ connectionId: added.id });
      expect(disabled.enabled).toBe(false);
      expect(disabled.lifecycleState).toBe('DISABLED');

      const reloaded = (await manager.getConnection(added.id))!;
      expect(reloaded.enabled).toBe(false);
      expect(reloaded.lifecycleState).toBe('DISABLED');

      const enabled = await manager.enableConnection({ connectionId: added.id });
      expect(enabled.enabled).toBe(true);
      expect(enabled.lifecycleState).toBe('ACTIVE');
    });

    it('rejects enabling a tombstoned connection', async () => {
      const added = await manager.addApiConnection({
        provider: 'openai',
        label: 'My OpenAI Key',
        apiKey: 'sk-openai-test-secret-key-1234',
      });
      await manager.removeConnection({ connectionId: added.id });

      await expect(manager.enableConnection({ connectionId: added.id })).rejects.toMatchObject({
        code: 'POLICY_REJECTED',
      });
    });
  });

  describe('removeConnection & restoreConnection', () => {
    it('refuses to remove built-in connections', async () => {
      await expect(
        manager.removeConnection({ connectionId: 'deepseek.api' }),
      ).rejects.toMatchObject({
        code: 'POLICY_REJECTED',
      });
    });

    it('refuses to remove a connection with active execution units', async () => {
      const added = await manager.addApiConnection({
        provider: 'groq',
        label: 'Groq Key',
        apiKey: 'gsk-groq-test-secret-key-1234',
      });

      const lease = await manager.acquireExecution(added.id);
      expect(manager.getActiveExecutionCount(added.id)).toBe(1);

      await expect(manager.removeConnection({ connectionId: added.id })).rejects.toMatchObject({
        code: 'POLICY_REJECTED',
      });

      lease.release();
      expect(manager.getActiveExecutionCount(added.id)).toBe(0);

      // Now removal succeeds
      const removed = await manager.removeConnection({ connectionId: added.id });
      expect(removed.lifecycleState).toBe('TOMBSTONED');
      expect(removed.enabled).toBe(false);
    });

    it('tombstones connection, records tombstone ID, and allows restore', async () => {
      const added = await manager.addApiConnection({
        provider: 'groq',
        label: 'Groq Key',
        apiKey: 'gsk-groq-test-secret-key-1234',
      });

      const removed = await manager.removeConnection({ connectionId: added.id });
      expect(removed.lifecycleState).toBe('TOMBSTONED');

      const settings = await settingsStore.getConnections();
      expect(settings.valid).toBe(true);
      if (settings.valid) {
        expect(settings.value.tombstones).toContain(added.id);
      }

      // Credentials are retained by default
      if (added.credentialScope.kind === 'keystore') {
        expect(keyStore.metadata(added.credentialScope.name).present).toBe(true);
      }

      // Restoring brings connection back to ACTIVE
      const restored = await manager.restoreConnection({ connectionId: added.id });
      expect(restored.lifecycleState).toBe('ACTIVE');
      expect(restored.enabled).toBe(true);

      const settingsAfter = await settingsStore.getConnections();
      expect(settingsAfter.valid).toBe(true);
      if (settingsAfter.valid) {
        expect(settingsAfter.value.tombstones).not.toContain(added.id);
      }
    });
  });

  describe('forgetCredential & rotateCredential', () => {
    it('refuses forgetCredential and rotateCredential while active execution units exist', async () => {
      const added = await manager.addApiConnection({
        provider: 'mistral',
        label: 'Mistral Key',
        apiKey: 'mis-mistral-test-secret-key-1234',
      });

      const lease = await manager.acquireExecution(added.id);

      await expect(manager.forgetCredential({ connectionId: added.id })).rejects.toMatchObject({
        code: 'POLICY_REJECTED',
      });

      await expect(
        manager.rotateCredential({
          sameAccount: true,
          connectionId: added.id,
          apiKey: 'mis-mistral-new-secret-key-5678',
        }),
      ).rejects.toMatchObject({
        code: 'POLICY_REJECTED',
      });

      lease.release();
    });

    it('forgets credentials while retaining connection record', async () => {
      const added = await manager.addApiConnection({
        provider: 'mistral',
        label: 'Mistral Key',
        apiKey: 'mis-mistral-test-secret-key-1234',
      });

      await manager.forgetCredential({ connectionId: added.id });

      if (added.credentialScope.kind === 'keystore') {
        expect(keyStore.metadata(added.credentialScope.name).present).toBe(false);
      }

      const connection = (await manager.getConnection(added.id))!;
      expect(connection).toBeDefined();
      expect(connection.label).toBe('Mistral Key');
    });

    it('rotates credential: increments generation and updates key in store', async () => {
      const added = await manager.addApiConnection({
        provider: 'xai',
        label: 'Grok Key',
        apiKey: 'xai-test-key-original-1234',
      });
      expect(added.credentialGeneration).toBe(1);

      const rotated = await manager.rotateCredential({
        sameAccount: true,
        connectionId: added.id,
        apiKey: 'xai-test-key-rotated-5678',
      });

      expect(rotated.credentialGeneration).toBe(2);
      if (added.credentialScope.kind === 'keystore') {
        expect(keyStore.resolveSecret(added.credentialScope.name)).toBe(
          'xai-test-key-rotated-5678',
        );
      }
    });
  });

  describe('acquireExecution lease tracking', () => {
    it('admits active connection and increments active executions', async () => {
      const added = await manager.addApiConnection({
        provider: 'openrouter',
        label: 'OpenRouter Key',
        apiKey: 'sk-or-test-secret-key-1234',
      });

      const lease1 = await manager.acquireExecution(added.id);
      expect(manager.getActiveExecutionCount(added.id)).toBe(1);

      const lease2 = await manager.acquireExecution(added.id);
      expect(manager.getActiveExecutionCount(added.id)).toBe(2);

      lease1.release();
      expect(manager.getActiveExecutionCount(added.id)).toBe(1);

      lease2.release();
      expect(manager.getActiveExecutionCount(added.id)).toBe(0);

      // Multiple releases have no negative effect
      lease2.release();
      expect(manager.getActiveExecutionCount(added.id)).toBe(0);
    });

    it('refuses admission if connection is disabled', async () => {
      const added = await manager.addApiConnection({
        provider: 'openrouter',
        label: 'OpenRouter Key',
        apiKey: 'sk-or-test-secret-key-1234',
      });
      await manager.disableConnection({ connectionId: added.id });

      await expect(manager.acquireExecution(added.id)).rejects.toMatchObject({
        code: 'RESOURCE_UNAVAILABLE',
      });
    });
  });

  describe('replacePlanAccount', () => {
    it('clears plan and binding blobs without errors', async () => {
      await keyStore.saveBlob('chatgpt-plan', 'eyJ0b2tlbiI6InBsYW4tdG9rZW4ifQ');
      await keyStore.saveBlob('chatgpt-plan:binding', 'eyJzdWIiOiJ1c2VyLTEyMzQ1Njc4OTAifQ');

      expect(keyStore.readBlob('chatgpt-plan')).toBeDefined();
      expect(keyStore.readBlob('chatgpt-plan:binding')).toBeDefined();

      await manager.replacePlanAccount();

      expect(keyStore.readBlob('chatgpt-plan')).toBeUndefined();
      expect(keyStore.readBlob('chatgpt-plan:binding')).toBeUndefined();
      expect(onChange).toHaveBeenCalled();
    });
  });

  describe('toDto', () => {
    it('maps PersistentConnectionRecord to ConnectionDto, stripping secret details', async () => {
      const added = await manager.addApiConnection({
        provider: 'deepseek',
        label: 'DeepSeek Pro',
        apiKey: 'sk-deepseek-test-secret-1234',
      });

      const dto = manager.toDto(added);
      expect(dto.id).toBe(added.id);
      expect(dto.label).toBe('DeepSeek Pro');
      expect(dto.credentialScopeKind).toBe('keystore');
      expect(dto.hasCredential).toBe(true);
      expect(dto).not.toHaveProperty('credentialScope');
    });
  });

  describe('IPC Bridge Integration', () => {
    let harness: Harness;

    beforeEach(async () => {
      harness = await createHarness({ connectionManager: manager });
    });

    afterEach(async () => {
      await harness.cleanup();
    });

    it('invokes connectionList and returns valid DTO array', async () => {
      const res = await harness.call<readonly ConnectionDto[]>(CHANNELS.connectionList);
      expect(res.ok).toBe(true);
      if (res.ok) {
        expect(Array.isArray(res.value)).toBe(true);
        expect(res.value.length).toBe(5);
        expect(res.value.map((c) => c.id)).toContain('deepseek.api');
      }
    });

    it('invokes connection lifecycle channels via bridge', async () => {
      // 1. Add
      const addRes = await harness.call<ConnectionDto>(CHANNELS.connectionAdd, {
        provider: 'anthropic',
        label: 'IPC Anthropic',
        apiKey: 'sk-ant-test-key-for-ipc-bridge-1234',
      });
      expect(addRes.ok).toBe(true);
      if (!addRes.ok) return;
      const id = addRes.value.id;
      expect(id).toMatch(/^anthropic\.api\.c/);
      expect(addRes.value.label).toBe('IPC Anthropic');

      // 2. Disable
      const disableRes = await harness.call<ConnectionDto>(CHANNELS.connectionDisable, {
        connectionId: id,
      });
      expect(disableRes.ok).toBe(true);
      if (disableRes.ok) {
        expect(disableRes.value.enabled).toBe(false);
        expect(disableRes.value.lifecycleState).toBe('DISABLED');
      }

      // 3. Enable
      const enableRes = await harness.call<ConnectionDto>(CHANNELS.connectionEnable, {
        connectionId: id,
      });
      expect(enableRes.ok).toBe(true);
      if (enableRes.ok) {
        expect(enableRes.value.enabled).toBe(true);
        expect(enableRes.value.lifecycleState).toBe('ACTIVE');
      }

      // 4. Rotate Key
      const rotateRes = await harness.call<ConnectionDto>(CHANNELS.connectionRotateKey, {
        sameAccount: true,
        connectionId: id,
        apiKey: 'sk-ant-test-key-rotated-via-ipc-5678',
      });
      expect(rotateRes.ok).toBe(true);
      if (rotateRes.ok) {
        expect(rotateRes.value.credentialGeneration).toBe(2);
      }

      // 5. Forget Credentials
      const forgetRes = await harness.call<ConnectionDto>(CHANNELS.connectionForgetCredentials, {
        connectionId: id,
      });
      expect(forgetRes.ok).toBe(true);
      if (forgetRes.ok) {
        expect(forgetRes.value.hasCredential).toBe(false);
      }

      // 6. Remove
      const removeRes = await harness.call<ConnectionDto>(CHANNELS.connectionRemove, {
        connectionId: id,
      });
      expect(removeRes.ok).toBe(true);
      if (removeRes.ok) {
        expect(removeRes.value.lifecycleState).toBe('TOMBSTONED');
      }

      // 7. Restore
      // Credentials were forgotten: re-enter with explicit continuity before Restore.
      const unavailable = await harness.call(CHANNELS.connectionRestore, { connectionId: id });
      expect(unavailable.ok).toBe(false);
      const reentry = await harness.call(CHANNELS.connectionRotateKey, {
        connectionId: id,
        apiKey: 'synthetic-reentry-same-account-1234',
        sameAccount: true,
      });
      expect(reentry.ok).toBe(true);
      const restoreRes = await harness.call<ConnectionDto>(CHANNELS.connectionRestore, {
        connectionId: id,
      });
      expect(restoreRes.ok).toBe(true);
      if (restoreRes.ok) expect(restoreRes.value.lifecycleState).toBe('ACTIVE');
    });

    it('rejects invalid inputs on connectionAdd with validation error', async () => {
      const res = await harness.call(CHANNELS.connectionAdd, {
        provider: 'bad provider!',
        label: 'Test',
        apiKey: 'short',
      });
      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.error.code).toBe('VALIDATION_ERROR');
      }
    });
  });
});
