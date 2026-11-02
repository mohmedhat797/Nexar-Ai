import type { Capability } from './capabilities.js';
import type { ResourceDescriptor } from './resource.js';
import type { SubscriptionRuntimeId } from './subscription.js';

/** How a provider is reached (ADR-027 §3). */
export type ConnectionMethod = 'subscription' | 'api' | 'local' | 'custom';

/** How the connection authenticates; says nothing about engine compatibility (ADR-027 §6). */
export type ConnectionAuthClass =
  'vendor-native' | 'official-api' | 'official-account' | 'experimental-client-compat' | 'none';

/** Whether the vendor documents and supports this route. */
export type ConnectionSupport = 'official' | 'experimental';

/** The value stored at `ResourceDescriptor.metadata.connection`. Holds no secret. */
export interface ResourceConnection {
  readonly id: string;
  readonly provider: string;
  readonly method: ConnectionMethod;
  readonly authClass: ConnectionAuthClass;
  readonly support: ConnectionSupport;
}

/** Safe credential scope reference: holds no secret value or key content. */
export type ConnectionCredentialScope =
  | { readonly kind: 'keystore'; readonly name: string }
  | { readonly kind: 'account'; readonly name: string }
  | {
      readonly kind: 'native-home';
      readonly runtimeId: SubscriptionRuntimeId;
      readonly home: 'default' | 'private';
    }
  | { readonly kind: 'none' };

/**
 * Additive contract representing a connection definition across hosts.
 * Extends ResourceConnection with host authority, label, and credential scope reference.
 */
export interface ConnectionDefinition extends ResourceConnection {
  readonly machine: 'desktop' | 'plane';
  readonly label: string;
  readonly enabled: boolean;
  readonly builtIn: boolean;
  readonly credentialScope: ConnectionCredentialScope;
}

/** Lifecycle states of a connection (ADR-029 §4.3 / OD-7). */
export type ConnectionLifecycleState = 'ACTIVE' | 'DISABLED' | 'TOMBSTONED';

/** Identity assurance levels for credential binding (ADR-029 §4.3 / OD-8). */
export type ConnectionIdentityAssurance =
  | 'VERIFIED_SAME_ACCOUNT'
  | 'OWNER_ASSERTED_SAME_ACCOUNT'
  | 'VERIFIED_DIFFERENT_ACCOUNT'
  | 'IDENTITY_UNKNOWN';

/** Full persistent connection record stored in settings. */
export interface PersistentConnectionRecord extends ConnectionDefinition {
  readonly credentialGeneration: number;
  readonly identityAssurance: ConnectionIdentityAssurance;
  readonly lifecycleState: ConnectionLifecycleState;
  readonly createdAt: string;
  readonly updatedAt: string;
  /** Evidence of an explicit owner continuity action; never a credential or account subject. */
  readonly assertion?:
    { readonly type: 'same-account'; readonly at: string; readonly source: 'owner' } | undefined;
  /** Replacement retirement is permanent; ordinary owner removal remains reversible. */
  readonly retirement?: 'replaced' | undefined;
  /** A private native home Nexar created for this connection. Never a path or account subject. */
  readonly nativeHome?:
    | {
        readonly marker: string;
        /** Present while the home holds a sign-in made through Nexar. */
        readonly signedInAt?: string | undefined;
        /** Once signed in, this identity keeps its account: signing in again needs an assertion. */
        readonly associated?: true | undefined;
      }
    | undefined;
}

/** Settings schema container for connections and tombstones. */
export interface ConnectionsSettings {
  readonly schemaVersion: 1;
  readonly connections: Readonly<Record<string, PersistentConnectionRecord>>;
  readonly tombstones: readonly string[];
}

/** Pure helper checking if connection can admit new execution units. */
export function canConnectionAdmit(record: PersistentConnectionRecord): boolean {
  return record.lifecycleState === 'ACTIVE' && record.enabled;
}

/** Pure helper checking if an ID has been permanently tombstoned. */
export function isConnectionTombstoned(id: string, tombstones: readonly string[]): boolean {
  return tombstones.includes(id);
}

/** Supported host literals for connection isolation and attribution. */
export type ConnectionHost = 'desktop' | 'plane';

/**
 * Pure connection key function combining host and connectionId.
 * Host literals 'desktop' and 'plane' are preserved. Never throws on valid inputs.
 */
export function connectionKey(machine: ConnectionHost, connectionId: string): string {
  if (machine !== 'desktop' && machine !== 'plane') {
    throw new Error(`Invalid connection host: ${String(machine)}`);
  }
  if (!connectionId || typeof connectionId !== 'string' || connectionId.trim() !== connectionId) {
    throw new Error('Invalid connectionId');
  }
  return `${machine}:${connectionId}`;
}

