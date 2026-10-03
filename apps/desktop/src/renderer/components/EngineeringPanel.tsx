import { useEffect, useState, type ReactElement } from 'react';
import type { ApprovalDto, CodeDiffDto, TurnDto } from '../../shared/api.js';
import { BridgeError, call, errorText, nexar } from '../bridge.js';
import {
  APPROVAL_LABEL,
  COMMIT_NOTE,
  ENGINEERING_STATUS_LABEL,
  approvalState,
  clipGoal,
  currentPhase,
  diffLines,
  fallbackText,
  shortSha,
} from '../code.js';

const DIFF_NOT_READY = 'The diff is not ready yet.';
const DIFF_AFTER_RESTART = 'Diff unavailable after restart';
const DIFF_RETRIES = 8;
const DIFF_RETRY_MS = 1000;

const STATE_STATUS: Readonly<Record<string, string>> = {
  running: 'Running',
  succeeded: 'Succeeded',
  failed: 'Failed',
  cancelled: 'Cancelled',
  interrupted: 'Interrupted',
};

type DiffState =
  | { readonly status: 'idle' }
  | { readonly status: 'loading' }
  | { readonly status: 'ready'; readonly diff: CodeDiffDto }
  | { readonly status: 'unavailable'; readonly message: string };

/** The diff as plain text in a `<pre>`: one span per line, classed by its first characters. */
function DiffText({ diff }: { diff: CodeDiffDto }): ReactElement {
  const view = diffLines(diff);
  return (
    <>
      {diff.files.length > 0 && (
        <ul className="diff-files" data-testid="diff-files" aria-label="Changed files">
          {diff.files.map((file) => (
            <li key={file} className="mono small">
              {file}
            </li>
          ))}
        </ul>
      )}
      <pre className="diff" data-testid="diff-view">
        {view.lines.map((line, i) => (
          <span key={i} className={`diff-line diff-${line.kind}`}>
            {line.text}
          </span>
        ))}
      </pre>
      {(diff.truncated || view.clipped) && (
        <div className="small muted" data-testid="diff-truncated">
          Diff truncated
        </div>
      )}
    </>
  );
}

function DiffSection({ sessionId, turn }: { sessionId: string; turn: TurnDto }): ReactElement {
  const [open, setOpen] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [state, setState] = useState<DiffState>({ status: 'idle' });
  const running = turn.state === 'running';

  useEffect(() => {
    if (!open) return;
    let stale = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    setState((current) => (current.status === 'ready' ? current : { status: 'loading' }));
    call(nexar.getCodeDiff({ sessionId, turnId: turn.id })).then(
      (diff) => {
        if (!stale) setState({ status: 'ready', diff });
      },
      (error: unknown) => {
        if (stale) return;
        if (!(error instanceof BridgeError) || error.code !== 'VALIDATION_ERROR') {
          setState({ status: 'unavailable', message: errorText(error) });
        } else if (running) {
          // The plane sends the diff right after it asks for approval: ask again shortly.
          setState({ status: 'unavailable', message: DIFF_NOT_READY });
          if (attempt < DIFF_RETRIES)
            timer = setTimeout(() => setAttempt(attempt + 1), DIFF_RETRY_MS);
        } else {
          setState({ status: 'unavailable', message: DIFF_AFTER_RESTART });
        }
      },
    );
    return () => {
      stale = true;
      clearTimeout(timer);
    };
  }, [open, attempt, sessionId, turn.id, running]);

  return (
    <div className="eng-diff">
      <button
        type="button"
        className="link"
        aria-expanded={open}
        data-testid="show-diff"
        onClick={() => {
          setOpen(!open);
          setAttempt(0);
        }}
      >
        {open ? 'Hide diff' : 'Show diff'}
      </button>
      {open && state.status === 'loading' && <div className="small muted">Loading the diff…</div>}
      {open && state.status === 'unavailable' && (
        <div className="small muted" data-testid="diff-unavailable">
          {state.message}
        </div>
      )}
      {open && state.status === 'ready' && <DiffText diff={state.diff} />}
    </div>
  );
}

function Row({
  label,
  testId,
  children,
}: {
  label: string;
  testId: string;
  children: string;
}): ReactElement {
  return (
    <>
      <dt>{label}</dt>
      <dd data-testid={testId}>{children}</dd>
    </>
  );
}

/**
 * What the engineering plane is doing, or did, for one Code turn. Everything shown is an id, a
 * count or a fixed text from the main process; the owner's decision on the commit is made here
 * through the same approval channels as the Approvals view.
 */
