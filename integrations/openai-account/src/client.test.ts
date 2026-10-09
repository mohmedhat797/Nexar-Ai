import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { isNexarError } from '@nexar/contracts';
import {
  accountFailureReason,
  challengeFor,
  createOpenAiAccountClient,
  createPkce,
  randomToken,
  type OpenAiAccountClient,
} from './index.js';
import { FAKE_SUB, startFakeAuthServer, type FakeAuthServer } from './fake-auth-server.js';

const REDIRECT = 'http://127.0.0.1:4/callback';
const HOST = 'urn:uuid:00000000-0000-4000-8000-000000000001';

let fake: FakeAuthServer;
let client: OpenAiAccountClient;
beforeEach(async () => {
  fake = await startFakeAuthServer();
  client = createOpenAiAccountClient({ issuer: fake.issuer, timeoutMs: 3000 });
});
afterEach(async () => {
  await fake.close();
});

/** Plays the browser: opens the authorize URL and reads the redirect it answers with. */
async function signIn(nonce = 'nonce-1') {
  const pkce = createPkce();
  const url = client.authorizeUrl({
    agentHostId: HOST,
    redirectUri: REDIRECT,
    state: 'state-1',
    nonce,
    codeChallenge: pkce.challenge,
  });
  const redirect = await fetch(url, { redirect: 'manual' });
  const location = new URL(redirect.headers.get('location') ?? '');
  return {
    pkce,
    code: location.searchParams.get('code') ?? '',
    clientId: location.searchParams.get('client_id') ?? '',
  };
}

async function failure(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise;
  } catch (error) {
    return error as Error;
  }
  throw new Error('expected a failure');
}

describe('PKCE', () => {
  it('matches the RFC 7636 S256 example', () => {
    expect(challengeFor('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk')).toBe(
      'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM',
    );
  });

  it('creates a URL-safe verifier whose challenge is S256', () => {
    const pkce = createPkce();
    expect(pkce.verifier).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(pkce.challenge).toBe(challengeFor(pkce.verifier));
    expect(randomToken()).not.toBe(randomToken());
  });
});

describe('authorize URL', () => {
  it('carries exactly the documented parameters', () => {
    const url = new URL(
      client.authorizeUrl({
        agentHostId: HOST,
        redirectUri: 'http://127.0.0.1:5555/callback',
        state: 'state-x',
        nonce: 'nonce-x',
        codeChallenge: 'challenge-x',
      }),
    );
    expect(`${url.origin}${url.pathname}`).toBe(`${fake.issuer}/api/accounts/authorize`);
    expect(Object.fromEntries(url.searchParams)).toEqual({
      client_id: 'dynamic_agent_client',
      agent_name_hint: 'Nexar',
      ext_agent_host_id: HOST,
      response_type: 'code',
      redirect_uri: 'http://127.0.0.1:5555/callback',
      resource: 'https://api.openai.com/v1',
      scope: 'openid profile email offline_access resource.invoke chatgpt.tokens.use.direct',
      state: 'state-x',
      nonce: 'nonce-x',
      code_challenge: 'challenge-x',
      code_challenge_method: 'S256',
    });
  });

  it('defaults to OpenAI production endpoints', () => {
    expect(createOpenAiAccountClient().issuer).toBe('https://auth.openai.com');
  });
});

