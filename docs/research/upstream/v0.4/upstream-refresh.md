# Upstream refresh for Nexar v0.4 "Resource Intelligence" (quota, cost, and history-aware routing)

Inspected: 2026-10-01 (`date` = Thu Oct 1 2026 UTC). This note is a delta on
`docs/research/upstream/v0.3/{codex,antigravity,claude-code-write}.md`, `pi.md` and `deepseek-harness.md`.
It covers only what is new or matters for quota, cost, catalog or probe work.
Legend: **[V]** verified (observed locally or read in source/raw docs), **[D]** stated in official docs
(fetched today, not exercised), **[U]** UNVERIFIED.
No model prompt, login, `claude -p`, `codex exec`, `agy -p` or credential-file read was made. No quota
numbers are given anywhere in this note.

## 0. Version table

| Runtime | Installed (observed) | Latest available | Change since v0.3 note |
|---|---|---|---|
| Claude Code | `2.1.287` [V] | npm `@anthropic-ai/claude-code` = `2.1.287` [V] | was 2.1.286 |
| Codex CLI | `codex-cli 0.159.3` [V] | npm `latest` 0.159.3; `alpha` 0.161.0-alpha.13 [V] | alpha moved from .8; source still `444da310` |
| Antigravity `agy` | `1.2.14` [V] | updater manifest `linux_amd64.json` → `1.2.14` [V] | none |
| DeepSeek Harness `dsh` | `0.2.0-rc.2` [V] | npm `latest`=`next`=`0.2.0-rc.2`, `alpha` 0.1.7-alpha.2 [V] | none |
| pi-ai | `0.99.2` (repo pin, `integrations/pi`) [V] | npm `0.99.2` [V] | none |
| Ollama | not installed (`which ollama` → rc 1) [V] | n/a | n/a |

## 1. Claude Code (`claude`)

- **Probes (free) [V]:** `claude --version`; `claude auth status` (`--json` is the default, `--text` also
  works). Observed keys: `loggedIn`, `authMethod` (here `oauth_token`), `apiProvider` (`firstParty`),
  `analyticsDisabled`, `projectsDirectory`, `configDirectory`. **No plan, quota or usage field** appears
  with this auth method. Whether `subscriptionType` shows up after a `/login` session is [U]. The SDK
  `AccountInfo` type does have `subscriptionType?`, `tokenSource?` and `apiKeySource?` [D].
  `claude doctor` exists. Its quota output is [U].
- **Pre-run quota probe: none that is free and supported.**
  - `/usage` (aliases `/cost`, `/stats`) shows "plan usage limits" for Pro/Max/Team/Enterprise [D]. The
    typescript doc says a `/usage` prompt in `-p`/SDK mode returns its output as an
    `SDKAssistantMessage` [D]. Whether this costs nothing and makes no model call is [U]. The
    command was not run because `-p` is outside the allowed probe set. The docs also say the usage
    endpoint is itself rate-limited, and that `/usage` then falls back to "last-known usage" [D].
  - Status-line JSON `rate_limits.{five_hour,seven_day}.{used_percentage,resets_at}` (0-100, epoch
    seconds) and `rate_limits.spend_limit.*` are documented [D]. They exist only in an interactive
    status-line hook, "only after the first API response in the session", and only for Pro/Max (or
    gateway spend limits). That makes them unusable as a headless probe.
- **In-run quota signal (stream-json / Agent SDK):** the `SDKRateLimitEvent` type is documented [D]:
  `{type:"rate_limit_event", rate_limit_info:{status:"allowed"|"allowed_warning"|"rejected",
  resetsAt?:number, utilization?:number, errorCode?:"credits_required", canUserPurchaseCredits?,
  hasChargeableSavedPaymentMethod?}, uuid, session_id}`, "emitted when the session encounters a rate
  limit". The schema embedded in the 2.1.287 binary also has these fields [V, strings]:
  - `rateLimitType` ∈ `five_hour|seven_day|seven_day_opus|seven_day_sonnet|seven_day_overage_included|overage`
  - `overageStatus`, `overageResetsAt`, `overageDisabledReason`, `isUsingOverage`
  - `surpassedThreshold`
  - `unifiedWindows.{five_hour,seven_day,…}.{utilization,resetsAt}`, marked `@internal`. Its doc string
    says it is read "from the anthropic-ratelimit-unified-* response headers".

  Only the documented subset is safe to depend on. `utilization` is a 0-1 fraction (the binary doc
  says it can exceed 1). Emission inside CLI `--output-format stream-json` is inferred, not observed:
  the event is in the SDK message union and the stdout schema. Status: [U] live.
