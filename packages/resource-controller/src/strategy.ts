import { createHash } from 'node:crypto';
import {
  NexarError,
  connectionOf,
  isControlCompatible,
  valueOf,
  type CandidateAssessment,
  type PolicyStamp,
  type ResourceSnapshot,
  type RouteDecision,
  type RouteReason,
  type RoutingHistory,
  type RoutingInput,
  type RoutingPolicy,
  type ScoreFactor,
  type StrategyAllocation,
  type StrategyLedger,
  type StrategyPolicyStamp,
  type UnitStrategy,
  type WorkGraph,
  type WorkUnit,
  type ResourceStrategy,
  type ResourceId,
} from '@nexar/contracts';

/** Identity of the plan-level planner (ADR-027 §10). */
export const STRATEGY_POLICY = { name: 'strategy', version: '1' } as const;

/** Owner-tunable knobs of `strategy@1`; every field has a documented default. */
export interface StrategySettings {
  /** Admit `experimental` connections (ranked after official ones). Default false. */
  readonly allowExperimental?: boolean;
  /** Score penalty for the resource that produced the reviewed unit (`preferred`). Default 0.3. */
  readonly diversityPenalty?: number;
  /** Score penalty per prior allocation of the same resource in the plan. Default 0.05. */
  readonly balancePenalty?: number;
  /** Score penalty for experimental connections when allowed. Default 0.2. */
  readonly experimentalPenalty?: number;
  /** Score bonus for local/free resources on `basic` units. Default 0.1. */
  readonly basicCheapBonus?: number;
}

interface ResolvedSettings {
  readonly allowExperimental: boolean;
  readonly diversityPenalty: number;
  readonly balancePenalty: number;
  readonly experimentalPenalty: number;
  readonly basicCheapBonus: number;
}

const DEFAULT_SETTINGS: ResolvedSettings = {
  allowExperimental: false,
  diversityPenalty: 0.3,
  balancePenalty: 0.05,
  experimentalPenalty: 0.2,
  basicCheapBonus: 0.1,
};

/** Inputs shared by every entry point; the clock is injected and nothing here does IO. */
interface StrategyContext {
  readonly candidates: readonly ResourceSnapshot[];
  readonly policy: RoutingPolicy;
  readonly history?: RoutingHistory;
  readonly now: Date;
  readonly settings?: StrategySettings;
}

export interface PlanStrategyInput extends StrategyContext {
  readonly graph: WorkGraph;
}

export interface AllocateNextInput extends StrategyContext {
  readonly ledger: StrategyLedger;
  readonly unit: WorkUnit;
}

export interface RevalidateInput extends StrategyContext {
  readonly planned: UnitStrategy;
  readonly unit: WorkUnit;
}

const QUALITY_RANK: Readonly<Record<string, number>> = { high: 0, standard: 1, basic: 2 };
const CHEAP_CLASSES: ReadonlySet<string> = new Set(['local-compute', 'free']);

const byId = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
const round6 = (n: number): number => Math.round(n * 1e6) / 1e6;

function invalid(message: string): NexarError {
  return new NexarError('VALIDATION_ERROR', message);
}

function resolveSettings(settings: StrategySettings | undefined): ResolvedSettings {
  const merged = { ...DEFAULT_SETTINGS, ...settings };
  for (const key of [
    'diversityPenalty',
    'balancePenalty',
    'experimentalPenalty',
    'basicCheapBonus',
  ] as const) {
    const value = merged[key];
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
      throw invalid(`Invalid strategy setting ${key}: must be a finite number >= 0`);
    }
  }
  return { ...merged, allowExperimental: merged.allowExperimental === true };
}

/** Short hash of the resolved settings, written with a fixed key order. */
function configIdOf(s: ResolvedSettings): string {
  return createHash('sha256')
    .update(
      JSON.stringify({
        policy: 'strategy@1',
        allowExperimental: s.allowExperimental,
        diversityPenalty: s.diversityPenalty,
        balancePenalty: s.balancePenalty,
        experimentalPenalty: s.experimentalPenalty,
        basicCheapBonus: s.basicCheapBonus,
      }),
    )
    .digest('hex')
    .slice(0, 12);
}

