import { createHash, randomUUID } from 'node:crypto';
import {
  BUILTIN_CONNECTIONS,
  canConnectionAdmit,
  connectionOf,
  generateConnectionId,
  NexarError,
  type ConnectionDefinition,
  type ConnectionsSettings,
  type PersistentConnectionRecord,
  type ResourceDescriptor,
} from '@nexar/contracts';
import { catalogResourceId } from '@nexar/resource-registry';
import { API_PROVIDER_IDS } from '../shared/providers.js';
import type { CredentialChange, DesktopKeyStore } from './desktop-key-store.js';
import type { SettingsStore } from './settings-store.js';
import { hasRetainedPlanBinding } from './chatgpt-plan.js';
import {
  defaultDefinition,
  ownerKeyName,
  PLAN_ID,
  planScopeName,
  validConnections,
} from './connection-state.js';
import {
  ConnectionAddArgsSchema,
  ConnectionIdArgsSchema,
  ConnectionRotateArgsSchema,
  type ConnectionAddArgs,
  type ConnectionDto,
  type ConnectionIdArgs,
  type ConnectionRotateArgs,
  type ConnectionConfirmation,
  type ConnectionPrepareArgs,
  type ConnectionConfirmedArgs,
} from '../shared/connections.js';

const JOURNAL = 'connection-transaction';
function stateDigest(value: ConnectionsSettings): string {
  const canonical = JSON.stringify(value, (_key, item: unknown) =>
    item !== null && typeof item === 'object' && !Array.isArray(item)
      ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
      : item,
  );
  return createHash('sha256').update(canonical).digest('hex');
}
const unavailable = (reason = 'connection.unavailable'): NexarError =>
  new NexarError('RESOURCE_UNAVAILABLE', 'Connection is unavailable', { details: { reason } });
const rejected = (reason: string): NexarError =>
  new NexarError('POLICY_REJECTED', 'Connection action is not permitted', { details: { reason } });
export interface ConnectionLease {
  release(): void;
  readonly record: PersistentConnectionRecord;
}
export interface ConnectionManagerDeps {
  readonly settingsStore: SettingsStore;
  readonly keyStore: DesktopKeyStore;
  readonly onChange?: () => void | Promise<void>;
  readonly now?: () => string;
  readonly rng?: (count: number) => Uint8Array;
  readonly isWriter?: () => boolean;
  readonly affectedPins?: (
    record: PersistentConnectionRecord,
  ) => Promise<{ readonly labels: readonly string[]; readonly fingerprint: string }>;
}
function builtin(def: ConnectionDefinition): PersistentConnectionRecord {
  return {
    ...def,
    credentialGeneration: 1,
    identityAssurance: 'IDENTITY_UNKNOWN',
    lifecycleState: 'ACTIVE',
    createdAt: '2026-10-17T00:00:00.000Z',
    updatedAt: '2026-10-17T00:00:00.000Z',
  };
}

