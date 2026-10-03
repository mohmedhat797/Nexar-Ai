/**
 * `@nexar/operating`: the Operating Layer (ADR-024): deterministic intent classification, the lane
 * router, the bounded context builder, the recursion guard and the `OperatingService` turn pipeline.
 *
 * Headless. No network, child-process, mail or approval-execution code: orchestrators and engines
 * are reached only through injected ports.
 */
export {
  CONTEXT_POLICY,
  MAX_CONTEXT_CHARS,
  MAX_CONTEXT_SIDE_CHARS,
  MAX_CONTEXT_TURNS,
} from './context.js';
export { buildContext } from './context.js';
export type { BuildContextInput, BuiltContext } from './context.js';
export { MAX_DELEGATION_DEPTH, childTask, delegate, rootCorrelation } from './correlation.js';
export type { Orchestrator, OperatingCorrelation } from './correlation.js';
export { INTENT_POLICY, INTENT_RULES, classifyIntent } from './intent.js';
export type { ClassifyIntentInput, IntentRule } from './intent.js';
export { LANE_POLICY, affinityLane, confirmLane, decideLane } from './router.js';
export type { DecideLaneInput, LaneAvailability, LaneOutcome, LaneRefusal } from './router.js';
export {
  CODE_GOAL_CONTEXT_POLICY,
  CODE_GOAL_REQUEST_ONLY_POLICY,
  MAX_CODE_GOAL_CHARS,
  MAX_CONCURRENT_TURNS,
  OperatingService,
} from './service.js';
export type {
  CodeRequest,
  CodeResult,
  DirectRequest,
  DirectResult,
  OperatingPorts,
  SubmitTurnInput,
  SubmitTurnResult,
} from './service.js';
