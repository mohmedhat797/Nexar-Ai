import type { ReactElement } from 'react';
import type { CoworkStatusDto } from '../../shared/api.js';
import type { CoworkStatus } from '../useCoworkStatus.js';

export const COWORK_EXECUTABLE_NOTE =
  'Isolated Cowork requires the configured WSL2 sandbox and its pinned DeepSeek Harness runtime.';
const PROVIDER_HINT =
  'Add a model resource that can run tool turns in Settings → Providers so Nexar can control DeepSeek Harness.';

/** What the Cowork lane can do right now, as a banner above the transcript. */
export function CoworkBanner({ cowork }: { cowork: CoworkStatus }): ReactElement {
  const { status, loading, error } = cowork;
  if (status === null) {
    return (
      <div className="code-banner" data-testid="cowork-banner" data-state="checking" role="status">
        <span className="code-banner-text" data-testid="cowork-banner-reason">
          {error ?? 'Checking DeepSeek Harness…'}
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
      <div
        className="code-banner code-banner-ready"
        data-testid="cowork-banner"
        data-state="ready"
        data-placement={status.placement}
      >
        <span className="chip chip-ok">Ready</span>
        <span className="code-banner-text" data-testid="cowork-banner-reason">
          {status.placement === 'WSL2_BUBBLEWRAP'
            ? 'Isolated Cowork ready (WSL2)'
            : 'DeepSeek Harness ready'}
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
      data-placement={status.placement}
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
      <dt>Runtime</dt>
      <dd data-testid="cowork-runtime">
        {status.version === undefined ? 'DeepSeek Harness' : `DeepSeek Harness ${status.version}`}
      </dd>
      <dt>State</dt>
      <dd data-testid="cowork-state">{status.state}</dd>
      <dt>Reason</dt>
      <dd data-testid="cowork-reason">{status.reason}</dd>
      <dt>DeepSeek Harness version</dt>
      <dd data-testid="cowork-version">{status.version ?? 'unknown'}</dd>
    </dl>
  );
}
