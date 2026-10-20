import type { ConnectionHost, ControlEngine } from './connection.js';
import { NexarError } from './errors.js';
import type { ResourceId } from './ids.js';
import type { LaneRole, TaskSizeEstimate } from './intelligence.js';
import type { PolicyStamp, RouteDecision } from './routing.js';
import type { NexarTask } from './task.js';

/** How much model quality a unit needs; resource-agnostic (ADR-027 §10). */
export type QualityClass = 'basic' | 'standard' | 'high';

export type ReviewDimension = 'resource' | 'connection' | 'provider';
export type ReviewDiversity = 'preferred' | 'required';
/** Opt-in constraints; resource keeps the legacy default unless explicitly specified. */
export type ReviewDimensions = Readonly<Partial<Record<ReviewDimension, ReviewDiversity>>>;

/** Canonical order is also the explanation/hash order. Host is deliberately absent. */
export const REVIEW_DIMENSIONS: readonly ReviewDimension[] = Object.freeze([
  'resource',
  'connection',
  'provider',
]);

/** Runtime validation for typed and serialized callers; never echoes untrusted values. */
export function resolveReviewDimensions(
  value: unknown,
  legacy?: ReviewDiversity,
): ReviewDimensions | undefined {
  if (value === undefined) return undefined;
  const fail = (): never => {
    throw new NexarError('VALIDATION_ERROR', 'Invalid review dimensions');
  };
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return fail();
  const record = value as Record<string, unknown>;
  const prototype: unknown = Object.getPrototypeOf(record);
  if (prototype !== Object.prototype && prototype !== null) return fail();
  const keys = Reflect.ownKeys(record);
  if (
    keys.length === 0 ||
    keys.some((k) => typeof k !== 'string' || !REVIEW_DIMENSIONS.includes(k as ReviewDimension))
  )
    return fail();
  for (const key of keys)
    if (record[key as string] !== 'preferred' && record[key as string] !== 'required')
      return fail();
  if (legacy !== undefined && legacy !== 'preferred' && legacy !== 'required') return fail();
  if (record.resource !== undefined && legacy !== undefined && record.resource !== legacy)
    return fail();
  return Object.freeze({
    resource: (record.resource ?? legacy ?? 'preferred') as ReviewDiversity,
    ...(record.connection === undefined
      ? {}
      : { connection: record.connection as ReviewDiversity }),
    ...(record.provider === undefined ? {} : { provider: record.provider as ReviewDiversity }),
  });
}

/** Public immutable allocation identity only. Never a credential, subject, home or mutable generation. */
export interface ReviewIdentity {
  readonly resourceId: ResourceId;
  readonly connectionId?: string;
  readonly provider?: string;
  readonly host?: ConnectionHost;
}

/** Retained in the existing plan so revalidation never has to reconstruct historical identity. */
export interface ReviewContext {
  readonly dimensions: ReviewDimensions;
  readonly reviewOf?: string;
  readonly reviewed?: ReviewIdentity;
}

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
  readonly reviewDimensions?: ReviewDimensions;
}

export interface UnitStrategy {
  readonly unitId: string;
  readonly decision: RouteDecision;
  readonly reviewContext?: ReviewContext;
}

/** Trusted code-level execution input; never accepted from a standalone tool request. */
export interface StrategyExecution {
  readonly planned: UnitStrategy;
  readonly unit: WorkUnit;
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
  readonly reviewIdentity?: ReviewIdentity;
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
  readonly reviewDimensions?: ReviewDimensions;
}
