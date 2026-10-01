import { useState, type ReactElement } from 'react';
import type { CandidateAssessment } from '@nexar/contracts';
import type { SelectedDecision } from '../../shared/api.js';
import { describeQuota } from '../../shared/quota.js';

export const COST_LABEL: Readonly<Record<string, string>> = {
  cash: 'Pay per use',
  'subscription-allowance': 'Subscription',
  'local-compute': 'Local compute',
  free: 'Free',
  unknown: 'Cost unknown',
};

function rejection(c: CandidateAssessment): string {
  const reason = c.reasons.find((r) => r.effect === 'rejects') ?? c.reasons[0];
  return reason?.message ?? 'Not eligible';
}

function Candidate({
  c,
  chosen,
  max,
}: {
  c: CandidateAssessment;
  chosen: boolean;
  max: number;
}): ReactElement {
  const pct = max > 0 ? Math.max(2, Math.round((c.score / max) * 100)) : 2;
  return (
    <li className="candidate" data-eligible={c.eligible}>
      <span className="candidate-id mono">
        {c.resourceId}
        {chosen ? ' (chosen)' : ''}
      </span>
      {c.eligible ? (
        <span className="score">
          <span className="score-track">
            <span className="score-fill" style={{ width: `${pct.toString()}%` }} />
          </span>
          <span className="small muted">{c.score.toFixed(2)}</span>
        </span>
      ) : (
        <span className="small bad-text">{rejection(c)}</span>
      )}
    </li>
  );
}

/** "‹resource› · chosen by Nexar · ‹policy›", status chips and the full candidate list. */
export function RoutingCard({ decision }: { decision: SelectedDecision }): ReactElement {
  const [open, setOpen] = useState(false);
  const { selected, alternatives, rejected, policy } = decision;
  const candidates = [selected, ...alternatives, ...rejected];
  const max = Math.max(...candidates.filter((c) => c.eligible).map((c) => c.score), 0);
  const cost = selected.cost?.class ?? 'unknown';
  return (
    <section className="routing-card" data-testid="routing-card" aria-label="Routing decision">
      <div className="routing-head">
        <span className="mono routing-resource" data-testid="routing-resource">
          {selected.resourceId}
        </span>
        <span className="muted">
          · chosen by Nexar · {policy.name}@{policy.version}
        </span>
      </div>
      <div className="chips">
        <span className="chip chip-ok">Eligible</span>
        <span className="chip">
          Allowance: {selected.quota === undefined ? 'unknown' : describeQuota(selected.quota)}
        </span>
        <span className="chip">{COST_LABEL[cost] ?? cost}</span>
        {policy.fallback !== undefined && <span className="chip chip-warn">Fallback policy</span>}
      </div>
      <button type="button" className="link" aria-expanded={open} onClick={() => setOpen(!open)}>
        Why this choice?
      </button>
      {open && (
        <ul className="candidates">
          {candidates.map((c) => (
            <Candidate
              key={c.resourceId}
              c={c}
              chosen={c.resourceId === selected.resourceId}
              max={max}
            />
          ))}
        </ul>
      )}
    </section>
  );
}
