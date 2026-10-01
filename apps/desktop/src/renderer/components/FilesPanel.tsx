import { useCallback, useEffect, useState, type ReactElement } from 'react';
import type { FileEntryDto, FilePreview } from '../../shared/api.js';
import { call, errorText, nexar } from '../bridge.js';
import { Icon } from './Icon.js';

interface DirState {
  readonly entries: readonly FileEntryDto[];
  readonly truncated: boolean;
  readonly error?: string;
}

function join(dir: string, name: string): string {
  return dir === '' ? name : `${dir}/${name}`;
}

function Tree({
  projectId,
  dir,
  depth,
  dirs,
  expanded,
  selected,
  onToggle,
  onSelect,
}: {
  projectId: string;
  dir: string;
  depth: number;
  dirs: Readonly<Record<string, DirState>>;
  expanded: ReadonlySet<string>;
  selected: string | null;
  onToggle: (path: string) => void;
  onSelect: (path: string) => void;
}): ReactElement | null {
  const state = dirs[dir];
  if (state === undefined) return <div className="muted small tree-note">Loading…</div>;
  if (state.error !== undefined)
    return <div className="bad-text small tree-note">{state.error}</div>;
  if (state.entries.length === 0) return <div className="muted small tree-note">Empty folder</div>;
  return (
    <ul className="tree" role={depth === 0 ? 'tree' : 'group'}>
      {state.entries.map((entry) => {
        const path = join(dir, entry.name);
        const open = expanded.has(path);
        return (
          <li key={path} role="treeitem" aria-expanded={entry.kind === 'dir' ? open : undefined}>
            <button
              type="button"
              className={`tree-row${selected === path ? ' selected' : ''}`}
              style={{ paddingLeft: 8 + depth * 14 }}
              onClick={() => (entry.kind === 'dir' ? onToggle(path) : onSelect(path))}
            >
              <span className={`tree-chevron${open ? ' open' : ''}`}>
                {entry.kind === 'dir' ? <Icon name="chevron" size={12} /> : null}
              </span>
              <Icon name={entry.kind === 'dir' ? 'folder' : 'file'} size={15} />
              <span className="tree-name">{entry.name}</span>
            </button>
            {entry.kind === 'dir' && open && (
              <Tree
                projectId={projectId}
                dir={path}
                depth={depth + 1}
                dirs={dirs}
                expanded={expanded}
                selected={selected}
                onToggle={onToggle}
                onSelect={onSelect}
              />
            )}
          </li>
        );
      })}
      {state.truncated && <li className="muted small tree-note">Showing the first 500 entries</li>}
    </ul>
  );
}

/** Right-hand panel: one directory level at a time, plus a text preview of the chosen file. */
export function FilesPanel({
  projectId,
  refreshKey,
}: {
  projectId: string;
  /** Changes when something was written (a new draft), so the tree reloads. */
  refreshKey: number;
}): ReactElement {
  const [dirs, setDirs] = useState<Readonly<Record<string, DirState>>>({});
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  const [selected, setSelected] = useState<string | null>(null);
  const [preview, setPreview] = useState<FilePreview | { error: string } | null>(null);

  const load = useCallback(
    (dir: string) => {
      call(nexar.listFiles({ projectId, ...(dir === '' ? {} : { dir }) })).then(
        (listing) =>
          setDirs((d) => ({
            ...d,
            [dir]: { entries: listing.entries, truncated: listing.truncated },
          })),
        (error: unknown) =>
          setDirs((d) => ({
            ...d,
            [dir]: { entries: [], truncated: false, error: errorText(error) },
          })),
      );
    },
    [projectId],
  );

  useEffect(() => {
    setDirs({});
    setExpanded(new Set());
    setSelected(null);
    setPreview(null);
  }, [projectId]);

  useEffect(() => {
    load('');
    for (const dir of expanded) load(dir);
    // Reload on project change or after a write; `expanded` is read, not a trigger.
  }, [load, refreshKey]);

  const toggle = (path: string): void => {
    const next = new Set(expanded);
    if (next.has(path)) next.delete(path);
    else {
      next.add(path);
      load(path);
    }
    setExpanded(next);
  };

  const select = (path: string): void => {
    setSelected(path);
    setPreview(null);
    call(nexar.readFile({ projectId, path })).then(setPreview, (error: unknown) =>
      setPreview({ error: errorText(error) }),
    );
  };

  return (
    <aside className="files" aria-label="Project files" data-testid="files-panel">
      <h2 className="panel-title">Project files</h2>
      <div className="files-tree">
        <Tree
          projectId={projectId}
          dir=""
          depth={0}
          dirs={dirs}
          expanded={expanded}
          selected={selected}
          onToggle={toggle}
          onSelect={select}
        />
      </div>
      {selected !== null && (
        <div className="preview" data-testid="file-preview">
          <div className="preview-title mono small">{selected}</div>
          {preview === null && <div className="muted small">Loading…</div>}
          {preview !== null && 'error' in preview && (
            <div className="muted small">{preview.error}</div>
          )}
          {preview !== null && 'text' in preview && (
            <>
              <pre className="preview-text">{preview.text}</pre>
              {preview.truncated && <div className="muted small">Preview truncated</div>}
            </>
          )}
        </div>
      )}
    </aside>
  );
}