export function EngineeringPanel({
  sessionId,
  turn,
  lines,
  approval,
  onApprovalChanged,
}: {
  sessionId: string;
  turn: TurnDto;
  lines: readonly string[];
  approval: ApprovalDto | undefined;
  onApprovalChanged: () => void;
}): ReactElement {
  const [decided, setDecided] = useState<'approved' | 'denied' | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const eng = turn.outcome?.engineering;
  const plane = approval?.plane;
  const state = approvalState(turn, approval, decided);
  const phase = currentPhase(turn, lines);
  const fallback = turn.lane === undefined ? null : fallbackText(turn.lane);
  const files = eng?.files ?? plane?.files;
  const gates = eng?.gatesPassed ?? plane?.gatesPassed;
  const verdict = eng?.reviewVerdict ?? plane?.reviewVerdict;
  const branch = eng?.branch ?? plane?.branch;
  const taskId = eng?.planeTaskId ?? approval?.taskId ?? turn.tasks[0]?.taskId;
  const status =
    eng === undefined
      ? (STATE_STATUS[turn.state] ?? turn.state)
      : ENGINEERING_STATUS_LABEL[eng.status];
  // A review is read-only: a report (shown as the turn result), never files, gates or an approval.
  const report = eng?.status === 'reported' || turn.intent?.kind === 'review';
  // A reported coding turn is the Plan profile's implementation plan (NXR-053), not a review.
  const plan = report && turn.intent?.kind === 'coding';
  const canShowDiff =
    !report &&
    (approval !== undefined || eng?.status === 'committed' || eng?.status === 'not-accepted');
  const resources = eng?.lanes ?? [];

  const decide = (decision: 'approve' | 'deny'): void => {
    if (approval === undefined) return;
    setBusy(true);
    setError(null);
    const request =
      decision === 'approve' ? nexar.approve({ id: approval.id }) : nexar.deny({ id: approval.id });
    call(request).then(
      () => {
        setBusy(false);
        setDecided(decision === 'approve' ? 'approved' : 'denied');
        onApprovalChanged();
      },
      (e: unknown) => {
        setBusy(false);
        setError(errorText(e));
        onApprovalChanged();
      },
    );
  };

  return (
    <section
      className="card eng-panel"
      data-testid="engineering-panel"
      aria-label={plan ? 'Implementation plan' : report ? 'Repository review' : 'Engineering'}
    >
      <h2>{plan ? 'Implementation plan' : report ? 'Repository review' : 'Engineering'}</h2>
      <dl className="facts">
        <Row label="Goal" testId="eng-goal">
          {clipGoal(turn.text)}
        </Row>
        {phase !== undefined && (
          <Row label="Phase" testId="eng-phase">
            {phase}
          </Row>
        )}
        <Row label="Lane" testId="eng-lane">
          {turn.lane?.effectiveLane ?? 'code'}
        </Row>
        {fallback !== null && (
          <Row label="Lane note" testId="eng-lane-note">
            {fallback}
          </Row>
        )}
        {taskId !== undefined && (
          <Row label="Plane task" testId="eng-task">
            {taskId}
          </Row>
        )}
        <Row label="Status" testId="eng-status">
          {status}
        </Row>
        {report && (
          <Row label="Plan" testId="eng-plan">
            {plan ? 'Implementation plan' : 'Repository report'}
          </Row>
        )}
        {resources.length > 0 && (
          <Row label="Resources" testId="eng-resources">
            {resources.map((lane) => `${lane.role}: ${lane.resourceId}`).join(', ')}
          </Row>
        )}
        {!report && files !== undefined && (
          <Row label="Files changed" testId="eng-files">
            {String(files)}
          </Row>
        )}
        {!report && gates !== undefined && (
          <Row label="Gates passed" testId="eng-gates">
            {String(gates)}
          </Row>
        )}
        {!report && verdict !== undefined && (
          <Row label="Review verdict" testId="eng-verdict">
            {verdict}
          </Row>
        )}
        {!report && (
          <Row label="Approval" testId="eng-approval">
            {APPROVAL_LABEL[state]}
          </Row>
        )}
        {!report && branch !== undefined && (
          <Row label="Branch" testId="eng-branch">
            {branch}
          </Row>
        )}
        {!report && eng?.commit !== undefined && (
          <Row label="Commit" testId="eng-commit">
            {shortSha(eng.commit)}
          </Row>
        )}
      </dl>
      {report && eng?.status === 'reported' && (
        <p className="small muted" data-testid="eng-report-note">
          {plan
            ? 'The plan is shown above as this turn’s result. Nothing was changed.'
            : 'The report is shown above as this turn’s result.'}
        </p>
      )}
      {!report && state === 'pending' && approval !== undefined && (
        <div className="eng-approve" data-testid="eng-approve">
          <div className="row">
            <button
              type="button"
              className="btn btn-primary"
              disabled={busy}
              data-testid="approve-commit"
              onClick={() => decide('approve')}
            >
              Approve commit
            </button>
            <button
              type="button"
              className="btn"
              disabled={busy}
              data-testid="deny-commit"
              onClick={() => decide('deny')}
            >
              Deny
            </button>
          </div>
          <p className="small muted" data-testid="eng-approve-note">
            {COMMIT_NOTE}
          </p>
        </div>
      )}
      {error !== null && (
        <div className="small bad-text" role="alert" data-testid="eng-error">
          {error}
        </div>
      )}
      {canShowDiff && <DiffSection sessionId={sessionId} turn={turn} />}
    </section>
  );
}
