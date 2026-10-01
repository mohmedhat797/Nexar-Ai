import { createHash } from 'node:crypto';
import type {
  CandidateAssessment,
  ExecutionAggregate,
  LaneAggregate,
  LaneRole,
  ResourceId,
  RouteReason,
  RoutingInput,
  ScoreFactor,
} from '@nexar/contracts';
import type { DeterministicPolicyConfig } from './deterministic-policy.js';
import type { FallbackRoutingPolicy } from './fallback.js';
import { applyHardFilters, ruleFor, type FilteredCandidate } from './hard-filters.js';
import type { ResourceIntelligenceSettings, ScoreWeights } from './intelligence-settings.js';

export interface ResourceIntelligencePolicyConfig extends DeterministicPolicyConfig {
  readonly settings: ResourceIntelligenceSettings;
}

const NEUTRAL = 0.5;
const IMPLEMENTER_ROLES: ReadonlySet<LaneRole> = new Set<LaneRole>([
  'feature',
  'tests',
  'debugging',
]);

/** Preference values used when `preferences: 'weighted'`. */
const WEIGHTED_TASK = 1;
const WEIGHTED_KIND = 0.75;
const WEIGHTED_DEFAULT = 0.5;

/** Deterministic-compatible score constants, used only by the fallback ranking. */
const TASK_BASE = 1000;
const KIND_BASE = 500;
const DEFAULT_BASE = 100;
const INDEX_STEP = 10;
const AVAILABLE_BONUS = 20;
const UNCERTAIN_BONUS = 10;

const byId = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
const round6 = (n: number): number => Math.round(n * 1e6) / 1e6;
const compare = (a: number, b: number): number => (a === b ? 0 : a < b ? -1 : 1);

/** Clamps to [0, 1]; a non-finite value is the neutral 0.5. */
function clamp01(n: number): number {
  return Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : NEUTRAL;
}

/** A usable count: finite and not negative. Anything else is absent. */
function count(n: unknown): number | undefined {
  return typeof n === 'number' && Number.isFinite(n) && n >= 0 ? n : undefined;
}

/** `num / den` clamped to [0, 1]; absent unless both are usable and `den > 0`. */
function ratio(num: unknown, den: unknown): number | undefined {
  const n = count(num);
  const d = count(den);
  return n === undefined || d === undefined || d <= 0 ? undefined : clamp01(n / d);
}

