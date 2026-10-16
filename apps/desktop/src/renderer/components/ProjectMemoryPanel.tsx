import { useState, type FormEvent, type ReactElement } from 'react';
import type { ProjectMemoryKindDto } from '../../shared/api.js';
import { useProjectMemory } from '../useProjectMemory.js';

const KINDS: readonly { readonly value: ProjectMemoryKindDto; readonly label: string }[] = [
  { value: 'constraint', label: 'Constraint' },
  { value: 'decision', label: 'Decision' },
  { value: 'requirement', label: 'Requirement' },
  { value: 'review-obligation', label: 'Review obligation' },
  { value: 'pending-work', label: 'Pending work' },
];

const MAX_TEXT = 1000;

/** Owner-confirmed knowledge that goes into every turn, in every mode (ADR-030 §7). */
export function ProjectMemoryPanel({ projectId }: { projectId: string }): ReactElement {
  const memory = useProjectMemory(projectId);
  const [kind, setKind] = useState<ProjectMemoryKindDto>('constraint');
  const [text, setText] = useState('');

  const submit = (event: FormEvent): void => {
    event.preventDefault();
    const value = text.trim();
    if (value === '') return;
    void memory.add(kind, value).then((ok) => {
      if (ok) setText('');
    });
  };

  return (
    <details className="project-memory" data-testid="project-memory">
      <summary>Project memory ({memory.entries.length})</summary>
      <p className="muted small">
        Saved by you and sent with every message, in Cowork and Code, so it is never forgotten.
      </p>
      {memory.error !== null && (
        <div className="notice notice-bad" role="alert" data-testid="project-memory-error">
          {memory.error}
        </div>
      )}
      <ul className="project-memory-list">
        {memory.entries.map((entry) => (
          <li key={entry.id} data-testid="project-memory-entry">
            <span className="muted small">
              {KINDS.find((k) => k.value === entry.kind)?.label ?? entry.kind}
            </span>{' '}
            <span>{entry.text}</span>{' '}
            <button
              type="button"
              className="btn"
              aria-label="Remove memory entry"
              onClick={() => void memory.remove(entry.id)}
            >
              Remove
            </button>
          </li>
        ))}
      </ul>
      <form className="project-memory-form" onSubmit={submit}>
        <select
          aria-label="Memory kind"
          value={kind}
          onChange={(e) => setKind(e.target.value as ProjectMemoryKindDto)}
        >
          {KINDS.map((k) => (
            <option key={k.value} value={k.value}>
              {k.label}
            </option>
          ))}
        </select>
        <input
          aria-label="Memory text"
          data-testid="project-memory-text"
          value={text}
          maxLength={MAX_TEXT}
          onChange={(e) => setText(e.target.value)}
          placeholder="Something Nexar must always remember for this project"
        />
        <button type="submit" className="btn" disabled={text.trim() === ''}>
          Add
        </button>
      </form>
    </details>
  );
}
