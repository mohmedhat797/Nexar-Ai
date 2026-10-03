import type { ReactElement } from 'react';
import type { CoworkStatusDto } from '../../shared/api.js';
import type { CoworkStatus } from '../useCoworkStatus.js';

export const COWORK_EXECUTABLE_NOTE =
  "Nexar runs its own private OpenWorker. Its executable is set in the owner's desktop settings file.";
const PROVIDER_HINT = 'Allow OpenWorker to use a provider key in Settings → Providers.';

/** What the Cowork lane can do right now, as a banner above the transcript. */
export function CoworkBanner({ cowork }: { cowork: CoworkStatus }): ReactElement {
  const { status, loading, error } = cowork;
  if (status === null) {
    return (
      <div className="code-banner" data-testid="cowork-banner" data-state="checking" role="status">
        <span className="code-banner-text" data-testid="cowork-banner-reason">
          {error ?? 'Checking OpenWorker…'}
        </span>
        {error !== null && (
          <button
            type="button"
            className="btn"
            data-testid="cowork-refresh"
            onClick={cowork.refresh}
          >
            Refresh
          </button>
        )}
      </div>
    );
  }
  if (status.state === 'ready') {
    return (
      <div className="code-banner code-banner-ready" data-testid="cowork-banner" data-state="ready">
        <span className="chip chip-ok">Ready</span>
        <span className="code-banner-text" data-testid="cowork-banner-reason">
          OpenWorker ready
        </span>
        {status.version !== undefined && (
          <span className="small muted" data-testid="cowork-banner-version">
            Version {status.version}
          </span>
        )}
      </div>
    );
  }
  return (
    <div
      className="code-banner code-banner-blocked"
      data-testid="cowork-banner"
      data-state={status.state}
    >
      <div className="code-banner-row">
        <span className="chip chip-warn">Not ready</span>
        <span className="code-banner-text" data-testid="cowork-banner-reason">
          {status.reason}
        </span>
        <button
          type="button"
          className="btn"
          disabled={loading}
          data-testid="cowork-refresh"
          onClick={cowork.refresh}
        >
          Refresh
        </button>
      </div>
      {status.state === 'configuration-missing' && (
        <div className="small muted" data-testid="cowork-banner-hint">
          {PROVIDER_HINT}
        </div>
      )}
      {error !== null && (
        <div className="small bad-text" role="alert">
          {error}
        </div>
      )}
    </div>
  );
}

/** The Cowork lane's state for the Settings tab: read-only facts. */
export function CoworkFacts({ status }: { status: CoworkStatusDto }): ReactElement {
  return (
    <dl className="facts" data-testid="cowork-facts">
      <dt>State</dt>
      <dd data-testid="cowork-state">{status.state}</dd>
      <dt>Reason</dt>
      <dd data-testid="cowork-reason">{status.reason}</dd>
      <dt>OpenWorker version</dt>
      <dd data-testid="cowork-version">{status.version ?? 'unknown'}</dd>
    </dl>
  );
}
