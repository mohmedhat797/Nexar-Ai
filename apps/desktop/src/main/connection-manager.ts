import {
  BUILTIN_CONNECTIONS,
  canConnectionAdmit,
  generateConnectionId,
  NexarError,
  type ConnectionDefinition,
  type PersistentConnectionRecord,
} from '@nexar/contracts';
import type { DesktopKeyStore } from './desktop-key-store.js';
import type { SettingsStore } from './settings-store.js';
import {
  ConnectionAddArgsSchema,
  ConnectionIdArgsSchema,
  ConnectionRotateArgsSchema,
  type ConnectionAddArgs,
  type ConnectionDto,
  type ConnectionIdArgs,
  type ConnectionRotateArgs,
} from '../shared/connections.js';

export interface ConnectionManagerDeps {
  readonly settingsStore: SettingsStore;
  readonly keyStore: DesktopKeyStore;
  readonly onChange?: () => void;
  readonly now?: () => string;
}

function defaultBuiltinRecord(def: ConnectionDefinition): PersistentConnectionRecord {
  return {
    ...def,
    credentialGeneration: 1,
    identityAssurance:
      def.id === 'openai.chatgpt-plan' ? 'VERIFIED_SAME_ACCOUNT' : 'OWNER_ASSERTED_SAME_ACCOUNT',
    lifecycleState: 'ACTIVE',
    createdAt: '2026-10-17T00:00:00.000Z',
    updatedAt: '2026-10-17T00:00:00.000Z',
  };
}

export class ConnectionManager {
  private readonly activeExecutions = new Map<string, number>();
  private readonly now: () => string;

  constructor(private readonly deps: ConnectionManagerDeps) {
    this.now = deps.now ?? (() => new Date().toISOString());
  }

  async listConnections(): Promise<readonly PersistentConnectionRecord[]> {
    const res = await this.deps.settingsStore.getConnections();
    const stored = res.valid ? res.value.connections : {};
    const result: PersistentConnectionRecord[] = [];
    const seen = new Set<string>();

    // Process built-ins first (with any stored overrides)
    for (const def of Object.values(BUILTIN_CONNECTIONS)) {
      seen.add(def.id);
      const override = stored[def.id];
      if (override !== undefined) {
        result.push(override);
      } else {
        result.push(defaultBuiltinRecord(def));
      }
    }

    // Process owner connections
    for (const [id, record] of Object.entries(stored)) {
      if (!seen.has(id)) {
        seen.add(id);
        result.push(record);
      }
    }

    return result.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  }

  async getConnection(id: string): Promise<PersistentConnectionRecord | undefined> {
    const list = await this.listConnections();
    return list.find((c) => c.id === id);
  }

  getActiveExecutionCount(connectionId: string): number {
    return this.activeExecutions.get(connectionId) ?? 0;
  }

  async acquireExecution(connectionId: string): Promise<{ release: () => void }> {
    const record = await this.getConnection(connectionId);
    if (!record || !canConnectionAdmit(record)) {
      throw new NexarError(
        'POLICY_REJECTED',
        `Connection '${connectionId}' cannot admit new execution units (state: ${record?.lifecycleState ?? 'NOT_FOUND'}, enabled: ${record?.enabled ?? false})`,
      );
    }

    const current = this.getActiveExecutionCount(connectionId);
    this.activeExecutions.set(connectionId, current + 1);

    let released = false;
    return {
      release: () => {
        if (released) return;
        released = true;
        const count = this.activeExecutions.get(connectionId) ?? 1;
        if (count <= 1) {
          this.activeExecutions.delete(connectionId);
        } else {
          this.activeExecutions.set(connectionId, count - 1);
        }
      },
    };
  }

