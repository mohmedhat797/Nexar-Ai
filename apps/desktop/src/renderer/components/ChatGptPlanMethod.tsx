import { useEffect, useState, type ReactElement } from 'react';
import type { ChatGptPlanStatus } from '../../shared/api.js';
import { call, errorText, nexar } from '../bridge.js';
import { ModelInventory } from './ModelInventory.js';

/** The renderer follows a sign-in for as long as the owner has to finish it in the browser. */
const POLL_INTERVAL_MS = 1000;
const POLL_MAX_MS = 10 * 60 * 1000;

const STATE_LABELS: Readonly<Record<ChatGptPlanStatus['state'], string>> = {
  'signed-out': 'Not connected',
  'signing-in': 'Signing in',
  connected: 'Connected',
  error: 'Error',
};

type PlanAction = 'connect' | 'cancel' | 'disconnect';

/** The fixed line for a status; plan sharing off is told apart from a plain connection. */
function statusLine(status: ChatGptPlanStatus): string {
  return status.state === 'connected' && status.planSharing !== true
    ? 'Connected, but ChatGPT plan sharing is off. Sign in again and allow plan usage.'
    : status.message;
}

/**
 * The ChatGPT plan method of the OpenAI card (NXR-067): Sign in with ChatGPT. Shows the fixed status
 * text and three actions; no token, code, URL or account identifier ever reaches this view.
 */
export function ChatGptPlanMethod({
  revision = 0,
  onChanged,
  onForget,
}: { revision?: number; onChanged?: () => void; onForget?: () => void } = {}): ReactElement {
  const [status, setStatus] = useState<ChatGptPlanStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const signingIn = status?.state === 'signing-in';

  useEffect(() => {
    let active = true;
    void call(nexar.chatgptPlanStatus())
      .then((next) => {
        if (active) setStatus(next);
      })
      .catch((failure: unknown) => {
        if (active) setError(errorText(failure));
      });
    return () => {
      active = false;
    };
  }, [revision]);

  // Follow a running sign-in once a second, for at most ten minutes.
  useEffect(() => {
    if (!signingIn) return;
    let active = true;
    const startedAt = Date.now();
    const timer = setInterval(() => {
      if (Date.now() - startedAt > POLL_MAX_MS) {
        clearInterval(timer);
        return;
      }
      void call(nexar.chatgptPlanStatus())
        .then((next) => {
          if (active) setStatus(next);
        })
        .catch((failure: unknown) => {
          if (active) setError(errorText(failure));
        });
    }, POLL_INTERVAL_MS);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [signingIn]);

  async function act(action: PlanAction): Promise<void> {
    if (action === 'disconnect' && onForget !== undefined) {
      onForget();
      return;
    }
    setBusy(true);
    setError(null);
    try {
      setStatus(
        await call(
          action === 'connect'
            ? nexar.connectChatgptPlan()
            : action === 'cancel'
              ? nexar.cancelChatgptPlan()
              : nexar.disconnectChatgptPlan(),
        ),
      );
    } catch (failure) {
      setError(errorText(failure));
    } finally {
      setBusy(false);
      onChanged?.();
    }
  }

  const connected = status?.state === 'connected';
  return (
    <div className="stack" data-testid="chatgpt-plan">
      <div className="row">
        <span className="strong">ChatGPT plan (Sign in with ChatGPT)</span>
        <span className="chip" data-testid="chatgpt-plan-state">
          {status === null ? 'Checking' : STATE_LABELS[status.state]}
        </span>
      </div>
      <p role="status" aria-live="polite" data-testid="chatgpt-plan-status">
        {status === null ? '' : statusLine(status)}
      </p>
      <p className="muted small">
        Uses your ChatGPT plan&apos;s usage. Manage limits or revoke access in ChatGPT settings.
      </p>
      {error !== null && (
        <div className="notice notice-bad" role="alert">
          {error}
        </div>
      )}
      <div className="row">
        <button
          type="button"
          className="btn btn-primary"
          aria-label="Connect ChatGPT plan"
          disabled={busy || status === null || signingIn || connected}
          onClick={() => void act('connect')}
        >
          Connect
        </button>
        <button
          type="button"
          className="btn"
          aria-label="Cancel ChatGPT sign-in"
          disabled={busy || !signingIn}
          onClick={() => void act('cancel')}
        >
          Cancel
        </button>
        <button
          type="button"
          className="btn"
          aria-label="Disconnect ChatGPT plan"
          disabled={busy || !connected}
          onClick={() => void act('disconnect')}
        >
          Disconnect
        </button>
      </div>
      <ModelInventory sourceId="chatgpt-plan" revision={status?.state} />
    </div>
  );
}