- **Failure signals [D]:** `system/api_retry` carries `{attempt, max_retries, retry_delay_ms,
  error_status, error}`, where `error` ∈ `authentication_failed, oauth_org_not_allowed,
  account_on_hold, billing_error, rate_limit, overloaded, invalid_request, model_not_found,
  server_error, max_output_tokens, cloud_credential_error, unknown`. `rate_limit` = 429 "against your
  quota" and `overloaded` = 529 capacity (distinguish them!).
- **Cost [D]:** `total_cost_usd`, `usage` and `modelUsage[model].costUSD` are "client-side estimates"
  at list price (unless an admin sets the managed `modelPricing`). For a subscription they are notional.
  Docs: "Do not bill end users or trigger financial decisions from these fields". Authoritative spend
  is the Console / Usage and Cost API (admin key; not in scope).
- **Budget flag [V/D]:** `--max-budget-usd <amount>` ("only works with --print"). It stops on the
  client-side estimate, counts only the call's own spend (resumed totals excluded), and ends with result
  subtype `error_max_budget_usd`. It is a useful hard ceiling even under a subscription, as a token
  proxy, but it is not a quota.
- **Model catalog:** no listing command. `--model` takes aliases (`fable`, `opus`, `sonnet`) or full
  names [V help]. The `system/init` event reports the model in use [D].

## 2. Codex CLI (`codex`)

- **Probes [V]:** `codex --version`; `codex login status` now prints `Logged in using ChatGPT` (exit 0).
  In v0.3 it printed "Not logged in", so the host state changed and the binary did not. The output is
  plain text with no plan or quota field. `codex doctor --json` ("redacted machine-readable report")
  exists (help only, not run; content [U]). `codex debug models [--bundled]` = "Render the raw model
  catalog as JSON" (help only; `--bundled` skips the network refresh) [V help]. Its `ModelInfo` fields
  include `slug, display_name, context_window, max_context_window, auto_compact_token_limit,
  input_modalities, supported_reasoning_levels, visibility, supported_in_api` [V source]. **No price
  fields.**
- **`codex exec --json` does NOT emit rate limits [V source @444da310].** The `exec/src` crate has no
  reference to `rate_limit`/`TokenCount`. The `ThreadEvent` variants are unchanged:
  `thread.started, turn.started, turn.completed{usage}, turn.failed{error:{message}},
  item.started|updated|completed, error{message}`. A usage-limit hit is visible only as the free-text
  `turn.failed.error.message`, which is rendered from `UsageLimitReachedError` and starts with
  `You’ve hit your usage limit` (note the U+2019 apostrophe; `protocol/src/error.rs` L683-775). The
  struct itself has `plan_type, resets_at, limit_window_minutes, rate_limits, rate_limit_reached_type`,
  but exec flattens it to a string. Classifying it means matching text, so it is fragile.
