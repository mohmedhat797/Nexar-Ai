# ADR-022: Providers and credentials in Nexar Desktop

**Status:** Accepted (2026-10-01) · Builds on ADR-007 (resource abstraction), ADR-008 (upstream
isolation), ADR-020 §9 (discovery), ADR-021 (Nexar Desktop) · Amends the "credentials are referenced by
environment variable only" practice for the desktop app

## Context

The owner wants a **Providers** tab where any AI provider can be added, either by signing in with a
subscription or with an API key, so DSH, pi-ai and the native agents can use it. Today a credential is a
`CredentialRef`: `{ source: 'env', name }` for API keys, or `{ source: 'runtime-managed' }` for runtimes
that log in themselves (Claude Code, Codex, Antigravity). A desktop user should not have to edit
environment variables.

Standing rules this must keep:

- Never read, copy or extract a runtime's own credentials (Claude, Codex or Google logins), and no
  reverse-engineered authentication.
- Config holds references, never secret values. Secrets never reach logs, telemetry, audit records or
  the renderer.

## Decision

### 1. Three ways to connect a provider

| Method                     | Providers                                                     | How it works                                                                                                       | Used by                                 |
| -------------------------- | ------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ | --------------------------------------- |
| **Subscription sign-in**   | Anthropic (Claude Code), OpenAI (Codex), Google (Antigravity) | Nexar starts the vendor's own documented login command (e.g. `codex login`) in a visible terminal or browser flow. | Only that vendor's own agent            |
| **API key**                | Any provider pi-ai or DSH supports, plus custom servers       | The owner pastes a key; Nexar stores it encrypted (§2) and passes it to the runtime at call time.                  | pi-ai, DSH, and OpenWorker when allowed |
| **Local or custom server** | Ollama, LM Studio, any OpenAI-compatible address              | The owner enters the address; discovery lists its models (ADR-020 §9: owner-listed only, no scanning).             | pi-ai, DSH                              |

- **A subscription never powers pi-ai or DSH.** Using a Claude or ChatGPT plan outside the vendor's own
  app would mean taking login tokens out of that app, which the rules above forbid (and the vendors'
  terms restrict). The Providers tab says so plainly; subscription status comes from the existing free
  probes (`claude auth status`, `codex login status`).
- Nexar never reads the vendors' credential stores. The login commands are started with an explicit
  environment and run in the vendor's own window; Nexar only observes the exit code and then re-probes.
  The exact login command per runtime is verified during implementation and recorded in the research
  snapshot.

### 2. Encrypted local key store

- A new credential source, **`{ source: 'keystore', name }`**, is added to `CredentialRef`. Config and
  resource descriptors carry only the name.
- In the desktop app, keys are encrypted with Electron **`safeStorage`**: DPAPI on Windows, Keychain on
  macOS, libsecret on Linux. The ciphertext lives in `<userData>/credentials.json` (mode 0600 where the
  platform supports it). When `safeStorage` reports no real encryption backend (Linux `basic_text`),
  Nexar **refuses to store the key** and asks for an environment variable instead.
- **Resolution happens in the main process only, at call time.** The resolved value is passed to the
  runtime the same way environment keys are today: as one explicitly named variable in the minimal
  subprocess environment (DSH), or as a per-request option (pi-ai). It is never written to disk in
  plain text, logged, put in telemetry or audit, or sent to the renderer.
- The renderer sees only the provider name, a status (`valid`, `invalid`, `not set`, `unchecked`) and
  the last four characters of the key.
- The CLI keeps `env` references. A `keystore` reference used outside the desktop app is reported as
  `AUTH_REQUIRED` with a clear message; it never falls back to reading anything else.

### 3. Checking a key costs nothing

"Check key" calls the provider's model-listing endpoint (no completion, so no charge), through the pi
integration. A failed check stores no key unless the owner saves it anyway; its error is reported as a
code, never as the provider's raw response.

### 4. What the provider list shows

One row per connection (a provider can have both a subscription and a key): provider, method, status,
which runtimes may use it (pi-ai, DSH, OpenWorker; owner-chosen), number of models, and Manage or
Remove. Removing a key deletes its ciphertext. Discovered resources from a provider follow ADR-020 §9:
discovered never means authenticated.

## Rationale

- `safeStorage` uses the operating system's own protection (DPAPI on Windows) without a native module,
  and ties the ciphertext to the owner's OS account.
- Keeping resolution in the main process at call time preserves the existing invariant: only the
  runtime that needs a key sees it, and only for that call.

## Alternatives considered

- **Keep environment variables only:** safe but unusable for a desktop owner.
- **A native keychain module (e.g. keytar):** archived upstream and adds a native build step;
  `safeStorage` covers the same platforms.
- **Using subscription logins for pi-ai or DSH:** rejected; it requires extracting vendor tokens.
- **Storing keys in `nexar.config.json`:** rejected; config must never hold secret values.

## Consequences

- `CredentialRef` gains `keystore`; adapters that resolve credentials take a resolver function injected
  by the host, so integrations never touch the key store directly.
