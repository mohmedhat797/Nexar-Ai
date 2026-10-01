import { useEffect, useRef, useState, type FormEvent, type ReactElement } from 'react';
import type { ProjectDto, ResourceRow } from '../../shared/api.js';
import type { Turn } from '../state.js';
import { Icon } from './Icon.js';
import { TurnView } from './TurnView.js';

const TASK_KINDS = [
  'general',
  'documentation',
  'analysis',
  'research',
  'review',
  'meeting-preparation',
  'automation',
  'coding',
] as const;

export interface SendArgs {
  readonly kind: string;
  readonly prompt: string;
  readonly preferredResourceIds?: readonly string[];
  readonly maxCostUsd?: number;
}

/** Resources worth offering in the "AI" picker: not known to be down or signed out. */
export function selectableResources(resources: readonly ResourceRow[]): readonly ResourceRow[] {
  return resources.filter((r) => r.availability !== 'unavailable' && r.auth !== 'unauthenticated');
}

function Composer({
  resources,
  busy,
  onSend,
}: {
  resources: readonly ResourceRow[];
  busy: boolean;
  onSend: (args: SendArgs) => void;
}): ReactElement {
  const [prompt, setPrompt] = useState('');
  const [kind, setKind] = useState<string>('general');
  const [resource, setResource] = useState('');
  const [budget, setBudget] = useState('');

  const submit = (event: FormEvent): void => {
    event.preventDefault();
    const text = prompt.trim();
    if (text === '') return;
    const max = budget.trim() === '' ? Number.NaN : Number(budget);
    onSend({
      kind,
      prompt: text,
      ...(resource === '' ? {} : { preferredResourceIds: [resource] }),
      ...(Number.isFinite(max) && max >= 0 ? { maxCostUsd: max } : {}),
    });
    setPrompt('');
  };

  return (
    <form className="composer" onSubmit={submit}>
      <label className="sr-only" htmlFor="prompt">
        Message
      </label>
      <textarea
        id="prompt"
        className="composer-input"
        rows={3}
        placeholder="Ask Nexar to work on this project…"
        value={prompt}
        onChange={(e) => setPrompt(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) e.currentTarget.form?.requestSubmit();
        }}
      />
      <div className="composer-row">
        <label className="field-inline">
          <span className="small muted">Task</span>
          <select value={kind} onChange={(e) => setKind(e.target.value)} aria-label="Task kind">
            {TASK_KINDS.map((k) => (
              <option key={k} value={k}>
                {k}
              </option>
            ))}
          </select>
        </label>
        <label className="field-inline">
          <span className="small muted">AI</span>
          <select value={resource} onChange={(e) => setResource(e.target.value)} aria-label="AI">
            <option value="">AI: Auto</option>
            {selectableResources(resources).map((r) => (
              <option key={r.id} value={r.id}>
                {r.displayName}
              </option>
            ))}
          </select>
        </label>
        <label className="field-inline">
          <span className="small muted">Budget $</span>
          <input
            className="budget"
            inputMode="decimal"
            placeholder="optional"
            value={budget}
            onChange={(e) => setBudget(e.target.value)}
            aria-label="Budget in US dollars"
          />
        </label>
        <span className="spacer" />
        <button type="submit" className="btn btn-primary" disabled={busy || prompt.trim() === ''}>
          <Icon name="send" size={16} /> Send
        </button>
      </div>
    </form>
  );
}

export function ChatView({
  project,
  resources,
  turns,
  filesOpen,
  onToggleFiles,
  onSend,
  onCancel,
}: {
  project: ProjectDto;
  resources: readonly ResourceRow[];
  turns: readonly Turn[];
  filesOpen: boolean;
  onToggleFiles: () => void;
  onSend: (args: SendArgs) => void;
  onCancel: (requestId: string) => void;
}): ReactElement {
  const endRef = useRef<HTMLDivElement>(null);
  const busy = turns.some((t) => t.status === 'running');
  useEffect(() => {
    endRef.current?.scrollIntoView?.({ block: 'end' });
  }, [turns]);

  return (
    <section className="chat" aria-label="Chat">
      <header className="chat-header">
        <div>
          <div className="chat-title" data-testid="chat-title">
            {project.name}
          </div>
          <div className="muted small mono">{project.root}</div>
        </div>
        <button type="button" className="btn" onClick={onToggleFiles} aria-pressed={filesOpen}>
          <Icon name="panel" size={16} /> {filesOpen ? 'Hide files' : 'Show files'}
        </button>
      </header>
      <div className="messages">
        {turns.length === 0 && (
          <div className="empty-inline">
            <h2>What should Nexar do in {project.name}?</h2>
            <p className="muted">
              Nexar picks the AI for each task and shows you why. Results are saved as drafts in the
              project.
            </p>
          </div>
        )}
        {turns.map((t) => (
          <TurnView key={t.requestId} turn={t} onCancel={onCancel} />
        ))}
        <div ref={endRef} />
      </div>
      <Composer resources={resources} busy={busy} onSend={onSend} />
    </section>
  );
}
