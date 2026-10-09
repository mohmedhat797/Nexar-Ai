/** Everything here comes from OpenAI's "Sign in with ChatGPT" token-sharing documentation. */
export const OPENAI_ISSUER = 'https://auth.openai.com';
export const DYNAMIC_CLIENT_ID = 'dynamic_agent_client';
export const AGENT_NAME_HINT = 'Nexar';
export const RESOURCE = 'https://api.openai.com/v1';
export const PLAN_SHARING_SCOPE = 'chatgpt.tokens.use.direct';
export const SCOPE = `openid profile email offline_access resource.invoke ${PLAN_SHARING_SCOPE}`;
export const CALLBACK_PATH = '/callback';

export const AUTHORIZE_PATH = '/api/accounts/authorize';
export const TOKEN_PATH = '/api/accounts/oauth/token';
export const JWKS_PATH = '/.well-known/jwks.json';

/** Bounds on what a (possibly hostile or broken) auth server may make us hold or store. */
export const MAX_RESPONSE_BYTES = 64 * 1024;
export const MAX_ACCESS_TOKEN_CHARS = 6144;
export const MAX_REFRESH_TOKEN_CHARS = 2048;
export const MAX_ID_TOKEN_CHARS = 6144;
export const MAX_SCOPE_CHARS = 1024;
export const DEFAULT_TIMEOUT_MS = 15_000;
