import {
  NexarError,
  taskId,
  type CandidateAssessment,
  type ControlDecision,
  type ControlEngine,
  type ControlResourcePolicy,
  type ResourceSnapshot,
  type RoutingHistory,
  type RoutingPolicy,
  type WorkUnit,
} from '@nexar/contracts';
import { allocateNext, type StrategySettings } from '@nexar/resource-controller';

export interface SelectControlInput {
  readonly engine: ControlEngine;
  readonly policy: ControlResourcePolicy;
  readonly candidates: readonly ResourceSnapshot[];
  readonly routingPolicy: RoutingPolicy;
  readonly history?: RoutingHistory;
  readonly now: Date;
  readonly strategySettings?: StrategySettings;
  readonly newId: () => string;
  /** Resources that already failed for this engine turn; never selected. */
  readonly exclude?: readonly string[];
}

const PINNED_UNAVAILABLE = 'control.pinned-unavailable';

function noEligible(engine: ControlEngine, reasonCodes: readonly string[]): NexarError {
  return new NexarError('NO_ELIGIBLE_RESOURCE', `No eligible control resource for ${engine}`, {
    details: { engine, reasonCodes },
  });
}

function unique(codes: readonly string[]): string[] {
  return [...new Set(codes)];
}

/** Eligible resources best-first (selected, then alternatives); empty when none is eligible. */
function rank(input: SelectControlInput): readonly CandidateAssessment[] {
  const excluded = new Set(input.exclude ?? []);
  const unit: WorkUnit = {
    unitId: `control-${input.engine}`,
    task: {
      id: taskId(`control-${input.engine}`),
      kind: 'general',
      requirements: { capabilities: [] },
    },
    control: input.engine,
  };
  const { decision } = allocateNext({
    candidates: input.candidates.filter((c) => !excluded.has(c.descriptor.id)),
    policy: input.routingPolicy,
    ...(input.history === undefined ? {} : { history: input.history }),
    now: input.now,
    ...(input.strategySettings === undefined ? {} : { settings: input.strategySettings }),
    ledger: {
      graphId: unit.unitId,
      allocations: [],
      spentUsd: 0,
      reviewDiversity: 'preferred',
    },
    unit,
  });
  return decision.outcome === 'selected' ? [decision.selected, ...decision.alternatives] : [];
}

function decide(
  input: SelectControlInput,
  ranked: readonly CandidateAssessment[],
  chosen: CandidateAssessment,
  codes: readonly string[],
): ControlDecision {
  return {
    controlDecisionId: input.newId(),
    engine: input.engine,
    resourceId: chosen.resourceId,
    alternatives: ranked.filter((a) => a !== chosen).map((a) => a.resourceId),
    decidedAt: input.now.toISOString(),
    reasonCodes: unique(codes),
  };
}

/**
 * Chooses the control resource for one engine turn (ADR-027 §7A). Only `model-turn` resources
 * pass; the strategy planner's hard filters (experimental, quota, ...) apply unchanged. Throws
 * `NO_ELIGIBLE_RESOURCE` when nothing qualifies.
 */
export function selectControl(input: SelectControlInput): ControlDecision {
  const { policy, engine } = input;
  const ranked = rank(input);
  const first = ranked[0];

  if (policy.mode === 'pinned') {
    if (typeof policy.resourceId !== 'string' || policy.resourceId.length === 0) {
      throw new NexarError('VALIDATION_ERROR', 'A pinned control policy needs a resourceId');
    }
    const pinned = ranked.find((a) => a.resourceId === policy.resourceId);
    if (pinned !== undefined) return decide(input, ranked, pinned, ['control.pinned']);
    if (policy.fallback === 'none') throw noEligible(engine, [PINNED_UNAVAILABLE]);
    if (first === undefined) throw noEligible(engine, [PINNED_UNAVAILABLE]);
    return decide(input, ranked, first, [PINNED_UNAVAILABLE, 'control.auto']);
  }

  if (first === undefined) throw noEligible(engine, ['control.auto']);
  return decide(input, ranked, first, ['control.auto']);
}