function stampOf(policy: RoutingPolicy, settings: ResolvedSettings): StrategyPolicyStamp {
  const base: PolicyStamp = {
    name: policy.name,
    version: policy.version,
    ...(policy.configId === undefined ? {} : { configId: policy.configId }),
  };
  return { ...STRATEGY_POLICY, configId: configIdOf(settings), base };
}

function validNow(now: Date): string {
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) throw invalid('Invalid clock value');
  return now.toISOString();
}

function validBudget(budgetUsd: number | undefined): void {
  if (budgetUsd !== undefined && (!Number.isFinite(budgetUsd) || budgetUsd < 0)) {
    throw invalid('Invalid plan budget: must be a finite number >= 0');
  }
}

/** Units a unit must wait for: explicit dependencies plus the unit it reviews. */
function predecessors(unit: WorkUnit): readonly string[] {
  return [...(unit.dependsOn ?? []), ...(unit.reviewOf === undefined ? [] : [unit.reviewOf])];
}

/** Validates the graph and returns its units in planning order (topological, then quality). */
function planningOrder(graph: WorkGraph): readonly WorkUnit[] {
  validBudget(graph.budgetUsd);
  if (
    graph.reviewDiversity !== undefined &&
    graph.reviewDiversity !== 'preferred' &&
    graph.reviewDiversity !== 'required'
  ) {
    throw invalid('Invalid reviewDiversity');
  }
  const ids = new Set<string>();
  for (const unit of graph.units) {
    if (typeof unit.unitId !== 'string' || unit.unitId.length === 0) {
      throw invalid('Work unit ids must be non-empty strings');
    }
    if (ids.has(unit.unitId)) throw invalid(`Duplicate work unit id "${unit.unitId}"`);
    ids.add(unit.unitId);
  }
  for (const unit of graph.units) {
    for (const dep of predecessors(unit)) {
      if (!ids.has(dep))
        throw invalid(`Work unit "${unit.unitId}" refers to unknown unit "${dep}"`);
      if (dep === unit.unitId) throw invalid(`Work unit "${unit.unitId}" depends on itself`);
    }
  }

  const rank = (u: WorkUnit): number =>
    u.qualityClass === undefined ? 3 : (QUALITY_RANK[u.qualityClass] ?? 3);
  const pending = graph.units.map((unit, index) => ({ unit, index }));
  const done = new Set<string>();
  const ordered: WorkUnit[] = [];
  while (pending.length > 0) {
    let best = -1;
    for (let i = 0; i < pending.length; i++) {
      const entry = pending[i];
      if (entry === undefined || !predecessors(entry.unit).every((d) => done.has(d))) continue;
      const current = best < 0 ? undefined : pending[best];
      if (
        current === undefined ||
        rank(entry.unit) < rank(current.unit) ||
        (rank(entry.unit) === rank(current.unit) && entry.index < current.index)
      ) {
        best = i;
      }
    }
    const next = best < 0 ? undefined : pending.splice(best, 1)[0];
    if (next === undefined) throw invalid('Work graph contains a dependency cycle');
    done.add(next.unit.unitId);
    ordered.push(next.unit);
  }
  return ordered;
}

const rejectReason = (code: string, message: string): RouteReason => ({
  code,
  effect: 'rejects',
  message,
});

/** A signed plan factor: `contribution = value × weight` with `value` 1 and a signed weight. */
function planFactor(
  name: string,
  contribution: number,
  detail: string,
): { factor: ScoreFactor; reason: RouteReason } {
  const signed = round6(contribution);
  return {
    factor: { name, value: 1, weight: signed, contribution: signed, detail },
    reason: {
      code: name,
      effect: signed > 0 ? 'supports' : 'neutral',
      message: `${signed > 0 ? '+' : ''}${String(signed)} (${detail})`,
    },
  };
}

interface UnitOutcome {
  readonly decision: RouteDecision;
  readonly allocation?: StrategyAllocation;
}