- **Structured rate limits exist only in the internal protocol (`TokenCountEvent{info,
  rate_limits: RateLimitSnapshot}`, TUI) and in the app-server [V source, D docs]:**
  - `codex app-server` (help: "[experimental]"). The docs say the app-server command and WebSocket
    transport "are experimental and aren't supported for production workloads" [D].
  - Request `account/rateLimits/read` → `{rateLimits, rateLimitsByLimitId?, rateLimitResetCredits?,
    ordinaryUsageAllowed?, accountId?, …}`. The notification is `account/rateLimits/updated
    {rateLimits}`.
  - `RateLimitSnapshot` (camelCase on the wire) = `limitId, limitName, normalModelSlug,
    primary/secondary: {usedPercent (0-100), windowDurationMins, resetsAt (unix s)}, credits:
    {hasCredits, unlimited, balance}, individualLimit: {limit, used, remainingPercent, resetsAt},
    spendControlReached, planType, rateLimitReachedType` (enum `rate_limit_reached |
    workspace_{owner,member}_{credits_depleted,usage_limit_reached}`).
  - The task brief's guessed names `used_percent` / `resets_in_seconds` are the core-protocol
    snake_case form `used_percent, window_minutes, resets_at`. `resets_in_seconds` does not exist in
    current source.
  - Backend call: `GET chatgpt.com/backend-api/wham/usage` (`backend-client/src/client.rs`
    `get_rate_limits`) [V source]. It is a usage read, not a model call, so presumably free [U].
    ChatGPT auth only.
  - `account/usage/read` → token-activity summary (`lifetimeTokens`, `peakDailyTokens`, daily
    buckets). API-key auth is not supported [D].
- **Cost:** none in exec events (unchanged). **Budget flag: none** (`exec --help` has no
  budget/limit/token option [V]).
- Upstream DeepSeek Harness drives Codex through the app-server (`subagent-codex`), which is a
  precedent for using it programmatically.

## 3. Antigravity (`agy`) — the biggest change in quota visibility

- **Probes [V]** (fresh `HOME`, stdin closed, 10 s timeout): `agy --version` → `1.2.14`. `agy models`
  prints `Fetching available models...` + `Error: Please sign in to view available models. Launch
  the CLI without arguments to sign in.` with **exit 0**, so the caller has to parse the text.
  `--help` lists no quota or usage subcommand. Subcommands: `agent(s) changelog help install mcp
  mic-serve models plugin(s) remote-control update`.
- **Quota read via print-mode slash commands [D, changelog 1.1.11, read locally via `agy
  changelog`]:** "`-p "/usage"`, `/quota`, `/credits`, `/model`, `/effort` and `/skills` emit one
  tab-separated record per line — or a structured payload under `--output-format json` and
  `stream-json` — without starting an agent turn, spending quota, or leaving a conversation behind."
  - The docs (`/docs/cli/headless`) say these "produce a text report rather than a standard event
    stream" and are rejected inside `--input-format stream-json` sessions.
  - The `/docs/plans` page lists `/usage` ("Model quotas") and `/credits`, says Pro/Ultra quota is
    "refreshed every five hours" and other plans weekly, and describes an "AI Credit Overages"
    setting (Never/Always).
  - The JSON payload shape is [U]: not run, because `-p` is forbidden here and unauthenticated `-p`
    starts interactive OAuth (v0.3 finding).
  - A safe probe would be: `agy models` first and abort unless signed in, then `agy -p "/quota"
    --output-format json`. This needs a spike on an authenticated host.
- Other relevant changelog items [V text]:
  - The client honours the server retry delay and "stops right away instead of retrying when the
    delay is longer than 30 seconds or the quota is a daily or billing cap" (1.2.13).
  - Status line has a `cost` field (estimated session cost, 1.1.21).
  - Exit code 3 + stderr `AGY_ERROR:{status,code,retryable}` (1.2.10, from v0.3).
- Cost: JSON `usage{input_tokens, output_tokens, thinking_tokens, cache_read_tokens, total_tokens}`,
  no cost field [D]. **No budget flag** [V help]. Model catalog: `agy models` (auth required).

## 4. DeepSeek Harness (`dsh`) and the DeepSeek API

- Probes [V]: `dsh --version` → `0.2.0-rc.2`. `dsh --help` gives launcher flags only
  (`--profile`, `--patch`, `--dump-config`, `--dump-config-schema`); no usage, balance or budget flag.
