import type { LaneRole, QuotaWindow, ResourceId } from '@nexar/contracts';

/** Weights of the `resource-intelligence` scoring factors (ADR-020 §6). Non-negative. */
export interface ScoreWeights {
  readonly default: number;
  readonly availability: number;
  readonly auth: number;
  readonly quota: number;
  readonly cost: number;
  readonly latency: number;
  readonly success: number;
  readonly lane: number;
}

/** Keeps a share of a resource's allowance for the listed kinds of work (ADR-020 §4). */
export interface ReservationRule {
  readonly resourceId: ResourceId;
  /** In (0, 1): headroom at or below this fraction is protected. */
  readonly reserveFraction: number;
  readonly reservedFor: {
    readonly taskKinds?: readonly string[];
    readonly laneRoles?: readonly LaneRole[];
  };
}

/** An owner-declared allowance; consumption is accounted by Nexar (ADR-020 §4). */
export interface AllowanceRule {
  readonly resourceId: ResourceId;
  readonly unit: 'requests' | 'tokens' | 'usd';
  readonly limit: number;
  readonly window: QuotaWindow;
  /** Short label shown in explanations (no account identifiers). */
  readonly label?: string;
}

/** Fully resolved Resource Intelligence settings (defaults applied). */
export interface ResourceIntelligenceSettings {
  readonly weights: ScoreWeights;
  /** `authoritative`: explicit owner preferences rank before any score. */
  readonly preferences: 'authoritative' | 'weighted';
  readonly history: { readonly windowDays: number; readonly minSamples: number };
  readonly quota: {
    /** Factor value used when quota is unknown or stale. */
    readonly unknownScore: number;
    /** Age after which a vendor-reported observation is stale. */
    readonly staleAfterMs: number;
    /** Hold applied to an exhausted signal that reports no reset time. */
    readonly exhaustedHoldMs: number;
  };
  readonly cost: {
    readonly defaultOutputTokens: number;
    /** Policy for `maxCostUsd` when the cost cannot be estimated. */
    readonly unknownUnderLimit: 'reject' | 'allow';
    /** Cash amount at which the cost factor is 0.5. */
    readonly costScaleUsd: number;
    /** Cost factor value for subscription-backed resources. */
    readonly subscriptionScore: number;
  };
  /** Latency at which the latency factor is 0.5. */
  readonly latencyScaleMs: number;
  readonly reservations: readonly ReservationRule[];
  readonly allowances: readonly AllowanceRule[];
}

/** Documented defaults (ADR-020). Changing them changes the config id. */
export const DEFAULT_RESOURCE_INTELLIGENCE_SETTINGS: ResourceIntelligenceSettings = {
  weights: {
    default: 0.1,
    availability: 0.1,
    auth: 0.05,
    quota: 0.2,
    cost: 0.15,
    latency: 0.1,
    success: 0.2,
    lane: 0.2,
  },
  preferences: 'authoritative',
  history: { windowDays: 30, minSamples: 5 },
  quota: { unknownScore: 0.5, staleAfterMs: 15 * 60 * 1000, exhaustedHoldMs: 60 * 60 * 1000 },
  cost: {
    defaultOutputTokens: 4096,
    unknownUnderLimit: 'reject',
    costScaleUsd: 0.1,
    subscriptionScore: 0.9,
  },
  latencyScaleMs: 60_000,
  reservations: [],
  allowances: [],
};