/**
 * The per-unit computation shared by `planStrategy`, `allocateNext` and `revalidate`: the policy's
 * own assessments (hard filters included), then plan filters that only narrow, then plan factors
 * that only reorder the still-eligible candidates.
 */
/** Infinity-safe ascending comparison (`Infinity - Infinity` would be NaN). */
function compareNumbers(a: number, b: number): number {
  return a === b ? 0 : a < b ? -1 : 1;
}

function decideUnit(
  unit: WorkUnit,
  ledger: StrategyLedger,
  ctx: StrategyContext,
  settings: ResolvedSettings,
  stamp: StrategyPolicyStamp,
): UnitOutcome {
  const decidedAt = validNow(ctx.now);
  const input: RoutingInput = {
    task: { id: unit.task.id, kind: unit.task.kind, requirements: unit.task.requirements },
    candidates: ctx.candidates,
    facts: {
      now: decidedAt,
      ...(unit.laneRole === undefined ? {} : { laneRole: unit.laneRole }),
      // Without a size, per-token cash cannot be estimated and the plan budget cannot act on it.
      ...(unit.size === undefined ? {} : { size: unit.size }),
    },
    ...(ctx.history === undefined ? {} : { history: ctx.history }),
  };
  const snapshots = new Map(ctx.candidates.map((c) => [c.descriptor.id as string, c]));
  const reviewed =
    unit.reviewOf === undefined
      ? undefined
      : ledger.allocations.find((a) => a.unitId === unit.reviewOf)?.resourceId;
  const remaining = ledger.budgetUsd === undefined ? undefined : ledger.budgetUsd - ledger.spentUsd;

  const rejected: CandidateAssessment[] = [];
  const eligible: CandidateAssessment[] = [];
  for (const assessment of ctx.policy.evaluate(input)) {
    const descriptor = snapshots.get(assessment.resourceId)?.descriptor;
    // An assessment for a resource that is not a candidate can never be selected.
    if (descriptor === undefined) continue;
    if (!assessment.eligible) {
      rejected.push(assessment);
      continue;
    }

    const rejects: RouteReason[] = [];
    if (unit.control !== undefined && !isControlCompatible(descriptor, unit.control)) {
      rejects.push(
        rejectReason('strategy.control', `cannot drive the ${unit.control} control loop`),
      );
    }
    const experimental = connectionOf(descriptor)?.support === 'experimental';
    if (experimental && !settings.allowExperimental) {
      rejects.push(rejectReason('strategy.experimental', 'experimental connection not allowed'));
    }
    if (ledger.reviewDiversity === 'required' && reviewed !== undefined) {
      if (assessment.resourceId === reviewed) {
        rejects.push(
          rejectReason(
            'strategy.diversity',
            `produced the reviewed unit "${String(unit.reviewOf)}"`,
          ),
        );
      }
    }
    const cost = assessment.cost;
    const cash = cost?.class === 'cash' ? valueOf(cost.cashUsd) : undefined;
    if (remaining !== undefined && cash !== undefined && cash > remaining) {
      rejects.push(
        rejectReason(
          'strategy.budget',
          `est $${String(cash)} exceeds remaining plan budget $${String(round6(remaining))}`,
        ),
      );
    }
    if (rejects.length > 0) {
      rejected.push({
        ...assessment,
        eligible: false,
        score: 0,
        reasons: [...assessment.reasons, ...rejects],
      });
      continue;
    }

    const added: { factor: ScoreFactor; reason: RouteReason }[] = [];
    if (ledger.reviewDiversity === 'preferred' && reviewed === assessment.resourceId) {
      if (settings.diversityPenalty > 0) {
        added.push(
          planFactor(
            'strategy.diversity',
            -settings.diversityPenalty,
            'same resource as reviewed unit',
          ),
        );
      }
    }
    const prior = ledger.allocations.filter((a) => a.resourceId === assessment.resourceId).length;
    if (prior > 0 && settings.balancePenalty > 0) {
      added.push(
        planFactor('strategy.balance', -settings.balancePenalty * prior, `prior=${String(prior)}`),
      );
    }
    if (experimental && settings.experimentalPenalty > 0) {
      added.push(
        planFactor('strategy.support', -settings.experimentalPenalty, 'experimental connection'),
      );
    }
    if (
      unit.qualityClass === 'basic' &&
      cost !== undefined &&
      CHEAP_CLASSES.has(cost.class) &&
      settings.basicCheapBonus > 0
    ) {
      added.push(
        planFactor('strategy.quality-fit', settings.basicCheapBonus, `basic on ${cost.class}`),
      );
    }
    eligible.push({
      ...assessment,
      score: round6(assessment.score + added.reduce((s, a) => s + a.factor.contribution, 0)),
      reasons: [...assessment.reasons, ...added.map((a) => a.reason)],
      factors: [...(assessment.factors ?? []), ...added.map((a) => a.factor)],
    });
  }

  // Owner preferences rank before plan factors (CLAUDE.md: preferences before learned signals):
  // the base tier, then the unit's explicit preference order, then official before experimental
  // (ADR-027 section 3), and only then the plan score.
  const preferred = unit.task.requirements.preferredResourceIds ?? [];
  const preferenceIndex = (id: string): number => {
    const index = preferred.indexOf(id as ResourceId);
    return index === -1 ? Number.POSITIVE_INFINITY : index;
  };
  const supportRank = (id: string): number => {
    const descriptor = snapshots.get(id)?.descriptor;
    return descriptor !== undefined && connectionOf(descriptor)?.support === 'experimental' ? 1 : 0;
  };
  eligible.sort(
    (a, b) =>
      (b.tier ?? 0) - (a.tier ?? 0) ||
      compareNumbers(preferenceIndex(a.resourceId), preferenceIndex(b.resourceId)) ||
      supportRank(a.resourceId) - supportRank(b.resourceId) ||
      b.score - a.score ||
      byId(a.resourceId, b.resourceId),
  );
  rejected.sort((a, b) => byId(a.resourceId, b.resourceId));

  const [selected, ...alternatives] = eligible;
  if (selected === undefined) {
    return {
      decision: {
        outcome: 'no-eligible-resource',
        taskId: unit.task.id,
        rejected,
        policy: stamp,
        decidedAt,
      },
    };
  }
  const estimatedCostUsd = selected.cost === undefined ? undefined : valueOf(selected.cost.cashUsd);
  return {
    decision: {
      outcome: 'selected',
      taskId: unit.task.id,
      selected,
      alternatives,
      rejected,
      policy: stamp,
      decidedAt,
    },
    allocation: {
      unitId: unit.unitId,
      resourceId: selected.resourceId,
      ...(estimatedCostUsd === undefined ? {} : { estimatedCostUsd }),
    },
  };
}