  async addApiConnection(rawArgs: ConnectionAddArgs): Promise<PersistentConnectionRecord> {
    const args = ConnectionAddArgsSchema.parse(rawArgs);
    const settingsRes = await this.deps.settingsStore.getConnections();
    if (!settingsRes.valid) {
      throw new NexarError('CONFIGURATION_ERROR', 'The connections settings are not valid');
    }

    const currentConnections = { ...settingsRes.value.connections };
    const tombstones = [...settingsRes.value.tombstones];

    // Generate unique ID: <provider>.api.c<10 base32>
    const connectionId = generateConnectionId(`${args.provider}.api`, {
      existingIds: Object.keys(currentConnections),
      tombstonedIds: tombstones,
    });

    const suffixMatch = /\.c([a-z0-9]{10})$/.exec(connectionId);
    if (!suffixMatch || !suffixMatch[1]) {
      throw new NexarError('INTERNAL_ERROR', 'Failed to parse connection ID suffix');
    }
    const suffix = suffixMatch[1].toUpperCase();
    const keyName = `${args.provider.toUpperCase()}_API_KEY__C${suffix}`;

    // Securely persist key first
    await this.deps.keyStore.save(keyName, args.apiKey);

    const timestamp = this.now();
    const record: PersistentConnectionRecord = {
      id: connectionId,
      provider: args.provider,
      method: 'api',
      authClass: 'official-api',
      support: 'official',
      machine: 'desktop',
      label: args.label.trim(),
      enabled: true,
      builtIn: false,
      credentialScope: { kind: 'keystore', name: keyName },
      credentialGeneration: 1,
      identityAssurance: 'OWNER_ASSERTED_SAME_ACCOUNT',
      lifecycleState: 'ACTIVE',
      createdAt: timestamp,
      updatedAt: timestamp,
    };

    currentConnections[connectionId] = record;
    await this.deps.settingsStore.saveConnections({
      schemaVersion: 1,
      connections: currentConnections,
      tombstones,
    });

    this.notifyChange();
    return record;
  }

  async disableConnection(rawArgs: ConnectionIdArgs): Promise<PersistentConnectionRecord> {
    const { connectionId } = ConnectionIdArgsSchema.parse(rawArgs);
    const existing = await this.getConnection(connectionId);
    if (!existing) {
      throw new NexarError('VALIDATION_ERROR', `Connection '${connectionId}' not found`);
    }

    const settingsRes = await this.deps.settingsStore.getConnections();
    if (!settingsRes.valid) {
      throw new NexarError('CONFIGURATION_ERROR', 'The connections settings are not valid');
    }

    const updated: PersistentConnectionRecord = {
      ...existing,
      enabled: false,
      lifecycleState: 'DISABLED',
      updatedAt: this.now(),
    };

    const currentConnections = { ...settingsRes.value.connections, [connectionId]: updated };
    await this.deps.settingsStore.saveConnections({
      ...settingsRes.value,
      connections: currentConnections,
    });

    this.notifyChange();
    return updated;
  }

  async enableConnection(rawArgs: ConnectionIdArgs): Promise<PersistentConnectionRecord> {
    const { connectionId } = ConnectionIdArgsSchema.parse(rawArgs);
    const existing = await this.getConnection(connectionId);
    if (!existing) {
      throw new NexarError('VALIDATION_ERROR', `Connection '${connectionId}' not found`);
    }
    if (existing.lifecycleState === 'TOMBSTONED') {
      throw new NexarError(
        'POLICY_REJECTED',
        `Connection '${connectionId}' is tombstoned and cannot be enabled directly. Restore it first.`,
      );
    }

    const settingsRes = await this.deps.settingsStore.getConnections();
    if (!settingsRes.valid) {
      throw new NexarError('CONFIGURATION_ERROR', 'The connections settings are not valid');
    }

    const updated: PersistentConnectionRecord = {
      ...existing,
      enabled: true,
      lifecycleState: 'ACTIVE',
      updatedAt: this.now(),
    };

    const currentConnections = { ...settingsRes.value.connections, [connectionId]: updated };
    await this.deps.settingsStore.saveConnections({
      ...settingsRes.value,
      connections: currentConnections,
    });

    this.notifyChange();
    return updated;
  }

