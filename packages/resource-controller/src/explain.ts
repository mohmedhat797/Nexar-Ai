import type {
  CandidateAssessment,
  CostEstimate,
  LaneRole,
  QuotaAssessment,
  RouteDecision,
  RouteReason,
  TaskSizeEstimate,
} from '@nexar/contracts';

/** Facts shown by the detailed explanation. Numbers and codes only; never the prompt. */
export interface ExplainContext {
  readonly size?: TaskSizeEstimate;
  readonly laneRole?: LaneRole;
  readonly history?: {
    readonly windowStart: string;
    readonly windowEnd: string;
    readonly skipped: number;
  };
}

const MARKERS: Record<RouteReason['effect'], string> = {
  supports: '+',
  rejects: '-',
  neutral: '·',
};

const pct = (n: number): string => `${Math.round(n * 100)}%`;
const num = (n: number): string => String(Math.round(n * 1e6) / 1e6);

function quotaLine(q: QuotaAssessment): string {
  const parts: string[] = [q.freshness];
  if (q.headroom !== undefined) parts.push(`headroom ${pct(q.headroom)}`);
  parts.push(`sources ${q.sources.length === 0 ? 'none' : q.sources.join(',')}`);
  if (q.resetsAt !== undefined) parts.push(`resets ${q.resetsAt}`);
  if (q.unaccountedRuns !== undefined) parts.push(`unaccounted runs ${q.unaccountedRuns}`);
  const r = q.reservation;
  if (r !== undefined) {
    parts.push(
      `reservation ${pct(r.reserveFraction)} (${r.protected ? 'protected' : 'not protected'}, ${
        r.verifiable ? 'verifiable' : 'unverifiable'
      })`,
    );
  }
  return parts.join(', ');
}

function costLine(c: CostEstimate): string {
  const cash = c.cashUsd;
  const amount =
    cash.status === 'unavailable'
      ? `unavailable: ${cash.reason ?? 'unknown'}`
      : `$${cash.value.toFixed(6)}`;
  const basis = cash.status === 'estimated' ? `, basis ${cash.basis}` : '';
  return `${c.class}, ${amount}${basis} (${c.estimator})`;
}

function candidateLines(a: CandidateAssessment, rank: number | undefined): string[] {
  const lines = [
    `  ${rank === undefined ? '-' : `${rank}.`} ${a.resourceId}: ${a.eligible ? 'eligible' : 'rejected'}` +
      `${a.tier === undefined ? '' : `, tier ${a.tier}`}, score ${num(a.score)}`,
  ];
  if (a.factors !== undefined) {
    lines.push('     factors:');
    for (const f of a.factors) {
      const detail = f.neutral === true ? ` (neutral: ${f.detail ?? 'neutral'})` : '';
      const note = f.neutral !== true && f.detail !== undefined ? ` [${f.detail}]` : '';
      lines.push(
        `       ${f.name} ${num(f.value)} × ${num(f.weight)} = ${num(f.contribution)}${detail}${note}`,
      );
    }
  }
  if (a.quota !== undefined) lines.push(`     quota: ${quotaLine(a.quota)}`);
  if (a.cost !== undefined) lines.push(`     cost: ${costLine(a.cost)}`);
  lines.push('     reasons:');
  for (const x of a.reasons) lines.push(`       ${MARKERS[x.effect]} ${x.code}: ${x.message}`);
  return lines;
}

/**
 * The full breakdown for every candidate: ranked eligible ones first, then the rejected ones.
 * Pure text over the decision; it prints codes, ids and numbers only.
 */
export function explainRouteDecisionDetailed(
  decision: RouteDecision,
  context: ExplainContext = {},
): string {
  const { policy } = decision;
  const lines: string[] = [
    `Policy: ${policy.name}@${policy.version}${policy.configId === undefined ? '' : ` (config ${policy.configId})`}`,
  ];
  if (policy.fallback !== undefined) {
    lines.push(
      `Fallback: ${policy.fallback.from} → ${policy.name}@${policy.version} (${policy.fallback.reason})`,
    );
  }
  const facts: string[] = [];
  if (context.size !== undefined) {
    facts.push(`estimated input tokens ${context.size.estimatedInputTokens}`);
    facts.push(
      `requested output tokens ${context.size.requestedMaxOutputTokens === undefined ? 'default' : context.size.requestedMaxOutputTokens}`,
    );
  }
  facts.push(`lane role ${context.laneRole ?? 'none'}`);
  lines.push(`Facts: ${facts.join(', ')}`);
  lines.push(
    context.history === undefined
      ? 'History: none'
      : `History: window ${context.history.windowStart} → ${context.history.windowEnd}, skipped ${context.history.skipped}`,
  );
  lines.push(
    decision.outcome === 'selected'
      ? `Selected resource: ${decision.selected.resourceId}`
      : `No eligible resource for task ${decision.taskId}`,
  );

  lines.push('Candidates:');
  const ranked =
    decision.outcome === 'selected' ? [decision.selected, ...decision.alternatives] : [];
  ranked.forEach((a, i) => lines.push(...candidateLines(a, i + 1)));
  for (const a of decision.rejected) lines.push(...candidateLines(a, undefined));
  return lines.join('\n');
}