export type BuiltinConnectionId =
  | 'anthropic.subscription'
  | 'openai.subscription'
  | 'google.subscription'
  | 'deepseek.api'
  | 'openai.chatgpt-plan';

/** Built-in connection definitions reproducing accepted baselines exactly. Golden-tested. */
export const BUILTIN_CONNECTIONS: Readonly<Record<BuiltinConnectionId, ConnectionDefinition>> =
  Object.freeze({
    'anthropic.subscription': Object.freeze({
      id: 'anthropic.subscription',
      provider: 'anthropic',
      method: 'subscription',
      authClass: 'vendor-native',
      support: 'official',
      machine: 'desktop',
      label: 'Claude Code (subscription)',
      enabled: true,
      builtIn: true,
      credentialScope: Object.freeze({
        kind: 'native-home',
        runtimeId: 'claude-code',
        home: 'default',
      }),
    }),
    'openai.subscription': Object.freeze({
      id: 'openai.subscription',
      provider: 'openai',
      method: 'subscription',
      authClass: 'vendor-native',
      support: 'official',
      machine: 'desktop',
      label: 'Codex (subscription)',
      enabled: true,
      builtIn: true,
      credentialScope: Object.freeze({
        kind: 'native-home',
        runtimeId: 'codex',
        home: 'default',
      }),
    }),
    'google.subscription': Object.freeze({
      id: 'google.subscription',
      provider: 'google',
      method: 'subscription',
      authClass: 'vendor-native',
      support: 'experimental',
      machine: 'desktop',
      label: 'Antigravity (subscription)',
      enabled: true,
      builtIn: true,
      credentialScope: Object.freeze({
        kind: 'native-home',
        runtimeId: 'antigravity',
        home: 'default',
      }),
    }),
    'deepseek.api': Object.freeze({
      id: 'deepseek.api',
      provider: 'deepseek',
      method: 'api',
      authClass: 'official-api',
      support: 'official',
      machine: 'desktop',
      label: 'DeepSeek (API)',
      enabled: true,
      builtIn: true,
      credentialScope: Object.freeze({
        kind: 'keystore',
        name: 'DEEPSEEK_API_KEY',
      }),
    }),
    'openai.chatgpt-plan': Object.freeze({
      id: 'openai.chatgpt-plan',
      provider: 'openai',
      method: 'subscription',
      authClass: 'official-account',
      support: 'official',
      machine: 'desktop',
      label: 'ChatGPT Plan',
      enabled: true,
      builtIn: true,
      credentialScope: Object.freeze({
        kind: 'account',
        name: 'chatgpt-plan',
      }),
    }),
  });

const OWNER_CODEX_ID = /^openai\.subscription\.c[a-z2-7]{10}$/;

/** An owner-created Codex connection, which has its own private home (ADR-029 §4.4). */
export function isOwnerCodexConnectionId(id: string): boolean {
  return OWNER_CODEX_ID.test(id);
}

/** The one resource an owner Codex connection publishes; a pin to it cannot reach another account. */
export function ownerCodexResourceId(connectionId: string): string {
  return `codex:${connectionId}`;
}

const BASE32_ALPHABET = 'abcdefghijklmnopqrstuvwxyz234567';
const FAMILY_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/;

export interface GenerateConnectionIdOptions {
  /** Optional deterministic RNG returning Uint8Array of requested byte length; defaults to crypto.getRandomValues. */
  readonly rng?: (byteCount: number) => Uint8Array;
  /** Existing active connection IDs to detect collisions against. */
  readonly existingIds?: Iterable<string>;
  /** Tombstoned connection IDs to prevent reuse. */
  readonly tombstonedIds?: Iterable<string>;
  /** Optional predicate to check if an ID is already taken. */
  readonly isTaken?: (id: string) => boolean;
  /** Maximum generation attempts before throwing; defaults to 10. */
  readonly maxAttempts?: number;
}

/** Pure generator for owner-created connection IDs: <family>.c<10 base32>. */
export function generateConnectionId(
  family: string,
  options: GenerateConnectionIdOptions = {},
): string {
  if (typeof family !== 'string' || !FAMILY_PATTERN.test(family)) {
    throw new Error(`Invalid connection family: ${String(family)}`);
  }
  const maxAttempts = options.maxAttempts ?? 10;
  if (maxAttempts < 1) {
    throw new Error('maxAttempts must be at least 1');
  }
  const existingSet = new Set(options.existingIds);
  const tombstonedSet = new Set(options.tombstonedIds);

  const rng = options.rng ?? ((n: number) => globalThis.crypto.getRandomValues(new Uint8Array(n)));

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const bytes = rng(10);
    if (bytes.length < 10) {
      throw new Error('RNG provided fewer than 10 bytes');
    }
    let suffix = '';
    for (let i = 0; i < 10; i++) {
      suffix += BASE32_ALPHABET[bytes[i]! & 0x1f];
    }
    const candidate = `${family}.c${suffix}`;

    if (Object.hasOwn(BUILTIN_CONNECTIONS, candidate)) continue;
    if (existingSet.has(candidate)) continue;
    if (tombstonedSet.has(candidate)) continue;
    if (options.isTaken?.(candidate)) continue;

    return candidate;
  }

  throw new Error(
    `Failed to generate unique connection ID for family '${family}' after ${maxAttempts} attempts (collision exhaustion)`,
  );
}

