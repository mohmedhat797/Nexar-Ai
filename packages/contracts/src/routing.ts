import type { ResourceId, TaskId } from './ids.js';
import type { ResourceSnapshot } from './resource.js';
import type { NexarTask } from './task.js';

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
}

/** Everything a policy may look at; deliberately excludes the task payload. */
export interface RoutingInput {
  readonly task: Pick<NexarTask, 'id' | 'kind' | 'requirements'>;
  readonly candidates: readonly ResourceSnapshot[];
}

/**
 * Replaceable routing algorithm (deterministic now, scoring/learning later).
 * Contract: pure and deterministic; returns one assessment per candidate;
 * eligible ones sorted best-first, followed by the ineligible ones.
 */
export interface RoutingPolicy {
  readonly name: string;
  readonly version: string;
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
      readonly policy: { readonly name: string; readonly version: string };
      readonly decidedAt: string;
    }
  | {
      readonly outcome: 'no-eligible-resource';
      readonly taskId: TaskId;
      readonly rejected: readonly CandidateAssessment[];
      readonly policy: { readonly name: string; readonly version: string };
      readonly decidedAt: string;
    };

/** What callers depend on to pick a resource; hides the policy algorithm behind it. */
export interface ResourceRouter {
  route(task: NexarTask): Promise<RouteDecision>;
}
