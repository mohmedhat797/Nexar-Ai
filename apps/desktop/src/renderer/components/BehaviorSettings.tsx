import { useCallback, useEffect, useState, type ReactElement } from 'react';
import type {
  BehaviorPatch,
  BehaviorView,
  CodePermissionId,
  CoworkPermissionId,
  ResourceRow,
} from '../../shared/api.js';
import { call, errorText, nexar } from '../bridge.js';

type Mode = 'cowork' | 'code';

interface Choice<T extends string> {
  readonly id: T;
  readonly label: string;
  readonly hint: string;
}

const COWORK_CHOICES: readonly Choice<CoworkPermissionId>[] = [
  {
    id: 'read-only',
    label: 'Read only',
    hint: 'Cowork talks and reads; it writes nothing and stores no draft.',
  },
  {
    id: 'drafts-only',
    label: 'Drafts only',
    hint: 'Writes only inside the turn’s scratch folder, imported as drafts.',
  },
  {
    id: 'ask-before-write',
    label: 'Ask before every write',
    hint: 'Each scratch write waits for your approval in Approvals.',
  },
];

const CODE_CHOICES: readonly Choice<CodePermissionId>[] = [
  {
    id: 'plan',
    label: 'Plan',
    hint: 'Engineering turns return an implementation plan; nothing is changed or committed.',
  },
  {
    id: 'auto-edit',
    label: 'Auto-edit in sandbox',
    hint: 'The change plan runs in the sandbox; you approve the commit.',
  },
];

interface BehaviorState {
  readonly view: BehaviorView | null;
  readonly error: string | null;
  readonly busy: boolean;
  readonly apply: (patch: BehaviorPatch) => void;
}

function useBehavior(): BehaviorState {
  const [view, setView] = useState<BehaviorView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let live = true;
    call(nexar.getBehavior()).then(
      (next) => live && setView(next),
      (e: unknown) => live && setError(errorText(e)),
    );
    return () => {
      live = false;
    };
  }, []);

  const apply = useCallback((patch: BehaviorPatch): void => {
    setBusy(true);
    call(nexar.setBehavior(patch)).then(
      (next) => {
        setView(next);
        setError(null);
        setBusy(false);
      },
      (e: unknown) => {
        setError(errorText(e));
        setBusy(false);
      },
    );
  }, []);

  return { view, error, busy, apply };
}

function ResourceSelect({
  mode,
  value,
  resources,
  disabled,
  onChange,
}: {
  mode: Mode;
  value: string | undefined;
  resources: readonly ResourceRow[];
  disabled: boolean;
  onChange: (id: string | null) => void;
}): ReactElement {
  return (
    <label className="field">
      <span className="strong">Preferred resource</span>
      <select
        value={value ?? ''}
        disabled={disabled}
        data-testid={`behavior-${mode}-resource`}
        onChange={(event) => onChange(event.target.value === '' ? null : event.target.value)}
      >
        <option value="">Let Nexar decide</option>
        {resources.map((r) => (
          <option key={r.id} value={r.id}>
            {r.displayName}
          </option>
        ))}
      </select>
    </label>
  );
}

function PermissionGroup<T extends string>({
  mode,
  label,
  choices,
  value,
  unsupported,
  disabled,
  onChange,
}: {
  mode: Mode;
  label: string;
  choices: readonly Choice<T>[];
  value: T;
  unsupported: readonly { id: string; label: string; reason: string }[];
  disabled: boolean;
  onChange: (id: T) => void;
}): ReactElement {
  return (
    <div className="stack" role="radiogroup" aria-label={label} data-testid={`behavior-${mode}`}>
      {choices.map((choice) => (
        <label key={choice.id} className="field-inline">
          <input
            type="radio"
            name={`behavior-${mode}`}
            checked={value === choice.id}
            disabled={disabled}
            data-testid={`behavior-${mode}-${choice.id}`}
            onChange={() => onChange(choice.id)}
          />
          <span>
            <span className="strong">{choice.label}</span>
            <span className="small muted"> {choice.hint}</span>
          </span>
        </label>
      ))}
      {unsupported.map((option) => (
        <label key={option.id} className="field-inline">
          <input
            type="radio"
            name={`behavior-${mode}`}
            checked={false}
            disabled
            data-testid={`behavior-${mode}-${option.id}`}
            onChange={() => undefined}
          />
          <span>
            <span className="strong">{option.label}</span>
            <span className="small muted"> {option.reason}</span>
          </span>
        </label>
      ))}
    </div>
  );
}

/** Settings → AI behavior: the permissions and preferred resource per mode (text only). */
export function BehaviorSettings({
  resources,
}: {
  resources: readonly ResourceRow[];
}): ReactElement {
  const { view, error, busy, apply } = useBehavior();
  if (view === null) {
    return (
      <div className="stack" data-testid="behavior-settings">
        <h2>AI behavior</h2>
        <p
          className={error === null ? 'muted' : 'bad-text'}
          role={error === null ? undefined : 'alert'}
        >
          {error ?? 'Loading…'}
        </p>
      </div>
    );
  }
  const { settings } = view;
  const unsupported = (mode: Mode) => view.unsupported.filter((o) => o.mode === mode);
  return (
    <div className="stack" data-testid="behavior-settings">
      <h2>AI behavior</h2>
      <p className="muted">
        These settings only narrow what Nexar does. They never relax the locked rules below.
      </p>

      <h2>Cowork</h2>
      <PermissionGroup
        mode="cowork"
        label="Cowork permission"
        choices={COWORK_CHOICES}
        value={settings.cowork.permission}
        unsupported={unsupported('cowork')}
        disabled={busy}
        onChange={(permission) => apply({ cowork: { permission } })}
      />
      <ResourceSelect
        mode="cowork"
        value={settings.cowork.preferredResourceId}
        resources={resources}
        disabled={busy}
        onChange={(preferredResourceId) => apply({ cowork: { preferredResourceId } })}
      />

      <h2>Code</h2>
      <PermissionGroup
        mode="code"
        label="Code permission"
        choices={CODE_CHOICES}
        value={settings.code.permission}
        unsupported={unsupported('code')}
        disabled={busy}
        onChange={(permission) => apply({ code: { permission } })}
      />
      <ResourceSelect
        mode="code"
        value={settings.code.preferredResourceId}
        resources={resources}
        disabled={busy}
        onChange={(preferredResourceId) => apply({ code: { preferredResourceId } })}
      />
      <p className="small muted" data-testid="behavior-code-note">
        The Code preference applies to Code turns that run directly. Engineering runs on the plane
        pick their own resources (not supported yet).
      </p>

      <h2>Reasoning effort</h2>
      <p className="muted" data-testid="behavior-effort">
        {view.reasoningEffort}
      </p>

      <h2>Locked rules</h2>
      <ul className="plain-list stack" data-testid="behavior-locked">
        {view.lockedRules.map((rule) => (
          <li key={rule}>{rule}</li>
        ))}
      </ul>
      {error !== null && (
        <p className="small bad-text" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
