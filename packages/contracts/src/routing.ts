import type { ResourceId, TaskId } from './ids.js';
import type {
  CostEstimate,
  QuotaAssessment,
  RoutingFacts,
  RoutingHistory,
  ScoreFactor,
} from './intelligence.js';
import type { ResourceSnapshot } from './resource.js';
import type { NexarTask } from './task.js';
import type { UnitStrategy, WorkUnit } from './strategy.js';

/** One machine-readable, human-explainable factor behind a routing outcome. */
export interface RouteReason {
  /** Dotted code, e.g. 'capability.missing'. */
  readonly code: string;
  readonly message: string;
  readonly effect: 'supports' | 'rejects' | 'neutral';
}

/** A policy's verdict on a single candidate, with the reasons that justify it. */
export interface CandidateAssessment {
  readonly resourceId: ResourceId;
  readonly eligible: boolean;
  readonly score: number;
  readonly reasons: readonly RouteReason[];
  /** Owner-preference tier used before the score (ADR-020 §6); higher wins. */
  readonly tier?: number;
  readonly quota?: QuotaAssessment;
  readonly cost?: CostEstimate;
  /** Per-factor breakdown; `score` is the sum of contributions. */
  readonly factors?: readonly ScoreFactor[];
}

/** Everything a policy may look at; deliberately excludes the task payload. */
export interface RoutingInput {
  readonly task: Pick<NexarTask, 'id' | 'kind' | 'requirements'>;
  readonly candidates: readonly ResourceSnapshot[];
  /** Controller-computed facts (size, lane role, clock); never the prompt. */
  readonly facts?: RoutingFacts;
  /** Aggregates read outside the policy; the policy never opens files. */
  readonly history?: RoutingHistory;
}

/** Identifies the policy that produced a decision, for reproducibility. */
export interface PolicyStamp {
  readonly name: string;
  readonly version: string;
  /** Short hash of the canonical routing configuration. */
  readonly configId?: string;
  /** Set when the controller fell back to another policy (never silent). */
  readonly fallback?: { readonly from: string; readonly reason: string };
}

/**
 * Replaceable routing algorithm (deterministic now, scoring/learning later).
 * Contract: pure and deterministic; returns one assessment per candidate;
 * eligible ones sorted best-first, followed by the ineligible ones.
 */
export interface RoutingPolicy {
  readonly name: string;
  readonly version: string;
  /** Short hash of the policy's configuration, if it has one. */
  readonly configId?: string;
  evaluate(input: RoutingInput): readonly CandidateAssessment[];
}

/** The explainable outcome of routing a task: a selection or a justified refusal. */
export type RouteDecision =
  | {
      readonly outcome: 'selected';
      readonly taskId: TaskId;
      readonly selected: CandidateAssessment;
      readonly alternatives: readonly CandidateAssessment[];
      readonly rejected: readonly CandidateAssessment[];
      readonly policy: PolicyStamp;
      readonly decidedAt: string;
    }
  | {
      readonly outcome: 'no-eligible-resource';
      /** Plan-level failure reasons, including required diversity with no allocatable candidate. */
      readonly reasons?: readonly RouteReason[];
      readonly taskId: TaskId;
      readonly rejected: readonly CandidateAssessment[];
      readonly policy: PolicyStamp;
      readonly decidedAt: string;
    };

/** What callers depend on to pick a resource; hides the policy algorithm behind it. */
export interface ResourceRouter {
  route(task: NexarTask): Promise<RouteDecision>;
  /** Optional trusted plan revalidation; absence fails closed for opt-in planned execution. */
  revalidate?(planned: UnitStrategy, unit: WorkUnit): Promise<RouteDecision>;
}