/** A provider connection as the owner sees it. No secrets, and no field that could hold one. */
export interface ProviderConnection extends ResourceConnection {
  readonly machine: 'desktop' | 'plane';
  readonly enabled: boolean;
  readonly status: 'connected' | 'not-connected' | 'unknown' | 'unsupported';
}

const METHODS: readonly string[] = ['subscription', 'api', 'local', 'custom'];
const AUTH_CLASSES: readonly string[] = [
  'vendor-native',
  'official-api',
  'official-account',
  'experimental-client-compat',
  'none',
];
const SUPPORTS: readonly string[] = ['official', 'experimental'];
const MAX_FIELD_LENGTH = 200;

function isShortString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= MAX_FIELD_LENGTH;
}

function wellFormed(value: unknown): ResourceConnection | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  const v = value as Record<string, unknown>;
  if (
    !isShortString(v.id) ||
    !isShortString(v.provider) ||
    typeof v.method !== 'string' ||
    !METHODS.includes(v.method) ||
    typeof v.authClass !== 'string' ||
    !AUTH_CLASSES.includes(v.authClass) ||
    typeof v.support !== 'string' ||
    !SUPPORTS.includes(v.support)
  ) {
    return undefined;
  }
  // Copy the known fields only: nothing else on the stored value is propagated.
  return {
    id: v.id,
    provider: v.provider,
    method: v.method as ConnectionMethod,
    authClass: v.authClass as ConnectionAuthClass,
    support: v.support as ConnectionSupport,
  };
}

function toResourceConnection(def: ResourceConnection): ResourceConnection {
  return {
    id: def.id,
    provider: def.provider,
    method: def.method,
    authClass: def.authClass,
    support: def.support,
  };
}

const NATIVE: Readonly<Record<string, ResourceConnection>> = {
  'claude-code': toResourceConnection(BUILTIN_CONNECTIONS['anthropic.subscription']),
  codex: toResourceConnection(BUILTIN_CONNECTIONS['openai.subscription']),
  antigravity: toResourceConnection(BUILTIN_CONNECTIONS['google.subscription']),
  'deepseek-harness': toResourceConnection(BUILTIN_CONNECTIONS['deepseek.api']),
};

/**
 * The connection a resource came from: `metadata.connection` when well-formed (malformed values
 * are ignored), otherwise a deterministic inference for configured resources. Never throws.
 */
export function connectionOf(descriptor: ResourceDescriptor): ResourceConnection | undefined {
  const explicit = wellFormed(descriptor.metadata?.connection);
  if (explicit !== undefined) return explicit;
  const kind = descriptor.kind;
  if (kind.type === 'agent') {
    return Object.hasOwn(NATIVE, kind.agent) ? NATIVE[kind.agent] : undefined;
  }
  if (kind.type !== 'model') return undefined;
  if (kind.access === 'api') {
    return {
      id: `${kind.provider}.api`,
      provider: kind.provider,
      method: 'api',
      authClass: 'official-api',
      support: 'official',
    };
  }
  if (kind.access === 'local') {
    return {
      id: `local.${kind.provider}`,
      provider: 'local',
      method: 'local',
      authClass: descriptor.auth.mode === 'none' ? 'none' : 'official-api',
      support: 'official',
    };
  }
  // A subscription model has no verified adapter yet.
  return undefined;
}

/** Orchestration engines that run their own model loop through the Engine Gateway. */
export type ControlEngine = 'dsh';

/** Capabilities a resource needs to drive an engine's control loop (ADR-027 §6). */
export const ENGINE_CONTROL_REQUIREMENTS: Readonly<Record<ControlEngine, readonly Capability[]>> = {
  dsh: ['model-turn'],
};

/** Capability check only: compatibility is never inferred from auth or connection method. */
export function isControlCompatible(
  descriptor: ResourceDescriptor,
  engine: ControlEngine,
): boolean {
  return ENGINE_CONTROL_REQUIREMENTS[engine].every((c) => descriptor.capabilities.includes(c));
}
