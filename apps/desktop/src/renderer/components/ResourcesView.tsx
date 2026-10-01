import type { ReactElement } from 'react';
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
        <button type="button" className="btn" onClick={onRefresh} disabled={loading}>
          {loading ? 'Checking…' : 'Refresh'}
        </button>
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
            <tr key={r.id} data-testid="resource-row">
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
          ))}
        </tbody>
      </table>
      {resources.length === 0 && !loading && <p className="muted">No resources found.</p>}
    </section>
  );
}
