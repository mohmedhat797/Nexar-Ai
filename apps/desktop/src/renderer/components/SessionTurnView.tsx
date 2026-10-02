import { useState, type ReactElement } from 'react';
import type { SelectedDecision, TurnDto } from '../../shared/api.js';
import { call, errorText, nexar } from '../bridge.js';
import { ArtifactCard } from './ArtifactCard.js';
import { CandidateList } from './RoutingCard.js';

const STATE_LABEL: Readonly<Record<string, string>> = {
  'pending-confirmation': 'Waiting for confirmation',
  cancelled: 'Cancelled',
  interrupted: 'Interrupted: Nexar closed before this finished',
  declined: 'Declined',
};

type Explanation =
  | { readonly status: 'idle' }
  | { readonly status: 'selected'; readonly decision: SelectedDecision }
  | { readonly status: 'refused' }
  | { readonly status: 'error'; readonly message: string };

/**
 * Which resource ran the turn comes from the stored task link. "Why this choice?" asks the router
 * again for the same request, so it shows Nexar's view now, not a stored decision.
 */
function Routing({ projectId, turn }: { projectId: string; turn: TurnDto }): ReactElement | null {
  const [open, setOpen] = useState(false);
  const [explanation, setExplanation] = useState<Explanation>({ status: 'idle' });
  const resource = turn.tasks.find((t) => t.resourceId !== undefined)?.resourceId;
  if (resource === undefined) return null;

  const toggle = (): void => {
    const next = !open;
    setOpen(next);
    if (!next || explanation.status !== 'idle') return;
    call(nexar.explainRoute({ projectId, kind: turn.kind ?? 'general', prompt: turn.text })).then(
      (decision) =>
        setExplanation(
          decision.outcome === 'selected'
            ? { status: 'selected', decision }
            : { status: 'refused' },
        ),
      (e: unknown) => setExplanation({ status: 'error', message: errorText(e) }),
    );
  };

  return (
    <section className="routing-card" data-testid="routing-card" aria-label="Routing">
      <div className="routing-head">
        <span className="mono routing-resource" data-testid="routing-resource">
          {resource}
        </span>
        <span className="muted"> · chosen by Nexar</span>
      </div>
      <button type="button" className="link" aria-expanded={open} onClick={toggle}>
        Why this choice?
      </button>
      {open && explanation.status === 'selected' && (
        <>
          <div className="small muted">Nexar&apos;s current view of the AI resources</div>
          <CandidateList decision={explanation.decision} />
        </>
      )}
      {open && explanation.status === 'refused' && (
        <div className="small muted">No AI resource is eligible for this request right now.</div>
      )}
      {open && explanation.status === 'error' && (
        <div className="small bad-text">{explanation.message}</div>
      )}
    </section>
  );
}

/** One conversation turn: the owner's message and what came back, always as plain text. */
export function SessionTurnView({
  projectId,
  turn,
  lines,
  onCancel,
}: {
  projectId: string;
  turn: TurnDto;
  lines: readonly string[];
  onCancel: (turnId: string) => void;
}): ReactElement {
  const label = STATE_LABEL[turn.state];
  const error = turn.outcome?.error;
  return (
    <article className="turn" data-testid="turn" data-state={turn.state}>
      <div className="bubble-user" data-testid="user-message">
        {turn.text}
      </div>
      <Routing projectId={projectId} turn={turn} />
      {turn.state === 'running' && (
        <div className="progress" aria-live="polite">
          {lines.map((line, i) => (
            <div key={i} className="progress-line small muted">
              {line}
            </div>
          ))}
          <div className="running">
            <span className="spinner" aria-hidden="true" /> Working…{' '}
            <button type="button" className="link" onClick={() => onCancel(turn.id)}>
              Cancel
            </button>
          </div>
        </div>
      )}
      {label !== undefined && (
        <div className="chips">
          <span className="chip chip-warn" data-testid="turn-state">
            {label}
          </span>
        </div>
      )}
      {error !== undefined && (
        <div className="notice notice-bad" role="alert" data-testid="turn-error">
          {error.message} ({error.code})
        </div>
      )}
      {turn.outcome?.text !== undefined && (
        <div className="result-text" data-testid="result-text">
          {turn.outcome.text}
        </div>
      )}
      {turn.outcome?.textTruncated === true && (
        <div className="small muted">
          The saved reply was shortened; the full text is in the draft.
        </div>
      )}
      {turn.artifacts.map((artifact) => (
        <ArtifactCard key={artifact.path} projectId={projectId} artifact={artifact} />
      ))}
    </article>
  );
}