- Usage reporting [V, installed package types/READMEs]:
  - `dsh-llm` `TokenUsage{inputTokens (uncached only), outputTokens, totalTokens?, cacheReadTokens?,
    cacheWriteTokens?, reasoningTokens?}`. The counts are **disjoint** (billed input = sum of the
    three).
  - It is carried on session-log events (`usage?: TokenUsage` in `dsh-session`), so it reaches the
    SDK through the `session.event` notification payloads.
  - `headless --json` events (`session,status,text,thinking,tool_call,tool_result,final,error`)
    carry no usage or cost per its README.
  - `dsh-token-meter` = deterministic, replay-based context-pressure estimate (no model calls), not
    billing.
  - No USD cost or budget cap found [U, not searched exhaustively].
- Balance: `dsh-api-account-controller`/`dsh-deepseek-account` expose `getBalance` (recharge and
  bonus wallets) for the **account-login** route (web/desktop), not the API key [V README]. Not
  reachable from the SDK/headless wire [U].
- **DeepSeek API [D]** (api-docs.deepseek.com):
  - `GET /user/balance` (Bearer API key) → `{is_available, balance_infos:[{currency CNY|USD,
    total_balance, granted_balance, topped_up_balance}]}` (decimal strings). The docs do not mention
    a cost for this endpoint. It is a non-inference read, so presumably free [U]. Not called (no key).
  - Pricing page: models `deepseek-flash`, `deepseek-v4-pro`, 1M context, 384K max output.
    **Peak/off-peak pricing** (off-peak = half price; peak windows are UTC weekday hours, holidays are
    off-peak).
  - Fees are deducted from the granted balance first, then the topped-up balance.
  - pi-ai's `deepseek-v4-pro` rates (1.32/3.96/0.044 $/M) equal the **peak** rates, so pi-ai has no
    time-of-day pricing and over-estimates cost off-peak.

## 5. pi-ai 0.99.2 (repo pin) — catalog API [V .d.ts + offline run]

- Entry points: `createModels()` (`@earendil-works/pi-ai`), `builtinModels()`
  (`/providers/all`), `calculateCost(model: AnyModel, usage: Usage): Usage["cost"]` (`dist/models.d.ts`).
- `Models` methods:
  - `getProviders(): readonly Provider[]`
  - `getModels(provider?)`
  - `getModel(provider, id)`
  - `getModelsOfType(type, provider?)`
  - `getAvailable(providerId?, opts?)` (only models with usable auth)
  - `refresh(opts?)`
  - `getAuth(providerId | model, overrides?)`
- `Provider` keys: `id, name, baseUrl, headers, auth, getModels, getAllModels, refreshModels,
  filterModels, filterAllModels, stream, streamSimple`.
- `BaseModel`: `id, name, api, provider, baseUrl, input: ("text"|"image")[], inputLimits?,
  cost: ModelCost, headers?`.
- `Model` (chat) adds `type?:"chat", reasoning: boolean, thinkingLevelMap?, promptCache?,
  contextWindow: number, maxTokens: number, samplingParams?, compat?`.
- `ModelCost = {input, output, cacheRead, cacheWrite}` in **USD per 1M tokens**, plus `tiers?:
  [{inputTokensAbove, …rates}]` ("highest matching input threshold applies to the full request").
- Offline count:
  - 42 providers, 1529 chat models, 51 with tiers.
  - **120 have input = output = 0.** They cluster in nvidia, openrouter, opencode, qwen/xiaomi
    "token-plan" and gateway providers. Zero means "free, unknown, or plan-billed" and is
    indistinguishable, so Nexar must map a 0/0 rate to `Measured` *unknown* and never to a measured
    free cost.
  - Sample: `anthropic/claude-sonnet-4-5` ctx 1,000,000, maxTokens 64,000, reasoning, text+image,
    $3/$15/0.3/3.75.
- Rate-limit capture: `StreamOptions.onResponse(response: {status, headers}, model)` exposes raw
  response headers [V .d.ts]. That allows **passive** capture of provider rate-limit headers on calls
  Nexar already makes, with no extra calls.