- New tests: encryption round-trip with a fake `safeStorage`, refusal without a real backend, no key in
  logs, telemetry, IPC responses or errors.

## Risks

- **Malware running as the owner** can ask DPAPI to decrypt, as it could read environment variables.
  Out of scope for a local app; documented in the security model.
- **Upstream login commands change.** Each login path is verified against the pinned runtime version and
  covered by fake-runtime contract tests.

## Amendment (2026-10-02, NXR-052 implementation)

- **A keystore entry's name is the credential variable it supplies.** References are
  `{ source: 'keystore', name: 'DEEPSEEK_API_KEY' }` (names match `^[A-Z][A-Z0-9_]*$`). pi-ai receives
  the resolved value as the per-request key; DSH receives exactly that one variable in its minimal
  child environment. DSH `piAiProviders` entries may name `{ keystore: NAME }` instead of
  `{ apiKeyEnv: NAME }`. There is no implicit fallback between `env` and `keystore`.
- **Resolver injection.** `@nexar/host` accepts an optional secret resolver and passes it to the pi and
  DSH adapters; Desktop main supplies one backed by the key store. Without a resolver (the CLI), a
  keystore reference is `AUTH_REQUIRED` with a clear message and nothing else is read.
- **Keys never cross renderer IPC, in either direction.** The renderer asks main to "save the key on
  the clipboard" for a named provider; main reads the clipboard itself, validates the value, encrypts
  and stores it, and clears the clipboard when it still holds that key. The renderer only ever sees
  the provider, status and the last four characters.
- **Key checks** live in the pi integration (the only code that knows provider endpoints) and use only
  documented, non-generating model-listing or key-information endpoints, with the key in a header,
  never in a URL. A provider without such an endpoint reports `unchecked`.

## Amendment (2026-10-03, NXR-052d)

- Native subscription ports live in each integration and are composed only by `@nexar/host`.
  Desktop IPC accepts one runtime enum; explicit shared schemas and preload validation return only
  account mode, normalized status, bounded version and login lifecycle metadata. Connected requires
  recognized vendor-account authentication; command success alone is insufficient.
- Claude Code and Codex use fixed documented browser-login commands, null stdio, public environment,
  explicit executable resolution, a five-minute deadline and cancellation. Status probes have
  ten-second deadlines and a 16 KiB cap. No login output, auth URL, code or credential is captured.
  The launcher supports vendor-owned browser callbacks; interactive/manual terminal flows must be
  completed in the vendor terminal followed by Recheck. Live browser acceptance remains pending.
- Antigravity's interactive flow has no verified standalone sign-in/status command. Its account
  status remains unknown and its login action is disabled; model metadata is not authentication.
  Default native CLI profiles remain separate from explicitly configured resources with other homes.
  See the [versioned research snapshot](../research/upstream/native-subscription-auth.md).

## Amendment (2026-10-04): resource orchestration

Connections are first-class ([ADR-027](027-resource-orchestration-architecture.md) §1–3): a provider may hold `subscription`, `api` and
`local`/`custom` connections at once, each with an auth class (`vendor-native`, `official-api`,
`official-account`, `experimental-client-compat`, `none`) and a support class (`official`,
`experimental`).

**Owner authentication policy (2026-10-04), superseding the stricter rule of §1.** Nexar prefers
vendor-owned native authentication and official account mechanisms. Experimental client-compatible
subscription authentication may also be supported when explicitly enabled by the owner, provided:

- credentials are obtained by Nexar's **own** isolated login for that connection and stored in
  Nexar's key store under it;
- credentials are **never** harvested from another application (credential files, CLI token stores,
  browser cookies, OS keyrings), and another application's auth store is never reused;
- the connection is clearly labelled experimental, disabled by default and visible to routing as
  such;
- vendor support status, terms/account risk, token storage, refresh behaviour and backend
  assumptions are documented per adapter before it ships (NXR-067).

Routes a vendor's terms explicitly prohibit (Antigravity Additional Terms §6) are excluded unless a
later owner ADR decides otherwise. "A subscription never powers pi-ai or DSH" now reads: never through
extracted vendor tokens; a Nexar-owned experimental model adapter may serve as a control or work
resource under this policy.

## Amendment (2026-10-05): ChatGPT plan through official token sharing

OpenAI documents "Sign in with ChatGPT" token sharing (`chatgpt.tokens.use.direct`) for open-source
and local personal apps: a user access token that spends the owner's ChatGPT Plus/Pro plan on the
public Responses API ([research](../research/upstream/chatgpt-sign-in-token-sharing.md)). Nexar
supports it as an **`official-account`** connection (support `official`), not as experimental
client-compat: Nexar's own PKCE sign-in (issued `client_id`, `agent_name_hint` "Nexar", a
per-installation host id), tokens in the key store under the connection, refresh in main, the ID
token validated against OpenAI's JWKS, plan use only when the granted scope includes
`chatgpt.tokens.use.direct`. Desktop main still opens no listener: the loopback callback runs in a
short-lived supervised child for one sign-in. The owner starts every sign-in; disconnecting deletes
the tokens. The experimental Codex-client route for ChatGPT is not built.
