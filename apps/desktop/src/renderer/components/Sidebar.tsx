import type { ReactElement } from 'react';
import type { Mode, ProjectDto } from '../../shared/api.js';
import { formatUsd, type SessionStats, type View } from '../state.js';
import { Icon, type IconName } from './Icon.js';

const SECTIONS: readonly { view: View; label: string; icon: IconName }[] = [
  { view: 'chat', label: 'Chat', icon: 'chat' },
  { view: 'workflows', label: 'Workflows', icon: 'workflow' },
  { view: 'approvals', label: 'Approvals', icon: 'approval' },
  { view: 'resources', label: 'AI resources', icon: 'resources' },
];

function todayCost(stats: SessionStats): string {
  if (stats.costUsd === null) return '—';
  return `${formatUsd(stats.costUsd)}${stats.partial ? ' + unknown' : ''}`;
}

export function Sidebar({
  mode,
  view,
  projects,
  selectedProjectId,
  pendingApprovals,
  stats,
  onMode,
  onView,
  onSelectProject,
  onAddProject,
  onRemoveProject,
  onNewTask,
}: {
  mode: Mode;
  view: View;
  projects: readonly ProjectDto[];
  selectedProjectId: string | null;
  pendingApprovals: number;
  stats: SessionStats;
  onMode: (mode: Mode) => void;
  onView: (view: View) => void;
  onSelectProject: (id: string) => void;
  onAddProject: () => void;
  onRemoveProject: (id: string) => void;
  onNewTask: () => void;
}): ReactElement {
  return (
    <nav className="sidebar" aria-label="Main">
      <div className="wordmark">Nexar</div>
      <div className="segmented mode-switch" role="radiogroup" aria-label="Mode">
        {(['cowork', 'code'] as const).map((m) => (
          <button
            key={m}
            type="button"
            role="radio"
            aria-checked={mode === m}
            className={mode === m ? 'active' : ''}
            data-testid={`mode-${m}`}
            onClick={() => onMode(m)}
          >
            {m === 'cowork' ? 'Cowork' : 'Code'}
          </button>
        ))}
      </div>
      <button type="button" className="btn btn-primary wide" onClick={onNewTask}>
        <Icon name="plus" size={16} /> New task
      </button>

      <div className="side-heading">Projects</div>
      <ul className="project-list" data-testid="project-list">
        {projects.map((p) => (
          <li key={p.id} className={p.id === selectedProjectId ? 'active' : ''}>
            <button
              type="button"
              className="project-item"
              title={p.root}
              aria-current={p.id === selectedProjectId ? 'true' : undefined}
              onClick={() => onSelectProject(p.id)}
            >
              <Icon name="folder" size={16} />
              <span className="ellipsis">{p.name}</span>
            </button>
            <button
              type="button"
              className="icon-btn"
              aria-label={`Remove project ${p.name}`}
              title="Remove from Nexar (files are kept)"
              onClick={() => onRemoveProject(p.id)}
            >
              <Icon name="close" size={14} />
            </button>
          </li>
        ))}
      </ul>
      <button type="button" className="link side-link" onClick={onAddProject}>
        Open folder as project…
      </button>

      <div className="side-heading">Workspace</div>
      <ul className="nav-list">
        {SECTIONS.map((s) => (
          <li key={s.view}>
            <button
              type="button"
              className={`nav-item${view === s.view ? ' active' : ''}`}
              aria-current={view === s.view ? 'page' : undefined}
              data-testid={`nav-${s.view}`}
              onClick={() => onView(s.view)}
            >
              <Icon name={s.icon} />
              <span>{s.label}</span>
              {s.view === 'approvals' && pendingApprovals > 0 && (
                <span className="badge" aria-label={`${pendingApprovals.toString()} pending`}>
                  {pendingApprovals}
                </span>
              )}
            </button>
          </li>
        ))}
      </ul>

      <div className="spacer" />
      <div className="today-card" data-testid="today-card">
        <div className="small muted">Today</div>
        <div className="today-row">
          <span>Tasks</span>
          <span className="strong">{stats.tasks}</span>
        </div>
        <div className="today-row">
          <span>Cost</span>
          <span className="strong">{todayCost(stats)}</span>
        </div>
      </div>
      <button
        type="button"
        className={`nav-item${view === 'settings' ? ' active' : ''}`}
        data-testid="nav-settings"
        onClick={() => onView('settings')}
      >
        <Icon name="settings" />
        <span>Settings</span>
      </button>
    </nav>
  );
}
