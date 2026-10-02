import { useEffect, useRef, useState, type FormEvent, type ReactElement } from 'react';
import type { LocalEndpointRow } from '../../shared/api.js';
import { call, errorText, nexar } from '../bridge.js';

const KIND_LABELS: Readonly<Record<LocalEndpointRow['kind'], string>> = {
  ollama: 'Ollama',
  'openai-compatible': 'OpenAI-compatible',
};

/** Addresses and catalog counts only; setup supports keyless pi endpoints. */
export function LocalEndpointsView(): ReactElement {
  const [rows, setRows] = useState<readonly LocalEndpointRow[]>([]);
  const [kind, setKind] = useState<LocalEndpointRow['kind']>('ollama');
  const [baseUrl, setBaseUrl] = useState('');
  const [selectedId, setSelectedId] = useState<string | undefined>();
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState('Loading servers…');
  const mounted = useRef(false);
  const working = useRef(true);

  useEffect(() => {
    mounted.current = true;
    let active = true;
    void call(nexar.listLocalEndpoints())
      .then((endpoints) => {
        if (active) {
          setRows(endpoints);
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
        if (active) {
          working.current = false;
          setBusy(false);
        }
      });
    return () => {
      active = false;
      mounted.current = false;
    };
  }, []);

  function reset(): void {
    setSelectedId(undefined);
    setKind('ollama');
    setBaseUrl('');
  }

  async function change(action: 'save' | 'remove' | 'refresh', id?: string): Promise<void> {
    if (working.current) return;
    working.current = true;
    setBusy(true);
    setError(null);
    setStatus(
      action === 'save'
        ? 'Saving server…'
        : action === 'remove'
          ? 'Removing server…'
          : 'Refreshing models…',
    );
    try {
      const endpoints = await call(
        action === 'save'
          ? nexar.saveLocalEndpoint({
              ...(selectedId === undefined ? {} : { id: selectedId }),
              kind,
              baseUrl,
            })
          : action === 'remove' && id !== undefined
            ? nexar.removeLocalEndpoint(id)
            : nexar.refreshLocalEndpoints(),
      );
      if (!mounted.current) return;
      setRows(endpoints);
      setStatus(
        action === 'save'
          ? 'Server saved.'
          : action === 'remove'
            ? 'Server removed.'
            : 'Model catalog refreshed.',
      );
      if (action === 'save' || (action === 'remove' && id === selectedId)) reset();
    } catch (failure) {
      if (mounted.current) {
        setError(errorText(failure));
        setStatus('');
      }
    } finally {
      working.current = false;
      if (mounted.current) setBusy(false);
    }
  }

  function save(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    void change('save');
  }

  function edit(row: LocalEndpointRow): void {
    setSelectedId(row.id);
    setKind(row.kind);
    setBaseUrl(row.baseUrl);
    setError(null);
    setStatus('Editing server.');
  }

  return (
    <section className="stack" aria-label="Local and custom servers" aria-busy={busy}>
      <div className="row">
        <h2>Local / Custom servers</h2>
        <span className="spacer" />
        <button
          type="button"
          className="btn"
          disabled={busy}
          onClick={() => void change('refresh')}
        >
          Refresh models
        </button>
      </div>
      <p className="muted">
        Add an Ollama or OpenAI-compatible server, such as LM Studio. Nexar contacts only addresses
        you list and never scans your network.
      </p>
      <p className="muted small">
        This setup supports keyless access through pi-ai only. Addresses cannot contain credentials,
        query parameters or fragments. OpenAI-compatible addresses may end in /v1.
      </p>
      <p className="muted small">
        Counts show cached discovered models. Zero does not prove a server is offline or
        authenticated. A remote address may send your tasks outside this computer.
      </p>
      <form className="card stack" onSubmit={save}>
        <label className="stack">
          Server type
          <select
            aria-label="Server type"
            value={kind}
            disabled={busy}
            onChange={(event) =>
              setKind(event.target.value === 'ollama' ? 'ollama' : 'openai-compatible')
            }
          >
            <option value="ollama">Ollama</option>
            <option value="openai-compatible">OpenAI-compatible / LM Studio</option>
          </select>
        </label>
        <label className="stack">
          Server address
          <input
            aria-label="Server address"
            type="url"
            inputMode="url"
            autoComplete="off"
            required
            maxLength={2048}
            value={baseUrl}
            disabled={busy}
            placeholder={kind === 'ollama' ? 'http://127.0.0.1:11434' : 'http://127.0.0.1:1234/v1'}
            onChange={(event) => setBaseUrl(event.target.value)}
          />
        </label>
        <div className="row">
          <button
            type="submit"
            className="btn btn-primary"
            disabled={busy || baseUrl.trim() === ''}
          >
            {selectedId === undefined ? 'Add server' : 'Save server'}
          </button>
          {selectedId !== undefined && (
            <button type="button" className="btn" disabled={busy} onClick={reset}>
              Cancel edit
            </button>
          )}
        </div>
      </form>
      <p role="status" aria-live="polite" data-testid="endpoint-status">
        {status}
      </p>
      {error !== null && (
        <div className="notice notice-bad" role="alert">
          {error}
        </div>
      )}
      <div className="grid" data-testid="endpoints-list">
        {rows.map((row) => (
          <article className="card stack" key={row.id} data-testid={`endpoint-${row.id}`}>
            <div className="row">
              <h2>{KIND_LABELS[row.kind]}</h2>
              <span className={`chip${row.enabled ? '' : ' chip-warn'}`}>
                Discovery {row.enabled ? 'enabled' : 'disabled'}
              </span>
            </div>
            <p>{row.baseUrl}</p>
            <p className="muted small">Discovered models: {row.modelCount}</p>
            <p className="muted small">Can be used by: pi-ai · No authentication</p>
            <div className="row">
              <button
                type="button"
                className="btn"
                aria-label={`Edit server ${row.id}`}
                disabled={busy}
                onClick={() => edit(row)}
              >
                Edit
              </button>
              <button
                type="button"
                className="btn"
                aria-label={`Remove server ${row.id}`}
                disabled={busy}
                onClick={() => void change('remove', row.id)}
              >
                Remove
              </button>
            </div>
          </article>
        ))}
      </div>
      {rows.length === 0 && !busy && error === null && (
        <p className="muted">No servers configured.</p>
      )}
    </section>
  );
}
