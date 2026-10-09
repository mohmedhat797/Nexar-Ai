import { createHash, timingSafeEqual } from 'node:crypto';
import { createServer, type Server, type ServerResponse } from 'node:http';
import { CALLBACK_PATH } from './constants.js';

export type CallbackErrorCode = 'denied' | 'state-mismatch' | 'invalid-callback';
export type CallbackOutcome =
  { readonly code: string; readonly clientId: string } | { readonly error: CallbackErrorCode };

export interface CallbackServerOptions {
  /** The `state` this sign-in was started with. */
  readonly state: string;
  /** Called once, with the first request that reaches `/callback` on the right host. */
  readonly onOutcome: (outcome: CallbackOutcome) => void;
}

const CODE = /^[A-Za-z0-9._~-]{1,2048}$/;
const CLIENT_ID = /^[A-Za-z0-9_-]{1,128}$/;
const MAX_URL_CHARS = 8192;

const PAGES = {
  ok: 'Signed in. You can close this tab and return to Nexar.',
  failed: 'Sign-in was not completed. Return to Nexar to try again.',
} as const;

function sameState(actual: string | null, expected: string): boolean {
  // Hash first so the comparison is constant-time whatever the input length.
  const a = createHash('sha256')
    .update(actual ?? '')
    .digest();
  const b = createHash('sha256').update(expected).digest();
  return timingSafeEqual(a, b) && actual !== null;
}

function page(response: ServerResponse, status: number, text: string): void {
  // Fixed text only: nothing from the request is ever reflected.
  const body = `<!doctype html><meta charset="utf-8"><title>Nexar</title><p>${text}</p>`;
  response.writeHead(status, {
    'content-type': 'text/html; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
    'referrer-policy': 'no-referrer',
    'x-content-type-options': 'nosniff',
    'content-security-policy': "default-src 'none'",
    connection: 'close',
  });
  response.end(body);
}

/**
 * The loopback redirect target of one sign-in. The caller binds it to `127.0.0.1` on an ephemeral
 * port (in a short-lived child, never in Desktop main). It answers only `GET /callback` addressed to
 * `127.0.0.1:<its port>`; everything else is a 404.
 */
export function createCallbackServer(options: CallbackServerOptions): Server {
  let settled = false;
  return createServer((request, response) => {
    const port = request.socket.localPort;
    if (
      request.method !== 'GET' ||
      port === undefined ||
      request.headers.host !== `127.0.0.1:${String(port)}` ||
      (request.url?.length ?? 0) > MAX_URL_CHARS
    ) {
      page(response, 404, 'Not found.');
      return;
    }
    let url: URL;
    try {
      url = new URL(request.url ?? '', 'http://127.0.0.1');
    } catch {
      page(response, 404, 'Not found.');
      return;
    }
    if (url.pathname !== CALLBACK_PATH) {
      page(response, 404, 'Not found.');
      return;
    }
    // A callback that does not carry this sign-in's state is not from it: refuse it and keep waiting,
    // so another local process cannot end the owner's sign-in.
    if (!sameState(url.searchParams.get('state'), options.state)) {
      page(response, 400, PAGES.failed);
      return;
    }
    let outcome: CallbackOutcome;
    const code = url.searchParams.get('code');
    const clientId = url.searchParams.get('client_id')?.trim() ?? '';
    if (url.searchParams.has('error')) {
      outcome = { error: 'denied' };
    } else if (code === null || !CODE.test(code) || !CLIENT_ID.test(clientId)) {
      outcome = { error: 'invalid-callback' };
    } else {
      outcome = { code, clientId };
    }
    page(response, 'error' in outcome ? 400 : 200, 'error' in outcome ? PAGES.failed : PAGES.ok);
    if (settled) return;
    settled = true;
    options.onOutcome(outcome);
  });
}