function advance(
  ledger: StrategyLedger,
  allocation: StrategyAllocation | undefined,
): StrategyLedger {
  if (allocation === undefined) return ledger;
  return {
    ...ledger,
    allocations: [...ledger.allocations, allocation],
    spentUsd: round6(ledger.spentUsd + (allocation.estimatedCostUsd ?? 0)),
  };
}

/**
 * `strategy@1` (ADR-027 §10): allocates resources across a whole work graph. Reuses the routing
 * policy's hard filters unchanged, narrows with plan filters, reorders with plan factors. Pure.
 */
export function planStrategy(input: PlanStrategyInput): ResourceStrategy {
  const { graph } = input;
  const settings = resolveSettings(input.settings);
  const stamp = stampOf(input.policy, settings);
  const decidedAt = validNow(input.now);
  let ledger: StrategyLedger = {
    graphId: graph.graphId,
    allocations: [],
    spentUsd: 0,
    ...(graph.budgetUsd === undefined ? {} : { budgetUsd: graph.budgetUsd }),
    reviewDiversity: graph.reviewDiversity ?? 'preferred',
  };
  const units: UnitStrategy[] = [];
  for (const unit of planningOrder(graph)) {
    const outcome = decideUnit(unit, ledger, input, settings, stamp);
    ledger = advance(ledger, outcome.allocation);
    units.push({ unitId: unit.unitId, decision: outcome.decision });
  }
  return { graphId: graph.graphId, policy: stamp, units, decidedAt };
}

