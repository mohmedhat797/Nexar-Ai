import type { LaneRole, QuotaAssessment, QuotaObservation, RouteReason } from '@nexar/contracts';
import type { ReservationRule, ResourceIntelligenceSettings } from './intelligence-settings.js';

type QuotaSettings = ResourceIntelligenceSettings['quota'];

/** What the policy knows about the task when it judges quota (ADR-020 §4). */
export interface QuotaContext {
  readonly taskKind: string;
  readonly laneRole?: LaneRole;
  readonly requireKnownQuota?: boolean;
}

export interface QuotaEvaluation {
  readonly reasons: RouteReason[];
  readonly rejected: boolean;
  /** `neutral` is true when the value is the configured unknown score. */
  readonly factor: { readonly value: number; readonly neutral: boolean };
  readonly assessment: QuotaAssessment;
}

interface Judged {
  readonly observation: QuotaObservation;
  readonly resetPassed: boolean;
  readonly exhausted: boolean;
  readonly stale: boolean;
  /** Remaining fraction in [0, 1], when computable. */
  readonly fraction: number | undefined;
  readonly resetMs: number | undefined;
}

/** A usable quantity: finite and not negative. Anything else is treated as absent. */
function valid(n: number | undefined): n is number {
  return n !== undefined && Number.isFinite(n) && n >= 0;
}

function timeOf(iso: string | undefined): number | undefined {
  if (iso === undefined) return undefined;
  const t = Date.parse(iso);
  return Number.isNaN(t) ? undefined : t;
}

function clamp01(n: number): number {
  return Math.min(1, Math.max(0, n));
}

function judge(o: QuotaObservation, nowMs: number, staleAfterMs: number): Judged {
  const limit = valid(o.limit) && o.limit > 0 ? o.limit : undefined;
  const used = valid(o.used) ? o.used : undefined;
  const remaining = valid(o.remaining) ? o.remaining : undefined;
  const resetMs = timeOf(o.resetsAt);
  const resetPassed = resetMs !== undefined && nowMs >= resetMs;
  const spent =
    (remaining !== undefined && remaining <= 0) ||
    (used !== undefined && o.limit !== undefined && valid(o.limit) && used >= o.limit);
  const vendor =
    o.provenance.limit?.startsWith('vendor-') === true ||
    o.provenance.usage?.startsWith('vendor-') === true;
  const observedMs = timeOf(o.observedAt);
  const stale = vendor && (observedMs === undefined || nowMs - observedMs > staleAfterMs);

  let fraction: number | undefined;
  if (limit !== undefined && remaining !== undefined) fraction = clamp01(remaining / limit);
  else if (limit !== undefined && used !== undefined) fraction = clamp01(1 - used / limit);

  // A stale vendor "exhausted" signal with no reset time cannot hold a resource forever: it
  // degrades to stale (ADR-020 §4 rejects only until a known reset).
  return {
    observation: o,
    resetPassed,
    exhausted: !resetPassed && spent && !(stale && resetMs === undefined),
    stale,
    fraction,
    resetMs,
  };
}

function sourceLabel(o: QuotaObservation): string {
  const parts = [o.provenance.limit, o.provenance.usage].filter(
    (p): p is NonNullable<typeof p> => p !== undefined,
  );
  return [...new Set(parts)].sort().join('+');
}

/** The policy's view of a candidate's quota at `now` (ADR-020 §4 freshness table). Pure. */
export function assessQuota(
  observations: readonly QuotaObservation[] | undefined,
  now: Date,
  settings: QuotaSettings,
): QuotaAssessment {
  const nowMs = now.getTime();
  const judged = (observations ?? []).map((o) => judge(o, nowMs, settings.staleAfterMs));
  // An observation whose window has reset says nothing about the new window.
  const live = judged.filter((j) => !j.resetPassed);
  const sources = [
    ...new Set(live.map((j) => sourceLabel(j.observation)).filter((s) => s !== '')),
  ].sort();
  const unaccounted = live.reduce((sum, j) => sum + (j.observation.unaccountedRuns ?? 0), 0);
  const extra = {
    sources,
    ...(unaccounted > 0 ? { unaccountedRuns: unaccounted } : {}),
  };

  const exhausted = live.filter((j) => j.exhausted);
  if (exhausted.length > 0) {
    const resets = exhausted.flatMap((j) => (j.resetMs === undefined ? [] : [j.resetMs]));
    return {
      freshness: 'exhausted',
      headroom: 0,
      ...extra,
      ...(resets.length > 0 ? { resetsAt: new Date(Math.min(...resets)).toISOString() } : {}),
    };
  }

  const current = live.filter((j) => !j.stale && j.fraction !== undefined);
  if (current.length > 0) {
    const headroom = Math.min(...current.map((j) => j.fraction as number));
    const resets = current.flatMap((j) => (j.resetMs === undefined ? [] : [j.resetMs]));
    return {
      freshness: 'known-current',
      headroom,
      ...extra,
      ...(resets.length > 0 ? { resetsAt: new Date(Math.min(...resets)).toISOString() } : {}),
    };
  }

  if (live.some((j) => j.stale)) return { freshness: 'known-stale', ...extra };
  return { freshness: 'unknown', ...extra };
}

