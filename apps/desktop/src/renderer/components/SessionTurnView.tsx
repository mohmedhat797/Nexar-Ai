import { useState, type ReactElement } from 'react';
import type { ApprovalDto, SelectedDecision, TurnDto } from '../../shared/api.js';
import { call, errorText, nexar } from '../bridge.js';
import { ArtifactCard } from './ArtifactCard.js';
import { fallbackText, isCodeTurn, isCoworkTurn, isRefusedTurn } from '../code.js';
import { EngineeringPanel } from './EngineeringPanel.js';
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

function LaneLine({ turn }: { turn: TurnDto }): ReactElement | null {
  const { lane } = turn;
  // Nothing ran while a turn waits for confirmation or after it was declined.
  if (lane === undefined || turn.state === 'pending-confirmation' || turn.state === 'declined') {
    return null;
  }
  const notice = fallbackText(lane);
  const resource = turn.tasks.find((t) => t.resourceId !== undefined)?.resourceId;
  return (
    <div className="lane-line small muted" data-testid="lane-line">
      <span data-testid="lane-effective">Lane: {lane.effectiveLane}</span>
      {isCoworkTurn(turn) && (
        <span data-testid="lane-orchestrator">
          {' '}
          · Orchestrated by OpenWorker{resource === undefined ? '' : ` using ${resource}`}
        </span>
      )}
      {notice !== null && <span data-testid="lane-fallback"> · {notice}</span>}
    </div>
  );
}

/** Choosing a lane is for this turn only; the fixed note says what it does not do. */
function LaneConfirmation({
  turn,
  onConfirm,
}: {
  turn: TurnDto;
  onConfirm: (turnId: string, decision: 'confirm' | 'decline') => Promise<void>;
}): ReactElement | null {
  const [working, setWorking] = useState(false);
  const lane = turn.lane;
  if (turn.state !== 'pending-confirmation' || lane === undefined) return null;
  const from = lane.mismatch?.from ?? lane.requestedLane;
  const to = lane.mismatch?.to ?? lane.requestedLane;
  const decide = (decision: 'confirm' | 'decline'): void => {
    setWorking(true);
    void onConfirm(turn.id, decision).finally(() => setWorking(false));
  };
  return (
    <section className="card lane-confirm" data-testid="lane-confirm" aria-label="Confirm lane">
      <p data-testid="lane-confirm-text">
        This request looks like {to} work, but this conversation is in {from} mode.
      </p>
      <div className="lane-confirm-actions">
        <button
          type="button"
          className="btn btn-primary"
          disabled={working}
          data-testid="lane-confirm-run"
          onClick={() => decide('confirm')}
        >
          Run in {to} lane
        </button>
        <button
          type="button"
          className="btn"
          disabled={working}
          data-testid="lane-confirm-decline"
          onClick={() => decide('decline')}
        >
          Don&apos;t run
        </button>
      </div>
      <p className="small muted">
        Confirming only chooses the orchestration lane. It grants no extra permissions; sandbox,
        review and approvals still apply.
      </p>
    </section>
  );
}

/** One conversation turn: the owner's message and what came back, always as plain text. */
export function SessionTurnView({
  projectId,
  sessionId,
  turn,
  lines,
  approval,
  onCancel,
  onConfirm,
  onApprovalChanged,
}: {
  projectId: string;
  sessionId: string;
  turn: TurnDto;
  lines: readonly string[];
  /** The plane approval waiting for this turn, if any. */
  approval: ApprovalDto | undefined;
  onCancel: (turnId: string) => void;
  onConfirm: (turnId: string, decision: 'confirm' | 'decline') => Promise<void>;
  onApprovalChanged: () => void;
}): ReactElement {
  const label = STATE_LABEL[turn.state];
  const error = turn.outcome?.error;
  const refused = isRefusedTurn(turn);
  return (
    <article className="turn" data-testid="turn" data-state={turn.state}>
      <div className="bubble-user" data-testid="user-message">
        {turn.text}
      </div>
      <LaneConfirmation turn={turn} onConfirm={onConfirm} />
      <LaneLine turn={turn} />
      <Routing projectId={projectId} turn={turn} />
      {isCodeTurn(turn) && (
        <EngineeringPanel
          sessionId={sessionId}
          turn={turn}
          lines={lines}
          approval={approval}
          onApprovalChanged={onApprovalChanged}
        />
      )}
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
      {refused && error !== undefined && (
        <div className="notice" role="status" data-testid="turn-refusal">
          {error.message}
        </div>
      )}
      {!refused && error !== undefined && (
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