/** The same per-unit computation as `planStrategy`, one unit at a time, for dynamic engines. */
export function allocateNext(input: AllocateNextInput): {
  decision: RouteDecision;
  ledger: StrategyLedger;
} {
  const { ledger, unit } = input;
  validBudget(ledger.budgetUsd);
  if (ledger.allocations.some((a) => a.unitId === unit.unitId)) {
    throw invalid(`Work unit "${unit.unitId}" is already allocated`);
  }
  const settings = resolveSettings(input.settings);
  const outcome = decideUnit(unit, ledger, input, settings, stampOf(input.policy, settings));
  return { decision: outcome.decision, ledger: advance(ledger, outcome.allocation) };
}

/**
 * Stage 2: re-evaluates a planned unit just before it runs. Keeps the planned resource while it
 * is eligible, otherwise falls back along the planned order. A resource the plan rejected is
 * never selected.
 */
export function revalidate(input: RevalidateInput): {
  decision: RouteDecision;
  fallback?: { from: string; reason: string };
} {
  const { planned, unit } = input;
  const settings = resolveSettings(input.settings);
  const stamp = stampOf(input.policy, settings);
  const empty: StrategyLedger = {
    graphId: planned.unitId,
    allocations: [],
    spentUsd: 0,
    reviewDiversity: 'preferred',
  };
  const { decision: current } = decideUnit(unit, empty, input, settings, stamp);

  const before = planned.decision;
  const plannedOrder =
    before.outcome === 'selected'
      ? [before.selected.resourceId, ...before.alternatives.map((a) => a.resourceId)]
      : [];
  const planRejected = new Set<string>(before.rejected.map((r) => r.resourceId));

  const nowEligible =
    current.outcome === 'selected' ? [current.selected, ...current.alternatives] : [];
  const usable = nowEligible.filter((a) => !planRejected.has(a.resourceId));
  const byResource = new Map(usable.map((a) => [a.resourceId as string, a]));
  const ordered = [
    ...plannedOrder.flatMap((id) => byResource.get(id) ?? []),
    ...usable.filter((a) => !plannedOrder.includes(a.resourceId)),
  ];
  const rejected = [
    ...current.rejected,
    ...nowEligible
      .filter((a) => planRejected.has(a.resourceId))
      .map((a): CandidateAssessment => ({
        ...a,
        eligible: false,
        score: 0,
        reasons: [
          ...a.reasons,
          rejectReason('strategy.plan-rejected', 'rejected by the plan hard filters'),
        ],
      })),
  ].sort((a, b) => byId(a.resourceId, b.resourceId));

  const [first, ...alternatives] = ordered;
  if (first === undefined) {
    return {
      decision: {
        outcome: 'no-eligible-resource',
        taskId: unit.task.id,
        rejected,
        policy: stamp,
        decidedAt: current.decidedAt,
      },
    };
  }

  const plannedId = before.outcome === 'selected' ? before.selected.resourceId : undefined;
  let fallback: { from: string; reason: string } | undefined;
  let note: RouteReason = {
    code: 'strategy.revalidated',
    effect: 'supports',
    message: 'planned resource is still eligible',
  };
  if (plannedId !== undefined && plannedId !== first.resourceId) {
    const gone = rejected.find((r) => r.resourceId === plannedId);
    const reason = gone?.reasons.find((r) => r.effect === 'rejects')?.code ?? 'resource.missing';
    fallback = { from: plannedId, reason };
    note = {
      code: 'strategy.fallback',
      effect: 'neutral',
      message: `planned ${plannedId} no longer eligible (${reason})`,
    };
  }
  return {
    decision: {
      outcome: 'selected',
      taskId: unit.task.id,
      selected: { ...first, reasons: [...first.reasons, note] },
      alternatives,
      rejected,
      policy: stamp,
      decidedAt: current.decidedAt,
    },
    ...(fallback === undefined ? {} : { fallback }),
  };
}