describe('token exchange and refresh', () => {
  it('sends form-encoded requests and rotates the refresh token', async () => {
    const { pkce, code, clientId } = await signIn();
    expect(clientId).toBe('oaiapp_fake_client');
    const first = await client.exchangeCode({
      code,
      codeVerifier: pkce.verifier,
      redirectUri: REDIRECT,
      clientId,
    });
    expect(fake.tokenRequests[0]).toEqual({
      grant_type: 'authorization_code',
      client_id: clientId,
      code,
      code_verifier: pkce.verifier,
      redirect_uri: REDIRECT,
      resource: 'https://api.openai.com/v1',
    });
    expect(first.planSharing).toBe(true);
    expect(first.expiresInSeconds).toBe(3600);
    const second = await client.refresh({ refreshToken: first.refreshToken, clientId });
    expect(fake.tokenRequests[1]).toEqual({
      grant_type: 'refresh_token',
      client_id: clientId,
      refresh_token: first.refreshToken,
      resource: 'https://api.openai.com/v1',
    });
    expect(second.refreshToken).toBeDefined();
    expect(second.refreshToken).not.toBe(first.refreshToken);
    // The rotated-out token is dead.
    const stale = await failure(client.refresh({ refreshToken: first.refreshToken, clientId }));
    expect(accountFailureReason(stale)).toBe('grant-rejected');
  });

  it('fails the exchange when the PKCE verifier does not match', async () => {
    const { code, clientId } = await signIn();
    const error = await failure(
      client.exchangeCode({
        code,
        codeVerifier: 'wrong-verifier',
        redirectUri: REDIRECT,
        clientId,
      }),
    );
    expect(accountFailureReason(error)).toBe('grant-rejected');
  });

  it('reports planSharing false when the grant lacks the plan scope', async () => {
    fake.scope = 'openid profile email offline_access';
    const { pkce, code, clientId } = await signIn();
    const tokens = await client.exchangeCode({
      code,
      codeVerifier: pkce.verifier,
      redirectUri: REDIRECT,
      clientId,
    });
    expect(tokens.planSharing).toBe(false);
  });

  it('does not treat a longer scope name as the plan scope', async () => {
    fake.scope = 'openid chatgpt.tokens.use.directly';
    const { pkce, code, clientId } = await signIn();
    const tokens = await client.exchangeCode({
      code,
      codeVerifier: pkce.verifier,
      redirectUri: REDIRECT,
      clientId,
    });
    expect(tokens.planSharing).toBe(false);
  });
});

describe('error mapping', () => {
  const SENTINEL = 'response-body-sentinel-secret';

  async function refreshWith(reply: { status: number; body: unknown }): Promise<Error> {
    fake.tokenReply = () => reply;
    return failure(
      client.refresh({ refreshToken: 'refresh-token-sentinel-0', clientId: 'oaiapp_x' }),
    );
  }

  it.each([
    [
      { status: 400, body: { error: 'invalid_grant', error_description: SENTINEL } },
      'grant-rejected',
    ],
    [{ status: 400, body: { error: 'refresh_token_expired' } }, 'grant-rejected'],
    [{ status: 401, body: { error: 'invalid_client', error_description: SENTINEL } }, 'rejected'],
    [{ status: 500, body: SENTINEL }, 'server'],
    [{ status: 503, body: { error: 'temporarily_unavailable' } }, 'server'],
    [{ status: 429, body: { error: 'slow_down' } }, 'server'],
    [{ status: 200, body: SENTINEL }, 'malformed'],
    [{ status: 200, body: { access_token: SENTINEL } }, 'malformed'],
    [{ status: 200, body: { access_token: SENTINEL, expires_in: 'soon' } }, 'malformed'],
  ] as const)('maps %j to %s without echoing the body', async (reply, reason) => {
    const error = await refreshWith(reply);
    expect(accountFailureReason(error)).toBe(reason);
    expect(isNexarError(error)).toBe(true);
    expect(JSON.stringify({ ...error, text: error.message })).not.toContain(SENTINEL);
  });

  it('uses AUTH_REQUIRED only for a rejected grant and PROVIDER_ERROR for outages', async () => {
    const rejected = await refreshWith({ status: 400, body: { error: 'invalid_grant' } });
    const outage = await refreshWith({ status: 502, body: '' });
    expect(isNexarError(rejected) && rejected.code).toBe('AUTH_REQUIRED');
    expect(isNexarError(outage) && outage.code).toBe('PROVIDER_ERROR');
  });

  it('rejects an oversize response', async () => {
    const error = await refreshWith({
      status: 200,
      body: JSON.stringify({ access_token: 'a', expires_in: 1, pad: SENTINEL.repeat(8000) }),
    });
    expect(accountFailureReason(error)).toBe('oversize');
    expect(error.message).not.toContain(SENTINEL);
  });

  it('rejects oversize token fields', async () => {
    const error = await refreshWith({
      status: 200,
      body: { access_token: 'a'.repeat(7000), expires_in: 3600 },
    });
    expect(accountFailureReason(error)).toBe('malformed');
  });

  it('requires a refresh and an ID token on the first exchange', async () => {
    fake.tokenReply = () => ({ status: 200, body: { access_token: 'access-1', expires_in: 3600 } });
    const error = await failure(
      client.exchangeCode({
        code: 'code-1',
        codeVerifier: 'verifier-1',
        redirectUri: REDIRECT,
        clientId: 'oaiapp_x',
      }),
    );
    expect(accountFailureReason(error)).toBe('malformed');
  });

  it('times out and reports a fixed reason', async () => {
    fake.tokenDelayMs = 400;
    const quick = createOpenAiAccountClient({ issuer: fake.issuer, timeoutMs: 50 });
    const error = await failure(quick.refresh({ refreshToken: 'refresh-1', clientId: 'oaiapp_x' }));
    expect(accountFailureReason(error)).toBe('timeout');
  });

  it('reports cancellation distinctly from a timeout', async () => {
    fake.tokenDelayMs = 400;
    const controller = new AbortController();
    const pending = failure(
      client.refresh({
        refreshToken: 'refresh-1',
        clientId: 'oaiapp_x',
        signal: controller.signal,
      }),
    );
    controller.abort();
    expect(accountFailureReason(await pending)).toBe('cancelled');
  });

  it('reports an unreachable server as a network failure', async () => {
    const dead = createOpenAiAccountClient({ issuer: 'http://127.0.0.1:1', timeoutMs: 2000 });
    const error = await failure(dead.refresh({ refreshToken: 'refresh-1', clientId: 'oaiapp_x' }));
    expect(accountFailureReason(error)).toBe('network');
  });

  it('never follows redirects from the token endpoint', async () => {
    const error = await refreshWith({ status: 302, body: '' });
    expect(['network', 'rejected']).toContain(accountFailureReason(error));
  });
});

