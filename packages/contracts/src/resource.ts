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
 * A *reference* to where the runtime finds its credential (an env var name, a Nexar
 * key store entry name, or a human description of a runtime-managed login). It must
 * NEVER contain a secret value; the shape intentionally has no field that could hold one.
 */
export type CredentialRef =
  | { readonly source: 'env'; readonly name: string }
  | { readonly source: 'keystore'; readonly name: string }
  /** A host-managed account connection (ADR-022 amendment 2026-10-05); only {@link CONNECTION_CREDENTIAL_NAMES}. */
  | { readonly source: 'connection'; readonly name: ConnectionCredentialName }
  | { readonly source: 'runtime-managed'; readonly description: string };

/** The only connection a `connection` credential may name: the owner's ChatGPT plan. */
export const CONNECTION_CREDENTIAL_NAMES = ['chatgpt-plan'] as const;

/** One of {@link CONNECTION_CREDENTIAL_NAMES}. */
export type ConnectionCredentialName = (typeof CONNECTION_CREDENTIAL_NAMES)[number];

/** True for the credential reference of the ChatGPT plan connection (strict: source and name). */
export function isChatGptPlanCredential(
  credential: CredentialRef,
): credential is { readonly source: 'connection'; readonly name: 'chatgpt-plan' } {
  return credential.source === 'connection' && credential.name === 'chatgpt-plan';
}

/**
 * Resolves a `connection` credential to a short-lived access token (`undefined` = not connected).
 * Injected by the host (Desktop main only); `refresh` forces a new token after a 401. Callers must
 * never store or log the result.
 */
export type ConnectionCredentialResolver = (
  descriptor: ResourceDescriptor,
  signal: AbortSignal,
  options?: { readonly refresh?: boolean },
) => Promise<string | undefined>;

/** Valid names for `env` and `keystore` credential references (also the child variable name). */
export const CREDENTIAL_NAME_PATTERN = /^[A-Z][A-Z0-9_]*$/;

/** Maximum length of a credential name. */
export const CREDENTIAL_NAME_MAX_LENGTH = 128;

/**
 * Resolves a `keystore` credential name to its secret value (`undefined` = not stored). Injected by
 * the host; integrations never touch the key store directly. Callers must never log the result.
 */
export type SecretResolver = (name: string) => string | undefined;

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
