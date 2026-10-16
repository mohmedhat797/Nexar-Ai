import { useEffect, useState, type ReactElement } from 'react';
import type { ApiProviderId, ProviderRow, ResourceRow, SubscriptionRow } from '../../shared/api.js';
import { call, errorText, nexar } from '../bridge.js';
import { NOT_AVAILABLE_REASON, groupProviderCards } from '../providers-model.js';
import { useCodeStatus } from '../useCodeStatus.js';
import { ChatGptPlanMethod } from './ChatGptPlanMethod.js';
import { LocalEndpointsView } from './LocalEndpointsView.js';
import { PlaneResources } from './PlaneResources.js';

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

type SubscriptionRuntimeId = SubscriptionRow['runtime'];
const SUBSCRIPTION_RUNTIMES = ['claude-code', 'codex', 'antigravity'] as const;
const RUNTIME_LABELS: Readonly<Record<SubscriptionRuntimeId, string>> = {
  'claude-code': 'Claude Code',
  codex: 'Codex',
  antigravity: 'Antigravity / Google',
};
const SUBSCRIPTION_LABELS: Readonly<Record<SubscriptionRow['status'], string>> = {
  connected: 'Connected',
  'not-connected': 'Not connected',
  unknown: 'Unknown',
  unavailable: 'Unavailable',
};
const AUTH_LABELS: Readonly<Record<SubscriptionRow['authMode'], string>> = {
  'vendor-account': 'Vendor account',
  'api-key': 'API key',
  none: 'Signed out',
  unknown: 'Unknown',
};
const LOGIN_LABELS: Readonly<Record<SubscriptionRow['loginState'], string>> = {
  idle: 'Not running',
  running: 'Running',
  succeeded: 'Finished',
  failed: 'Failed',
  cancelled: 'Cancelled',
  'timed-out': 'Timed out',
  unavailable: 'Unavailable',
};

type SubscriptionAction = 'start' | 'cancel' | 'refresh';

interface Subscriptions {
  readonly rows: readonly SubscriptionRow[];
  readonly loaded: boolean;
  readonly busy: boolean;
  readonly error: string | null;
  readonly status: string;
  readonly change: (runtime: SubscriptionRuntimeId, action: SubscriptionAction) => Promise<void>;
}