  async removeConnection(rawArgs: ConnectionIdArgs): Promise<PersistentConnectionRecord> {
    const { connectionId } = ConnectionIdArgsSchema.parse(rawArgs);
    if (this.getActiveExecutionCount(connectionId) > 0) {
      throw new NexarError(
        'POLICY_REJECTED',
        `Cannot remove connection '${connectionId}' while active execution units are running. Disable the connection first.`,
      );
    }

    const existing = await this.getConnection(connectionId);
    if (!existing) {
      throw new NexarError('VALIDATION_ERROR', `Connection '${connectionId}' not found`);
    }
    if (existing.builtIn) {
      throw new NexarError('POLICY_REJECTED', 'Built-in connections cannot be removed');
    }

    const settingsRes = await this.deps.settingsStore.getConnections();
    if (!settingsRes.valid) {
      throw new NexarError('CONFIGURATION_ERROR', 'The connections settings are not valid');
    }

    const updated: PersistentConnectionRecord = {
      ...existing,
      enabled: false,
      lifecycleState: 'TOMBSTONED',
      updatedAt: this.now(),
    };

    const currentConnections = { ...settingsRes.value.connections, [connectionId]: updated };
    const tombstones = Array.from(new Set([...settingsRes.value.tombstones, connectionId]));

    await this.deps.settingsStore.saveConnections({
      schemaVersion: 1,
      connections: currentConnections,
      tombstones,
    });

    this.notifyChange();
    return updated;
  }

  async restoreConnection(rawArgs: ConnectionIdArgs): Promise<PersistentConnectionRecord> {
    const { connectionId } = ConnectionIdArgsSchema.parse(rawArgs);
    const existing = await this.getConnection(connectionId);
    if (!existing) {
      throw new NexarError('VALIDATION_ERROR', `Connection '${connectionId}' not found`);
    }
    if (existing.lifecycleState !== 'TOMBSTONED') {
      throw new NexarError('CONFLICT', `Connection '${connectionId}' is not tombstoned`);
    }

    const settingsRes = await this.deps.settingsStore.getConnections();
    if (!settingsRes.valid) {
      throw new NexarError('CONFIGURATION_ERROR', 'The connections settings are not valid');
    }

    const updated: PersistentConnectionRecord = {
      ...existing,
      enabled: true,
      lifecycleState: 'ACTIVE',
      updatedAt: this.now(),
    };

    const currentConnections = { ...settingsRes.value.connections, [connectionId]: updated };
    const tombstones = settingsRes.value.tombstones.filter((id) => id !== connectionId);

    await this.deps.settingsStore.saveConnections({
      schemaVersion: 1,
      connections: currentConnections,
      tombstones,
    });

    this.notifyChange();
    return updated;
  }

  async forgetCredential(rawArgs: ConnectionIdArgs): Promise<PersistentConnectionRecord> {
    const { connectionId } = ConnectionIdArgsSchema.parse(rawArgs);
    if (this.getActiveExecutionCount(connectionId) > 0) {
      throw new NexarError(
        'POLICY_REJECTED',
        `Cannot forget credentials for connection '${connectionId}' while active execution units are running`,
      );
    }

    const existing = await this.getConnection(connectionId);
    if (!existing) {
      throw new NexarError('VALIDATION_ERROR', `Connection '${connectionId}' not found`);
    }

    if (existing.credentialScope.kind === 'keystore') {
      await this.deps.keyStore.remove(existing.credentialScope.name);
    } else if (existing.credentialScope.kind === 'account') {
      await this.deps.keyStore.removeBlob(existing.credentialScope.name);
    }

    const settingsRes = await this.deps.settingsStore.getConnections();
    if (!settingsRes.valid) {
      throw new NexarError('CONFIGURATION_ERROR', 'The connections settings are not valid');
    }

    const updated: PersistentConnectionRecord = {
      ...existing,
      updatedAt: this.now(),
    };

    const currentConnections = { ...settingsRes.value.connections, [connectionId]: updated };
    await this.deps.settingsStore.saveConnections({
      ...settingsRes.value,
      connections: currentConnections,
    });

    this.notifyChange();
    return updated;
  }

