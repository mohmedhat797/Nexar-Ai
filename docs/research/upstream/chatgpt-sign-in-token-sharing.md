# ChatGPT plan as a model-turn resource: Sign in with ChatGPT token sharing (NXR-067)

| Field   | Value                                                                                         |
| ------- | --------------------------------------------------------------------------------------------- |
| Date    | 2026-10-05                                                                                    |
| Sources | OpenAI developer docs (below), `@earendil-works/pi-ai@0.99` `dist/auth/oauth/openai-chatgpt.js`, OpenWorker `e892350` `coworker/providers/codex_auth.py`, Codex CLI `4ad985e` `codex-rs/login/src/device_code_auth.rs` |
| Method  | Documentation and source reading; no live login or paid call.                                 |

## Finding

OpenAI documents an **official** flow for third-party and open-source apps to spend a ChatGPT
Plus/Pro plan: "Sign in with ChatGPT" with the `chatgpt.tokens.use.direct` permission. The resulting
user access token calls the **public Responses API** (`POST https://api.openai.com/v1/responses`).
This supersedes the experimental client-compat route (Codex CLI client id against
`chatgpt.com/backend-api/codex`) that the 2026-10-04 spike recorded for ChatGPT: Nexar does not need
another client's identity or a private backend. Auth class `official-account`, support `official`
(ADR-022 amendment 2026-10-05).

## Flow (documented)

- Authorize: `https://auth.openai.com/api/accounts/authorize`, PKCE `S256`, no client secret.
  First sign-in uses `client_id=dynamic_agent_client` with `agent_name_hint` (the app's name, used
  consistently) and `ext_agent_host_id` (a per-installation id; pi-ai sends `urn:uuid:<uuid>`); the
  callback returns an issued `client_id` (`oaiapp_…`), kept with the account for reauthorization.
- Scopes: `openid profile email offline_access resource.invoke chatgpt.tokens.use.direct`;
  resource `https://api.openai.com/v1`.
- Redirect: HTTP loopback on `127.0.0.1` (not `localhost`), port free per attempt, fixed scheme,
  host and path (`/callback` per the docs; pi-ai uses `:1455/auth/callback`). Desktop main opens no
  listener (ADR-021), so the callback is served by a short-lived supervised child bound to
  `127.0.0.1:0` for one sign-in, `state`-checked, then exited.
- Token: `https://auth.openai.com/api/accounts/oauth/token`, form-encoded `authorization_code`;
  response `access_token` (1 h), `refresh_token` (30 days, rotated on every refresh — replace
  atomically), `expires_in`, granted `scope`, `id_token`. Validate the ID token against OpenAI's
  JWKS; the account identity is `sub`. Plan usage is enabled only when the granted scope contains
  `chatgpt.tokens.use.direct` (identity sign-in alone does not grant it).
- Storage: owner-only; Nexar keeps tokens in its key store (`safeStorage`) under the connection,
  never in another application's store, never in logs/IPC/telemetry.

## Use and errors (documented)

- Supported route: `POST /v1/responses` only (`subscription_sharing_route_not_supported` otherwise).
  Streaming is supported. Models are discovered per connection (the devkit's `listModels`).
- Errors: `subscription_sharing_user_not_eligible` 403 (do not loop sign-in);
  `subscription_sharing_usage_limit_exceeded` 429 (pause; usage is managed in ChatGPT settings);
  `subscription_sharing_usage_unavailable` 503 (bounded retry);
  `subscription_sharing_unsupported_capability` 400 (input/model/tool not supported; do not retry the
  same body); `subscription_sharing_invalid_user` 401 (re-authenticate); `chatpass_v2_scope_not_authorized`
  403; refresh `invalid_grant` / `refresh_token_expired` (clear and sign in again). OpenAI never
  silently switches the request to another billing path.
- Eligibility: ChatGPT Plus and Pro; available to open-source projects and personal apps that run
  locally (Nexar qualifies); paid or remotely hosted apps need waitlist approval.

## Open (verify live in NXR-066, owner-initiated)

- **Function tools** (caller-executed tool calls) on this route are not stated in the docs; the
  `unsupported_capability` error suggests some tools or inputs are restricted. Nexar marks the
  resources `model-turn` (the route is the standard Responses API, which pi-ai already speaks) and
  maps `unsupported_capability` to a control failure, so a refusal is honest and history
  down-ranks it; the owner's live acceptance (NXR-066) confirms it.
- Exact model list for a given plan; usage reporting (`Measured`: token counts if returned; cash
  cost is plan usage, never fabricated as API cost).
- The plane (Code): signing in inside WSL needs a browser reachable callback; plane support is a
  follow-up (Desktop/Cowork first).

## Sources

- https://developers.openai.com/siwc/token-sharing-open-source/sign-in
- https://developers.openai.com/siwc/token-sharing-open-source/token-reference
- https://developers.openai.com/siwc/token-sharing-open-source/errors-and-recovery
- https://developers.openai.com/cookbook/articles/sign-in-with-chatgpt
