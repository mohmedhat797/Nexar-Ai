import type { Capability } from './capabilities.js';
import type { AdapterId, ResourceId } from './ids.js';
import type { QuotaObservation } from './intelligence.js';

/**
 * What kind of AI Resource this is. A discriminated union (not an enum) so each
 * kind carries its own shape and new kinds can be added without touching callers.
 */
export type ResourceKind =
  | {
      readonly type: 'model';
      readonly provider: string;
      readonly model: string;
      readonly access: 'api' | 'subscription' | 'local';
    }
  | {
      readonly type: 'agent';
      /** e.g. 'claude-code', 'codex', 'antigravity', 'deepseek-harness', 'pi'. */
      readonly agent: string;
      readonly interface: 'cli' | 'sdk' | 'rpc' | 'acp' | 'mcp';
      readonly underlying?: { readonly provider?: string; readonly model?: string };
    }
  | {
      readonly type: 'tool-runtime';
      readonly tool: string;
      readonly interface: 'cli' | 'sdk' | 'rpc' | 'mcp' | 'http';
    };

/** The discriminant values of {@link ResourceKind}. */
export type ResourceKindType = ResourceKind['type'];

/** Names which execution adapter runs a resource and where, decoupling description from execution. */
export interface RuntimeBinding {
  readonly adapter: AdapterId;
  readonly locality: 'local' | 'remote';
  readonly options?: Readonly<Record<string, unknown>>;
}

/**
 * A *reference* to where the runtime finds its credential (an env var name or a
 * human description of a runtime-managed login). It must NEVER contain a secret
 * value; the shape intentionally has no field that could hold one.
 */
export type CredentialRef =
  | { readonly source: 'env'; readonly name: string }
  | { readonly source: 'runtime-managed'; readonly description: string };

/** How a resource authenticates, so routing can reason about auth without seeing secrets. */
export type AuthRequirement =
  | { readonly mode: 'none' }
  | { readonly mode: 'api-key'; readonly credential: CredentialRef }
  | { readonly mode: 'oauth' | 'subscription'; readonly credential: CredentialRef };

/** How using a resource is billed, enabling cost-aware routing across very different pricing models. */
export type CostProfile =
  | {
      readonly model: 'per-token';
      readonly currency: 'USD';
      readonly inputPerMillionTokens: number;
      readonly outputPerMillionTokens: number;
    }
  | { readonly model: 'subscription'; readonly plan?: string }
  | { readonly model: 'local-compute' }
  | { readonly model: 'free' }
  | { readonly model: 'unknown' };

/** Hard size limits of a resource, used to filter by task requirements. */
export interface ResourceLimits {
  readonly contextWindowTokens?: number;
  readonly maxOutputTokens?: number;
}

/** Static, configuration-time description of an AI Resource; never changes at runtime. */
export interface ResourceDescriptor {
  readonly id: ResourceId;
  readonly displayName: string;
  readonly kind: ResourceKind;
  readonly capabilities: readonly Capability[];
  readonly runtime: RuntimeBinding;
  readonly auth: AuthRequirement;
  readonly cost: CostProfile;
  readonly limits?: ResourceLimits;
  readonly dataLocality: 'local' | 'third-party';
  readonly tags?: readonly string[];
  readonly metadata?: Readonly<Record<string, unknown>>;
  /** Where the descriptor came from: `configured` or `discovered:<source>` (ADR-020 §9). */
  readonly provenance?: string;
}

/** Whether a resource can currently take work. */
export type Availability = 'available' | 'degraded' | 'unavailable' | 'unknown';

/** Whether the resource's credentials are currently usable. */
export type AuthState = 'authenticated' | 'unauthenticated' | 'not-required' | 'unknown';

/** Remaining allowance of a resource, in whatever unit the provider reports. */
export interface QuotaState {
  readonly unit: 'requests' | 'tokens' | 'usd' | 'percent';
  readonly remaining?: number;
  readonly limit?: number;
  readonly resetsAt?: string;
}

/** Dynamic, observed condition of a resource; kept apart from the descriptor because it changes constantly. */
export interface ResourceState {
  readonly availability: Availability;
  readonly auth: AuthState;
  /** @deprecated v0.1 single-figure quota; v0.4 uses `quotas`. */
  readonly quota?: QuotaState;
  /** Quota observations with provenance (ADR-020 §4). Absent means unknown. */
  readonly quotas?: readonly QuotaObservation[];
  readonly detail?: string;
  readonly observedAt: string;
}

/** Descriptor plus current state: the unit of input that routing consumes. */
export interface ResourceSnapshot {
  readonly descriptor: ResourceDescriptor;
  readonly state: ResourceState;
}

/** Builds the state to use before anything has been probed. */
export function unknownResourceState(observedAt: string): ResourceState {
  return { availability: 'unknown', auth: 'unknown', observedAt };
}
