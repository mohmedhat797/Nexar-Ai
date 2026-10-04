import { createRemoteJWKSet, jwtVerify } from 'jose';
import { z } from 'zod';
import {
  AGENT_NAME_HINT,
  AUTHORIZE_PATH,
  DEFAULT_TIMEOUT_MS,
  DYNAMIC_CLIENT_ID,
  JWKS_PATH,
  MAX_ACCESS_TOKEN_CHARS,
  MAX_ID_TOKEN_CHARS,
  MAX_REFRESH_TOKEN_CHARS,
  MAX_RESPONSE_BYTES,
  MAX_SCOPE_CHARS,
  OPENAI_ISSUER,
  PLAN_SHARING_SCOPE,
  RESOURCE,
  SCOPE,
  TOKEN_PATH,
} from './constants.js';
import { accountError, accountFailureReason } from './errors.js';

export interface OpenAiAccountClientOptions {
  /** Test seam: the issuer base URL. Production always uses OpenAI's. */
  readonly issuer?: string;
  readonly fetch?: typeof fetch;
  readonly timeoutMs?: number;
}

export interface AuthorizeInput {
  /** `urn:uuid:<installation uuid>`: one stable id per installation, never a hardware id. */
  readonly agentHostId: string;
  readonly redirectUri: string;
  readonly state: string;
  readonly nonce: string;
  readonly codeChallenge: string;
}

export interface TokenSet {
  readonly accessToken: string;
  readonly refreshToken: string;
  readonly expiresInSeconds: number;
  readonly scope: string;
  readonly idToken: string;
  /** True only when the grant includes `chatgpt.tokens.use.direct`. */
  readonly planSharing: boolean;
}

export interface RefreshedTokens {
  readonly accessToken: string;
  /** Rotated on every refresh; absent means the previous one stays valid. */
  readonly refreshToken?: string;
  readonly expiresInSeconds: number;
  readonly scope?: string;
  readonly idToken?: string;
}

export interface OpenAiAccountClient {
  readonly issuer: string;
  authorizeUrl(input: AuthorizeInput): string;
  exchangeCode(input: {
    readonly code: string;
    readonly codeVerifier: string;
    readonly redirectUri: string;
    /** The `client_id` OpenAI issued in the callback. */
    readonly clientId: string;
    readonly signal?: AbortSignal;
  }): Promise<TokenSet>;
  refresh(input: {
    readonly refreshToken: string;
    readonly clientId: string;
    readonly signal?: AbortSignal;
  }): Promise<RefreshedTokens>;
  /** Verifies signature (RS256, OpenAI's JWKS), issuer, audience, expiry and, when given, `nonce`. */
  verifyIdToken(input: {
    readonly idToken: string;
    readonly clientId: string;
    readonly nonce?: string;
  }): Promise<{ readonly sub: string }>;
}

const TokenResponse = z.object({
  access_token: z.string().min(1).max(MAX_ACCESS_TOKEN_CHARS),
  refresh_token: z.string().min(1).max(MAX_REFRESH_TOKEN_CHARS).optional(),
  expires_in: z.number().positive().max(31_536_000),
  scope: z.string().max(MAX_SCOPE_CHARS).optional(),
  id_token: z.string().min(1).max(MAX_ID_TOKEN_CHARS).optional(),
});
const ErrorResponse = z.object({ error: z.string().max(128) });
const GRANT_ERRORS: ReadonlySet<string> = new Set(['invalid_grant', 'refresh_token_expired']);

export function hasPlanSharing(scope: string): boolean {
  return scope.split(/\s+/).includes(PLAN_SHARING_SCOPE);
}

