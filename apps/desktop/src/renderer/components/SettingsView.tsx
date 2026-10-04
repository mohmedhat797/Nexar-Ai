import { useState, type ReactElement } from 'react';
import {
  DENSITIES,
  THEMES,
  type DesktopSettings,
  type ProjectDto,
  type ResourceRow,
  type ThemeId,
} from '../../shared/api.js';
import { THEME_LABELS, THEME_TOKENS } from '../theme.js';
import { useCodeStatus } from '../useCodeStatus.js';
import { useCoworkStatus } from '../useCoworkStatus.js';
import { BehaviorSettings } from './BehaviorSettings.js';
import { PlaneFacts, PlaneProjectForm } from './CodeStatus.js';
import { COWORK_EXECUTABLE_NOTE, CoworkFacts } from './CoworkStatus.js';
import { ProvidersView } from './ProvidersView.js';

type Tab = 'appearance' | 'behavior' | 'code' | 'cowork' | 'providers';

const TABS: readonly { id: Tab; label: string }[] = [
  { id: 'appearance', label: 'Appearance' },
  { id: 'behavior', label: 'AI behavior' },
  { id: 'code', label: 'Code' },
  { id: 'cowork', label: 'Cowork' },
  { id: 'providers', label: 'Providers' },
];

/** A miniature window painted with the theme's own tokens. */
function ThemePreview({ theme }: { theme: ThemeId }): ReactElement {
  const t = THEME_TOKENS[theme];
  return (
    <span
      className="theme-preview"
      aria-hidden="true"
      style={{ background: t.bg, borderColor: t.line }}
    >
      <span className="tp-side" style={{ background: t.side, borderColor: t.line }}>
        <span style={{ background: t.accent }} />
        <span style={{ background: t.line2 }} />
        <span style={{ background: t.line2 }} />
      </span>
      <span className="tp-main">
        <span className="tp-bubble" style={{ background: t.accentSoft }} />
        <span className="tp-card" style={{ background: t.surface, borderColor: t.line }}>
          <span style={{ background: t.ink }} />
          <span style={{ background: t.muted }} />
        </span>
        <span className="tp-chip" style={{ background: t.okSoft }} />
        <span className="tp-send" style={{ background: t.accent }} />
      </span>
    </span>
  );
}

function Appearance({
  settings,
  onChange,
}: {
  settings: DesktopSettings;
  onChange: (patch: Partial<DesktopSettings>) => void;
}): ReactElement {
  return (
    <div className="stack">
      <h2>Theme</h2>
      <div className="theme-grid" role="radiogroup" aria-label="Theme">
        {THEMES.map((id) => (
          <button
            key={id}
            type="button"
            role="radio"
            aria-checked={settings.theme === id}
            className={`theme-card${settings.theme === id ? ' selected' : ''}`}
            data-testid={`theme-${id}`}
            onClick={() => onChange({ theme: id })}
          >
            <ThemePreview theme={id} />
            <span className="strong">{THEME_LABELS[id]}</span>
          </button>
        ))}
      </div>
      <h2>Density</h2>
      <div className="segmented" role="radiogroup" aria-label="Density">
        {DENSITIES.map((d) => (
          <button
            key={d}
            type="button"
            role="radio"
            aria-checked={settings.density === d}
            className={settings.density === d ? 'active' : ''}
            onClick={() => onChange({ density: d })}
          >
            {d === 'comfortable' ? 'Comfortable' : 'Compact'}
          </button>
        ))}
      </div>
    </div>
  );
}