- The catalog is a static snapshot per release (from models.dev and similar sources). Rates are list
  prices with no time-of-day pricing (see the DeepSeek note above).

## 6. Local runtimes (Ollama) [D, docs.ollama.com]

- Not installed here.
- Documented free local endpoints (default base `http://localhost:11434`):
  - `GET /api/tags`: per model `name, model, modified_at, size, digest, details{format, family,
    families, parameter_size, quantization_level}`.
  - `POST /api/show {model, verbose?}`: `parameters, license, template, capabilities, model_info`
    (context length under the `<arch>.context_length` key, e.g. `gemma4.context_length`).
  - `GET /api/ps` (running models) and `GET /api/version`.
  - OpenAI-compatible `GET /v1/models` and `/v1/models/{model}` → `id, object, created, owned_by`.
  - The cloud variant `https://ollama.com/v1` needs `OLLAMA_API_KEY`, so it is out of scope for "local".
- Usage per response: `prompt_eval_count`, `prompt_eval_cached_count`, `eval_count` and durations
  (ns). No cost. Quota does not apply (local compute).
- The probe must target only the owner-configured base URL. No scanning.

## 7. Provider API rate-limit headers (note only; returned on paid calls) [V raw docs]

- Anthropic (`platform.claude.com/docs/en/api/rate-limits`): `anthropic-ratelimit-{requests,tokens,
  input-tokens,output-tokens}-{limit,remaining,reset}`, plus `retry-after` on 429.
  `anthropic-ratelimit-unified-*` (subscription windows) is referenced only inside the Claude Code
  binary and is not publicly documented, so do not depend on it.
- OpenAI (`platform.openai.com/docs/guides/rate-limits`): `x-ratelimit-{limit,remaining,reset}-
  {requests,tokens}` and `x-ratelimit-{limit,remaining,reset}-project-tokens`.
- These are per-minute API rate limits, not plan quotas or balances. Capture them passively (pi-ai
  `onResponse`) and keep them short-lived.

## 8. Implications for v0.4

1. No subscription runtime offers a quota probe that is free, headless and officially *supported*:
   - Codex's is documented but sits on an experimental surface.
   - agy's is documented in the changelog and docs but its JSON shape is unverified.
   - Claude's appears only as an in-run event.

   The default quota model therefore has to be **Nexar accounting + owner-declared limits**. Vendor
   signals should update state opportunistically: Claude `rate_limit_event`, Codex
   `turn.failed`/usage-limit text, agy exit 3/`AGY_ERROR`, `api_retry error=rate_limit`.
2. Treat every reset time a vendor reports (`resetsAt`, `resets_at`) as "unavailable until" in the
   registry's dynamic state. Never derive "available" from percentages alone. Codex docs: "clients
   must not infer recovery from percentages or reset times" (`ordinaryUsageAllowed`).
3. Cost: every runtime-reported USD figure is an estimate (Claude `total_cost_usd`, agy status-line
   `cost`, pi-ai `usage.cost`), so label it `estimated`. Subscription runs have a notional cost only;
   route on tokens and windows, not dollars. Map 0/0 catalog rates to unknown.
4. Budget enforcement: Claude `--max-budget-usd` is the only native per-run cap. Codex, agy and dsh
   need Nexar-side caps (timeouts, turn caps, token accounting from events).
5. Spike candidates (owner machine, authenticated): `agy -p "/quota" --output-format json` shape and
   zero-cost claim; `codex app-server` `account/rateLimits/read` as a read-only probe; Claude
   `-p "/usage"` cost and shape; DeepSeek `/user/balance` with the owner's key.

## 9. Recommended quota source per resource

