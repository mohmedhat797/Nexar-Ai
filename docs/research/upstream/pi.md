# Upstream research: Pi / pi-ai

| Field | Value |
|---|---|
| Canonical repo | https://github.com/earendil-works/pi-mono (`badlogic/pi-mono` and `earendil-works/pi` resolve to the same object: `git ls-remote` returns identical HEAD `b35af04f` for all three, so they are redirects/renames, not divergent forks) |
| Inspected commit | `d4d74eb19be92c559f629a7f9707c5503a840edc` (2026-09-30T22:32:47+02:00; tip of `main` was `b35af04f4` 25 min later, same day) |
| Inspected on | 2026-09-30 |
| npm names | `@earendil-works/pi-ai`, `@earendil-works/pi-agent-core`, `@earendil-works/pi-coding-agent` (all `latest` = **0.99.2**, published 2026-09-30) |
| Deprecated scope | `@mariozechner/pi-ai` / `pi-coding-agent`: frozen at 0.73.1 (2026-05-07), npm `deprecated`: "please use @earendil-works/pi-ai instead going forward" |
| License | MIT (root `LICENSE`, "Copyright (c) 2025 Mario Zechner"; npm `license: MIT`) |
| Runtime | Node >= 22.19.0 (`engines`); `legacy-node20` dist-tag = 0.74.2 |
| Build tool | npm workspaces (not pnpm); consumers may use any manager |

Evidence type: all claims below are from the cloned source at the SHA above, the npm registry, or a local no-network run (see "Verified API shape"). Anything else is marked UNVERIFIED.

## 1. Canonical project, packages, roles

Root `package.json` is a private workspace `pi-monorepo`; every package is at 0.99.2 and versioned in lock-step. Roles:

| Package (`packages/…`) | npm name | Role |
|---|---|---|
| `ai` | `@earendil-works/pi-ai` | Unified multi-provider LLM API (this is the Nexar candidate) |
| `agent` | `@earendil-works/pi-agent-core` | Stateful agent loop, tool execution, events, built on pi-ai |
| `coding-agent` | `@earendil-works/pi-coding-agent` | `pi` CLI (TUI, print, JSON, RPC modes) + SDK (`createAgentSession`, `RpcClient`) |
| `telemetry` | `@earendil-works/pi-telemetry` | Vendor-neutral telemetry contracts; hard dependency of pi-ai (`^0.99.2`) |
| `mcp`, `codemode` | `…/pi-mcp`, `…/pi-codemode` | MCP client; sandboxed JS tool-calling |
| `durable`, `session-backends/sqlite-node` | `…/pi-durable`, `…/pi-session-backend-sqlite-node` | Durable conversation/task runtime; SQLite session store |
| `protocol`, `client`, `server` | `…/pi-protocol`, `…/pi-client`, `…/pi-server` | Remote-session CBOR protocol; `pi-server` self-describes as "experimental" |
| `chord`, `tui`, `evals` | `…/chord`, `…/pi-tui` (evals private) | Composition runtime, terminal UI, evals |