/** Single Desktop authority: admission and every complete mutation share this queue. */
export class ConnectionManager {
  private readonly confirmations = new Map<
    string,
    {
      record: PersistentConnectionRecord;
      action: ConnectionPrepareArgs['action'];
      pins: string;
      expires: number;
    }
  >();
  private queue: Promise<unknown> = Promise.resolve();
  private readonly activeExecutions = new Map<string, number>();
  private readonly authenticating = new Set<string>();
  private readonly now: () => string;
  private records = new Map<string, PersistentConnectionRecord>();
  private recovering = false;
  /** Rollback control: stays off until the setting has been read. */
  private ownerConnectionsEnabled = false;
  constructor(private readonly deps: ConnectionManagerDeps) {
    this.now = deps.now ?? (() => new Date().toISOString());
  }
  private serial<T>(operation: () => Promise<T>): Promise<T> {
    const run = this.queue.then(async () => {
      await this.recover();
      return operation();
    });
    this.queue = run.catch(() => undefined);
    return run;
  }
  private async state(): Promise<ConnectionsSettings> {
    const res = await this.deps.settingsStore.getConnections();
    if (!res.valid || !validConnections(res.value)) throw rejected('connection.settings-invalid');
    this.ownerConnectionsEnabled = await this.deps.settingsStore.getOwnerConnectionsEnabled();
    this.updateView(res.value);
    return res.value;
  }
  private updateView(state: ConnectionsSettings): void {
    this.records = new Map(Object.values(BUILTIN_CONNECTIONS).map((d) => [d.id, builtin(d)]));
    for (const r of Object.values(state.connections)) this.records.set(r.id, r);
    for (const provider of API_PROVIDER_IDS) {
      const d = defaultDefinition(`${provider}.api`);
      if (d !== undefined && !this.records.has(d.id)) {
        const r = builtin(d);
        if (this.hasCredential(r)) this.records.set(r.id, r);
      }
    }
  }
  private record(id: string): PersistentConnectionRecord {
    const definition = defaultDefinition(id);
    const record = this.records.get(id) ?? (definition ? builtin(definition) : undefined);
    if (record === undefined) throw rejected('connection.unknown');
    return record;
  }
  /**
   * ADR-029 §6: rollback hides added connections and retains their state. The single plan stays,
   * since a replacement is the only plan left once the built-in id is retired.
   */
  private hidden(r: PersistentConnectionRecord): boolean {
    return !this.ownerConnectionsEnabled && !r.builtIn && planScopeName(r.id) === undefined;
  }
  private manageable(id: string): PersistentConnectionRecord {
    const r = this.record(id);
    if (this.hidden(r)) throw rejected('connection.owner-connections-off');
    return r;
  }
  private idle(id: string): void {
    if (this.getActiveExecutionCount(id) !== 0) throw rejected('connection.active');
  }
  private writer(): void {
    if (this.deps.isWriter?.() === false)
      throw new NexarError('CONFLICT', 'Connection changes require the Desktop writer lease');
  }
  private hasCredential(r: PersistentConnectionRecord): boolean {
    if (r.credentialScope.kind === 'keystore')
      return this.deps.keyStore.metadata(r.credentialScope.name).present;
    if (r.credentialScope.kind === 'account')
      return this.deps.keyStore.readBlob(r.credentialScope.name) !== undefined;
    return false;
  }
  private eligible(r: PersistentConnectionRecord): boolean {
    return (
      !this.hidden(r) &&
      canConnectionAdmit(r) &&
      !this.authenticating.has(r.id) &&
      (r.credentialScope.kind === 'native-home' ||
        r.credentialScope.kind === 'none' ||
        this.hasCredential(r))
    );
  }
  private nextId(family: string, state: ConnectionsSettings): string {
    return generateConnectionId(family, {
      existingIds: [...Object.keys(BUILTIN_CONNECTIONS), ...Object.keys(state.connections)],
      tombstonedIds: state.tombstones,
      ...(this.deps.rng === undefined ? {} : { rng: this.deps.rng }),
    });
  }
  /** Encrypted redo record contains metadata/references only, committed atomically with key changes. */
  private async recover(): Promise<void> {
    const text = this.deps.keyStore.readBlob(JOURNAL);
    if (text === undefined) {
      this.recovering = false;
      return;
    }
    this.writer();
    this.recovering = true;
    try {
      const raw: unknown = JSON.parse(Buffer.from(text, 'base64url').toString('utf8'));
      if (typeof raw !== 'object' || raw === null || Array.isArray(raw))
        throw rejected('connection.recovery-required');
      const j = raw as {
        version?: unknown;
        updates?: unknown;
        tombstones?: unknown;
        base?: unknown;
        target?: unknown;
      };
      if (
        j.version !== 1 ||
        Object.keys(raw).sort().join(',') !== 'base,target,tombstones,updates,version' ||
        typeof j.updates !== 'object' ||
        j.updates === null ||
        Array.isArray(j.updates) ||
        !Array.isArray(j.tombstones)
      )
        throw rejected('connection.recovery-required');
      const current = await this.deps.settingsStore.getConnections();
      if (!current.valid) throw rejected('connection.recovery-required');
      const target: ConnectionsSettings = {
        schemaVersion: 1,
        connections: {
          ...current.value.connections,
          ...(j.updates as Record<string, PersistentConnectionRecord>),
        },
        tombstones: j.tombstones as string[],
      };
      const currentDigest = stateDigest(current.value);
      if (
        (currentDigest !== j.base && currentDigest !== j.target) ||
        stateDigest(target) !== j.target
      )
        throw rejected('connection.recovery-required');
      await this.deps.settingsStore.saveConnections(target);
      await this.deps.keyStore.removeBlob(JOURNAL);
      this.updateView(target);
      this.recovering = false;
    } catch {
      throw rejected('connection.recovery-required');
    }
  }
  private async commit(
    state: ConnectionsSettings,
    updates: readonly PersistentConnectionRecord[],
    changes: readonly CredentialChange[] = [],
    tombstones: readonly string[] = state.tombstones,
  ): Promise<void> {
    const next = {
      ...state,
      tombstones,
      connections: { ...state.connections, ...Object.fromEntries(updates.map((r) => [r.id, r])) },
    };
    if (!validConnections(next)) throw rejected('connection.invalid-state');
    if (changes.length > 0) {
      const journal = Buffer.from(
        JSON.stringify({
          version: 1,
          base: stateDigest(state),
          target: stateDigest(next),
          updates: Object.fromEntries(updates.map((r) => [r.id, r])),
          tombstones: next.tombstones,
        }),
      ).toString('base64url');
      this.recovering = true;
      await this.deps.keyStore.batch([...changes, { kind: 'blob', name: JOURNAL, value: journal }]);
      await this.deps.settingsStore.saveConnections(next);
      await this.deps.keyStore.removeBlob(JOURNAL);
      this.recovering = false;
    } else await this.deps.settingsStore.saveConnections(next);
    this.updateView(next);
  }
  private mutate<T>(operation: (state: ConnectionsSettings) => Promise<T>): Promise<T> {
    return this.serial(async () => {
      this.writer();
      return operation(await this.state());
    }).then(async (result) => {
      await this.deps.onChange?.();
      return result;
    });
  }
  async initialize(): Promise<void> {
    await this.serial(async () => {
      await this.state();
    });
  }
  listConnections(): Promise<readonly PersistentConnectionRecord[]> {
    return this.serial(async () => {
      await this.state();
      return [...this.records.values()]
        .filter((r) => !this.hidden(r))
        .sort((a, b) => a.id.localeCompare(b.id));
    });
  }
  async getConnection(id: string): Promise<PersistentConnectionRecord | undefined> {
    await this.listConnections();
    const definition = defaultDefinition(id);
    const record = this.records.get(id) ?? (definition ? builtin(definition) : undefined);
    return record === undefined || this.hidden(record) ? undefined : record;
  }
  prepareAction(args: ConnectionPrepareArgs): Promise<ConnectionConfirmation> {
    return this.serial(async () => {
      this.writer();
      await this.state();
      const record = this.manageable(args.connectionId);
      if (
        (args.action === 'remove' && record.builtIn) ||
        (args.action === 'replace' &&
          (planScopeName(record.id) === undefined || record.lifecycleState === 'TOMBSTONED')) ||
        (args.action === 'forget' && !['keystore', 'account'].includes(record.credentialScope.kind))
      )
        throw rejected('connection.invalid-transition');
      const now = Date.parse(this.now());
      for (const [token, ticket] of this.confirmations)
        if (ticket.expires <= now) this.confirmations.delete(token);
      if (this.confirmations.size >= 64) throw rejected('connection.confirmation-limit');
      const effects = (await this.deps.affectedPins?.(record)) ?? {
        labels: [],
        fingerprint: 'none',
      };
      const affectedPins = [...effects.labels];
      const expires = now + 120000;
      const token = randomUUID();
      this.confirmations.set(token, {
        record,
        action: args.action,
        pins: effects.fingerprint,
        expires,
      });
      return {
        token,
        connectionId: record.id,
        action: args.action,
        label: record.label,
        affectedPins,
        expiresAt: new Date(expires).toISOString(),
      };
    });
  }
  private async confirm(
    record: PersistentConnectionRecord,
    action: ConnectionPrepareArgs['action'],
    args?: Partial<ConnectionConfirmedArgs>,
  ): Promise<void> {
    // Internal trusted service calls use the same authority; IPC always requires a host-issued ticket.
    if (args?.confirmation === undefined) return;
    const ticket = this.confirmations.get(args.confirmation);
    this.confirmations.delete(args.confirmation);
    if (
      ticket === undefined ||
      ticket.record.id !== record.id ||
      ticket.action !== action ||
      ticket.expires <= Date.parse(this.now()) ||
      ticket.record.credentialGeneration !== record.credentialGeneration ||
      ticket.record.lifecycleState !== record.lifecycleState ||
      ticket.record.updatedAt !== record.updatedAt ||
      ticket.pins !==
        ((await this.deps.affectedPins?.(record)) ?? { fingerprint: 'none' }).fingerprint ||
      (action === 'forget' && args.confirmationName !== record.label)
    )
      throw rejected('connection.confirmation-invalid');
  }
  getActiveExecutionCount(id: string): number {
    return this.activeExecutions.get(id) ?? 0;
  }
  acquireAuthentication(id: string): Promise<ConnectionLease> {
    return this.serial(async () => {
      this.writer();
      await this.state();
      const record = this.manageable(id);
      if (!canConnectionAdmit(record) || this.authenticating.has(id)) throw unavailable();
      this.idle(id);
      this.authenticating.add(id);
      const lease = this.lease(record);
      return {
        record,
        release: () => {
          lease.release();
          this.authenticating.delete(id);
        },
      };
    });
  }
  private lease(record: PersistentConnectionRecord): ConnectionLease {
    this.activeExecutions.set(record.id, this.getActiveExecutionCount(record.id) + 1);
    let released = false;
    return {
      record,
      release: () => {
        if (released) return;
        released = true;
        const n = this.getActiveExecutionCount(record.id) - 1;
        if (n <= 0) this.activeExecutions.delete(record.id);
        else this.activeExecutions.set(record.id, n);
      },
    };
  }
  acquireExecution(id: string): Promise<ConnectionLease> {
    return this.serial(async () => {
      this.writer();
      await this.state();
      const record = this.record(id);
      if (!this.eligible(record))
        throw unavailable(
          record.lifecycleState === 'TOMBSTONED'
            ? 'pin.connection-removed'
            : 'pin.connection-disabled',
        );
      return this.lease(record);
    });
  }
  async addApiConnection(raw: ConnectionAddArgs): Promise<PersistentConnectionRecord> {
    const args = ConnectionAddArgsSchema.parse(raw);
    return this.mutate(async (state) => {
      if (!this.ownerConnectionsEnabled) throw rejected('connection.owner-connections-off');
      const id = this.nextId(`${args.provider}.api`, state);
      const name = ownerKeyName(args.provider, id);
      if (name === undefined) throw rejected('connection.unsupported-provider');
      const at = this.now();
      const r: PersistentConnectionRecord = {
        id,
        provider: args.provider,
        method: 'api',
        authClass: 'official-api',
        support: 'official',
        machine: 'desktop',
        label: args.label,
        enabled: true,
        builtIn: false,
        credentialScope: { kind: 'keystore', name },
        credentialGeneration: 1,
        identityAssurance: 'IDENTITY_UNKNOWN',
        lifecycleState: 'ACTIVE',
        createdAt: at,
        updatedAt: at,
      };
      await this.commit(state, [r], [{ kind: 'key', name, value: args.apiKey }]);
      return r;
    });
  }
  /** Legacy first-entry clipboard flow; replacing/re-entering an established identity requires Rotate. */
  enterBuiltinApiCredential(provider: string, apiKey: string): Promise<void> {
    return this.mutate(async (state) => {
      const r = this.record(`${provider}.api`);
      this.idle(r.id);
      if (
        r.credentialScope.kind !== 'keystore' ||
        Object.hasOwn(state.connections, r.id) ||
        this.hasCredential(r)
      )
        throw rejected('connection.assertion-required');
      await this.commit(state, [r], [{ kind: 'key', name: r.credentialScope.name, value: apiKey }]);
    });
  }
  private async transition(
    raw: ConnectionIdArgs & Partial<ConnectionConfirmedArgs>,
    action: 'disable' | 'enable' | 'remove' | 'restore',
  ): Promise<PersistentConnectionRecord> {
    const { connectionId } = ConnectionIdArgsSchema.parse({ connectionId: raw.connectionId });
    return this.mutate(async (state) => {
      const r = this.manageable(connectionId);
      const expected = {
        disable: 'ACTIVE',
        enable: 'DISABLED',
        remove: 'ACTIVE',
        restore: 'TOMBSTONED',
      } as const;
      if (
        r.retirement === 'replaced' ||
        (action === 'remove'
          ? !['ACTIVE', 'DISABLED'].includes(r.lifecycleState)
          : r.lifecycleState !== expected[action])
      )
        throw rejected('connection.invalid-transition');
      if (action === 'remove') {
        await this.confirm(r, 'remove', raw);
        this.idle(r.id);
        if (r.builtIn) throw rejected('connection.builtin');
      }
      if (
        (action === 'enable' || action === 'restore') &&
        (r.credentialScope.kind === 'keystore' || r.credentialScope.kind === 'account') &&
        !this.hasCredential(r)
      )
        throw new NexarError('AUTH_REQUIRED', 'Connection credentials are required');
      const lifecycleState =
        action === 'disable' ? 'DISABLED' : action === 'remove' ? 'TOMBSTONED' : 'ACTIVE';
      const next: PersistentConnectionRecord = {
        ...r,
        lifecycleState,
        enabled: lifecycleState === 'ACTIVE',
        updatedAt: this.now(),
      };
      const tombstones =
        action === 'remove'
          ? [...new Set([...state.tombstones, r.id])]
          : action === 'restore'
            ? state.tombstones.filter((id) => id !== r.id)
            : state.tombstones;
      await this.commit(state, [next], [], tombstones);
      return next;
    });
  }
  disableConnection(raw: ConnectionIdArgs): Promise<PersistentConnectionRecord> {
    return this.transition(raw, 'disable');
  }
  enableConnection(raw: ConnectionIdArgs): Promise<PersistentConnectionRecord> {
    return this.transition(raw, 'enable');
  }
  removeConnection(
    raw: ConnectionIdArgs & Partial<ConnectionConfirmedArgs>,
  ): Promise<PersistentConnectionRecord> {
    return this.transition(raw, 'remove');
  }
  restoreConnection(raw: ConnectionIdArgs): Promise<PersistentConnectionRecord> {
    return this.transition(raw, 'restore');
  }
  async forgetCredential(
    raw: ConnectionIdArgs & Partial<ConnectionConfirmedArgs>,
  ): Promise<PersistentConnectionRecord> {
    const { connectionId } = ConnectionIdArgsSchema.parse({ connectionId: raw.connectionId });
    return this.mutate(async (state) => {
      const r = this.manageable(connectionId);
      await this.confirm(r, 'forget', raw);
      this.idle(r.id);
      const scope = r.credentialScope;
      if (r.retirement === 'replaced' || (scope.kind !== 'keystore' && scope.kind !== 'account'))
        throw rejected('connection.invalid-transition');
      const next = {
        ...r,
        credentialGeneration: r.credentialGeneration + 1,
        updatedAt: this.now(),
      };
      await this.commit(
        state,
        [next],
        [{ kind: scope.kind === 'keystore' ? 'key' : 'blob', name: scope.name }],
      );
      return next;
    });
  }
  async rotateCredential(raw: ConnectionRotateArgs): Promise<PersistentConnectionRecord> {
    const args = ConnectionRotateArgsSchema.parse(raw);
    return this.mutate(async (state) => {
      const r = this.manageable(args.connectionId);
      this.idle(r.id);
      // Re-entry into an ordinarily removed identity keeps it tombstoned until explicit Restore.
      if (
        r.retirement === 'replaced' ||
        r.identityAssurance === 'VERIFIED_DIFFERENT_ACCOUNT' ||
        r.credentialScope.kind !== 'keystore'
      )
        throw rejected('connection.identity');
      const at = this.now();
      const next: PersistentConnectionRecord = {
        ...r,
        credentialGeneration: r.credentialGeneration + 1,
        identityAssurance: 'OWNER_ASSERTED_SAME_ACCOUNT',
        assertion: { type: 'same-account', at, source: 'owner' },
        updatedAt: at,
      };
      await this.commit(
        state,
        [next],
        [{ kind: 'key', name: r.credentialScope.name, value: args.apiKey }],
      );
      return next;
    });
  }
  currentPlan(): Promise<PersistentConnectionRecord> {
    return this.serial(async () => {
      await this.state();
      const plans = [...this.records.values()].filter((r) => planScopeName(r.id) !== undefined);
      const r =
        plans.find((r) => planScopeName(r.id) !== undefined && r.lifecycleState !== 'TOMBSTONED') ??
        plans.find((r) => r.retirement !== 'replaced') ??
        plans[0];
      if (!r) throw unavailable('connection.plan-unavailable');
      return r;
    });
  }
  acquirePlanOperation(id: string, kind: 'signin' | 'refresh'): Promise<ConnectionLease> {
    return this.serial(async () => {
      this.writer();
      await this.state();
      const r = this.record(id);
      const permitted =
        kind === 'signin'
          ? r.retirement !== 'replaced'
          : canConnectionAdmit(r) ||
            (r.lifecycleState === 'DISABLED' && this.getActiveExecutionCount(id) > 0);
      if (!permitted || this.authenticating.has(id)) throw unavailable();
      if (kind === 'signin') {
        this.idle(id);
        this.authenticating.add(id);
      }
      const lease = this.lease(r);
      return {
        record: r,
        release: () => {
          lease.release();
          if (kind === 'signin') this.authenticating.delete(id);
        },
      };
    });
  }
  /** Trusted grant-expiry cleanup: retain binding, journal deletion and advance generation. */
  expirePlanCredentials(id: string): Promise<void> {
    return this.mutate(async (state) => {
      const r = this.record(id),
        name = planScopeName(id);
      if (!name || r.lifecycleState === 'TOMBSTONED' || this.getActiveExecutionCount(id) === 0)
        throw rejected('connection.plan-unavailable');
      await this.commit(
        state,
        [{ ...r, credentialGeneration: r.credentialGeneration + 1, updatedAt: this.now() }],
        [{ kind: 'blob', name }],
      );
    });
  }
  /** Only the trusted Plan service calls this after comparing its private verified subject. */
  commitPlanCredentials(id: string, tokenBlob: string, bindingBlob: string): Promise<void> {
    return this.mutate(async (state) => {
      const r = this.record(id);
      const name = planScopeName(id);
      if (!name || r.retirement === 'replaced' || this.getActiveExecutionCount(id) === 0)
        throw rejected('connection.plan-unavailable');
      const next: PersistentConnectionRecord = {
        ...r,
        identityAssurance: 'VERIFIED_SAME_ACCOUNT',
        credentialGeneration: r.credentialGeneration + 1,
        updatedAt: this.now(),
      };
      await this.commit(
        state,
        [next],
        [
          { kind: 'blob', name, value: tokenBlob },
          { kind: 'blob', name: name + ':binding', value: bindingBlob },
        ],
      );
    });
  }
  replacePlanAccount(args?: ConnectionConfirmedArgs): Promise<PersistentConnectionRecord> {
    return this.mutate(async (state) => {
      const r = [...this.records.values()].find(
        (r) => planScopeName(r.id) !== undefined && r.lifecycleState !== 'TOMBSTONED',
      );
      if (!r) throw unavailable();
      if (args !== undefined && args.connectionId !== r.id)
        throw rejected('connection.confirmation-invalid');
      await this.confirm(r, 'replace', args);
      this.idle(r.id);
      const id = this.nextId(PLAN_ID, state);
      const name = planScopeName(r.id)!;
      const at = this.now();
      const retired: PersistentConnectionRecord = {
        ...r,
        enabled: false,
        lifecycleState: 'TOMBSTONED',
        retirement: 'replaced',
        updatedAt: at,
      };
      const next: PersistentConnectionRecord = {
        ...builtin(BUILTIN_CONNECTIONS[PLAN_ID]),
        id,
        builtIn: false,
        credentialScope: { kind: 'account', name: planScopeName(id)! },
        createdAt: at,
        updatedAt: at,
      };
      await this.commit(
        state,
        [retired, next],
        [
          { kind: 'blob', name },
          { kind: 'blob', name: name + ':binding' },
        ],
        [...new Set([...state.tombstones, r.id])],
      );
      return next;
    });
  }
  isAvailable(descriptor: ResourceDescriptor): boolean {
    try {
      if (this.recovering) return false;
      const r = this.resourceRecord(descriptor);
      return r === undefined || this.eligible(r);
    } catch {
      return false;
    }
  }
  assertAvailable(descriptor: ResourceDescriptor): void {
    if (this.recovering) throw unavailable('connection.recovery-required');
    const r = this.resourceRecord(descriptor);
    if (r !== undefined && !this.eligible(r))
      throw unavailable(
        r.lifecycleState === 'TOMBSTONED' ? 'pin.connection-removed' : 'pin.connection-disabled',
      );
  }
  validateResource(descriptor: ResourceDescriptor): void {
    this.resourceRecord(descriptor, true);
  }
  private resourceRecord(
    descriptor: ResourceDescriptor,
    bound = false,
  ): PersistentConnectionRecord | undefined {
    const c = connectionOf(descriptor);
    const explicit = descriptor.metadata?.['connection'];
    if (
      explicit !== undefined &&
      (typeof explicit !== 'object' ||
        explicit === null ||
        Array.isArray(explicit) ||
        (explicit as { id?: unknown }).id !== c?.id ||
        (explicit as { provider?: unknown }).provider !== c?.provider)
    )
      throw rejected('connection.scope');
    if (!c || (descriptor.kind.type === 'model' && descriptor.kind.access === 'local'))
      return undefined;
    const r = this.record(c.id);
    if (
      c.provider !== r.provider ||
      c.method !== r.method ||
      c.authClass !== r.authClass ||
      c.support !== r.support ||
      (descriptor.kind.type === 'model' && descriptor.kind.provider !== r.provider)
    )
      throw rejected('connection.scope');
    if (r.credentialScope.kind === 'keystore') {
      if (
        descriptor.auth.mode !== 'api-key' ||
        descriptor.auth.credential.source === 'runtime-managed' ||
        descriptor.auth.credential.name !== r.credentialScope.name ||
        (!r.builtIn && descriptor.auth.credential.source !== 'keystore')
      )
        throw rejected('connection.scope');
    }
    const generation = descriptor.metadata?.['connectionGeneration'];
    if (
      (!r.builtIn || generation !== undefined) &&
      generation !== r.credentialGeneration &&
      !(
        bound &&
        r.credentialScope.kind === 'account' &&
        typeof generation === 'number' &&
        Number.isSafeInteger(generation) &&
        generation >= 1 &&
        generation <= r.credentialGeneration &&
        this.getActiveExecutionCount(r.id) > 0
      )
    )
      throw unavailable('connection.stale-generation');
    if (!r.builtIn && descriptor.metadata?.['connectionHost'] !== 'desktop')
      throw rejected('connection.host');
    if (
      !r.builtIn &&
      r.method === 'api' &&
      descriptor.kind.type === 'model' &&
      descriptor.id !== catalogResourceId(r, r.provider, descriptor.kind.model)
    )
      throw rejected('connection.resource-id');
    if (
      r.credentialScope.kind === 'account' &&
      ((descriptor.auth.mode !== 'subscription' && descriptor.auth.mode !== 'oauth') ||
        descriptor.auth.credential.source !== 'connection' ||
        descriptor.auth.credential.name !== 'chatgpt-plan')
    )
      throw rejected('connection.scope');
    return r;
  }
  acquireResource(descriptor: ResourceDescriptor): Promise<{ release(): void }> {
    return this.serial(async () => {
      this.writer();
      await this.state();
      const r = this.resourceRecord(descriptor);
      if (!r) return { release() {} };
      if (!this.eligible(r))
        throw unavailable(
          r.lifecycleState === 'TOMBSTONED' ? 'pin.connection-removed' : 'pin.connection-disabled',
        );
      return this.lease(r);
    });
  }
  toDto(r: PersistentConnectionRecord): ConnectionDto {
    let hasCredential = false;
    let assurance = r.identityAssurance;
    try {
      hasCredential = this.hasCredential(r);
    } catch {
      /* unavailable is not authenticated */
    }
    if (
      assurance === 'VERIFIED_SAME_ACCOUNT' &&
      (r.credentialScope.kind !== 'account' || !hasRetainedPlanBinding(this.deps.keyStore, r.id))
    )
      assurance = 'IDENTITY_UNKNOWN';
    return {
      id: r.id,
      provider: r.provider,
      method: r.method,
      authClass: r.authClass,
      support: r.support,
      machine: r.machine,
      label: r.label,
      enabled: r.enabled,
      builtIn: r.builtIn,
      credentialScopeKind: r.credentialScope.kind,
      credentialGeneration: r.credentialGeneration,
      identityAssurance: assurance,
      lifecycleState: r.lifecycleState,
      hasCredential,
      permanentlyRetired: r.retirement === 'replaced',
      createdAt: r.createdAt,
      updatedAt: r.updatedAt,
    };
  }
}
