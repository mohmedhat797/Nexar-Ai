import { useCallback, useEffect, useRef, useState, type ReactElement } from 'react';
import type {
  BehaviorPatch,
  BehaviorView,
  CodePermissionId,
  CoworkPermissionId,
  ResourceRow,
} from '../../shared/api.js';
import type { ControlPolicyView, ControlView } from '../../shared/behavior.js';
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
  const latest = useRef(0);
  const writing = useRef(false);

  useEffect(() => {
    let live = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const read = async (): Promise<void> => {
      if (writing.current) {
        if (live) timer = setTimeout(() => void read(), 15_000);
        return;
      }
      const mine = ++latest.current;
      try {
        const next = await call(nexar.getBehavior());
        if (live && mine === latest.current) {
          setView(next);
          setError(null);
        }
      } catch (e) {
        if (live && mine === latest.current) setError(errorText(e));
      } finally {
        if (live) timer = setTimeout(() => void read(), 15_000);
      }
    };
    void read();
    return () => {
      live = false;
      latest.current += 1;
      clearTimeout(timer);
    };
  }, []);

  const apply = useCallback((patch: BehaviorPatch): void => {
    const mine = ++latest.current;
    writing.current = true;
    setBusy(true);
    call(nexar.setBehavior(patch)).then(
      (next) => {
        if (mine !== latest.current) return;
        setView(next);
        setError(null);
        writing.current = false;
        setBusy(false);
      },
      (e: unknown) => {
        if (mine !== latest.current) return;
        setError(errorText(e));
        writing.current = false;
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
          <option
            key={r.id}
            value={r.id}
            disabled={
              r.provenance.startsWith('discovered:inventory:') &&
              (r.availability === 'unavailable' || r.auth === 'unauthenticated')
            }
          >
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

const ENGINE_LABEL: Readonly<Record<Mode, string>> = {
  cowork: 'OpenWorker',
  code: 'DeepSeek Harness',
};
const MODE_LABEL: Readonly<Record<Mode, string>> = { cowork: 'Cowork', code: 'Code' };
export const NO_CONTROL_CANDIDATES =
  'No resource can run the control loop; add an API model or a local endpoint with tool calling.';

/** `Auto`, or `Auto → <label>` when the gateway's current pick is known. */
export function autoLabel(control: ControlView): string {
  if (control.effectiveResourceId === undefined) return 'Auto';
  const known = control.candidates.find((c) => c.id === control.effectiveResourceId);
  return `Auto → ${known?.label ?? control.effectiveResourceId}`;
}

/** One mode's orchestration: engine (fixed), control resource and fallback; Code is read-only. */
function OrchestrationMode({
  mode,
  control,
  disabled,
  onChange,
}: {
  mode: Mode;
  control: ControlView;
  disabled: boolean;
  onChange: (policy: ControlPolicyView) => void;
}): ReactElement {
  const { policy } = control;
  const locked = disabled || !control.editable;
  const pinned = policy.mode === 'pinned' ? policy.resourceId : undefined;
  const stale = pinned !== undefined && !control.candidates.some((c) => c.id === pinned);
  const setResource = (value: string): void =>
    onChange(
      value === ''
        ? { mode: 'auto', fallback: policy.fallback }
        : { mode: 'pinned', resourceId: value, fallback: policy.fallback },
    );
  return (
    <div className="stack" data-testid={`orch-${mode}`}>
      <h3>{MODE_LABEL[mode]}</h3>
      <div className="field">
        <span className="strong">Engine</span>
        <span data-testid={`orch-${mode}-engine`}>{ENGINE_LABEL[mode]}</span>
      </div>
      <label className="field">
        <span className="strong">Control resource</span>
        <select
          value={pinned ?? ''}
          disabled={locked}
          data-testid={`orch-${mode}-control`}
          onChange={(event) => setResource(event.target.value)}
        >
          <option value="">{autoLabel(control)}</option>
          {stale && <option value={pinned}>{pinned}</option>}
          {control.candidates.map((c) => (
            <option key={c.id} value={c.id}>
              {c.label}
            </option>
          ))}
        </select>
      </label>
      <label className="field">
        <span className="strong">Fallback</span>
        <select
          value={policy.fallback}
          disabled={locked}
          data-testid={`orch-${mode}-fallback`}
          onChange={(event) =>
            onChange({
              mode: policy.mode,
              ...(policy.mode === 'pinned' && policy.resourceId !== undefined
                ? { resourceId: policy.resourceId }
                : {}),
              fallback: event.target.value === 'none' ? 'none' : 'auto',
            })
          }
        >
          <option value="auto">Auto</option>
          <option value="none">None</option>
        </select>
      </label>
      {control.candidates.length === 0 && (
        <p className="small muted" data-testid={`orch-${mode}-empty`}>
          {NO_CONTROL_CANDIDATES}
        </p>
      )}
      {!control.editable && control.reason !== undefined && (
        <p className="small muted" data-testid={`orch-${mode}-reason`}>
          {control.reason}
        </p>
      )}
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

      <h2>Orchestration</h2>
      <p className="muted">Which resource drives each engine&apos;s control loop.</p>
      <OrchestrationMode
        mode="cowork"
        control={view.control.cowork}
        disabled={busy}
        onChange={(controlResource) => apply({ cowork: { controlResource } })}
      />
      <OrchestrationMode
        mode="code"
        control={view.control.code}
        disabled={busy}
        onChange={() => undefined}
      />

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