function useSubscriptions(): Subscriptions {
  const [rows, setRows] = useState<readonly SubscriptionRow[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState('Loading subscriptions…');
  const running = rows
    .filter((row) => row.loginState === 'running')
    .map((row) => row.runtime)
    .join(',');

  useEffect(() => {
    let active = true;
    void call(nexar.listSubscriptions())
      .then((subscriptions) => {
        if (active) {
          setRows(subscriptions);
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
          setLoaded(true);
          setBusy(false);
        }
      });
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    if (busy || running === '') return;
    let active = true;
    let timer: ReturnType<typeof setTimeout>;
    const runtimes = SUBSCRIPTION_RUNTIMES.filter((runtime) =>
      running.split(',').includes(runtime),
    );
    async function poll(): Promise<void> {
      for (const runtime of runtimes) {
        if (!active) return;
        try {
          const updated = await call(nexar.refreshSubscription(runtime));
          if (active) {
            setRows((current) => current.map((row) => (row.runtime === runtime ? updated : row)));
            if (updated.loginState !== 'running')
              setStatus(`${RUNTIME_LABELS[runtime]} login: ${LOGIN_LABELS[updated.loginState]}.`);
          }
        } catch (failure) {
          if (active) setError(errorText(failure));
        }
      }
      if (active) timer = setTimeout(() => void poll(), 1000);
    }
    timer = setTimeout(() => void poll(), 1000);
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [running, busy]);

  async function change(runtime: SubscriptionRuntimeId, action: SubscriptionAction): Promise<void> {
    setBusy(true);
    setError(null);
    setStatus(
      `${RUNTIME_LABELS[runtime]}: ${action === 'start' ? 'Opening vendor sign-in' : action === 'cancel' ? 'Cancelling login' : 'Checking native authentication'}…`,
    );
    try {
      const updated = await call(
        action === 'start'
          ? nexar.startSubscriptionLogin(runtime)
          : action === 'cancel'
            ? nexar.cancelSubscriptionLogin(runtime)
            : nexar.refreshSubscription(runtime),
      );
      setRows((current) => current.map((row) => (row.runtime === runtime ? updated : row)));
      setStatus(
        `${RUNTIME_LABELS[runtime]}: ${SUBSCRIPTION_LABELS[updated.status]}. Login: ${LOGIN_LABELS[updated.loginState]}.`,
      );
    } catch (failure) {
      setError(errorText(failure));
      setStatus('');
    } finally {
      setBusy(false);
    }
  }

  return { rows, loaded, busy, error, status, change };
}

/** The Subscription method of a provider card: native vendor sign-in status and actions. */
function SubscriptionMethod({
  row,
  busy,
  onChange,
}: {
  row: SubscriptionRow;
  busy: boolean;
  onChange: (runtime: SubscriptionRuntimeId, action: SubscriptionAction) => Promise<void>;
}): ReactElement {
  const name = RUNTIME_LABELS[row.runtime];
  const isRunning = row.loginState === 'running';
  return (
    <div className="stack" data-testid={`subscription-${row.runtime}`}>
      <div className="row">
        <span className="strong">Subscription · {name}</span>
        <span className={`chip${row.status === 'unavailable' ? ' chip-warn' : ''}`}>
          {SUBSCRIPTION_LABELS[row.status]}
        </span>
      </div>
      <p>Native authentication: {AUTH_LABELS[row.authMode]}</p>
      {row.version !== undefined && <p className="muted small">CLI version: {row.version}</p>}
      <p className="muted small">Can be used by: {RUNTIME_LABELS[row.usableBy]}</p>
      <p role="status" aria-live="polite">
        Login: {LOGIN_LABELS[row.loginState]}
      </p>
      {!row.loginSupported && (
        <p className="muted small">
          {row.runtime === 'antigravity'
            ? 'The native Google CLI sign-in flow is not implemented in Nexar.'
            : 'Vendor browser sign-in is unavailable for this runtime.'}
        </p>
      )}
      <div className="row">
        <button
          type="button"
          className="btn btn-primary"
          aria-label={`Sign in to ${name}`}
          disabled={busy || !row.loginSupported || isRunning || row.status === 'unavailable'}
          onClick={() => void onChange(row.runtime, 'start')}
        >
          Sign in
        </button>
        <button
          type="button"
          className="btn"
          aria-label={`Cancel ${name} sign-in`}
          disabled={busy || !isRunning}
          onClick={() => void onChange(row.runtime, 'cancel')}
        >
          Cancel
        </button>
        <button
          type="button"
          className="btn"
          aria-label={`Recheck ${name} authentication`}
          disabled={busy}
          onClick={() => void onChange(row.runtime, 'refresh')}
        >
          Recheck
        </button>
      </div>
      <ModelInventory
        sourceId={row.runtime}
        native
        disabled={isRunning}
        revision={`${row.status}:${row.loginState}`}
      />
    </div>
  );
}

/** The API key method of a provider card; only safe provider metadata reaches this view. */
function ApiKeyMethod({
  row,
  busy,
  onChange,
}: {
  row: ProviderRow;
  busy: boolean;
  onChange: (provider: ApiProviderId, action: 'save' | 'remove' | 'check') => Promise<void>;
}): ReactElement {
  const name = PROVIDER_LABELS[row.provider];
  const hasKey = row.status === 'saved' || row.lastFour !== undefined;
  return (
    <div className="stack" data-testid={`provider-${row.provider}`}>
      <div className="row">
        <span className="strong">API key</span>
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
          onClick={() => void onChange(row.provider, 'save')}
        >
          Save from clipboard
        </button>
        <button
          type="button"
          className="btn"
          aria-label={`Check ${name} API key`}
          disabled={busy || row.status !== 'saved'}
          onClick={() => void onChange(row.provider, 'check')}
        >
          Check key
        </button>
        <button
          type="button"
          className="btn"
          aria-label={`Remove ${name} API key`}
          disabled={busy || !hasKey}
          onClick={() => void onChange(row.provider, 'remove')}
        >
          Remove
        </button>
      </div>
    </div>
  );
}

/**
 * Settings → Providers: one card per provider with the connection methods Desktop supports for
 * it (ADR-027 section 3), then the engineering plane's resources, read-only.
 */
export function ProvidersView({ resources }: { resources: readonly ResourceRow[] }): ReactElement {
  const subscriptions = useSubscriptions();
  const plane = useCodeStatus(undefined, true);
  const [rows, setRows] = useState<readonly ProviderRow[]>([]);
  const [loaded, setLoaded] = useState(false);
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
        if (active) {
          setLoaded(true);
          setBusy(false);
        }
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

  const cards = groupProviderCards({ keys: rows, subscriptions: subscriptions.rows, resources });
  const ready = loaded && subscriptions.loaded;

  return (
    <div className="stack">
      <section className="stack" aria-label="Providers" aria-busy={busy}>
        <div className="row">
          <h2>Providers</h2>
          <span className="spacer" />
          <button type="button" className="btn" disabled={busy} onClick={() => void refresh()}>
            Refresh providers
          </button>
        </div>
        <p className="muted">
          Each provider lists the ways Nexar can connect to it. Subscription status reports native
          vendor-account authentication, not a paid plan, credits or remaining quota. Sign-in opens
          the vendor’s own browser flow.
        </p>
        <p className="muted small">
          Subscriptions work only with their own native agent. They never become API keys and cannot
          power pi-ai or DeepSeek Harness.
        </p>
        <p className="muted">
          Copy your API key, then choose Save from clipboard for its provider. Nexar stores it
          encrypted and clears the clipboard if it still contains that key.
        </p>
        <p className="muted">
          Saved means the key is stored. Check key verifies access to a provider metadata endpoint.
          It performs no generation and does not verify credits or generation permissions. Model
          counts come from the available catalog.
        </p>
        <p className="muted small">
          Saving selects Desktop key storage for discovered API resources. Environment keys are not
          used as a fallback.
        </p>
        <p role="status" aria-live="polite" data-testid="subscription-status">
          {subscriptions.status}
        </p>
        <p role="status" aria-live="polite" data-testid="provider-status">
          {status}
        </p>
        {subscriptions.error !== null && (
          <div className="notice notice-bad" role="alert">
            {subscriptions.error}
          </div>
        )}
        {error !== null && (
          <div className="notice notice-bad" role="alert">
            {error}
          </div>
        )}
        <div className="grid" data-testid="providers-list">
          {cards.map((card) => (
            <article
              className="card stack"
              key={card.id}
              data-testid={`provider-card-${card.id}`}
              aria-label={card.label}
            >
              <div className="row">
                <h2>{card.label}</h2>
                <span className="spacer" />
                <span className="chip" data-testid={`provider-card-resources-${card.id}`}>
                  Resources: {card.resourceCount}
                </span>
              </div>
              {card.subscription !== undefined && (
                <SubscriptionMethod
                  row={card.subscription}
                  busy={subscriptions.busy}
                  onChange={subscriptions.change}
                />
              )}
              {card.apiKey !== undefined && (
                <ApiKeyMethod row={card.apiKey} busy={busy} onChange={change} />
              )}
              {card.chatgptPlan && <ChatGptPlanMethod />}
              {card.local && <LocalEndpointsView />}
              {card.notAvailable && ready && (
                <p className="muted" data-testid={`provider-unavailable-${card.id}`}>
                  Not available. {NOT_AVAILABLE_REASON}
                </p>
              )}
            </article>
          ))}
        </div>
        {rows.length === 0 && !busy && error === null && (
          <p className="muted">No API providers available.</p>
        )}
      </section>
      <PlaneResources status={plane.status} error={plane.error} />
    </div>
  );
}
import { ModelInventory } from './ModelInventory.js';