describe('ID token validation', () => {
  async function idTokenFor(nonce = 'nonce-1'): Promise<{ idToken: string; clientId: string }> {
    const { pkce, code, clientId } = await signIn(nonce);
    const tokens = await client.exchangeCode({
      code,
      codeVerifier: pkce.verifier,
      redirectUri: REDIRECT,
      clientId,
    });
    return { idToken: tokens.idToken, clientId };
  }

  it('accepts a valid token and returns the subject', async () => {
    const { idToken, clientId } = await idTokenFor();
    await expect(client.verifyIdToken({ idToken, clientId, nonce: 'nonce-1' })).resolves.toEqual({
      sub: FAKE_SUB,
    });
  });

  it('does not require a nonce on refresh-time validation', async () => {
    const { idToken, clientId } = await idTokenFor();
    await expect(client.verifyIdToken({ idToken, clientId })).resolves.toEqual({ sub: FAKE_SUB });
  });

  it('rejects a wrong nonce', async () => {
    const { idToken, clientId } = await idTokenFor();
    const error = await failure(client.verifyIdToken({ idToken, clientId, nonce: 'other-nonce' }));
    expect(accountFailureReason(error)).toBe('id-token');
  });

  it('rejects a wrong audience', async () => {
    const { idToken } = await idTokenFor();
    const error = await failure(client.verifyIdToken({ idToken, clientId: 'oaiapp_other' }));
    expect(accountFailureReason(error)).toBe('id-token');
  });

  it('rejects a wrong issuer', async () => {
    fake.idClaims = { iss: 'https://evil.example' };
    const { idToken, clientId } = await idTokenFor();
    const error = await failure(client.verifyIdToken({ idToken, clientId, nonce: 'nonce-1' }));
    expect(accountFailureReason(error)).toBe('id-token');
  });

  it('rejects an expired token', async () => {
    fake.idClaims = { exp: Math.floor(Date.now() / 1000) - 3600 };
    const { idToken, clientId } = await idTokenFor();
    const error = await failure(client.verifyIdToken({ idToken, clientId, nonce: 'nonce-1' }));
    expect(accountFailureReason(error)).toBe('id-token');
  });

  it('rejects a bad signature', async () => {
    fake.signWithUnlistedKey = true;
    const { idToken, clientId } = await idTokenFor();
    const error = await failure(client.verifyIdToken({ idToken, clientId, nonce: 'nonce-1' }));
    expect(accountFailureReason(error)).toBe('id-token');
  });

  it('rejects garbage and an unsigned token without echoing it', async () => {
    const garbage = 'not-a-jwt-sentinel';
    const error = await failure(
      client.verifyIdToken({ idToken: garbage, clientId: 'oaiapp_x', nonce: 'nonce-1' }),
    );
    expect(accountFailureReason(error)).toBe('id-token');
    expect(error.message).not.toContain(garbage);
    const none = `${Buffer.from('{"alg":"none"}').toString('base64url')}.${Buffer.from(
      JSON.stringify({ sub: 'x', iss: fake.issuer, aud: 'oaiapp_x', exp: 4102444800 }),
    ).toString('base64url')}.`;
    const unsigned = await failure(
      client.verifyIdToken({ idToken: none, clientId: 'oaiapp_x', nonce: 'nonce-1' }),
    );
    expect(accountFailureReason(unsigned)).toBe('id-token');
  });
});
