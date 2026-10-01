import { useState, type ReactElement } from 'react';
import { DENSITIES, THEMES, type DesktopSettings, type ThemeId } from '../../shared/api.js';
import { THEME_LABELS, THEME_TOKENS } from '../theme.js';

type Tab = 'appearance' | 'behavior' | 'providers';

const TABS: readonly { id: Tab; label: string }[] = [
  { id: 'appearance', label: 'Appearance' },
  { id: 'behavior', label: 'AI behavior' },
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

function ComingSoon({
  title,
  ticket,
  text,
}: {
  title: string;
  ticket: string;
  text: string;
}): ReactElement {
  return (
    <div className="empty-inline">
      <h2>{title}</h2>
      <p className="muted">
        Coming in the next phase ({ticket}). {text}
      </p>
    </div>
  );
}

export function SettingsView({
  settings,
  onChange,
}: {
  settings: DesktopSettings;
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
      {tab === 'behavior' && (
        <ComingSoon
          title="AI behavior"
          ticket="NXR-053"
          text="Default agent, model, reasoning effort and permission mode per mode."
        />
      )}
      {tab === 'providers' && (
        <ComingSoon
          title="Providers"
          ticket="NXR-052"
          text="Connect providers without ever exposing keys to this window."
        />
      )}
    </section>
  );
}