  async rotateCredential(rawArgs: ConnectionRotateArgs): Promise<PersistentConnectionRecord> {
    const { connectionId, apiKey } = ConnectionRotateArgsSchema.parse(rawArgs);
    if (this.getActiveExecutionCount(connectionId) > 0) {
      throw new NexarError(
        'POLICY_REJECTED',
        `Cannot rotate credentials for connection '${connectionId}' while active execution units are running`,
      );
    }

    const existing = await this.getConnection(connectionId);
    if (!existing) {
      throw new NexarError('VALIDATION_ERROR', `Connection '${connectionId}' not found`);
    }
    if (existing.lifecycleState === 'TOMBSTONED') {
      throw new NexarError(
        'POLICY_REJECTED',
        `Cannot rotate credentials for tombstoned connection '${connectionId}'`,
      );
    }
    if (existing.identityAssurance === 'VERIFIED_DIFFERENT_ACCOUNT') {
      throw new NexarError(
        'POLICY_REJECTED',
        'Account mismatch: connection cannot be bound to a verified different account',
      );
    }
    if (existing.credentialScope.kind !== 'keystore') {
      throw new NexarError(
        'POLICY_REJECTED',
        'Only keystore-scoped connections can have their key rotated directly',
      );
    }

    await this.deps.keyStore.save(existing.credentialScope.name, apiKey);

    const settingsRes = await this.deps.settingsStore.getConnections();
    if (!settingsRes.valid) {
      throw new NexarError('CONFIGURATION_ERROR', 'The connections settings are not valid');
    }

    const updated: PersistentConnectionRecord = {
      ...existing,
      credentialGeneration: existing.credentialGeneration + 1,
      identityAssurance: 'OWNER_ASSERTED_SAME_ACCOUNT',
      updatedAt: this.now(),
    };

    const currentConnections = { ...settingsRes.value.connections, [connectionId]: updated };
    await this.deps.settingsStore.saveConnections({
      ...settingsRes.value,
      connections: currentConnections,
    });

    this.notifyChange();
    return updated;
  }

  async replacePlanAccount(): Promise<void> {
    const planId = 'openai.chatgpt-plan';
    if (this.getActiveExecutionCount(planId) > 0) {
      throw new NexarError(
        'POLICY_REJECTED',
        'Cannot replace plan account while execution units are active',
      );
    }

    await this.deps.keyStore.removeBlob('chatgpt-plan').catch(() => undefined);
    await this.deps.keyStore.removeBlob('chatgpt-plan:binding').catch(() => undefined);
    await this.deps.keyStore.removeBlob('chatgpt-plan-binding').catch(() => undefined);

    this.notifyChange();
  }

  toDto(record: PersistentConnectionRecord): ConnectionDto {
    let hasCredential: boolean;
    try {
      if (record.credentialScope.kind === 'keystore') {
        hasCredential = this.deps.keyStore.metadata(record.credentialScope.name).present;
      } else if (record.credentialScope.kind === 'account') {
        hasCredential = this.deps.keyStore.readBlob(record.credentialScope.name) !== undefined;
      } else {
        hasCredential = true;
      }
    } catch {
      hasCredential = false;
    }

    return {
      id: record.id,
      provider: record.provider,
      method: record.method,
      authClass: record.authClass,
      support: record.support,
      machine: record.machine,
      label: record.label,
      enabled: record.enabled,
      builtIn: record.builtIn,
      credentialScopeKind: record.credentialScope.kind,
      credentialGeneration: record.credentialGeneration,
      identityAssurance: record.identityAssurance,
      lifecycleState: record.lifecycleState,
      hasCredential,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
    };
  }

  private notifyChange(): void {
    try {
      this.deps.onChange?.();
    } catch {
      // Listener errors never alter operation outcomes
    }
  }
}
