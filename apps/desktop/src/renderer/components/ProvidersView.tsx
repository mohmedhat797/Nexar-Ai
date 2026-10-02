import { useEffect, useState, type ReactElement } from 'react';
import type { ApiProviderId, ProviderRow } from '../../shared/api.js';
import { call, errorText, nexar } from '../bridge.js';

const PROVIDER_LABELS: Readonly<Record<ApiProviderId, string>> = {
  anthropic: 'Anthropic',
  openai: 'OpenAI',
  google: 'Google / Gemini',
  deepseek: 'DeepSeek',
  openrouter: 'OpenRouter',
  groq: 'Groq',
  mistral: 'Mistral',
  xai: 'xAI',
};

const STATUS_LABELS: Readonly<Record<ProviderRow['status'], string>> = {
  missing: 'Not saved',
  saved: 'Saved',
  unavailable: 'Unavailable',
};

const CHECK_LABELS: Readonly<Record<ProviderRow['keyCheckStatus'], string>> = {
  unchecked: 'Not checked',
  valid: 'Metadata access verified',
  invalid: 'Authentication rejected',
  unavailable: 'Check unavailable',
};

/** Only safe provider metadata reaches this view; clipboard access belongs to main. */
export function ProvidersView(): ReactElement {
  const [rows, setRows] = useState<readonly ProviderRow[]>([]);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState('Loading providers…');

  useEffect(() => {
    let active = true;
    void call(nexar.listProviders())
      .then((providers) => {
        if (active) {
          setRows(providers);
          setStatus('');
        }
      })
      .catch((failure: unknown) => {
        if (active) {
          setError(errorText(failure));
          setStatus('');
        }
      })
      .finally(() => {
        if (active) setBusy(false);
      });
    return () => {
      active = false;
    };
  }, []);

  async function refresh(): Promise<void> {
    setBusy(true);
    setError(null);
    setStatus('Loading providers…');
    try {
      setRows(await call(nexar.listProviders()));
      setStatus('Providers refreshed.');
    } catch (failure) {
      setError(errorText(failure));
      setStatus('');
    } finally {
      setBusy(false);
    }
  }

  async function change(
    provider: ApiProviderId,
    action: 'save' | 'remove' | 'check',
  ): Promise<void> {
    const name = PROVIDER_LABELS[provider];
    let completed = false;
    setBusy(true);
    setError(null);
    const progress = { save: 'Saving', remove: 'Removing', check: 'Checking' }[action];
    setStatus(`${progress} ${name} API key…`);
    try {
      const updated = await call(
        action === 'save'
          ? nexar.saveProviderKeyFromClipboard(provider)
          : action === 'remove'
            ? nexar.removeProviderKey(provider)
            : nexar.checkProviderKey(provider),
      );
      completed = true;
      setRows((current) => current.map((row) => (row.provider === provider ? updated : row)));
      setStatus(
        action === 'check'
          ? `${name}: ${CHECK_LABELS[updated.keyCheckStatus]}.`
          : `${name} API key ${action === 'save' ? 'saved' : 'removed'}.`,
      );
      setRows(await call(nexar.listProviders()));
    } catch (failure) {
      setError(errorText(failure));
      if (!completed) setStatus('');
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="stack" aria-label="Providers" aria-busy={busy}>
      <div className="row">
        <h2>API keys</h2>
        <span className="spacer" />
        <button type="button" className="btn" disabled={busy} onClick={() => void refresh()}>
          Refresh providers
        </button>
      </div>
      <p className="muted">
        Copy your API key, then choose Save from clipboard for its provider. Nexar stores it
        encrypted and clears the clipboard if it still contains that key.
      </p>
      <p className="muted">
        Saved means the key is stored. Check key verifies access to a provider metadata endpoint. It
        performs no generation and does not verify credits or generation permissions. Model counts
        come from the available catalog.
      </p>
      <p className="muted small">
        Saving selects Desktop key storage for discovered API resources. Environment keys are not
        used as a fallback.
      </p>
      <p role="status" aria-live="polite" data-testid="provider-status">
        {status}
      </p>
      {error !== null && (
        <div className="notice notice-bad" role="alert">
          {error}
        </div>
      )}
      <div className="grid" data-testid="providers-list">
        {rows.map((row) => {
          const name = PROVIDER_LABELS[row.provider];
          const hasKey = row.status === 'saved' || row.lastFour !== undefined;
          return (
            <article
              className="card stack"
              key={row.provider}
              data-testid={`provider-${row.provider}`}
            >
              <div className="row">
                <h2>{name}</h2>
                <span className={`chip${row.status === 'unavailable' ? ' chip-warn' : ''}`}>
                  {STATUS_LABELS[row.status]}
                </span>
              </div>
              <div>
                <p>API key{row.lastFour === undefined ? '' : ` · ending in ${row.lastFour}`}</p>
                <p className="muted small">Network: {CHECK_LABELS[row.keyCheckStatus]}</p>
                <p className="muted small">Catalog models: {row.modelCount}</p>
                <p className="muted small">
                  Can be used by:{' '}
                  {row.usableBy.length === 0
                    ? 'No supported runtimes'
                    : row.usableBy
                        .map((runtime) => (runtime === 'pi' ? 'pi-ai' : 'DeepSeek Harness'))
                        .join(', ')}
                </p>
              </div>
              <div className="row">
                <button
                  type="button"
                  className="btn btn-primary"
                  aria-label={`Save ${name} API key from clipboard`}
                  disabled={busy || row.status === 'unavailable'}
                  onClick={() => void change(row.provider, 'save')}
                >
                  Save from clipboard
                </button>
                <button
                  type="button"
                  className="btn"
                  aria-label={`Check ${name} API key`}
                  disabled={busy || row.status !== 'saved'}
                  onClick={() => void change(row.provider, 'check')}
                >
                  Check key
                </button>
                <button
                  type="button"
                  className="btn"
                  aria-label={`Remove ${name} API key`}
                  disabled={busy || !hasKey}
                  onClick={() => void change(row.provider, 'remove')}
                >
                  Remove
                </button>
              </div>
            </article>
          );
        })}
      </div>
      {rows.length === 0 && !busy && error === null && (
        <p className="muted">No API providers available.</p>
      )}
    </section>
  );
}
