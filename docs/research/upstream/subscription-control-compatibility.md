# Subscription and control-model compatibility spike (NXR-060/062 input)

| Field | Value |
| --- | --- |
| Date | 2026-10-04 (time-boxed; offline source research; no login, no model call) |
| OpenWorker | pinned `v0.3.0`; current `main` (inspected 2026-10-04, previously `074ad3f`): `coworker/providers/{base,registry,router,codex_provider,codex_auth}.py` |
| Claude Code | `2.1.286` (repo research `v0.3/claude-code-write.md`); installed `2.1.287` (native-subscription-auth.md) |
| Codex | `0.159.3` (repo research `v0.3/codex.md`); app-server README at `main` (2026-10-04) |
| Antigravity | `agy 1.2.14` (repo research `v0.3/antigravity.md`) |
| Gemini CLI | not installed or inspected in this repo; general knowledge only, marked UNVERIFIED |

## 1. What an engine control resource must provide

OpenWorker's control protocol is `ProviderClient.complete(model, messages, tools, **settings) →
AssistantTurn`:

- `text`
- `tool_calls[{ id, name, arguments }]`
- `finish_reason`
- `usage` (input, output, cache read, cache write)
- `reasoning` (display-only, stripped before provider calls)
- `extras` (provider-private sidecars, underscore keys)

`stream()` defaults to a single chunk. `TurnEngine` owns the loop and **executes the tools itself**.
The router resolves `provider:model` once per call; there is no mid-loop switching. Call this
property **`model-turn`**: a resource takes caller-supplied messages and JSON tool schemas, and returns
one assistant turn whose tool calls the **caller** executes. DSH's own loop needs the same property
through its LLM route.

## 2. Matrix

| Resource | Auth: official | Auth: experimental client-compat | Single model-turn | Caller-supplied tools, calls returned unexecuted | Streaming | Continuity / private state | OpenWorker control | DSH control | Worker resource |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| API models via pi-ai (Anthropic, OpenAI, Gemini, DeepSeek, Mistral, OpenRouter) | API key | — | yes | yes | yes | provider-specific (signatures, reasoning items, cache) | **yes** (through a Nexar gateway) | **yes** (through a Nexar gateway or the pi route) | yes |
| Local or custom (Ollama, LM Studio, vLLM) | none or key | — | yes | per model (`tool-use` must be verified) | yes | stateless | yes, if the model supports tools | yes, if the model supports tools | yes |
| Claude Code (Claude subscription) | `claude auth login`, `claude setup-token` (`CLAUDE_CODE_OAUTH_TOKEN`, documented for headless Claude Code) | Claude OAuth bearer against the Messages API outside Claude Code | **no** (agent loop; `-p` runs its own tools; custom tools only as MCP servers that Claude Code itself calls) | no | stream-json events | own sessions | **no** | **no** | **yes** (validated live, NXR-055) |
| Codex (ChatGPT subscription) | `codex login` (browser or device) | ChatGPT OAuth (PKCE) against `chatgpt.com/backend-api/codex` (Responses-style) | **no** officially (exec and app-server are threads with server-side state; no client-executed tools found in the app-server docs at `main`); **yes** through the experimental route | experimental route: yes | yes | Responses reasoning items (encrypted) | **only through the experimental route** | **only through the experimental route** (UNVERIFIED for DSH) | yes |
| OpenWorker `openai-codex` | — | OpenWorker's own PKCE flow with the **Codex CLI client id** `app_EMoamEEZ73f0CkXaXp7hrann`, callback `localhost:1455`, backend `chatgpt.com/backend-api/codex`; tokens in OpenWorker's SecretStore; reads no other app's credentials | yes (`CodexProvider` satisfies `ProviderClient`) | yes | yes | sidecars in `extras` | works **inside OpenWorker** (OpenWorker-owned auth) | n/a | n/a |
| Gemini CLI (Google account) | Gemini CLI login (UNVERIFIED here) | Google OAuth against the Code Assist backend (UNVERIFIED) | **no** officially (agent); experimental route UNVERIFIED | experimental: function declarations (UNVERIFIED) | — | thought signatures | research required | research required | yes, once an adapter exists |
| Antigravity (Google account) | interactive `agy` sign-in | **excluded:** Additional Terms §6 calls third-party access with Antigravity OAuth a breach; account suspensions were reported in Feb 2026 | no (agent) | no | stream-json | own state | **no** | **no** | yes (experimental adapter, official binary only) |

Every row also has these properties:

- **Cancellation:** process kill for native CLIs, HTTP abort for model routes.
- **Usage:** native CLIs report usage when they emit it (`Measured`); quota is unknown unless
  vendor-reported (ADR-020).

## 3. Findings that change ADR-027

1. A subscription **can** drive a control loop when a model-turn route exists. OpenWorker's
   `openai-codex` proves this for ChatGPT. The earlier claim "engines need a local model or an API
   key" is withdrawn. Eligibility is per verified adapter.
2. Every such route found is **experimental client-compat**: a third party using a vendor's client
   identity or backend. The owner allows these when explicitly enabled (ADR-022 amendment
   2026-10-04), with an isolated, Nexar-owned login and documented risk. Antigravity stays excluded
   because of its explicit terms. Claude's route carries explicit restrictions from Anthropic on
   third-party use of subscription OAuth: re-verify the current text before enabling, high risk.
3. Official native CLIs are **work resources**, not control resources.
4. OpenWorker has **no provider extension seam**. A Nexar provider needs one of these:
   - an upstream entry-point seam;
   - a supervised loopback gateway that OpenWorker's `openai` provider reaches through `base_url`
     (Chat Completions);
   - a minimal maintained patch.
5. Provider-private state (Gemini thought signatures, OpenAI reasoning items, Anthropic tool
   semantics, tool-call ids) is valid only for the resource that produced it. The control resource is
   therefore pinned per engine turn.
6. Code runs in the WSL plane with its own connections (ADR-025: no credentials cross the bridge).
   Code resources are the plane's resources, signed in inside the plane.

## 4. Open questions (for the units that need them)

- Gemini CLI auth and backend specifics, and their terms (NXR-067 research before any adapter).
- Whether Codex app-server can be configured to return client-executed tools (protocol schema diff
  against `generate-json-schema`), which would give an official ChatGPT route.
- DSH: whether its LLM route accepts an OpenAI-compatible base URL without a key, and whether its
  MCP client can reach a lane-local relay (NXR-064).
- OpenWorker: at-rest handling of provider keys and OAuth tokens in its private state (NXR-063).
