import type { ControlEngine } from './connection.js';
import type { ResourceId } from './ids.js';
import type { LaneRole, TaskSizeEstimate } from './intelligence.js';
import type { PolicyStamp, RouteDecision } from './routing.js';
import type { NexarTask } from './task.js';

/** How much model quality a unit needs; resource-agnostic (ADR-027 §10). */
export type QualityClass = 'basic' | 'standard' | 'high';

/** One schedulable piece of work in a {@link WorkGraph}. Carries no prompt, only routing facts. */
export interface WorkUnit {
  readonly unitId: string;
  readonly task: Pick<NexarTask, 'id' | 'kind' | 'requirements'>;
  readonly laneRole?: LaneRole;
  readonly qualityClass?: QualityClass;
  /** The unit whose output this unit reviews; planned after it. */
  readonly reviewOf?: string;
  readonly dependsOn?: readonly string[];
  /** Set when the unit's model turns are driven by an orchestration engine. */
  readonly control?: ControlEngine;
  /** Controller-computed size (never the prompt): lets the planner estimate per-token cash. */
  readonly size?: TaskSizeEstimate;
}

/** A plan-level view of the work to allocate resources for. */
export interface WorkGraph {
  readonly graphId: string;
  readonly units: readonly WorkUnit[];
  /** Cash ceiling for the whole plan. */
  readonly budgetUsd?: number;
  /** Default `preferred`. */
  readonly reviewDiversity?: 'preferred' | 'required';
}

export interface UnitStrategy {
  readonly unitId: string;
  readonly decision: RouteDecision;
}

/** `strategy@1` stamp; `base` is the routing policy whose hard filters the plan reused. */
export interface StrategyPolicyStamp extends PolicyStamp {
  readonly base: PolicyStamp;
}

export interface ResourceStrategy {
  readonly graphId: string;
  readonly policy: StrategyPolicyStamp;
  /** In planning order. */
  readonly units: readonly UnitStrategy[];
  readonly decidedAt: string;
}

/** One resource assignment recorded in a {@link StrategyLedger}. */
export interface StrategyAllocation {
  readonly unitId: string;
  readonly resourceId: ResourceId;
  /** Known cash estimate only; never a fabricated zero. */
  readonly estimatedCostUsd?: number;
}

/** Immutable plan state for dynamic engines; every allocation returns a new ledger. */
export interface StrategyLedger {
  readonly graphId: string;
  readonly allocations: readonly StrategyAllocation[];
  readonly spentUsd: number;
  readonly budgetUsd?: number;
  readonly reviewDiversity: 'preferred' | 'required';
}
