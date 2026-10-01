/**
 * Resource Intelligence types (ADR-020): quota observations, cost estimates, task size facts,
 * routing history and score breakdowns. All are metadata; none may carry prompt text, code,
 * documents, credentials or account identifiers.
 */
import type { Measured } from './measured.js';

// ---------------------------------------------------------------------------------------------
// Quota (NXR-030)
// ---------------------------------------------------------------------------------------------

/** Where a quota figure came from. Anything not listed here is not a legitimate source. */
export type QuotaLimitSource = 'vendor-probe' | 'vendor-reported' | 'owner-declared';
export type QuotaUsageSource = 'vendor-probe' | 'vendor-reported' | 'nexar-accounting';

/** A reset window. `hours` covers rolling or custom windows declared by the owner. */
export type QuotaWindow = 'daily' | 'weekly' | 'monthly' | { readonly hours: number };

/** One allowance observation for a resource. A resource may have several (e.g. 5 h and weekly). */
export interface QuotaObservation {
  readonly unit: 'requests' | 'tokens' | 'usd' | 'percent';
  readonly limit?: number;
  readonly used?: number;
  readonly remaining?: number;
  readonly window?: QuotaWindow;
  /** ISO-8601; when the current window resets, if known. */
  readonly resetsAt?: string;
  /** ISO-8601; when this observation was made or computed. */
  readonly observedAt: string;
  readonly provenance: {
    readonly limit?: QuotaLimitSource;
    readonly usage?: QuotaUsageSource;
  };
  /** Runs in the window whose usage was not measured; never counted as zero consumption. */
  readonly unaccountedRuns?: number;
  /** Optional label, e.g. "5h window" (no account identifiers). */
  readonly label?: string;
}

/** Freshness of a quota observation, computed by the policy from an injected clock. */
export type QuotaFreshness = 'known-current' | 'known-stale' | 'unknown' | 'exhausted';

/** The policy's view of a candidate's quota, attached to its assessment for explanations. */
export interface QuotaAssessment {
  readonly freshness: QuotaFreshness;
  /** Remaining fraction in [0, 1] when known (the minimum across observations). */
  readonly headroom?: number;
  readonly sources: readonly string[];
  readonly resetsAt?: string;
  readonly unaccountedRuns?: number;
  /** Set when a reservation applies to this candidate. */
  readonly reservation?: {
    readonly reserveFraction: number;
    readonly protected: boolean;
    readonly verifiable: boolean;
  };
}

// ---------------------------------------------------------------------------------------------
// Cost (NXR-031)
// ---------------------------------------------------------------------------------------------

/**
 * What kind of spend a candidate implies. `subscription-allowance` has zero marginal cash cost but
 * consumes allowance; `unknown` cannot be estimated (never a fabricated zero).
 */
export type CostClass = 'cash' | 'subscription-allowance' | 'local-compute' | 'free' | 'unknown';

/** A pre-execution cost estimate for one candidate. */
export interface CostEstimate {
  readonly class: CostClass;
  /** `estimated` with a basis, or `unavailable` for `unknown`. */
  readonly cashUsd: Measured<number>;
  readonly inputTokens: number;
  readonly outputTokens: number;
  /** e.g. `estimator@1`. */
  readonly estimator: string;
}

/** Estimate vs actual, recorded on the execution record for observability (no learning). */
export interface CostEstimateRecord {
  readonly estimator: string;
  readonly class: CostClass;
  readonly estimatedUsd: Measured<number>;
  readonly actualUsd: Measured<number>;
  /** |estimate − actual| when both are known numbers. */
  readonly absoluteErrorUsd?: number;
  /** absoluteError / actual when actual > 0. */
  readonly relativeError?: number;
}

// ---------------------------------------------------------------------------------------------
// Task facts (computed by the controller; the policy never sees the prompt)
// ---------------------------------------------------------------------------------------------

/** Size metadata of a task, derived from its input before routing. */
export interface TaskSizeEstimate {
  readonly estimatedInputTokens: number;
  readonly attachmentCount: number;
  readonly documentCount: number;
  readonly requestedMaxOutputTokens?: number;
  /** e.g. `chars/4@1`. */
  readonly basis: string;
}

/** Engineering lane roles that routing may receive (ADR-019). */
export type LaneRole = 'architecture' | 'feature' | 'tests' | 'debugging' | 'review';

/** Facts the controller computes for the policy. */
export interface RoutingFacts {
  /** ISO-8601; the injected clock's value for this decision. */
  readonly now: string;
  readonly size?: TaskSizeEstimate;
  readonly laneRole?: LaneRole;
}

// ---------------------------------------------------------------------------------------------
// History (NXR-032, NXR-034)
// ---------------------------------------------------------------------------------------------

/** Execution aggregates for one (resource, task kind) inside the history window. */
export interface ExecutionAggregate {
  /** Executions counted (caller/policy outcomes excluded). */
  readonly samples: number;
  readonly successes: number;
  readonly resourceFaults: number;
  readonly timeouts: number;
  readonly p50LatencyMs?: number;
  readonly p95LatencyMs?: number;
  /** Mean of measured or estimated cash cost; absent when no run reported one. */
  readonly meanCostUsd?: number;
  readonly costSamples: number;
}

/** Engineering aggregates for one (resource, lane role). */
export interface LaneAggregate {
  /** Lane executions counted. */
  readonly samples: number;
  /** Implementer roles: tasks whose first-round gates all passed / tasks with gate results. */
  readonly firstRoundGatePasses?: number;
  readonly gateSamples?: number;
  /** Implementer roles: total rework rounds over the tasks counted. */
  readonly reworkRounds?: number;
  readonly tasks?: number;
  /** Implementer roles: approve verdicts received / verdicts received on its work. */
  readonly reviewApprovals?: number;
  readonly reviewVerdicts?: number;
  /** Implementer roles: owner approvals / decided owner approvals. */
  readonly ownerApprovals?: number;
  readonly ownerDecisions?: number;
  /** Review role: valid (parseable, consistent) verdicts / verdicts produced. */
  readonly validVerdicts?: number;
  readonly producedVerdicts?: number;
  readonly p50LatencyMs?: number;
}

/** History handed to the policy as data. Keys are resource ids, then task kinds / lane roles. */
export interface RoutingHistory {
  /** ISO-8601 window bounds. */
  readonly windowStart: string;
  readonly windowEnd: string;
  readonly executions: Readonly<Record<string, Readonly<Record<string, ExecutionAggregate>>>>;
  readonly lanes: Readonly<Record<string, Readonly<Partial<Record<LaneRole, LaneAggregate>>>>>;
  /** Lines/records skipped as malformed or out of bounds (observability). */
  readonly skipped: number;
}

// ---------------------------------------------------------------------------------------------
// Explanations
// ---------------------------------------------------------------------------------------------

/** One scoring factor's contribution: `contribution = value × weight`. */
export interface ScoreFactor {
  readonly name: string;
  /** In [0, 1]. */
  readonly value: number;
  readonly weight: number;
  readonly contribution: number;
  /** True when the value is the neutral default (cold start / unknown). */
  readonly neutral?: boolean;
  /** Short safe detail (numbers and codes only). */
  readonly detail?: string;
}