/** One project's mapping to a plane project, with the lane's state for it. */
function ProjectMapping({ project }: { project: ProjectDto }): ReactElement {
  const code = useCodeStatus(project.id, true);
  const { status } = code;
  const mapped = status?.project?.planeProject;
  return (
    <li className="card stack" data-testid="plane-mapping">
      <div className="row">
        <span className="strong">{project.name}</span>
        <span className="chip" data-testid="plane-mapping-state">
          {status?.project?.state ?? code.error ?? 'checking'}
        </span>
      </div>
      <div className="small muted" data-testid="plane-mapping-current">
        {mapped === undefined ? 'Not mapped to a plane project' : `Plane project: ${mapped}`}
      </div>
      {status !== null && (
        <PlaneProjectForm
          key={mapped ?? ''}
          current={mapped}
          known={status.projects}
          busy={code.loading}
          onSave={code.setPlaneProject}
        />
      )}
    </li>
  );
}

/** The engineering plane's state (read-only) and the per-project mapping. */
function CodeSettings({ projects }: { projects: readonly ProjectDto[] }): ReactElement {
  const code = useCodeStatus(undefined, true);
  return (
    <div className="stack" data-testid="code-settings">
      <h2>Engineering plane</h2>
      <p className="muted">
        The engineering plane runs in the <code>nexar-plane</code> WSL2 distro; its distro and
        command are set in the owner&apos;s desktop settings file.
      </p>
      {code.status === null ? (
        <p className="muted">{code.error ?? 'Checking the engineering plane…'}</p>
      ) : (
        <PlaneFacts status={code.status} />
      )}
      <div className="row">
        <button
          type="button"
          className="btn"
          disabled={code.loading}
          data-testid="code-settings-refresh"
          onClick={code.refresh}
        >
          Refresh
        </button>
        {code.error !== null && code.status !== null && (
          <span className="small bad-text" role="alert">
            {code.error}
          </span>
        )}
      </div>
      <h2>Projects</h2>
      {projects.length === 0 ? (
        <p className="muted">Open a project to map it to a plane project.</p>
      ) : (
        <ul className="stack plain-list">
          {projects.map((p) => (
            <ProjectMapping key={p.id} project={p} />
          ))}
        </ul>
      )}
    </div>
  );
}

/** OpenWorker's state (read-only) for the Cowork lane. */
function CoworkSettings(): ReactElement {
  const cowork = useCoworkStatus(true);
  return (
    <div className="stack" data-testid="cowork-settings">
      <h2>Cowork</h2>
      <p className="muted" data-testid="cowork-note">
        {COWORK_EXECUTABLE_NOTE}
      </p>
      {cowork.status === null ? (
        <p className="muted">{cowork.error ?? 'Checking OpenWorker…'}</p>
      ) : (
        <CoworkFacts status={cowork.status} />
      )}
      <div className="row">
        <button
          type="button"
          className="btn"
          disabled={cowork.loading}
          data-testid="cowork-settings-refresh"
          onClick={cowork.refresh}
        >
          Refresh
        </button>
        {cowork.error !== null && cowork.status !== null && (
          <span className="small bad-text" role="alert">
            {cowork.error}
          </span>
        )}
      </div>
    </div>
  );
}

export function SettingsView({
  settings,
  projects,
  resources,
  onChange,
}: {
  settings: DesktopSettings;
  projects: readonly ProjectDto[];
  resources: readonly ResourceRow[];
  onChange: (patch: Partial<DesktopSettings>) => void;
}): ReactElement {
  const [tab, setTab] = useState<Tab>('appearance');
  return (
    <section className="page" aria-label="Settings">
      <header className="page-header">
        <h1>Settings</h1>
      </header>
      <div className="tabs" role="tablist">
        {TABS.map((t) => (
          <button
            key={t.id}
            type="button"
            role="tab"
            aria-selected={tab === t.id}
            className={tab === t.id ? 'active' : ''}
            onClick={() => setTab(t.id)}
          >
            {t.label}
          </button>
        ))}
      </div>
      {tab === 'appearance' && <Appearance settings={settings} onChange={onChange} />}
      {tab === 'behavior' && <BehaviorSettings resources={resources} />}
      {tab === 'code' && <CodeSettings projects={projects} />}
      {tab === 'cowork' && <CoworkSettings />}
      {tab === 'providers' && <ProvidersView resources={resources} />}
    </section>
  );
}
