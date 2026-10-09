import type { Capability } from './capabilities.js';
import type { AuthState, Availability, ResourceLimits } from './resource.js';

/** Provider-default delegates to a native runtime; it is never a model slug or NRC Auto. */
export type ProviderModelSelection =
  { readonly kind: 'model'; readonly id: string } | { readonly kind: 'provider-default' };

/** Public, immutable route identity. No account identifiers, tokens or credential-derived hashes. */
export interface ProviderRuntimeIdentity {
  readonly provider: string;
  readonly connectionId: string;
  readonly runtimeId: string;
  readonly routeId: string;
  readonly machine: 'desktop' | 'plane';
}

export const PROVIDER_MODEL_SOURCES = [
  'live-runtime',
  'official-api',
  'static-verified',
  'provider-default',
] as const;
export type ProviderModelSource = (typeof PROVIDER_MODEL_SOURCES)[number];

export const PROVIDER_MODEL_INVENTORY_MAX_ENTRIES = 256;

/** Only verified public facts. An absent limit/capability is unknown, not a fabricated default. */
export interface ProviderModelEntry {
  readonly selection: ProviderModelSelection;
  readonly displayName: string;
  readonly availability: Availability;
  readonly compatibility: 'native-agent' | 'model-turn';
  readonly source?: ProviderModelSource;
  readonly capabilities?: readonly Capability[];
  readonly limits?: ResourceLimits;
  readonly reasoningModes?: readonly string[];
}

/** Fixed reasons only: exception messages and provider response bodies must never cross this port. */
export const PROVIDER_INVENTORY_FAILURE_REASONS = [
  'refresh-failed',
  'timeout',
  'cancelled',
  'invalid-response',
  'auth-rejected',
  'model-rejected',
  'not-connected',
  'runtime-unavailable',
  'unsupported',
  'expired',
  'restored',
  'invalidated',
] as const;
export type ProviderInventoryFailureReason = (typeof PROVIDER_INVENTORY_FAILURE_REASONS)[number];
export type ProviderModelInventoryReason = ProviderInventoryFailureReason;

export interface ProviderModelInventory {
  readonly identity: ProviderRuntimeIdentity;
  readonly generation: number;
  readonly status: 'fresh' | 'stale' | 'unavailable' | 'unsupported';
  readonly source: ProviderModelSource;
  /** Metadata authentication observation does not imply credit or generation rights. */
  readonly auth: AuthState;
  /** Time of the last successful observation in this generation, retained on refresh failure. */
  readonly observedAt?: string;
  readonly attemptedAt?: string;
  readonly reason?: ProviderModelInventoryReason;
  readonly runtimeVersion?: string;
  readonly entries: readonly ProviderModelEntry[];
  /** An observed selection that is also present in entries; not the owner's desired selection. */
  readonly current?: ProviderModelSelection;
}

export type InventorySourceResult =
  | {
      readonly status: 'success';
      readonly source: ProviderModelSource;
      readonly auth: AuthState;
      readonly entries: readonly ProviderModelEntry[];
      readonly current?: ProviderModelSelection;
      readonly runtimeVersion?: string;
    }
  | {
      readonly status: 'unavailable' | 'unsupported';
      readonly source: ProviderModelSource;
      readonly auth: AuthState;
      readonly reason: ProviderModelInventoryReason;
    };

/** Integration-owned and already bound to one route; never accepts renderer commands or secrets. */
export interface InventorySource {
  fetch(signal: AbortSignal): Promise<InventorySourceResult>;
}
