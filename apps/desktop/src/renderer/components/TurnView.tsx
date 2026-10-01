import type { ReactElement } from 'react';
import type { Turn } from '../state.js';
import { ArtifactCard } from './ArtifactCard.js';
import { RoutingCard } from './RoutingCard.js';

/** One request and everything that came back; output is always rendered as plain text. */
export function TurnView({
  turn,
  onCancel,
}: {
  turn: Turn;
  onCancel: (requestId: string) => void;
}): ReactElement {
  const { result } = turn;
  return (
    <article className="turn" data-testid="turn">
      <div className="bubble-user" data-testid="user-message">
        {turn.label}
      </div>
      {result !== undefined && <RoutingCard decision={result.decision} />}
      {turn.status === 'running' && (
        <div className="progress" aria-live="polite">
          {turn.events.map((line, i) => (
            <div key={i} className="progress-line small muted">
              {line}
            </div>
          ))}
          <div className="running">
            <span className="spinner" aria-hidden="true" /> Working…{' '}
            <button type="button" className="link" onClick={() => onCancel(turn.requestId)}>
              Cancel
            </button>
          </div>
        </div>
      )}
      {turn.status === 'error' && (
        <div className="notice notice-bad" role="alert" data-testid="turn-error">
          {turn.error}
        </div>
      )}
      {result !== undefined && (
        <>
          <div className="result-text" data-testid="result-text">
            {result.text}
          </div>
          {result.artifact !== null && (
            <ArtifactCard projectId={turn.projectId} artifact={result.artifact} />
          )}
        </>
      )}
    </article>
  );
}