function pct(fraction: number): string {
  return `${Math.round(fraction * 100)}%`;
}

function covered(rule: ReservationRule, ctx: QuotaContext): boolean {
  const { taskKinds, laneRoles } = rule.reservedFor;
  return (
    (taskKinds?.includes(ctx.taskKind) ?? false) ||
    (ctx.laneRole !== undefined && (laneRoles?.includes(ctx.laneRole) ?? false))
  );
}

function reservedList(rule: ReservationRule): string {
  const all = [...(rule.reservedFor.taskKinds ?? []), ...(rule.reservedFor.laneRoles ?? [])];
  return [...new Set(all)].join(', ');
}

/** Turns an assessment into stable routing reasons, a rejection flag and the quota factor. Pure. */
export function evaluateQuota(
  assessment: QuotaAssessment,
  ctx: QuotaContext,
  reservation: ReservationRule | undefined,
  settings: QuotaSettings,
): QuotaEvaluation {
  const reasons: RouteReason[] = [];
  let rejected = false;
  const { freshness, headroom } = assessment;
  const known = freshness === 'known-current' && headroom !== undefined;
  let reservationDetail: QuotaAssessment['reservation'];

  if (freshness === 'exhausted') {
    rejected = true;
    const until = assessment.resetsAt === undefined ? '' : ` until ${assessment.resetsAt}`;
    reasons.push({
      code: 'quota.exhausted',
      message: `quota exhausted${until}`,
      effect: 'rejects',
    });
  } else if (!known && ctx.requireKnownQuota === true) {
    rejected = true;
    reasons.push({
      code: 'quota.unknown-strict',
      message: `quota is ${freshness} and this task requires known quota`,
      effect: 'rejects',
    });
  }

  if (reservation !== undefined && freshness !== 'exhausted') {
    const reserve = reservation.reserveFraction;
    if (known) {
      const low = headroom <= reserve;
      const isCovered = covered(reservation, ctx);
      reservationDetail = {
        reserveFraction: reserve,
        protected: low && !isCovered,
        verifiable: true,
      };
      if (low && !isCovered) {
        rejected = true;
        reasons.push({
          code: 'quota.reserved',
          message: `headroom ${pct(headroom)} ≤ reserved ${pct(reserve)} for ${reservedList(reservation)}`,
          effect: 'rejects',
        });
      } else if (low) {
        reasons.push({
          code: 'quota.reserved-for-task',
          message: `reserve (${pct(reserve)}) is usable for this task: headroom ${pct(headroom)}`,
          effect: 'supports',
        });
      }
    } else {
      reservationDetail = { reserveFraction: reserve, protected: false, verifiable: false };
      reasons.push({
        code: 'quota.reservation-unverifiable',
        message: `a ${pct(reserve)} reservation cannot be verified: quota is ${freshness}`,
        effect: 'neutral',
      });
    }
  }

  if (freshness !== 'exhausted' && !rejected) {
    if (known) {
      reasons.push({
        code: 'quota.ok',
        message: `quota headroom ${pct(headroom)}`,
        effect: 'supports',
      });
    } else if (freshness === 'known-stale') {
      reasons.push({
        code: 'quota.stale',
        message: 'quota observation is stale; treated as unknown',
        effect: 'neutral',
      });
    } else {
      reasons.push({ code: 'quota.unknown', message: 'quota is unknown', effect: 'neutral' });
    }
  }

  const factor = known
    ? { value: headroom, neutral: false }
    : freshness === 'exhausted'
      ? { value: 0, neutral: false }
      : { value: settings.unknownScore, neutral: true };

  return {
    reasons,
    rejected,
    factor,
    assessment:
      reservationDetail === undefined
        ? assessment
        : { ...assessment, reservation: reservationDetail },
  };
}