| Resource | Quota / allowance source (v0.4) | Vendor signal to ingest (passive) | Cost basis | Probe commands (free) |
|---|---|---|---|---|
| Claude Code (subscription) | **owner-declared** (plan windows) + **nexar-accounting** (tokens per window) | `rate_limit_event` (status, resetsAt, utilization), `api_retry` `error=rate_limit` | estimate (notional) | `--version`, `auth status` |
| Codex CLI (ChatGPT) | **owner-declared** + **nexar-accounting**; *vendor-probe candidate* `app-server account/rateLimits/read` (documented, experimental, so off by default pending ADR + spike) | `turn.failed` text `You’ve hit your usage limit…` | unknown (tokens only) | `--version`, `login status` |
| Antigravity `agy` | **owner-declared** + **nexar-accounting**; *vendor-probe candidate* `agy -p "/quota"` / `"/usage"` `--output-format json` (documented as quota-free, shape [U]; only after `agy models` shows signed-in) | exit 3 / `AGY_ERROR{code,retryable}` | unknown (tokens only) | `--version`, `models` |
| DeepSeek Harness → DeepSeek API | **vendor-probe** `GET /user/balance` is documented and non-inference, but needs the owner's key and its zero cost is [U]. Until spiked: **nexar-accounting** of disjoint `TokenUsage` × peak/off-peak price table | `session.event` usage | nexar-computed estimate | `dsh --version` |
| pi-ai (API-key providers) | **nexar-accounting** (`usage` × catalog rates; 0/0 rate → unknown) + **owner-declared** budgets | `onResponse` rate-limit headers (`anthropic-ratelimit-*`, `x-ratelimit-*`) | catalog estimate | none needed (`getModel`) |
| pi-ai OAuth/subscription providers | **unknown** (policy-risky; keep disabled) | n/a | notional | n/a |
| Ollama / local OpenAI-compatible | no quota (**owner-declared** concurrency only) | n/a | zero marginal $ (record as local, not as measured 0 API cost) | `GET /api/tags`, `/api/version`, `/v1/models` on the configured base URL |

## Sources

- Local runs: `claude --version|--help|auth status [--help]|auth --help`; `codex --version|--help|exec
  --help|login status|doctor --help|debug [models] --help`; `agy --version|--help|models|changelog`
  (fresh HOME); `dsh --version|--help`; `npm view` for @openai/codex, @earendil-works/pi-ai,
  @deepseek-ai/dsh, @anthropic-ai/claude-code; agy updater manifest `manifests/linux_amd64.json`;
  `strings`-grep of `/opt/claude-code/bin/claude` for the `rate_limit_info` schema.
- Codex source @ `444da310e108da16aaeb18fd790b0ac464f08aca`: `codex-rs/exec/src/exec_events.rs`,
  `protocol/src/protocol.rs` (L2342-2420), `protocol/src/error.rs` (L683-775),
  `app-server-protocol/src/protocol/{common.rs L1322-1340,1999; v2/account.rs L331, 655-790}`,
  `backend-client/src/client.rs` L385, `protocol/src/openai_models.rs` L405.
- Docs (raw markdown/HTML fetched 2026-10-01): code.claude.com/docs/en/{agent-sdk/typescript,
  agent-sdk/cost-tracking, headless, costs, commands, statusline}.md; learn.chatgpt.com/docs/app-server
  (§6 Rate limits, §7 Token usage); antigravity.google/docs/{plans, cli/headless};
  api-docs.deepseek.com/{api/get-user-balance, quick_start/pricing}; docs.ollama.com/{api/tags,
  api-reference/show-model-details, api/openai-compatibility, api/usage, llms.txt};
  platform.claude.com/docs/en/api/rate-limits.md; platform.openai.com/docs/guides/rate-limits.
- pi-ai 0.99.2: `integrations/pi/node_modules/@earendil-works/pi-ai/dist/{types.d.ts L52-122, 865-960;
  models.d.ts L84-261; providers/all.d.ts}`; offline script `v04-research/pi-cat.mjs`.
- dsh 0.2.0-rc.2 (scratch install `dshtry/`): `dsh-llm/lib/types/types.d.ts` (TokenUsage),
  `dsh-session` types, `dsh-headless/README.md`, `dsh-token-meter/README.md`,
  `dsh-deepseek-account/README.md`.
