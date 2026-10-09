import { createHash } from 'node:crypto';
import { createServer, type IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';
import { SignJWT, exportJWK, generateKeyPair, type CryptoKey, type JWK } from 'jose';
import { SCOPE } from './constants.js';

/*
 * Test kit: a fake OpenAI auth server on 127.0.0.1 (authorize redirect, token endpoint with PKCE and
 * refresh rotation checks, JWKS). Used by the adapter's contract tests and Desktop's service tests so
 * nothing ever contacts the real endpoints. Not used by production code.
 */

export interface FakeTokenReply {
  readonly status: number;
  /** An object is sent as JSON; a string is sent verbatim. */
  readonly body: unknown;
}

export interface FakeAuthServer {
  readonly issuer: string;
  /** The `client_id` issued in the callback (`oaiapp_...`). */
  readonly clientId: string;
  readonly authorizeRequests: Record<string, string>[];
  readonly tokenRequests: Record<string, string>[];
  /** Replaces the token endpoint's answer for a request when it returns a reply. */
  tokenReply?: (form: Record<string, string>) => FakeTokenReply | undefined;
  /** Sign the next ID tokens with a key that is not in the JWKS. */
  signWithUnlistedKey: boolean;
  /** Claims merged over the valid ones (e.g. a wrong `nonce`). */
  idClaims: Record<string, unknown>;
  scope: string;
  expiresIn: number;
  /** Answer the next authorize request with `error=access_denied` instead of a code. */
  denyNextAuthorize: boolean;
  tokenDelayMs: number;
  close(): Promise<void>;
}

export const FAKE_SUB = 'user-sentinel-subject';

async function readForm(request: IncomingMessage): Promise<Record<string, string>> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(chunk as Buffer);
  return Object.fromEntries(new URLSearchParams(Buffer.concat(chunks).toString('utf8')));
}

export async function startFakeAuthServer(): Promise<FakeAuthServer> {
  const listed = await generateKeyPair('RS256', { extractable: true });
  const unlisted = await generateKeyPair('RS256');
  const jwk: JWK = { ...(await exportJWK(listed.publicKey)), kid: 'fake-key', alg: 'RS256' };
  const codes = new Map<string, { nonce: string; challenge: string; used: boolean }>();
  const refreshTokens = new Set<string>();
  let counter = 0;
  let issuer = '';

  const state: FakeAuthServer = {
    get issuer() {
      return issuer;
    },
    clientId: 'oaiapp_fake_client',
    authorizeRequests: [],
    tokenRequests: [],
    signWithUnlistedKey: false,
    idClaims: {},
    scope: SCOPE,
    expiresIn: 3600,
    denyNextAuthorize: false,
    tokenDelayMs: 0,
    close: () =>
      new Promise((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  };

  async function idToken(audience: string, nonce: string): Promise<string> {
    const key: CryptoKey = state.signWithUnlistedKey ? unlisted.privateKey : listed.privateKey;
    const now = Math.floor(Date.now() / 1000);
    return new SignJWT({
      iss: issuer,
      aud: audience,
      sub: FAKE_SUB,
      iat: now,
      exp: now + 3600,
      nonce,
      ...state.idClaims,
    })
      .setProtectedHeader({ alg: 'RS256', kid: 'fake-key' })
      .sign(key);
  }

  async function token(form: Record<string, string>): Promise<FakeTokenReply> {
    const override = state.tokenReply?.(form);
    if (override !== undefined) return override;
    const invalidGrant = { status: 400, body: { error: 'invalid_grant' } };
    counter += 1;
    const base = {
      access_token: `access-token-sentinel-${String(counter)}`,
      refresh_token: `refresh-token-sentinel-${String(counter)}`,
      expires_in: state.expiresIn,
      scope: state.scope,
      token_type: 'Bearer',
    };
    if (form['grant_type'] === 'authorization_code') {
      const entry = codes.get(form['code'] ?? '');
      const challenge = createHash('sha256')
        .update(form['code_verifier'] ?? '')
        .digest('base64url');
      if (entry === undefined || entry.used || entry.challenge !== challenge) return invalidGrant;
      entry.used = true;
      refreshTokens.add(base.refresh_token);
      return {
        status: 200,
        body: { ...base, id_token: await idToken(form['client_id'] ?? '', entry.nonce) },
      };
    }
    if (form['grant_type'] === 'refresh_token') {
      const presented = form['refresh_token'] ?? '';
      if (!refreshTokens.delete(presented)) return invalidGrant;
      refreshTokens.add(base.refresh_token);
      return { status: 200, body: base };
    }
    return { status: 400, body: { error: 'unsupported_grant_type' } };
  }

  const server = createServer((request, response) => {
    const url = new URL(request.url ?? '', 'http://127.0.0.1');
    const send = (status: number, body: unknown, headers: Record<string, string> = {}): void => {
      response.writeHead(status, { 'content-type': 'application/json', ...headers });
      response.end(typeof body === 'string' ? body : JSON.stringify(body));
    };
    if (request.method === 'GET' && url.pathname === '/.well-known/jwks.json') {
      send(200, { keys: [jwk] });
    } else if (request.method === 'GET' && url.pathname === '/api/accounts/authorize') {
      const query = Object.fromEntries(url.searchParams);
      state.authorizeRequests.push(query);
      const target = new URL(query['redirect_uri'] ?? '');
      if (state.denyNextAuthorize) {
        state.denyNextAuthorize = false;
        target.searchParams.set('error', 'access_denied');
      } else {
        counter += 1;
        const code = `code-sentinel-${String(counter)}`;
        codes.set(code, {
          nonce: query['nonce'] ?? '',
          challenge: query['code_challenge'] ?? '',
          used: false,
        });
        target.searchParams.set('code', code);
        target.searchParams.set('client_id', state.clientId);
      }
      target.searchParams.set('state', query['state'] ?? '');
      response.writeHead(302, { location: target.toString() });
      response.end();
    } else if (request.method === 'POST' && url.pathname === '/api/accounts/oauth/token') {
      void readForm(request).then(async (form) => {
        state.tokenRequests.push(form);
        if (state.tokenDelayMs > 0) await new Promise((r) => setTimeout(r, state.tokenDelayMs));
        const reply = await token(form);
        send(reply.status, reply.body);
      });
    } else {
      send(404, { error: 'not_found' });
    }
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  issuer = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
  return state;
}
