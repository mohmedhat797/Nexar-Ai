import type { CandidateAssessment, RoutingInput, RoutingPolicy } from '@nexar/contracts';

/**
 * A policy that can also rank with `deterministic@1` semantics over its own hard-filter stage.
 * The controller calls `evaluateFallback` when `evaluate` throws (ADR-020 §11).
 */
export interface FallbackRoutingPolicy extends RoutingPolicy {
  evaluateFallback(input: RoutingInput): readonly CandidateAssessment[];
}

export function isFallbackRoutingPolicy(policy: RoutingPolicy): policy is FallbackRoutingPolicy {
  return typeof (policy as Partial<FallbackRoutingPolicy>).evaluateFallback === 'function';
}