async function readBounded(response: Response): Promise<string> {
  if (response.body === null) return '';
  const chunks: Uint8Array[] = [];
  let total = 0;
  // Leaving the loop early cancels the stream, so an oversize body is never read to the end.
  for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
    total += chunk.byteLength;
    if (total > MAX_RESPONSE_BYTES) throw accountError('oversize');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

export function createOpenAiAccountClient(
  options: OpenAiAccountClientOptions = {},
): OpenAiAccountClient {
  const issuer = (options.issuer ?? OPENAI_ISSUER).replace(/\/+$/, '');
  const doFetch = options.fetch ?? fetch;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  let jwks: ReturnType<typeof createRemoteJWKSet> | undefined;

  async function postForm(
    path: string,
    params: Readonly<Record<string, string>>,
    signal: AbortSignal | undefined,
  ): Promise<unknown> {
    const timeout = AbortSignal.timeout(timeoutMs);
    const combined = signal === undefined ? timeout : AbortSignal.any([timeout, signal]);
    let status: number;
    let text: string;
    try {
      const response = await doFetch(`${issuer}${path}`, {
        method: 'POST',
        headers: {
          accept: 'application/json',
          'content-type': 'application/x-www-form-urlencoded',
        },
        body: new URLSearchParams(params).toString(),
        redirect: 'error',
        signal: combined,
      });
      status = response.status;
      text = await readBounded(response);
    } catch (error) {
      if (signal?.aborted === true) throw accountError('cancelled');
      if (timeout.aborted) throw accountError('timeout');
      if (accountFailureReason(error) !== undefined) throw error;
      throw accountError('network');
    }
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      body = undefined;
    }
    if (status >= 200 && status < 300) {
      if (body === undefined) throw accountError('malformed');
      return body;
    }
    // Only a known error id is ever consulted; the body itself is never kept or echoed.
    const failure = ErrorResponse.safeParse(body);
    if (failure.success && GRANT_ERRORS.has(failure.data.error))
      throw accountError('grant-rejected');
    throw accountError(status >= 500 || status === 429 ? 'server' : 'rejected');
  }

  function parseTokens(body: unknown): z.output<typeof TokenResponse> {
    const parsed = TokenResponse.safeParse(body);
    if (!parsed.success) throw accountError('malformed');
    return parsed.data;
  }

  return {
    issuer,
    authorizeUrl(input) {
      const url = new URL(`${issuer}${AUTHORIZE_PATH}`);
      url.search = new URLSearchParams({
        client_id: DYNAMIC_CLIENT_ID,
        agent_name_hint: AGENT_NAME_HINT,
        ext_agent_host_id: input.agentHostId,
        response_type: 'code',
        redirect_uri: input.redirectUri,
        resource: RESOURCE,
        scope: SCOPE,
        state: input.state,
        nonce: input.nonce,
        code_challenge: input.codeChallenge,
        code_challenge_method: 'S256',
      }).toString();
      return url.toString();
    },
    async exchangeCode(input) {
      const token = parseTokens(
        await postForm(
          TOKEN_PATH,
          {
            grant_type: 'authorization_code',
            client_id: input.clientId,
            code: input.code,
            code_verifier: input.codeVerifier,
            redirect_uri: input.redirectUri,
            resource: RESOURCE,
          },
          input.signal,
        ),
      );
      if (token.refresh_token === undefined || token.id_token === undefined) {
        throw accountError('malformed');
      }
      const scope = token.scope ?? '';
      return {
        accessToken: token.access_token,
        refreshToken: token.refresh_token,
        expiresInSeconds: token.expires_in,
        scope,
        idToken: token.id_token,
        planSharing: hasPlanSharing(scope),
      };
    },
    async refresh(input) {
      const token = parseTokens(
        await postForm(
          TOKEN_PATH,
          {
            grant_type: 'refresh_token',
            client_id: input.clientId,
            refresh_token: input.refreshToken,
            resource: RESOURCE,
          },
          input.signal,
        ),
      );
      return {
        accessToken: token.access_token,
        expiresInSeconds: token.expires_in,
        ...(token.refresh_token === undefined ? {} : { refreshToken: token.refresh_token }),
        ...(token.scope === undefined ? {} : { scope: token.scope }),
        ...(token.id_token === undefined ? {} : { idToken: token.id_token }),
      };
    },
    async verifyIdToken(input) {
      try {
        jwks ??= createRemoteJWKSet(new URL(`${issuer}${JWKS_PATH}`), {
          timeoutDuration: timeoutMs,
        });
        const { payload } = await jwtVerify(input.idToken, jwks, {
          issuer,
          audience: input.clientId,
          algorithms: ['RS256'],
          clockTolerance: 30,
          requiredClaims: ['sub', 'exp'],
        });
        const { sub, nonce } = payload;
        if (typeof sub !== 'string' || sub === '' || sub.length > 256) throw new Error('sub');
        if (input.nonce !== undefined && nonce !== input.nonce) throw new Error('nonce');
        return { sub };
      } catch {
        throw accountError('id-token');
      }
    },
  };
}
