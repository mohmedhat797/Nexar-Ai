import { useEffect, useRef, useState, type FormEvent, type ReactElement } from 'react';
import type { Mode, ProjectDto, ResourceRow, SessionDto } from '../../shared/api.js';
import type { SendArgs } from '../useSessions.js';
import { pendingFor } from '../code.js';
import { useCodeStatus } from '../useCodeStatus.js';
import { useCoworkStatus } from '../useCoworkStatus.js';
import { usePlaneApprovals } from '../usePlaneApprovals.js';
import { CodeBanner } from './CodeStatus.js';
import { CoworkBanner } from './CoworkStatus.js';
import { Icon } from './Icon.js';
import { SessionTurnView } from './SessionTurnView.js';

/** `general` is the default: Nexar decides from the message. Anything else is an explicit choice. */
const KIND_LABEL: Readonly<Record<string, string>> = { general: 'Auto (Nexar decides)' };
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
  onSend: (args: SendArgs) => Promise<void>;
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
    // The text stays in the box until the turn is stored, so a failed send can be retried.
    onSend({
      kind,
      prompt: text,
      ...(resource === '' ? {} : { preferredResourceIds: [resource] }),
      ...(Number.isFinite(max) && max >= 0 ? { maxCostUsd: max } : {}),
    }).then(
      // Clear only what was sent: the reply can arrive after the owner has typed the next message.
      () => setPrompt((current) => (current.trim() === text ? '' : current)),
      () => undefined,
    );
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
                {KIND_LABEL[k] ?? k}
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
  mode,
  project,
  resources,
  session,
  progress,
  busy,
  error,
  filesOpen,
  onToggleFiles,
  onSend,
  onCancel,
  onConfirm,
  onSetMode,
  onApprovalsChanged,
}: {
  /** The sidebar mode, used for new conversations. */
  mode: Mode;
  project: ProjectDto;
  resources: readonly ResourceRow[];
  session: SessionDto | null;
  progress: Readonly<Record<string, readonly string[]>>;
  busy: boolean;
  error: string | null;
  filesOpen: boolean;
  onToggleFiles: () => void;
  onSend: (args: SendArgs) => Promise<void>;
  onCancel: (turnId: string) => void;
  onConfirm: (turnId: string, decision: 'confirm' | 'decline') => Promise<void>;
  onSetMode: (mode: Mode) => Promise<void>;
  onApprovalsChanged: () => void;
}): ReactElement {
  const endRef = useRef<HTMLDivElement>(null);
  const turns = session?.turns ?? [];
  // The Code banner belongs to Code conversations, and to the mode new conversations will use.
  const codeView = (session?.mode ?? mode) === 'code' || mode === 'code';
  const code = useCodeStatus(project.id, codeView);
  const coworkView = (session?.mode ?? mode) === 'cowork' || mode === 'cowork';
  const cowork = useCoworkStatus(coworkView);
  const planeApprovals = usePlaneApprovals(session);
  const approvalsChanged = (): void => {
    planeApprovals.reload();
    onApprovalsChanged();
  };
  useEffect(() => {
    endRef.current?.scrollIntoView?.({ block: 'end' });
  }, [session, progress]);

  return (
    <section className="chat" aria-label="Chat">
      <header className="chat-header">
        <div>
          <div className="chat-title" data-testid="chat-title">
            {project.name}
          </div>
          <div className="muted small mono">{project.root}</div>
        </div>
        <div className="chat-header-actions">
          {session !== null && (
            <div
              className="segmented session-mode"
              role="radiogroup"
              aria-label="Conversation mode"
              title="Mode of this conversation; a change applies from the next message"
            >
              {(['cowork', 'code'] as const).map((m) => (
                <button
                  key={m}
                  type="button"
                  role="radio"
                  aria-checked={session.mode === m}
                  className={session.mode === m ? 'active' : ''}
                  data-testid={`session-mode-${m}`}
                  onClick={() => void onSetMode(m)}
                >
                  {m === 'cowork' ? 'Cowork' : 'Code'}
                </button>
              ))}
            </div>
          )}
          <button type="button" className="btn" onClick={onToggleFiles} aria-pressed={filesOpen}>
            <Icon name="panel" size={16} /> {filesOpen ? 'Hide files' : 'Show files'}
          </button>
        </div>
      </header>
      {coworkView && <CoworkBanner cowork={cowork} />}
      {codeView && <CodeBanner code={code} />}
      <div className="messages">
        {error !== null && (
          <div className="notice notice-bad" role="alert" data-testid="chat-error">
            {error}
          </div>
        )}
        {turns.length === 0 && (
          <div className="empty-inline">
            <h2>What should Nexar do in {project.name}?</h2>
            <p className="muted">
              Nexar picks the AI for each task and shows you why. Results are saved as drafts in the
              project, and this conversation is kept so you can come back to it.
            </p>
          </div>
        )}
        {turns.map((t) => (
          <SessionTurnView
            key={t.id}
            projectId={project.id}
            sessionId={session?.id ?? ''}
            turn={t}
            lines={progress[t.id] ?? []}
            approval={pendingFor(planeApprovals.approvals, session?.id ?? '', t.id)}
            onCancel={onCancel}
            onConfirm={onConfirm}
            onApprovalChanged={approvalsChanged}
          />
        ))}
        <div ref={endRef} />
      </div>
      <Composer resources={resources} busy={busy} onSend={onSend} />
    </section>
  );
}
