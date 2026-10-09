import type { Capability } from './capabilities.js';
import type { ResourceDescriptor } from './resource.js';

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

const NATIVE: Readonly<Record<string, ResourceConnection>> = {
  'claude-code': {
    id: 'anthropic.subscription',
    provider: 'anthropic',
    method: 'subscription',
    authClass: 'vendor-native',
    support: 'official',
  },
  codex: {
    id: 'openai.subscription',
    provider: 'openai',
    method: 'subscription',
    authClass: 'vendor-native',
    support: 'official',
  },
  antigravity: {
    id: 'google.subscription',
    provider: 'google',
    method: 'subscription',
    authClass: 'vendor-native',
    support: 'experimental',
  },
  'deepseek-harness': {
    id: 'deepseek.api',
    provider: 'deepseek',
    method: 'api',
    authClass: 'official-api',
    support: 'official',
  },
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
