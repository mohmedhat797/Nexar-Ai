import { useId, useState, type FormEvent, type ReactElement } from 'react';
import type { PlaneStatusDto } from '../../shared/api.js';
import { PLANE_PROJECT_PATTERN } from '../../shared/plane.js';
import { needsPlaneProject } from '../code.js';
import type { CodeStatus } from '../useCodeStatus.js';

const ID_HINT = 'Use lowercase letters, digits and . _ : - (up to 128 characters).';

/**
 * Maps a Desktop project to a plane project by id. Text only: the plane resolves the repository
 * itself, so no path, distro or command is ever asked for or sent.
 */
export function PlaneProjectForm({
  current,
  known,
  busy,
  onSave,
}: {
  current: string | undefined;
  known: readonly string[];
  busy: boolean;
  onSave: (planeProject: string | null) => Promise<void>;
}): ReactElement {
  const [value, setValue] = useState(current ?? '');
  const [touched, setTouched] = useState(false);
  const id = value.trim();
  const valid = PLANE_PROJECT_PATTERN.test(id);
  const listId = useId();

  const submit = (event: FormEvent): void => {
    event.preventDefault();
    setTouched(true);
    if (valid) void onSave(id);
  };

  return (
    <form className="plane-form" onSubmit={submit} data-testid="plane-project-form">
      <label className="field-inline">
        <span className="small muted">Plane project id</span>
        <input
          data-testid="plane-project-input"
          aria-label="Plane project id"
          autoComplete="off"
          spellCheck={false}
          maxLength={128}
          list={known.length > 0 ? listId : undefined}
          value={value}
          onChange={(e) => setValue(e.target.value)}
        />
      </label>
      {known.length > 0 && (
        <datalist id={listId}>
          {known.map((name) => (
            <option key={name} value={name} />
          ))}
        </datalist>
      )}
      <button
        type="submit"
        className="btn btn-primary"
        disabled={busy || id === ''}
        data-testid="plane-project-save"
      >
        Set plane project
      </button>
      {current !== undefined && (
        <button
          type="button"
          className="btn"
          disabled={busy}
          data-testid="plane-project-clear"
          onClick={() => void onSave(null)}
        >
          Remove mapping
        </button>
      )}
      {touched && !valid && (
        <span className="small bad-text" role="alert">
          {ID_HINT}
        </span>
      )}
    </form>
  );
}

/** What the engineering plane can do for a project right now, as a banner above the transcript. */
export function CodeBanner({ code }: { code: CodeStatus }): ReactElement {
  const { status, loading, error } = code;
  if (status === null) {
    return (
      <div className="code-banner" data-testid="code-banner" data-state="checking" role="status">
        <span className="code-banner-text" data-testid="code-banner-reason">
          {error ?? 'Checking the engineering plane…'}
        </span>
        {error !== null && (
          <button type="button" className="btn" data-testid="code-refresh" onClick={code.refresh}>
            Refresh
          </button>
        )}
      </div>
    );
  }
  const project = status.project;
  const state = project?.state ?? status.state;
  const reason = project?.reason ?? status.reason;
  if (state === 'ready') {
    return (
      <div className="code-banner code-banner-ready" data-testid="code-banner" data-state="ready">
        <span className="chip chip-ok">Ready</span>
        <span className="code-banner-text" data-testid="code-banner-reason">
          Engineering plane ready
        </span>
        {status.planeVersion !== undefined && (
          <span className="small muted" data-testid="code-banner-version">
            Plane version {status.planeVersion}
          </span>
        )}
      </div>
    );
  }
  return (
    <div className="code-banner code-banner-blocked" data-testid="code-banner" data-state={state}>
      <div className="code-banner-row">
        <span className="chip chip-warn">Not ready</span>
        <span className="code-banner-text" data-testid="code-banner-reason">
          {reason}
        </span>
        <button
          type="button"
          className="btn"
          disabled={loading}
          data-testid="code-refresh"
          onClick={code.refresh}
        >
          Refresh
        </button>
      </div>
      {needsPlaneProject(state) && (
        <PlaneProjectForm
          current={project?.planeProject}
          known={status.projects}
          busy={loading}
          onSave={code.setPlaneProject}
        />
      )}
      {error !== null && (
        <div className="small bad-text" role="alert">
          {error}
        </div>
      )}
    </div>
  );
}

/** The plane's state for the Settings tab: read-only facts. */
export function PlaneFacts({ status }: { status: PlaneStatusDto }): ReactElement {
  return (
    <dl className="facts" data-testid="plane-facts">
      <dt>State</dt>
      <dd data-testid="plane-state">{status.state}</dd>
      <dt>Reason</dt>
      <dd data-testid="plane-reason">{status.reason}</dd>
      <dt>Plane version</dt>
      <dd data-testid="plane-version">{status.planeVersion ?? 'unknown'}</dd>
      <dt>Kernel</dt>
      <dd data-testid="plane-kernel">{status.kernel ?? 'unknown'}</dd>
    </dl>
  );
}
