import { useEffect, useState, type ReactElement } from 'react';
import { API_PROVIDER_IDS, type ApiProviderId } from '../../shared/providers.js';
import type {
  ConnectionConfirmation,
  ConnectionDto,
  ConnectionPrepareArgs,
} from '../../shared/connections.js';
import { call, errorText, nexar } from '../bridge.js';

export type ConnectionIntent = { readonly connectionId?: string; readonly plan?: true };
const ASSURANCE: Readonly<Record<ConnectionDto['identityAssurance'], string>> = {
  VERIFIED_SAME_ACCOUNT: 'Provider-verified account binding',
  OWNER_ASSERTED_SAME_ACCOUNT: 'Owner asserted same account',
  VERIFIED_DIFFERENT_ACCOUNT: 'Different account — rejected',
  IDENTITY_UNKNOWN: 'Unknown',
};

/** Minimal B′ management: no routing policy, native-home management, or credential persistence in renderer. */
export function ConnectionManagement({
  revision,
  intent,
  onIntentHandled,
  onChanged,
}: {
  revision: number;
  intent: ConnectionIntent | null;
  onIntentHandled: () => void;
  onChanged: () => void;
}): ReactElement {
  const [rows, setRows] = useState<readonly ConnectionDto[]>([]),
    [busy, setBusy] = useState(false),
    [error, setError] = useState<string | null>(null);
  const [provider, setProvider] = useState<ApiProviderId>('openai'),
    [label, setLabel] = useState(''),
    [key, setKey] = useState('');
  const [rotation, setRotation] = useState<ConnectionDto | null>(null),
    [sameAccount, setSameAccount] = useState(false);
  const [confirmation, setConfirmation] = useState<ConnectionConfirmation | null>(null),
    [confirmationName, setConfirmationName] = useState('');
  async function reload(): Promise<void> {
    setRows(await call(nexar.listConnections()));
  }
  useEffect(() => {
    let active = true;
    void call(nexar.listConnections())
      .then((value) => {
        if (active) setRows(value);
      })
      .catch((failure) => {
        if (active) setError(errorText(failure));
      });
    return () => {
      active = false;
    };
  }, [revision]);
  useEffect(() => {
    if (intent === null) return;
    let active = true;
    setBusy(true);
    setError(null);
    void (async () => {
      const current = await call(nexar.listConnections());
      const target = intent.plan
        ? current.find(
            (r) => r.authClass === 'official-account' && r.lifecycleState !== 'TOMBSTONED',
          )
        : current.find((r) => r.id === intent.connectionId);
      if (target === undefined) throw Error('Connection unavailable');
      const ticket = await call(
        nexar.prepareConnectionAction({ connectionId: target.id, action: 'forget' }),
      );
      if (active) {
        setRows(current);
        setConfirmationName('');
        setConfirmation(ticket);
      }
    })()
      .catch((failure) => {
        if (active) setError(errorText(failure));
      })
      .finally(() => {
        if (active) {
          setBusy(false);
          onIntentHandled();
        }
      });
    return () => {
      active = false;
    };
  }, [intent]);
  async function perform(operation: () => Promise<unknown>): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      await operation();
      await reload();
      onChanged();
    } catch (failure) {
      setError(errorText(failure));
      await reload().catch(() => undefined);
    } finally {
      setBusy(false);
    }
  }
  async function prepare(
    row: ConnectionDto,
    action: ConnectionPrepareArgs['action'],
  ): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      setConfirmation(await call(nexar.prepareConnectionAction({ connectionId: row.id, action })));
      setConfirmationName('');
    } catch (failure) {
      setError(errorText(failure));
    } finally {
      setBusy(false);
    }
  }
  function cancel(): void {
    setConfirmation(null);
    setConfirmationName('');
    setRotation(null);
    setKey('');
    setSameAccount(false);
  }
  async function confirm(): Promise<void> {
    const ticket = confirmation;
    if (ticket === null) return;
    setConfirmation(null);
    setConfirmationName('');
    const args = {
      connectionId: ticket.connectionId,
      confirmation: ticket.token,
      confirmationName,
    };
    await perform(async () => {
      if (ticket.action === 'remove') await call(nexar.removeConnection(args));
      else if (ticket.action === 'forget') await call(nexar.forgetConnectionCredentials(args));
      else await call(nexar.replaceChatGptPlanAccount(args));
    });
  }
  return (
    <section className="stack" aria-label="Connections" aria-busy={busy}>
      <div className="row">
        <h3>Connections</h3>
        <button type="button" className="btn" disabled={busy} onClick={() => void perform(reload)}>
          Refresh connections
        </button>
      </div>
      <p className="muted">
        Each connection keeps its own account identity. Saved keys are not proof of authentication,
        reachability, quota, or account verification.
      </p>
      {error !== null && (
        <div className="notice notice-bad" role="alert">
          {error}
        </div>
      )}
      <form
        className="stack"
        aria-label={rotation === null ? 'Add API connection' : 'Rotate connection credential'}
        onSubmit={(event) => {
          event.preventDefault();
          if (busy || key.length < 16 || (rotation !== null && !sameAccount)) return;
          const secret = key;
          setKey('');
          if (rotation === null) {
            void perform(async () => {
              await call(nexar.addConnection({ provider, label, apiKey: secret }));
              setLabel('');
            });
          } else {
            const target = rotation;
            setRotation(null);
            setSameAccount(false);
            void perform(() =>
              call(
                nexar.rotateConnectionKey({
                  connectionId: target.id,
                  apiKey: secret,
                  sameAccount: true,
                }),
              ),
            );
          }
        }}
      >
        {rotation === null ? (
          <>
            <label>
              Connection provider
              <select
                aria-label="Connection provider"
                value={provider}
                onChange={(event) => setProvider(event.target.value as ApiProviderId)}
                disabled={busy}
              >
                {API_PROVIDER_IDS.map((id) => (
                  <option key={id} value={id}>
                    {id}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Connection label
              <input
                aria-label="Connection label"
                value={label}
                maxLength={128}
                required
                disabled={busy}
                onChange={(event) => setLabel(event.target.value)}
              />
            </label>
          </>
        ) : (
          <p>
            Rotate or re-enter credentials for <strong>{rotation.label}</strong>. A different
            account needs a new connection.
          </p>
        )}
        <label>
          Connection API key
          <input
            type="password"
            aria-label="Connection API key"
            autoComplete="new-password"
            spellCheck={false}
            value={key}
            minLength={16}
            maxLength={4096}
            required
            disabled={busy}
            onChange={(event) => setKey(event.target.value)}
          />
        </label>
        {rotation !== null && (
          <label>
            <input
              type="checkbox"
              checked={sameAccount}
              disabled={busy}
              onChange={(event) => setSameAccount(event.target.checked)}
            />
            I confirm this key belongs to the same account
          </label>
        )}
        <div className="row">
          <button
            className="btn btn-primary"
            type="submit"
            disabled={busy || key.length < 16 || (rotation !== null && !sameAccount)}
          >
            {rotation === null ? 'Add connection' : 'Confirm rotation'}
          </button>
          {rotation !== null && (
            <button className="btn" type="button" disabled={busy} onClick={cancel}>
              Cancel rotation
            </button>
          )}
        </div>
      </form>
      {confirmation !== null && (
        <div
          className="card stack"
          role="dialog"
          aria-modal="false"
          aria-label="Confirm connection action"
        >
          <h4>
            Confirm {confirmation.action}: {confirmation.label}
          </h4>
          <p>
            {confirmation.action === 'remove'
              ? 'The connection will be removed. Its credentials are retained; its saved pins remain unavailable until the same account is restored.'
              : confirmation.action === 'forget'
                ? 'Delete only this connection’s local credentials. The account association and history remain. This does not revoke vendor access.'
                : 'Permanently retire this Plan identity and forget its tokens and binding. Historical sessions and pins stay under the old identity. A new identity is created for a future sign-in; accounts are never redirected.'}
          </p>
          <strong>Affected saved pins and preferences</strong>
          {confirmation.affectedPins.length === 0 ? (
            <p>
              No current saved pins or preferences were found. Historical references are retained.
            </p>
          ) : (
            <ul>
              {confirmation.affectedPins.map((pin, index) => (
                <li key={index}>{pin}</li>
              ))}
            </ul>
          )}
          {confirmation.action === 'forget' && (
            <label>
              Type {confirmation.label} to confirm
              <input
                aria-label="Connection name confirmation"
                value={confirmationName}
                autoComplete="off"
                maxLength={128}
                onChange={(event) => setConfirmationName(event.target.value)}
              />
            </label>
          )}
          <div className="row">
            <button
              type="button"
              className="btn btn-primary"
              disabled={
                busy ||
                (confirmation.action === 'forget' && confirmationName !== confirmation.label)
              }
              onClick={() => void confirm()}
            >
              Confirm connection action
            </button>
            <button type="button" className="btn" disabled={busy} onClick={cancel}>
              Cancel connection action
            </button>
          </div>
        </div>
      )}
      <div className="stack">
        {rows.map((row) => (
          <article
            key={row.id}
            className="card stack"
            aria-label={`${row.label}${row.permanentlyRetired ? ' retired' : ''}`}
            data-testid="connection-row"
          >
            <div className="row">
              <strong>{row.label}</strong>
              <span className="chip">{row.provider}</span>
              <span className="chip">{row.lifecycleState}</span>
            </div>
            <p>
              Configured. Credential:{' '}
              {row.credentialScopeKind === 'native-home'
                ? 'external — not inspected'
                : row.hasCredential
                  ? 'present'
                  : 'absent'}
              . Authentication: unknown. Reachability: unknown.
            </p>
            <p>Identity: {ASSURANCE[row.identityAssurance]}</p>
            {row.permanentlyRetired ? (
              <p>Permanently retired. Historical references are retained.</p>
            ) : row.credentialScopeKind === 'native-home' ? (
              <p className="muted">
                Native account management stays in the provider’s existing subscription controls.
              </p>
            ) : (
              <div className="row">
                {row.lifecycleState === 'ACTIVE' && (
                  <button
                    type="button"
                    className="btn"
                    disabled={busy}
                    onClick={() =>
                      void perform(() => call(nexar.disableConnection({ connectionId: row.id })))
                    }
                  >
                    Disable connection
                  </button>
                )}
                {row.lifecycleState === 'DISABLED' && (
                  <button
                    type="button"
                    className="btn"
                    disabled={busy || !row.hasCredential}
                    onClick={() =>
                      void perform(() => call(nexar.enableConnection({ connectionId: row.id })))
                    }
                  >
                    Enable connection
                  </button>
                )}
                {row.credentialScopeKind === 'keystore' && (
                  <button
                    type="button"
                    className="btn"
                    disabled={busy}
                    onClick={() => {
                      setRotation(row);
                      setSameAccount(false);
                      setKey('');
                    }}
                  >
                    Rotate / re-enter key
                  </button>
                )}
                {!row.builtIn && row.lifecycleState !== 'TOMBSTONED' && (
                  <button
                    type="button"
                    className="btn"
                    disabled={busy}
                    onClick={() => void prepare(row, 'remove')}
                  >
                    Remove connection
                  </button>
                )}
                {row.lifecycleState === 'TOMBSTONED' && (
                  <button
                    type="button"
                    className="btn"
                    disabled={busy || !row.hasCredential}
                    onClick={() =>
                      void perform(() => call(nexar.restoreConnection({ connectionId: row.id })))
                    }
                  >
                    Restore connection
                  </button>
                )}
                {row.hasCredential && (
                  <button
                    type="button"
                    className="btn"
                    disabled={busy}
                    onClick={() => void prepare(row, 'forget')}
                  >
                    Forget credentials
                  </button>
                )}
                {row.authClass === 'official-account' && row.lifecycleState !== 'TOMBSTONED' && (
                  <button
                    type="button"
                    className="btn"
                    disabled={busy}
                    onClick={() => void prepare(row, 'replace')}
                  >
                    Replace Plan account
                  </button>
                )}
              </div>
            )}
          </article>
        ))}
      </div>
    </section>
  );
}
