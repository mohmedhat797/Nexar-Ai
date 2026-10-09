import { Fragment, useState, type ReactElement } from 'react';
import type { ResourceRow } from '../../shared/api.js';
import { describeQuota } from '../../shared/quota.js';
import { COST_LABEL } from './RoutingCard.js';

const COST_MODEL_LABEL: Readonly<Record<string, string>> = {
  free: COST_LABEL['free'] ?? 'Free',
  subscription: COST_LABEL['subscription-allowance'] ?? 'Subscription',
  'per-token': COST_LABEL['cash'] ?? 'Pay per use',
  'local-compute': COST_LABEL['local-compute'] ?? 'Local compute',
  unknown: COST_LABEL['unknown'] ?? 'Cost unknown',
};

function statusTone(availability: string): string {
  if (availability === 'available') return 'chip-ok';
  if (availability === 'unavailable') return 'chip-bad';
  return 'chip-warn';
}

const AUTH_LABEL: Readonly<Record<string, string>> = {
  authenticated: 'Signed in',
  unauthenticated: 'Not signed in',
  'not-required': 'Not required',
  unknown: 'Unknown',
};

/** `anthropic · subscription · official`; `unknown` when the connection is not inferable. */
export function connectionText(connection: ResourceRow['connection']): string {
  if (connection === undefined) return 'unknown';
  return [connection.provider ?? 'unknown provider', connection.method, connection.support].join(
    ' · ',
  );
}

/** Which engines can run the resource as their control loop. */
export function controlText(control: ResourceRow['control']): string {
  const engines = [...(control.dsh ? ['DeepSeek Harness'] : [])];
  return engines.length === 0 ? 'none' : engines.join(', ');
}

function ResourceDetails({ r }: { r: ResourceRow }): ReactElement {
  return (
    <dl className="facts" data-testid="resource-details">
      <dt>Id</dt>
      <dd className="mono">{r.id}</dd>
      <dt>Connection</dt>
      <dd data-testid="resource-connection">{connectionText(r.connection)}</dd>
      <dt>Adapter</dt>
      <dd>{r.adapter}</dd>
      <dt>Capabilities</dt>
      <dd data-testid="resource-capabilities">
        {r.capabilities.length === 0 && 'none'}
        {r.capabilities.map((c) => (
          <span key={c} className={`chip${c === 'model-turn' ? ' chip-ok' : ''}`}>
            {c}
          </span>
        ))}
      </dd>
      <dt>Auth</dt>
      <dd>{AUTH_LABEL[r.auth] ?? r.auth}</dd>
      <dt>Quota</dt>
      <dd>{describeQuota(r.quota)}</dd>
      <dt>Cost model</dt>
      <dd>{COST_MODEL_LABEL[r.costModel] ?? r.costModel}</dd>
      <dt>Availability</dt>
      <dd>{r.detail === undefined ? r.availability : `${r.availability} · ${r.detail}`}</dd>
      <dt>Control</dt>
      <dd data-testid="resource-control">{controlText(r.control)}</dd>
    </dl>
  );
}

export function ResourcesView({
  resources,
  loading,
  error,
  onRefresh,
}: {
  resources: readonly ResourceRow[];
  loading: boolean;
  error: string | null;
  onRefresh: () => void;
}): ReactElement {
  const [details, setDetails] = useState(false);
  return (
    <section className="page" aria-label="AI resources">
      <header className="page-header">
        <div>
          <h1>AI resources</h1>
          <p className="muted">
            Everything Nexar can route work to. Allowance is shown only when it is known; unknown is
            never treated as unlimited.
          </p>
        </div>
        <div className="row">
          <button
            type="button"
            className="btn"
            aria-pressed={details}
            data-testid="resources-details-toggle"
            onClick={() => setDetails(!details)}
          >
            {details ? 'Hide details' : 'Show details'}
          </button>
          <button type="button" className="btn" onClick={onRefresh} disabled={loading}>
            {loading ? 'Checking…' : 'Refresh'}
          </button>
        </div>
      </header>
      {error !== null && (
        <div className="notice notice-bad" role="alert">
          {error}
        </div>
      )}
      <table className="table" data-testid="resources-table">
        <thead>
          <tr>
            <th scope="col">Resource</th>
            <th scope="col">Status</th>
            <th scope="col">Sign-in</th>
            <th scope="col">Allowance</th>
            <th scope="col">Cost</th>
            <th scope="col">Found by</th>
          </tr>
        </thead>
        <tbody>
          {resources.map((r) => (
            <Fragment key={r.id}>
              <tr data-testid="resource-row">
                <td>
                  <div className="strong">{r.displayName}</div>
                  <div className="muted small mono">
                    {r.id} · {r.kind}
                  </div>
                </td>
                <td>
                  <span className={`chip ${statusTone(r.availability)}`} title={r.detail}>
                    {r.availability}
                  </span>
                </td>
                <td>{AUTH_LABEL[r.auth] ?? r.auth}</td>
                <td>{describeQuota(r.quota)}</td>
                <td>{COST_MODEL_LABEL[r.costModel] ?? r.costModel}</td>
                <td>{r.provenance}</td>
              </tr>
              {details && (
                <tr data-testid="resource-details-row">
                  <td colSpan={6}>
                    <ResourceDetails r={r} />
                  </td>
                </tr>
              )}
            </Fragment>
          ))}
        </tbody>
      </table>
      {resources.length === 0 && !loading && <p className="muted">No resources found.</p>}
    </section>
  );
}
