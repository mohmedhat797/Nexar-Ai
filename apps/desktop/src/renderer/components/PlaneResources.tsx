import type { ReactElement } from 'react';
import type { PlaneStatusDto } from '../../shared/api.js';
import { controlText } from './ResourcesView.js';

export const PLANE_RESOURCES_NOTE =
  'Resources the engineering plane can use. They are managed on the plane; Desktop shows them read-only.';

/** Settings, Providers, Engineering plane: the plane's resources, text only, no actions. */
export function PlaneResources({
  status,
  error,
}: {
  status: PlaneStatusDto | null;
  error: string | null;
}): ReactElement {
  const resources = status?.planeResources;
  return (
    <section className="stack" aria-label="Engineering plane" data-testid="plane-resources">
      <h2>Engineering plane</h2>
      <p className="muted">{PLANE_RESOURCES_NOTE}</p>
      {status === null ? (
        <p className="muted">{error ?? 'Checking the engineering plane…'}</p>
      ) : resources === undefined ? (
        <p className="muted" data-testid="plane-resources-none">
          {status.state === 'ready'
            ? 'The engineering plane does not report its resources.'
            : `The engineering plane is not ready: ${status.reason}`}
        </p>
      ) : resources.length === 0 ? (
        <p className="muted" data-testid="plane-resources-none">
          The engineering plane reports no resources.
        </p>
      ) : (
        <table className="table" data-testid="plane-resources-table">
          <thead>
            <tr>
              <th scope="col">Resource</th>
              <th scope="col">Provider</th>
              <th scope="col">Method</th>
              <th scope="col">Support</th>
              <th scope="col">Auth</th>
              <th scope="col">Availability</th>
              <th scope="col">Control</th>
            </tr>
          </thead>
          <tbody>
            {resources.map((r) => (
              <tr key={r.id} data-testid="plane-resource-row">
                <td className="mono">{r.id}</td>
                <td>{r.provider ?? 'unknown'}</td>
                <td>{r.method ?? 'unknown'}</td>
                <td>{r.support ?? 'unknown'}</td>
                <td>{r.auth}</td>
                <td>{r.availability}</td>
                <td>{controlText(r.control)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}