The monorepo is broader than "pi-ai + agent": 2026-09 added durable/server/client/chord layers, i.e. Pi is becoming its own agent platform (overlapping Nexar's domain). Only `pi-ai` is a sane adapter target.

## 2. pi-ai: API surface (0.99.2)

**Breaking redesign vs 0.7x/0.8x.** The old global `getModel()/stream()/complete()` moved to `@earendil-works/pi-ai/compat`, documented as "will be removed in a future release" (`packages/ai/README.md` "Migrating from the Old Global API"). The new root entry is side-effect free (`src/index.ts`) and works through a `Models` collection.

Exact signatures (`packages/ai/src/models.ts`, interface `Models`):

```ts
createModels(options?: CreateModelsOptions): MutableModels          // @earendil-works/pi-ai
builtinModels(options?): MutableModels                              // @earendil-works/pi-ai/providers/all (all 42 providers)
models.getModel(provider: string, id: string): Model<Api> | undefined
models.getModels(provider?: string): readonly Model<Api>[]
models.stream<TApi>(model: Model<TApi>, context: Context, options?: ModelsApiStreamOptions<TApi>): AssistantMessageEventStream
models.complete<TApi>(model, context, options?): Promise<AssistantMessage>
models.streamSimple(model, context, options?: ModelsSimpleStreamOptions): AssistantMessageEventStream
models.completeSimple(model, context, options?): Promise<AssistantMessage>   // adds `reasoning`, `toolChoice`
models.getAuth(providerId | model, overrides?): Promise<AuthResult | undefined>
models.getAvailable(providerId?, opts?): Promise<readonly Model<Api>[]>      // only models with usable auth
models.refresh(options?): Promise<ModelsRefreshResult>                        // dynamic providers (llama.cpp, Radius)
models.login(providerId, type, interaction, options?) / logout(providerId)
```

**Types** (`packages/ai/src/types.ts`):
- `Context { systemPrompt?: string; messages: Message[]; tools?: Tool[] }`; `Message = SystemMessage | UserMessage | AssistantMessage | ToolResultMessage`. Every message carries `timestamp: number`.
- Content blocks: `TextContent`, `ThinkingContent` (with opaque `thinkingSignature`, `redacted`), `ImageContent` (base64 + mimeType), `ToolCall { id; name; arguments: JsonObject }`.
- `Tool { name; description; parameters: TSchema; constrainedSampling? }` uses **TypeBox** (`Type` re-exported). Validation helpers: `validateToolCall`, `validateToolArguments`. Tool results are fed back as `{ role: "toolResult", toolCallId, toolName, content, isError, timestamp }`. pi-ai does NOT execute tools; the caller loops (pi-agent-core does this).
- `AssistantMessage { content; api; provider; model; responseModel?; responseId?; usage: Usage; stopReason; errorMessage?; thinkingLevel?; diagnostics?; timestamp }`.
- `StopReason = "pending" | "stop" | "length" | "toolUse" | "error" | "aborted" | "deferred"`.

**Usage/cost (Nexar telemetry)**, `Usage`:
`input, output, cacheRead, cacheWrite, cacheWrite1h?, reasoning? (subset of output), totalTokens, cost { input, output, cacheRead, cacheWrite, total }`.
Cost is **computed by pi** as catalog `$ / million tokens` x token counts (`calculateCost`, `models.ts:1193`, with tier support via `ModelCost.tiers`), not read from a provider bill. It is an estimate; for subscription auth it reflects list price, not what the user pays (`OAuthAuth.isSubscription?: boolean` exists to flag this). Partial usage is present on `error`/`aborted` messages. `pi-ai` also accepts `telemetryContext` (from `pi-telemetry`) per request.

**Request options** (`StreamOptions`/`ProviderRequestOptions`): `signal`, `apiKey`, `fetch`, `env` (provider-scoped env override, avoids mutating `process.env`), `headers`, `timeoutMs`, `maxRetries`, `maxRetryDelayMs`, `onPayload`, `onResponse`, `onProviderStreamEvent`, `temperature`, `maxTokens`, `samplingParams`, `cacheRetention`, `sessionId`, `metadata`, `transport`. Simple options add `reasoning: "minimal"|"low"|"medium"|"high"|"xhigh"|"max"`, `toolChoice: "auto"|"none"`, `thinkingBudgets`, `deferred`.

## 3. Model registry / catalog

- Built-in catalog is **generated**: `scripts/generate-models.ts` fetches `https://models.dev/api.json`, OpenRouter `/api/v1/models`, NVIDIA and Vercel gateway listings, then applies hand overrides; output goes to `src/models.generated.ts` and `src/providers/*.models.ts` + `providers/data/*.json` (data files hydrated at build; the git-tracked `*.models.ts` are stubs). The published npm tarball contains the data (verified by running it).
- Run locally, 0.99.2: **42 providers, 1529 chat models** (`builtinModels().getModels().length`).
- `Model` fields (`types.ts:1097-1144`): `id, name, api, provider, baseUrl, input: ("text"|"image")[], cost {input,output,cacheRead,cacheWrite,tiers?} ($/M tok), reasoning: boolean, thinkingLevelMap?, contextWindow, maxTokens, promptCache?, inputLimits?, headers?, samplingParams?, compat?, type?`. Also image and classifier model types (`getModelsOfType`).
- Staleness risk: catalog ships inside the npm release; new models need a pi-ai release (they publish often) or a caller-side `createProvider` override. Dynamic listings only for some providers (`models.refresh()`).

## 4. Authentication architecture

- **Resolution**: provider-owned. Order: explicit `options.apiKey` > stored `CredentialStore` credential (owns the provider; no silent env fallback after failed OAuth refresh) > env var/ambient (README "How Auth Resolves").
- **Env vars** (README "Environment Variables"): `OPENAI_API_KEY`, `ANTHROPIC_API_KEY` (or `ANTHROPIC_OAUTH_TOKEN`; `ANTHROPIC_AUTH_TOKEN` bearer; workload-identity federation vars added in 0.99.2), `GEMINI_API_KEY`, `DEEPSEEK_API_KEY`, `MISTRAL_API_KEY`, `GROQ_API_KEY`, `XAI_API_KEY`, `OPENROUTER_API_KEY`, `COPILOT_GITHUB_TOKEN`, `AI_GATEWAY_API_KEY`, `HF_TOKEN`, Azure (`AZURE_OPENAI_API_KEY` + base URL), Bedrock (AWS chain / `AWS_BEARER_TOKEN_BEDROCK`), Vertex (`GOOGLE_CLOUD_API_KEY` or ADC), plus ~25 more.
- **OAuth/subscription providers** (verified at runtime: `provider.auth.oauth` exists on `anthropic`, `openai`, `openai-codex`, `github-copilot`, `openrouter`, `xai`, `kimi-coding`, `meta`, `radius`): Claude Pro/Max (`src/auth/oauth/anthropic.ts`, PKCE, local callback `127.0.0.1:53692`), ChatGPT ("Sign in with ChatGPT" on `openai`; `openai-codex` labelled legacy), GitHub Copilot (device code). **Gemini CLI and Antigravity were removed** ("Removed built-in Google Gemini CLI and Google Antigravity support", `coding-agent/CHANGELOG.md:1946`).
- **Token storage**: pi-ai itself stores nothing durable: `CredentialStore` (`src/auth/types.ts:65`) is injected; default is `InMemoryCredentialStore`. Contract: `read / list / modify (serialized RMW, refresh happens inside) / delete`. Shape `Credential = {type:"api_key", key?, env?} | {type:"oauth", access, refresh, expires, ...}`. The `pi` CLI persists to `<agent-dir>/auth.json` (default `~/.pi/agent`, override `PI_CODING_AGENT_DIR`); `npx @earendil-works/pi-ai login` writes `auth.json` in the **current directory**. `key` may be `"!shell command"` for secret managers (`coding-agent/docs/providers.md`).
- **ToS/policy caveats stated upstream**: the only one is an in-product warning (since 0.66.0): "Anthropic subscription auth is active. Third-party harness usage draws from extra usage and is billed per token, not your Claude plan limits." (`interactive-mode.ts:298`). Observed in source: the Anthropic OAuth flow uses a base64-obfuscated client ID and a scope list including `user:sessions:claude_code` (`anthropic.ts:12-20`), i.e. it impersonates Anthropic's first-party client. Whether Anthropic/OpenAI/GitHub permit this use is UNVERIFIED; treat as a policy risk for Nexar.

## 5. Local models

OpenAI-compatible custom `baseUrl` is first class via `createProvider()` + `openAICompletionsApi()` (README "Custom Providers"). Verified locally (no network): an `ollama` provider with `auth: { apiKey: { name, resolve: async () => ({ auth: {} }) } }` registers and `getAuth('ollama')` returns `{auth:{}}`. `OpenAICompletionsCompat` covers quirks (`maxTokensField`, `supportsDeveloperRole`, `thinkingFormat`, vLLM `thinkingTokenBudgetField`, `chatTemplateKwargs`), and `samplingParams` passes `top_k/min_p/...`. The `pi` CLI reads `models.json` for Ollama/LM Studio/vLLM/SGLang and has a dedicated llama.cpp router provider (`docs/models.md`, `docs/llama-cpp.md`). Not verified by a real run: actual Ollama/vLLM calls (UNVERIFIED).

## 6. Streaming and abort

`stream()` returns `AssistantMessageEventStream` (async-iterable + `.result(): Promise<AssistantMessage>`). Events (`AssistantMessageEvent`): `start`, `text_{start,delta,end}`, `thinking_{start,delta,end}`, `toolcall_{start,delta,end}`, `done{reason,message}`, `error{reason:"error"|"aborted",error}`; each carries a live `partial`. Post-start failures never throw: they arrive as `error` event and `result()` returns a message with `stopReason` `"error"`/`"aborted"`, `errorMessage`, partial content and usage. Abort = `options.signal` (`AbortSignal`); aborted partials can be replayed into the next request. Verified: a call with no credentials resolves (no throw) to `stopReason: "error"`, `errorMessage: "Provider is not configured: anthropic"`, no network. Helpers: `isContextOverflow`, `isRetryableAssistantError`, `retryAssistantCall`.

## 7. Pi coding agent: SDK, RPC, print

Invocations (`coding-agent/docs/cli-integration.md`, `cli.md`; bin `pi` -> `dist/bundle/cli.js`):
- Print: `pi --print "prompt"` (or `-p`; also implied when stdin/stdout are piped). Final text on stdout; nonzero exit when final stop reason is `error`/`aborted`.
- JSON: `pi --mode json "prompt" > events.jsonl` -- session header + JSONL events (`agent_start`, `turn_*`, `message_*`, `message_update` with `assistantMessageEvent`, `agent_end`, `agent_settled`); one invocation; a failed assistant message does NOT give a nonzero exit.
- RPC: `pi --mode rpc --no-session`; JSONL over stdio (LF-framed, not `readline`). Commands `prompt`, `steer`, `follow_up`, `abort`, `get_state`, `set_model`, `get_available_models`, `compact`, `bash`, `fork`, ...; `{"id","type":"response","success"}` replies; wait for `agent_settled`. Typed client: `RpcClient` exported from the package.
- SDK: `import { createAgentSession } from "@earendil-works/pi-coding-agent"; const { session } = await createAgentSession(); await session.prompt(...); session.subscribe(ev => ...)`; `SessionManager.inMemory()` avoids session files.
- Security: upstream states Pi has **no permission system** and runs with the user's rights (`README.md`, `docs/security.md`); sandbox it (Docker, Gondolin micro-VM, OpenShell).

## 8. DeepSeek Harness integration

Both directions exist. (a) pi-ai ships a built-in `deepseek` provider (`src/providers/deepseek.ts`, `DEEPSEEK_API_KEY`, `openai-completions`; models `deepseek-flash`, `deepseek-v4-pro` in 0.99.2). (b) DeepSeek Harness (`github.com/deepseek-ai/deepseek-harness`, MIT, commit `639ed015`, 2026-09-29) contains `packages/llm/llm-pi-ai` = `@deepseek-ai/dsh-llm-pi-ai` 0.2.0-rc.2, "pi-ai-backed multi-provider adapter for the harness LLM seam", with per-request profile/credential resolution. It depends on `@earendil-works/pi-ai` **`^0.87.1`**, which under semver 0.x caret means `>=0.87.1 <0.88.0` and therefore excludes 0.99.x: a real-world data point that 0.x minors break integrators, and that a mature third party pins pi-ai behind an adapter seam (the pattern Nexar wants). DeepSeek Harness is a separate coding agent (competitor to Pi), not built on Pi's agent. Press comparisons found via WebSearch (composio, harnessrouter) were not read: UNVERIFIED.

## 9. When native runtimes beat pi-ai

- Claude Code / Codex CLI are preferable when the goal is an **autonomous coding run** with vendor-tuned tool loops, sandboxing/permissions, plan/compaction behavior, and subscription use that is sanctioned by the vendor. pi-ai only gives one LLM turn; tool execution, permissions and loop are yours (or pi-coding-agent's, which has no permission layer).
- Subscription entitlement: using Claude Pro/Max or ChatGPT plan quota through a third-party harness is the ToS-risky path (section 4); native CLIs are the supported path. Use pi-ai with API keys, gateways, local models, Bedrock/Vertex for plain inference.
- Provider-specific features (Anthropic server tools/MCP connector, OpenAI built-in tools, Claude Code hooks/skills) are only partially surfaced by the unified API. Judgment, not measured: UNVERIFIED.

## 10. Update cadence and breaking-change risk

- Commits: 476 on `main` in the 31 days to 2026-09-30 (histogram shows 15-40/day in the last 3 days); authors Armin Ronacher 151, Mario Zechner 124, David Brailovsky 91 (+ others).
- npm pi-ai: 52 versions since the scope move; 0.80.6 (07-09) ... 0.87.1 (09-22) then **0.99.0 (09-29), 0.99.1 (09-29), 0.99.2 (09-30)**. Previous scope had 308 versions. Roughly one minor per 1-2 weeks, patches same day.
- Breaking changes are routine and listed under "### Breaking Changes" (28 mentions in `packages/ai/CHANGELOG.md`): 0.99.0 removed the separate `ImagesModels` collection and bumped the generated model-data schema to v6; the global API moved behind `/compat` (itself slated for removal). 0.x semver gives no stability guarantee. Plus repo/scope renames in 2026 (badlogic -> earendil-works; `@mariozechner` -> `@earendil-works`; issue links now point to `earendil-works/pi`).
- Install weight: `npm i @earendil-works/pi-ai@0.99.2` = 50 packages, 104 MB `node_modules` (AWS SDK, `@google/genai`, `openai`, `@anthropic-ai/sdk`); subpath imports with lazy API loaders reduce runtime load, not install size.

## Integration opportunities

- One typed call shape across 40+ providers and 1500+ models, with consistent `Usage` (incl. cache and reasoning tokens) that maps directly to Nexar telemetry.
- Streaming with partial-message semantics, abort via `AbortSignal`, cross-provider context handoff (thinking blocks/tool calls converted), prompt-cache options.
- Local/OpenAI-compatible endpoints as plain `createProvider` config; keyless providers supported.
- Injectable `CredentialStore` so Nexar's own local-first secret store owns credentials and pi-ai never touches `~/.pi`.
- `fauxProvider()` gives deterministic contract tests with no network (verified).
- `@earendil-works/pi-ai/models` lightweight entry (0.99.2) for constructing collections without bundling every catalog.

## Integration risks

- API churn (see section 10); the Nexar adapter must be the only importer; pin exact.
- Policy risk on OAuth subscription providers (Claude Pro/Max, ChatGPT) and client-ID impersonation; upstream's own warning says third-party use is billed as extra usage. Default Nexar to API-key/local; gate OAuth behind explicit opt-in and a warning.
- Cost is catalog-estimated; stale or missing rates give wrong numbers; subscription use shows a non-real cost.
- Large transitive footprint (104 MB), Node >= 22.19 floor (check Nexar's Node 22 minor), hard dep on `pi-telemetry`.
- Pi types (`Model`, `Context`, TypeBox `TSchema`, event types) must not leak: tool schemas need conversion from Nexar's schema to TypeBox.
- Platform-creep: monorepo growing into durable sessions/server/chord overlaps Nexar; do not adopt those.
- `pi-coding-agent` has no permission system; do not run it unsandboxed as an execution backend.
- Maintainership concentrated in a few people; new-contributor PRs/issues auto-closed (root README), so upstream fixes need paid/maintainer attention.

## Recommended Nexar boundary

- **Depend on:** `@earendil-works/pi-ai` only (exact-pinned, e.g. `"@earendil-works/pi-ai": "0.99.2"`, no caret, committed lockfile; renovate bot PRs gated by the adapter contract tests). Do not depend on `@mariozechner/*`, `/compat`, `pi-agent-core`, `pi-coding-agent`, `pi-server/client/durable/chord`.
- **Where:** a single workspace package, e.g. `packages/adapters-pi-ai`, exporting Nexar's `ModelExecutor` port implementation; nothing else imports `@earendil-works/*` (enforce with a lint/dep-cruiser rule).
- **Import subpaths:** `@earendil-works/pi-ai`, `.../providers/<id>` for an allowlist of providers (not `providers/all`) and `.../api/openai-completions.lazy` for local endpoints.
- **Auth:** implement Nexar's `CredentialStore` over its own secret store; pass `env`/`apiKey` per request; never call `login()` for subscription providers by default.
- **Sketch** (Nexar names illustrative):

```ts
// Nexar domain (no Pi types)
interface ExecutionRequest { modelRef: {provider: string; id: string}; system?: string;
  messages: NexarMessage[]; tools?: NexarToolSpec[]; maxOutputTokens?: number;
  reasoning?: "low"|"medium"|"high"; signal: AbortSignal; correlationId: string }
interface ExecutionResult { content: NexarBlock[]; stop: "end"|"length"|"tool_use"|"error"|"aborted";
  usage: { inputTokens; outputTokens; cacheReadTokens; cacheWriteTokens; reasoningTokens?;
           estimatedCostUsd; costBasis: "catalog-estimate" }; providerModel: string; error?: string }

// adapter
async execute(req): Promise<ExecutionResult> {
  const model = this.models.getModel(req.modelRef.provider, req.modelRef.id);
  if (!model) return unknownModel(req);
  const ctx: Context = { systemPrompt: req.system, tools: toTypeBox(req.tools),
                         messages: toPi(req.messages) };
  const msg = await this.models.completeSimple(model, ctx,
      { signal: req.signal, maxTokens: req.maxOutputTokens, reasoning: req.reasoning });
  return fromPi(msg);   // msg.usage -> usage; stopReason map: stop->end, toolUse->tool_use, length, error, aborted
}
// executeStream(): iterate models.streamSimple(...) and map text_delta/toolcall_end/done/error to NexarEvents
```

- **Catalog:** expose `models.getModels()` mapped to Nexar `ModelInfo` (`contextWindow`, `maxTokens`, `reasoning`, `input`, `cost`), but let Nexar's own registry override rates.
- **Tests:** contract suite using `fauxProvider()`; snapshot test on `Object.keys(pi-ai)` subset used; smoke job on each version bump.

## Open questions

- Does Anthropic/OpenAI/GitHub permit this third-party OAuth use for Nexar users? (UNVERIFIED)
- Real-world behavior against Ollama/vLLM/LM Studio with tool calls and streaming usage (UNVERIFIED; needs a local run).
- Will `/compat` removal and further 0.x redesigns continue after a 1.0? No roadmap read (RFCs at rfc.earendil.com not checked).
- Is per-token `usage.cost` accurate for tiered/cached pricing across providers (spot-check vs invoices)? UNVERIFIED.
- Is the Node 22.19 minimum compatible with Nexar's pinned Node 22 patch?
- Do we want pi-agent-core for multi-step loops, or keep the loop in Nexar (recommended: keep)?
- DeepSeek Harness relationship and licensing of its adapter is separate from Pi; third-party analysis not read.

## Verified API shape (local run, no network, no credentials)

`npm i @earendil-works/pi-ai@0.99.2` in a scratch dir, Node 22.22.2. Verified minimal call shape:

```ts
import { createModels, fauxProvider, fauxAssistantMessage, fauxText } from "@earendil-works/pi-ai";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";
const models = builtinModels();                                   // 42 providers, 1529 chat models
const model = models.getModel("anthropic", "claude-sonnet-4-5");  // Model<Api> | undefined
const msg = await models.complete(model!, { systemPrompt, messages: [{ role: "user", content: "hi", timestamp: Date.now() }], tools }, { signal, maxTokens: 100 });
// msg.usage = { input, output, cacheRead, cacheWrite, totalTokens, cost: { input, output, cacheRead, cacheWrite, total } }
```

Executed end-to-end only against `fauxProvider()` (usage + toolCall content returned) and unconfigured-provider error path; no real provider call was made.

## Sources (permalinks at `d4d74eb19be92c559f629a7f9707c5503a840edc`)

- https://github.com/earendil-works/pi-mono/blob/d4d74eb19be92c559f629a7f9707c5503a840edc/README.md
- https://github.com/earendil-works/pi-mono/blob/d4d74eb19be92c559f629a7f9707c5503a840edc/packages/ai/README.md
- https://github.com/earendil-works/pi-mono/blob/d4d74eb19be92c559f629a7f9707c5503a840edc/packages/ai/src/index.ts
- https://github.com/earendil-works/pi-mono/blob/d4d74eb19be92c559f629a7f9707c5503a840edc/packages/ai/src/models.ts#L244-L323 (Models interface), `#L1193` (calculateCost)
- https://github.com/earendil-works/pi-mono/blob/d4d74eb19be92c559f629a7f9707c5503a840edc/packages/ai/src/types.ts#L427 (Usage), `#L546` (AssistantMessage), `#L767` (events), `#L1097` (Model)
- https://github.com/earendil-works/pi-mono/blob/d4d74eb19be92c559f629a7f9707c5503a840edc/packages/ai/src/auth/types.ts#L65 (CredentialStore)
- https://github.com/earendil-works/pi-mono/blob/d4d74eb19be92c559f629a7f9707c5503a840edc/packages/ai/src/auth/oauth/anthropic.ts
- https://github.com/earendil-works/pi-mono/blob/d4d74eb19be92c559f629a7f9707c5503a840edc/packages/ai/scripts/generate-models.ts
- https://github.com/earendil-works/pi-mono/blob/d4d74eb19be92c559f629a7f9707c5503a840edc/packages/ai/src/providers/deepseek.ts
- https://github.com/earendil-works/pi-mono/blob/d4d74eb19be92c559f629a7f9707c5503a840edc/packages/ai/CHANGELOG.md
- https://github.com/earendil-works/pi-mono/blob/d4d74eb19be92c559f629a7f9707c5503a840edc/packages/coding-agent/docs/cli-integration.md (also `rpc.md`, `json.md`, `sdk.md`, `providers.md`, `models.md`, `security.md`)
- https://github.com/earendil-works/pi-mono/blob/d4d74eb19be92c559f629a7f9707c5503a840edc/packages/coding-agent/src/modes/interactive/interactive-mode.ts#L298
- https://github.com/earendil-works/pi-mono/blob/d4d74eb19be92c559f629a7f9707c5503a840edc/packages/coding-agent/CHANGELOG.md#L1946
- https://github.com/deepseek-ai/deepseek-harness/blob/639ed015397290b3745d163aafe02ffee4aa3f84/packages/llm/llm-pi-ai/package.json and `.../README.md`
- npm registry: https://registry.npmjs.org/@earendil-works%2Fpi-ai, `.../@earendil-works%2Fpi-coding-agent`, `.../@mariozechner%2Fpi-ai` (fetched 2026-09-30)
- WebSearch "deepseek-harness pi-ai" (2026-09-30), used only to locate the DeepSeek Harness repo