/** JSON with recursively sorted object keys (arrays keep their order); `undefined` is omitted. */
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map((v) => canonicalJson(v ?? null)).join(',')}]`;
  if (typeof value === 'object' && value !== null) {
    const record = value as Record<string, unknown>;
    const parts = Object.keys(record)
      .filter((k) => record[k] !== undefined)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonicalJson(record[k])}`);
    return `{${parts.join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

function own<T>(record: Readonly<Record<string, T>> | undefined, key: string): T | undefined {
  return record !== undefined && Object.hasOwn(record, key) ? record[key] : undefined;
}

interface Preference {
  /** 3 task, 2 task kind, 1 none. */
  readonly tier: number;
  /** Index in the list that gave the tier; `Infinity` when none did. */
  readonly index: number;
  readonly kind: 'task' | 'task-kind' | 'default' | 'none';
}

type AddFactor = (
  name: keyof ScoreWeights,
  value: number,
  neutral: boolean,
  detail?: string,
) => void;

/**
 * `resource-intelligence@1` (ADR-020 §6): hard filters first (shared with the fallback), then a
 * weighted, fully explained score over the eligible set. Pure and deterministic; it never receives
 * the prompt and a score can never make a rejected candidate eligible.
 */
export class ResourceIntelligencePolicy implements FallbackRoutingPolicy {
  readonly name = 'resource-intelligence';
  readonly version = '1';
  readonly configId: string;

  constructor(private readonly config: ResourceIntelligencePolicyConfig) {
    this.configId = createHash('sha256')
      .update(
        canonicalJson({
          policy: 'resource-intelligence@1',
          taskKinds: config.taskKinds,
          defaultResourceId: config.defaultResourceId,
          settings: config.settings,
        }),
      )
      .digest('hex')
      .slice(0, 12);
  }

  evaluate(input: RoutingInput): readonly CandidateAssessment[] {
    const { settings } = this.config;
    const rule = ruleFor(this.config.taskKinds, input.task.kind);
    const weighted = settings.preferences === 'weighted';

    const entries = applyHardFilters(input, this.config).map((candidate) => {
      const pref = this.preferenceOf(candidate.resourceId, input, rule?.preferredResourceIds);
      const reasons = [...candidate.reasons, ...this.preferenceReasons(pref, input.task.kind)];
      const base = {
        resourceId: candidate.resourceId,
        reasons,
        tier: weighted ? 1 : pref.tier,
        quota: candidate.quota,
        cost: candidate.cost,
      };
      // Scoring only runs for candidates the hard filters left eligible.
      if (!candidate.eligible) {
        return { assessment: { ...base, eligible: false, score: 0 }, index: Infinity };
      }
      const factors = this.factors(candidate, pref, input);
      const score = round6(factors.reduce((sum, f) => sum + f.contribution, 0));
      return {
        assessment: { ...base, eligible: true, score, factors },
        index: weighted ? Infinity : pref.index,
      };
    });

    const eligible = entries
      .filter((e) => e.assessment.eligible)
      .sort(
        (a, b) =>
          compare(b.assessment.tier, a.assessment.tier) ||
          compare(a.index, b.index) ||
          compare(b.assessment.score, a.assessment.score) ||
          byId(a.assessment.resourceId, b.assessment.resourceId),
      );
    return [...eligible, ...this.rejectedLast(entries)].map((e) => e.assessment);
  }

  /**
   * `deterministic@1` ranking (tier, preference index, default resource, availability, id) over
   * the same hard-filter stage: no history, no factors. Never admits a rejected candidate.
   */
  evaluateFallback(input: RoutingInput): readonly CandidateAssessment[] {
    const rule = ruleFor(this.config.taskKinds, input.task.kind);
    const entries = applyHardFilters(input, this.config).map((candidate) => {
      const id = candidate.resourceId;
      const pref = this.preferenceOf(id, input, rule?.preferredResourceIds);
      const certain = candidate.snapshot.state.availability === 'available';
      const isDefault = this.config.defaultResourceId === id;
      const base =
        pref.kind === 'task'
          ? TASK_BASE - INDEX_STEP * pref.index
          : pref.kind === 'task-kind'
            ? KIND_BASE - INDEX_STEP * pref.index
            : isDefault
              ? DEFAULT_BASE
              : 0;
      const assessment = {
        resourceId: id,
        eligible: candidate.eligible,
        score: candidate.eligible ? base + (certain ? AVAILABLE_BONUS : UNCERTAIN_BONUS) : 0,
        reasons: [...candidate.reasons, ...this.preferenceReasons(pref, input.task.kind)],
        tier: pref.tier,
        quota: candidate.quota,
        cost: candidate.cost,
      };
      return { assessment, index: pref.index, isDefault, certain };
    });
    const eligible = entries
      .filter((e) => e.assessment.eligible)
      .sort(
        (a, b) =>
          compare(b.assessment.tier, a.assessment.tier) ||
          compare(a.index, b.index) ||
          compare(Number(b.isDefault), Number(a.isDefault)) ||
          compare(Number(b.certain), Number(a.certain)) ||
          byId(a.assessment.resourceId, b.assessment.resourceId),
      );
    return [...eligible, ...this.rejectedLast(entries)].map((e) => e.assessment);
  }

  private rejectedLast<T extends { assessment: CandidateAssessment }>(entries: T[]): T[] {
    return entries
      .filter((e) => !e.assessment.eligible)
      .sort((a, b) => byId(a.assessment.resourceId, b.assessment.resourceId));
  }

  private preferenceOf(
    id: ResourceId,
    input: RoutingInput,
    kindPreferred: readonly ResourceId[] | undefined,
  ): Preference {
    const taskIndex = input.task.requirements.preferredResourceIds?.indexOf(id) ?? -1;
    if (taskIndex >= 0) return { tier: 3, index: taskIndex, kind: 'task' };
    const kindIndex = kindPreferred?.indexOf(id) ?? -1;
    if (kindIndex >= 0) return { tier: 2, index: kindIndex, kind: 'task-kind' };
    const isDefault = this.config.defaultResourceId === id;
    return { tier: 1, index: Infinity, kind: isDefault ? 'default' : 'none' };
  }

  private preferenceReasons(pref: Preference, taskKind: string): RouteReason[] {
    switch (pref.kind) {
      case 'task':
        return [{ code: 'preference.task', effect: 'supports', message: 'preferred by the task' }];
      case 'task-kind':
        return [
          {
            code: 'preference.task-kind',
            effect: 'supports',
            message: `preferred for task kind "${taskKind}"`,
          },
        ];
      case 'default':
        return [{ code: 'preference.default', effect: 'supports', message: 'default resource' }];
      case 'none':
        return [];
    }
  }

  private factors(
    candidate: FilteredCandidate,
    pref: Preference,
    input: RoutingInput,
  ): ScoreFactor[] {
    const { settings } = this.config;
    const { state, descriptor } = candidate.snapshot;
    const out: ScoreFactor[] = [];
    const add: AddFactor = (name, rawValue, neutral, detail) => {
      const rawWeight = settings.weights[name];
      const weight = Number.isFinite(rawWeight) && rawWeight > 0 ? rawWeight : 0;
      const value = clamp01(rawValue);
      out.push({
        name,
        value,
        weight,
        contribution: value * weight,
        ...(neutral ? { neutral: true } : {}),
        ...(detail === undefined ? {} : { detail }),
      });
    };

    if (settings.preferences === 'weighted') {
      const value =
        pref.kind === 'task'
          ? WEIGHTED_TASK
          : pref.kind === 'task-kind'
            ? WEIGHTED_KIND
            : pref.kind === 'default'
              ? WEIGHTED_DEFAULT
              : 0;
      add('default', value, false, 'weighted-preference');
    } else {
      add('default', this.config.defaultResourceId === descriptor.id ? 1 : 0, false);
    }

    add('availability', state.availability === 'available' ? 1 : NEUTRAL, false);
    // Unauthenticated candidates never get here (hard filter); only "unknown" is uncertain.
    const authCertain = descriptor.auth.mode === 'none' || state.auth !== 'unknown';
    add('auth', authCertain ? 1 : NEUTRAL, false);
    add('quota', candidate.quotaFactor.value, candidate.quotaFactor.neutral);
    add('cost', candidate.costFactor.value, candidate.costFactor.neutral);

    const min = settings.history.minSamples;
    const agg = own(own(input.history?.executions, descriptor.id), input.task.kind);
    this.addHistoryFactors(add, agg, min);

    const role = input.facts?.laneRole;
    if (role !== undefined) {
      const lane = own(own(input.history?.lanes, descriptor.id), role);
      const { value, detail } = this.laneValue(role, lane, min);
      add('lane', value ?? NEUTRAL, value === undefined, detail);
    }
    return out;
  }

  private addHistoryFactors(
    add: AddFactor,
    agg: ExecutionAggregate | undefined,
    min: number,
  ): void {
    const successes = count(agg?.successes) ?? 0;
    const faults = count(agg?.resourceFaults) ?? 0;
    const samples = successes + faults;
    const cold = `cold-start ${String(samples)}<${String(min)}`;
    const warm = agg !== undefined && samples >= min;

    const p50 = count(agg?.p50LatencyMs);
    if (!warm) add('latency', NEUTRAL, true, cold);
    else if (p50 === undefined) add('latency', NEUTRAL, true, 'no-latency');
    else {
      const value = 1 / (1 + p50 / this.config.settings.latencyScaleMs);
      add('latency', value, false, `p50=${String(p50)}ms`);
    }

    if (!warm) add('success', NEUTRAL, true, cold);
    else {
      add(
        'success',
        (successes + 1) / (samples + 2),
        false,
        `${String(successes)}/${String(samples)}`,
      );
    }
  }

  private laneValue(
    role: LaneRole,
    agg: LaneAggregate | undefined,
    min: number,
  ): { value: number | undefined; detail: string } {
    if (role === 'architecture') return { value: undefined, detail: 'architecture-neutral' };
    const samples = count(agg?.samples) ?? 0;
    if (agg === undefined || samples < min) {
      return { value: undefined, detail: `cold-start ${String(samples)}<${String(min)}` };
    }
    let signals: (number | undefined)[];
    if (IMPLEMENTER_ROLES.has(role)) {
      const tasks = count(agg.tasks);
      const rework = count(agg.reworkRounds);
      signals = [
        ratio(agg.firstRoundGatePasses, agg.gateSamples),
        tasks !== undefined && tasks > 0 && rework !== undefined
          ? 1 - Math.min(rework / tasks, 3) / 3
          : undefined,
        ratio(agg.reviewApprovals, agg.reviewVerdicts),
        ratio(agg.ownerApprovals, agg.ownerDecisions),
      ];
    } else {
      signals = [ratio(agg.validVerdicts, agg.producedVerdicts)];
    }
    const available = signals.filter((s): s is number => s !== undefined);
    if (available.length === 0) return { value: undefined, detail: 'no-signals' };
    const mean = available.reduce((a, b) => a + b, 0) / available.length;
    return { value: clamp01(mean), detail: `signals=${String(available.length)}` };
  }
}
