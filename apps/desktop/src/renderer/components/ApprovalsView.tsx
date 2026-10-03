import { useCallback, useEffect, useState, type ReactElement } from 'react';
import type { ApprovalDto } from '../../shared/api.js';
import { call, errorText, nexar } from '../bridge.js';
import { COMMIT_NOTE } from '../code.js';

function ApprovalCard({
  approval,
  onDecided,
}: {
  approval: ApprovalDto;
  onDecided: () => void;
}): ReactElement {
  const [confirming, setConfirming] = useState<'approve' | 'deny' | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const pending = approval.status === 'pending';

  const decide = (action: 'approve' | 'deny'): void => {
    setBusy(true);
    setError(null);
    const request =
      action === 'approve' ? nexar.approve({ id: approval.id }) : nexar.deny({ id: approval.id });
    call(request).then(
      () => {
        setBusy(false);
        setConfirming(null);
        onDecided();
      },
      (e: unknown) => {
        setBusy(false);
        setError(errorText(e));
      },
    );
  };

  return (
    <article className="card approval" data-testid="approval-card">
      <div className="approval-head">
        <span className="strong">{approval.summary}</span>
        <span className={`chip ${pending ? 'chip-warn' : ''}`}>{approval.status}</span>
      </div>
      <div className="muted small">
        {approval.actionType} · risk {approval.risk} · fingerprint{' '}
        <span className="mono">{approval.fingerprint}</span>
      </div>
      <div className="muted small">
        Requested {approval.createdAt} · expires {approval.expiresAt}
        {approval.decidedAt !== undefined && ` · decided ${approval.decidedAt}`}
      </div>
      {approval.source === 'plane' && (
        <div className="small muted" data-testid="approval-plane-note">
          {COMMIT_NOTE}
        </div>
      )}
      {error !== null && (
        <div className="bad-text small" role="alert">
          {error}
        </div>
      )}
      {pending && confirming === null && (
        <div className="row">
          <button
            type="button"
            className="btn btn-primary"
            onClick={() => setConfirming('approve')}
          >
            Approve
          </button>
          <button type="button" className="btn" onClick={() => setConfirming('deny')}>
            Deny
          </button>
        </div>
      )}
      {pending && confirming !== null && (
        <div className="row confirm" role="group" aria-label="Confirm decision">
          <span className="small">
            {confirming === 'approve' ? 'Approve this one action?' : 'Deny this request?'}
          </span>
          <button
            type="button"
            className="btn btn-primary"
            disabled={busy}
            onClick={() => decide(confirming)}
          >
            Yes, {confirming}
          </button>
          <button type="button" className="btn" disabled={busy} onClick={() => setConfirming(null)}>
            Cancel
          </button>
        </div>
      )}
    </article>
  );
}

export function ApprovalsView({ onChanged }: { onChanged: () => void }): ReactElement {
  const [all, setAll] = useState(false);
  const [items, setItems] = useState<readonly ApprovalDto[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    call(nexar.listApprovals({ all })).then(
      (list) => {
        setItems(list);
        setError(null);
      },
      (e: unknown) => setError(errorText(e)),
    );
  }, [all]);

  useEffect(load, [load]);

  const decided = (): void => {
    load();
    onChanged();
  };

  return (
    <section className="page" aria-label="Approvals">
      <header className="page-header">
        <div>
          <h1>Approvals</h1>
          <p className="muted">
            Actions that need your decision. Each approval is bound to one exact action and works
            once.
          </p>
        </div>
        <label className="field-inline">
          <input type="checkbox" checked={all} onChange={(e) => setAll(e.target.checked)} />
          <span>Show history</span>
        </label>
      </header>
      {error !== null && (
        <div className="notice notice-bad" role="alert">
          {error}
        </div>
      )}
      {items !== null && items.length === 0 && (
        <div className="empty-inline" data-testid="approvals-empty">
          <h2>{all ? 'No approvals yet' : 'Nothing waiting for you'}</h2>
          <p className="muted">When Nexar needs your decision, it will appear here.</p>
        </div>
      )}
      <div className="stack">
        {(items ?? []).map((a) => (
          <ApprovalCard key={a.id} approval={a} onDecided={decided} />
        ))}
      </div>
    </section>
  );
}
