import { useEffect, useState, type FormEvent, type ReactElement } from 'react';
import type { ProjectDto, WorkflowDto } from '../../shared/api.js';
import { call, errorText, nexar } from '../bridge.js';
import type { Turn } from '../state.js';
import { TurnView } from './TurnView.js';

type FormValues = Readonly<Record<string, string>>;

/** `list` inputs are one item per line; documents are project-relative paths, one per line. */
function toInputs(
  workflow: WorkflowDto,
  values: FormValues,
): Record<string, string | readonly string[]> {
  const inputs: Record<string, string | readonly string[]> = {};
  for (const input of workflow.inputs) {
    const raw = values[input.name] ?? '';
    if (input.type === 'list' || input.type === 'document-set') {
      const lines = raw
        .split('\n')
        .map((l) => l.trim())
        .filter((l) => l !== '');
      if (lines.length > 0) inputs[input.name] = lines;
    } else if (raw.trim() !== '') {
      inputs[input.name] = raw;
    }
  }
  return inputs;
}

function WorkflowForm({
  workflow,
  disabled,
  onRun,
}: {
  workflow: WorkflowDto;
  disabled: boolean;
  onRun: (inputs: Record<string, string | readonly string[]>) => void;
}): ReactElement {
  const [values, setValues] = useState<FormValues>({});
  const missing = workflow.inputs.some((i) => i.required && (values[i.name] ?? '').trim() === '');
  const submit = (event: FormEvent): void => {
    event.preventDefault();
    onRun(toInputs(workflow, values));
  };
  const set = (name: string, value: string): void => setValues((v) => ({ ...v, [name]: value }));
  return (
    <form className="card stack" onSubmit={submit} aria-label={`${workflow.displayName} inputs`}>
      {workflow.inputs.map((input) => {
        const id = `wf-${workflow.id}-${input.name}`;
        const multi = input.type !== 'string';
        const hint =
          input.type === 'document-set'
            ? 'One project file path per line (passed by reference).'
            : input.type === 'list'
              ? 'One item per line.'
              : undefined;
        return (
          <div className="field" key={input.name}>
            <label htmlFor={id}>
              {input.label}
              {input.required ? ' *' : ''}
            </label>
            {multi ? (
              <textarea
                id={id}
                rows={input.type === 'text' ? 6 : 4}
                value={values[input.name] ?? ''}
                maxLength={input.maxLength}
                onChange={(e) => set(input.name, e.target.value)}
              />
            ) : (
              <input
                id={id}
                value={values[input.name] ?? ''}
                maxLength={input.maxLength}
                onChange={(e) => set(input.name, e.target.value)}
              />
            )}
            {hint !== undefined && <span className="muted small">{hint}</span>}
          </div>
        );
      })}
      <div className="row">
        <button type="submit" className="btn btn-primary" disabled={disabled || missing}>
          Run workflow
        </button>
        <span className="muted small">
          Produces: {workflow.outputs.map((o) => `${o.id} (${o.mediaType})`).join(', ')}
        </span>
      </div>
    </form>
  );
}

export function WorkflowsView({
  project,
  turns,
  onRun,
  onCancel,
}: {
  project: ProjectDto | null;
  turns: readonly Turn[];
  onRun: (workflow: WorkflowDto, inputs: Record<string, string | readonly string[]>) => void;
  onCancel: (requestId: string) => void;
}): ReactElement {
  const [workflows, setWorkflows] = useState<readonly WorkflowDto[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    call(nexar.listWorkflows(project === null ? {} : { projectId: project.id })).then(
      (list) => {
        setWorkflows(list);
        setError(null);
      },
      (e: unknown) => setError(errorText(e)),
    );
  }, [project]);

  const selected = workflows.find((w) => w.id === selectedId) ?? null;
  const running = turns.some((t) => t.status === 'running');

  return (
    <section className="page" aria-label="Workflows">
      <header className="page-header">
        <div>
          <h1>Workflows</h1>
          <p className="muted">
            Repeatable recipes. Inputs are treated as untrusted text and results are saved as
            drafts.
          </p>
        </div>
      </header>
      {project === null && (
        <div className="notice">Open a folder as a project to run a workflow.</div>
      )}
      {error !== null && (
        <div className="notice notice-bad" role="alert">
          {error}
        </div>
      )}
      <div className="grid">
        {workflows.map((w) => (
          <button
            type="button"
            key={w.id}
            className={`card workflow-card${w.id === selectedId ? ' selected' : ''}`}
            aria-pressed={w.id === selectedId}
            data-testid="workflow-card"
            onClick={() => setSelectedId(w.id)}
          >
            <span className="strong">{w.displayName}</span>
            <span className="muted small">{w.description}</span>
            <span className="chip">{w.source}</span>
          </button>
        ))}
      </div>
      {workflows.length === 0 && error === null && <p className="muted">No workflows found.</p>}
      {selected !== null && project !== null && (
        <WorkflowForm
          key={selected.id}
          workflow={selected}
          disabled={running}
          onRun={(inputs) => onRun(selected, inputs)}
        />
      )}
      <div className="stack">
        {turns.map((t) => (
          <TurnView key={t.requestId} turn={t} onCancel={onCancel} />
        ))}
      </div>
    </section>
  );
}
