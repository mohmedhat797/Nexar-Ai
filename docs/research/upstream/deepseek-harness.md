# Upstream research: DeepSeek Harness (`dsh`)

| Field | Value |
|---|---|
| Canonical repo | https://github.com/deepseek-ai/deepseek-harness (verified by `git clone`; `origin` URL matches) |
| Inspected commit | `639ed015397290b3745d163aafe02ffee4aa3f84` (2026-09-29T17:21:31+08:00, "Merge pull request #5479 ... release-dsh-0.2.0-rc.2") |
| Date inspected | 2026-09-30 |
| Latest tag / npm version | `dsh-v0.2.0-rc.2` (same commit as HEAD); npm `@deepseek-ai/dsh@0.2.0-rc.2` (dist-tags `latest` = `next` = `0.2.0-rc.2`, `alpha` = `0.1.7-alpha.2`) |
| License | MIT, Copyright (c) 2026 DeepSeek (`LICENSE`); all inspected npm manifests report MIT |
| Stability | Self-declared "developer preview": "THERE WILL BE COMPATIBILITY-BREAKING CHANGES." (`README.md`) |
| Method | Shallow git clone (history fetched only back to 2026-08-29), reading source/READMEs, `npm view`, and a credential-free SDK handshake against the published `0.2.0-rc.2` packages |

GitHub Releases pages and the REST API were not reachable; release status is inferred from git tags and the npm registry (UNVERIFIED for GitHub "Release" objects).

## 1. Identity, packages, versions

- Product name "DeepSeek Harness", CLI `dsh`. Root `package.json`: `@deepseek-ai/dsh-root` `0.2.0-rc.2`, private, `engines.node: "^22.19.0 || >=24.0.0"`, `packageManager: pnpm@11.7.0`.
- npm names (all `@deepseek-ai/*`, all versioned in lockstep, currently `0.2.0-rc.2`):
  - `@deepseek-ai/dsh` (CLI, bin `dsh`), `@deepseek-ai/dsh-sdk-client` (TypeScript SDK), `@deepseek-ai/dsh-sdk-protocol`, `@deepseek-ai/dsh-acp`, `@deepseek-ai/dsh-llm`, `@deepseek-ai/dsh-llm-pi-ai`, `@deepseek-ai/dsh-headless`, `@deepseek-ai/dsh-mcp-client`, `@deepseek-ai/dsh-subagent-*`, and roughly 200 more.
  - Non-existent names: `@deepseek-ai/harness`, `@deepseek-ai/dsh-sdk`, `@deepseek-ai/dsh-core`.
  - The unscoped npm name `deepseek-harness@0.0.1` is a reserved placeholder ("Reserved package name for the DeepSeek Harness TUI project").
- Python: `deepseek-harness-sdk` (module `deepseek_harness`) and `deepseek-harness-runtime-bin` (bundled `dsh`), from `python/` (`python/README.md`).
- Some npm dist-tag `latest` values are stale (for example `@deepseek-ai/dsh-sdk-client` `latest` = `0.0.1-rc.1`); use the exact `0.2.0-rc.2` or the `next` tag.

## 2. Language, runtime, monorepo structure

TypeScript (ESM), Node 22.19+/24, pnpm workspace (`pnpm-workspace.yaml`, root `workspaces`: `vendor/*`, `packages/*/*`, `native/system`, `apps/*`, `website`). Also Python SDK and a native (Rust/N-API) sandbox addon under `native/system`.

| Area | Role |
|---|---|
| `vendor/` | Source-vendored Cordis framework (`@deepseek-ai/cordis` 4.0.4, loader, include, group, timer, hmr) plus cosmokit, schemastery. `vendor/README.md` lists local modifications. |
| `apps/cli` | The `dsh` launcher (profiles, `plugin` subcommand). `apps/web`, `apps/desktop`, `apps/desktop-host`: UIs. |
| `packages/core/*` | `agent`, `agent-loop`, `session`, `system-prompt`, `tools`, `scope`, `agent-default-model`. |
| `packages/llm/*` | `llm` (provider-neutral model service), `llm-deepseek*`, `llm-pi-ai`, `llm-retry`, `token-meter`. |
| `packages/session/*`, `storage/*`, `session-query/*` | Session log, JSONL persistence, migrations, SQLite query. |
| `packages/subagent/*` | Delegation service plus providers: in-process spawn/fork, ACP, Codex, Claude Code, dsh-sdk. |
| `packages/sdk/{protocol,client,server}` | JSON-RPC-over-stdio SDK. |
| `packages/acp/acp` | ACP server. |
| `packages/bundle/*` | Profile bundles: `base`, `headless`, `sdk-app`, `sdk-minimal`, `acp-app`, `web-app`. |
| `packages/mcp/*`, `skill/*`, `hooks/*`, `context/*` | MCP client, skills, Claude Code/Codex hook bridges, AGENTS.md/CLAUDE.md loading. |
| `packages/{shell,fs,sandbox,terminal,lsp,browser-use,computer-use,jobs,schedule,workflow,goal,plan,...}` | Tools and runtime services. |
| `packages/experimental/*` | Explicitly no stability promise (agent-team, inspector, browser-use variants, voice). |
| `packages/client/*`, `host/*`, `api/*` | Web/desktop UI and HTTP gateway (Nexar does not need these). |

## 3. Cordis / plugin model

- Doc: `docs/cordis-primer.md`. "A plugin is a object that implements Service ... a function with optional `inject` and `apply(ctx)` fields, or a `Service` subclass." A context is a service repository (`ctx.llm`, `ctx.tools`, `ctx.agents`, `ctx.sessions`); dependencies are declared by `inject`; typed events (`emit`/`waterfall`/`parallel`/`serial`/`bail`); registrations are disposable effects (`ctx.effect()`, `ctx.on()`), HMR-safe.
- Minimal third-party plugin (`docs/user/develop/basic/index.md`):
  ```ts
  import type { Context } from '@deepseek-ai/cordis'
  export const name = 'hello-plugin'
  export function apply(ctx: Context) { /* register capabilities */ }
  ```
- Declaration and loading: a YAML "patch" (`cordis.patch.yml`, array of `insert`/id-targeted overrides) references plugins by package name or absolute path: `- insert: [{ id: hello, name: dsh-hello-plugin }]`. A plugin package is shipped as a "bundle" (`package.json` field `dsh.bundle.patch`) and installed with `dsh plugin --profile <name> add <pkg>` (forwards to pnpm); profiles list bundles in `dsh.profile.bundles` (`docs/user/develop/basic/publish.md`).
- Layer order: bundle patches in order, then profile `cordis.patch.yml`, then `$DSH_HOME/cordis.patch.yml`, then `--patch` overlays. A patch replaces a row's whole `config` (no deep merge). `!!js` expressions are allowed in config and `disabled`.
- Plugin exports rule (`packages/AGENTS.md`): function plugins named-export `name`/`inject`/`Config`/`apply` and have no default export; service packages default-export a service class.
- Public surface for third parties: `@deepseek-ai/cordis` (Context/Service), `@deepseek-ai/schemastery` (Config schemas), and the `@deepseek-ai/dsh-*` service packages (`dsh-llm`, `dsh-agent`, `dsh-session`, tool services). Plugins must declare dsh packages as peerDependencies so they share the host's instance; there is a peer-range compatibility check and a version-exemption mechanism (`apps/cli/README.md`). Generated catalogs list all services/events: `docs/config-catalog.md`, `docs/subsystems/*.md`, `docs/cordis-api/`.
- Not a stable API: the project says there will be breaking changes; plugin peer ranges are tied to the exact runtime version (lockstep `0.2.0-rc.2`).

## 4. Provider / model routing

- `@deepseek-ai/dsh-llm` (`packages/llm/llm/src/index.ts`) exposes `ctx.llm`. Provider adapters subclass `LlmAdapter` (only `stream(options: GenerateOptions): AsyncIterable<StreamChunk>` is abstract; optional `listModels`, `resolveModel`, `prepareCall`, `providerRetryPolicy`) and register with `ctx.llm.registerAdapter(providers: string[], adapter)`. One adapter per route; duplicates throw `DUPLICATE_ADAPTER`. Guide: `docs/cookbook/adding-an-llm-adapter.md`, `docs/user/develop/practice/llm-adapter.md`.
- Route selection: every request carries `GenerateOptions.provider` + `model` (e.g. `provider: 'deepseek-official', model: 'deepseek-v4-flash'`). An unregistered provider fails `NO_ADAPTER`. Models are "opaque provider/model choices"; reasoning effort is an opaque adapter-owned id validated against the exact model.
- Defaults: `agent-default-model` (base bundle: `provider: deepseek-official`, `model: deepseek-flash`); SDK/ACP/web entry points select per session. Credentials resolve per request via `apiKeyEnv` references (default `DEEPSEEK_API_KEY`).
- Adapters in tree: `llm-deepseek` (+ `-api-key`, `-account`) and `llm-pi-ai` (see section 9). `base` mounts `llm-pi-ai` dormant: zero routes until a `llm-pi-ai` config row lists `providers`.
- Retry is separate: `dsh-llm-retry` at agent-step boundaries. Request attribution headers are mandatory in adapters (`LlmAdapter` doc: "Every provider HTTP request must include `attributionHeaders()`").

## 5. Subagents and collaboration

- `ctx.subagents` (`packages/subagent/subagent`): provider registry with one-shot runs, continuable children, and discovery. Providers (`packages/subagent/README.md`): in-process spawn (fresh) and fork (history-seeded); out-of-process via ACP (`subagent-acp`), Codex (`subagent-codex`, `@openai/codex` 0.153.4 app-server), Claude Code (`subagent-claude-code`, `@anthropic-ai/claude-agent-sdk` 0.3.263), and dsh itself over the SDK (`subagent-dsh-sdk`). Model-facing tools: `tool-subagent`, `tool-subagent-control` (message/interrupt/list).
- Collaboration: `packages/experimental/agent-team` (Lead plus named teammates, durable messages, shared task board; "carries no stability promise"), `goal`, `workflow`, `plan`, `jobs`, `schedule`.

## 6. ACP, MCP, skills

- ACP: yes. `@deepseek-ai/dsh-acp` uses `@agentclientprotocol/sdk` 1.4.0 and is "automation-only"; start with `dsh --profile acp`. Supports `initialize`, `session/new|list|resume|close|prompt|cancel|set_config_option|update|request_permission`; omits `session/load`, fork, delete, terminals, client fs, modes, plans, elicitation (`packages/acp/acp/README.md`). `authenticate` is an immediate success (no auth).
- MCP: yes, client only. `@deepseek-ai/dsh-mcp-client` (`@modelcontextprotocol/client` 2.0.0); tools appear as `mcp__<server>__<tool>`; no server enabled by default; MCP prompt templates unsupported. ACP sessions can also mount stdio/HTTP MCP servers per session. No MCP server mode for dsh itself was found (UNVERIFIED by exhaustive search).
- Skills: yes. `dsh-skill` registry + `dsh-skill-filesystem` + `dsh-tool-skill`. Format: `<name>/SKILL.md` or flat `<name>.md` with YAML frontmatter (`name` kebab-case, `description`, optional `whenToUse`, `disable-model-invocation`, `user-invocable`); roots include `<project>/.agents/skills` (`packages/skill/skill-filesystem/README.md`). Whether `.claude/skills` is scanned was not confirmed (UNVERIFIED).

## 7. Session model and persistence

- Append-only event log per session; logical `SessionEvent` stream with envelope `{type, seq, time, data, ...}` (`docs/persistence-catalog.md`). Current writer `SESSION_FORMAT_VERSION = 4` (`packages/core/session/src/types.ts`). Latest released format recorded as 3 (evidence tag `dsh-v0.1.5-alpha.1`), so V4 has not yet shipped in a release per `docs/session-format-status.md` (rc tags published after this record may change that; UNVERIFIED).
- Backend: `dsh-session-persistence-jsonl` writes per-session JSONL under `$DSH_HOME/sessions` (base patch: `root: dshHomePath('sessions')`), Zstandard-compressed checksummed frames by default, plain lines with `compression: 'none'`. Migration chain `session-format-v0-to-v1 ... v3-to-v4`, torn-tail crash recovery. Optional SQLite full-text index (`session-query-sqlite`, search disabled by default). Attachments are content-addressed files outside the log.
- `$DSH_HOME` defaults to `~/.dsh` (`packages/util/home-paths`). Profiles live at `$DSH_HOME/profiles/<name>/`.

## 8. Programmatic embedding and headless use (most important)

Three supported out-of-process routes exist; there is no in-process library entry point (the SDK client "registers nothing on a Cordis context" and always spawns a runtime subprocess).

### 8.1 TypeScript SDK (recommended): `@deepseek-ai/dsh-sdk-client`

Source: `packages/sdk/client/README.md`, `src/api.ts`, `src/client.ts`, `src/index.ts`. Exports: `DeepSeekHarness`, `HarnessSession`, `HarnessClient`, `JsonRpcResponseError`, `RequestTimeoutError`, `SdkProtocolError`, `TransportClosedError`, types `DeepSeekHarnessOptions`, `HarnessClientOptions`, `RunResult`, `HarnessNotification`.

```ts
import { DeepSeekHarness } from '@deepseek-ai/dsh-sdk-client'

await using harness = new DeepSeekHarness({
  profile: 'sdk',                       // default; also 'sdk-minimal'
  patches: ['./automation.cordis.yml'], // per-launch config overlays
  provider: 'deepseek-official',        // default
  model: 'deepseek-v4-flash',           // default
  // also: dshHome, cwd, processCwd, env (replaces child env entirely),
  //       reasoningEffort, maxTokens, dshBin, timeouts
})
const result = await harness.run('say hi')   // RunResult { sessionId, finalResponse, events, notifications }
console.log(result.finalResponse)
```

Install: `npm i @deepseek-ai/dsh-sdk-client@0.2.0-rc.2` (depends on `@deepseek-ai/dsh@0.2.0-rc.2`; peer deps `@deepseek-ai/cordis@~4.0.4`, `dsh-llm`, `dsh-session`, `dsh-sdk-protocol` at the same version, which are needed for types and must be installed).

Wire protocol (`packages/sdk/protocol/README.md`, `src/types.ts`): newline-delimited JSON-RPC 2.0 over the child's stdio; methods `initialize{cwd, provider, model, reasoningEffort?, maxTokens?}`, `session/prompt{sessionId, contentBlocks}` -> `{messageId}` (enqueue receipt only), `shutdown`; notifications `session.event` (full session-log event, every session), `session.status` (`idle`/`running`), `subagent.started`, `subagent.finished`. `serverInfo.name = "deepseek-harness-sdk-runtime"`. Python SDK speaks the same protocol, so Nexar could implement the wire directly.

Documented limits (same READMEs): no mid-turn cancel (abandon = close the runtime), no protocol-version negotiation ("pre-release stance, no compatibility promise"), no per-prompt result (`finalResponse` = last committed root assistant text in the activity interval), server-to-client requests (approvals) unimplemented, `initialize` timeout default 10 s, one provider/model per runtime process (per `initialize`).

Verified locally (2026-09-30, Node 22.22.2, scratch install of the published rc.2, isolated `DSH_HOME`, no credentials, no model call):
- `dsh --version` -> `0.2.0-rc.2`; `dsh --help` and `dsh --profile headless --help` work.
- `new DeepSeekHarness({profile:'sdk', dshHome, cwd, env:{PATH,HOME}}).start()` -> handshake OK with no API key present (credentials are only needed on the first model request). First use auto-creates `profiles/sdk`, `profiles/headless`, `.anonymous-user-id`, `storages/` inside `DSH_HOME`.
- Routing a non-DeepSeek provider through pi-ai with a patch works at handshake: patch `- id: llm-pi-ai` / `config: { providers: { anthropic: { apiKeyEnv: ANTHROPIC_API_KEY } } }` plus `provider: 'anthropic', model: 'claude-sonnet-4-5'` -> OK. Without the patch, `provider: 'openai'` -> `JsonRpcResponseError: no adapter registered for provider "openai"`.
- Not run: any `harness.run()` (needs a paid model call).

### 8.2 CLI headless, one task per process

`dsh --profile headless "run the tests"` (also `dsh headless "..."`; task from stdin when omitted or `-`). Prints the final answer on stdout, reasoning on stderr, exit 0 success / 1 abort or error. `--json` emits NDJSON events (`session`, `status`, `text`, `thinking`, `tool_call`, `tool_result`, terminal `final`; lines capped at 32 KiB, strings at 8 KiB except `final`); `--session-id <id>` resumes a persisted session (must match cwd and preset). Caveats: a turn failing in-turn can still emit `final` (check exit code and `turn_end` reason); no interactive follow-up (`packages/bundle/headless/README.md`). Model selection comes from default-model config/patches, not a flag (UNVERIFIED that no `--model` flag exists beyond `--help` output showing only `--json`, `--session-id`).

### 8.3 ACP stdio server

`dsh --profile acp` speaks standard ACP v1 (section 6), with persistent sessions, per-session `model`/`reasoning_effort` config options, cancel, and permission requests that the client can answer. This is the only route with cancel and approval round-trips.

### 8.4 Other

`dsh web` (HTTP/Web UI, port 3080) and Electron desktop: UI-oriented, not an embedding API. No in-process `createHarness()` exists; embedding in-process would mean composing Cordis contexts directly through internal packages (see risks).

## 9. Pi / pi-ai integration

- Yes. `@deepseek-ai/dsh-llm-pi-ai` (`packages/llm/llm-pi-ai`) depends on `@earendil-works/pi-ai` `^0.87.1` (npm latest seen: 0.99.2, MIT; the older `@mariozechner/pi-ai` is at 0.73.1 and is not used by dsh). Search for `@mariozechner` in the repo found no package.json dependency; `earendil` appears only in `llm-pi-ai/package.json`.
- It is a model-adapter seam, not a Pi agent integration: pi-ai supplies provider catalogs/wire protocols (`openai-completions`, `openai-responses`, `anthropic-messages`, and more), OAuth/key sign-in, and model metadata. Hand-declared gateways need `api`, `baseURL`, and non-empty `models`. `GenerateOptions.stop` is rejected (`UNSUPPORTED_OPTION`). Credentials: `apiKeyEnv` per route, or stored sign-in under `llm-pi-ai/<provider id>` in the credential store. Web UI docs state OAuth providers such as Codex are "not supported here yet" (`docs/user/guide/providers.md`).
- CI workflow `.github/workflows/pi-ai-provider-e2e.yml` exists (contents not reviewed).

## 10. Claude Code and Codex integration

- Claude Code: `subagent-claude-code` runs a real Claude Code session as an unattended child via `@anthropic-ai/claude-agent-sdk` (`permissionMode` default `dontAsk`; uses the user's native Claude settings/auth; credential-shaped ambient env vars are stripped unless passed in `env`). `hooks-claude-code` runs existing Claude Code `hooks.json`/settings hooks. `agent-instructions` loads `AGENTS.md`-compatible files (CLAUDE.md handling UNVERIFIED for user projects).
- Codex: `subagent-codex` (official app-server via `@openai/codex` 0.153.4), `hooks-codex` (Codex `hooks.json`, five hook points).
- These make dsh a consumer/orchestrator of Claude Code and Codex, not a harness that Claude Code drives.

## 11. Authentication and credentials

- DeepSeek: `DEEPSEEK_API_KEY` (`llm-deepseek-api-key`, `apiKeyEnv` default), optional `DEEPSEEK_BASE_URL` (`docs/user/guide/python-sdk.md`); account-token login via `deepseek-account*` (web/desktop).
- Store: `$DSH_HOME/.credentials.yaml` (private file, OS-user readable; "cannot isolate secrets from the agent", `packages/credentials/credentials-local/README.md`). Precedence: launch environment, then stored file, then project `.env`, then harness-home `.env`. References, not literals, live in config.
- SDK client passes `env` to the child ("replaces the child environment entirely when given"); caller owns credential policy, `scrubbedParentEnv` from `dsh-subprocess` is the suggested base.
- Privacy/telemetry: `.anonymous-user-id` is created in `DSH_HOME`; `session-log-deepseek` uploads session-log suffixes with requests to the official DeepSeek API by default ("Disable it only when the official API must not receive a Session-log suffix") and `SAFETY.md` warns of no security audit. OTel product telemetry plugins exist in base (defaults not verified, UNVERIFIED). The probe patch above disables `session-log-deepseek` (`disabled: true`); the handshake passed with it disabled.

## 12. Update cadence and stability

- Git history: the fetched history starts 2026-09-08 (shallow; earlier history not inspected). From 2026-09-08 to 2026-09-29 there were 2608 commits (1754 non-merge) on the fetched branch, peaking at 200-280/day during 2026-09-17..23; top authors each 130-400. The 30-day figure is therefore a lower bound (UNVERIFIED for 2026-08-31 to 2026-09-07).
- Tags: 25 tags from 2026-08-17 to 2026-09-29, e.g. `dsh-v0.1.5-alpha.1` (09-08), `0.1.6-alpha.1` (09-15), `0.1.7-rc.1` (09-23), `0.2.0-rc.1` (09-28), `0.2.0-rc.2` (09-29). npm shows 5 releases in the last week. Roughly daily prereleases; minor-version jump 0.1.x to 0.2.0 within 5 days.
- Breaking-change markers: README banner; SDK protocol "no compatibility promise"; persisted Session format V3 to V4 migration in flight; `docs/upgrade-guide/` has entries (e.g. `schedule-optional-bundle`, `transcript-view-legacy-normal`); checked persistence-type and config catalogs (`docs/persistence-schema.json`, `docs/config-catalog.md`) signal that internal types are tracked but still change.
- Tag/npm naming is irregular: npm `latest` tags on some packages are old (`0.0.1-rc.1`, `0.1.0-rc.6`); always pin exact versions.

## Safe extension points vs internals

Safe(ish) to depend on, behind an adapter:
1. SDK wire protocol (`initialize`, `session/prompt`, `shutdown`, four notifications), or the `DeepSeekHarness` / `HarnessClient` TypeScript API.
2. `dsh --profile headless [--json] [--session-id]` CLI contract.
3. ACP v1 surface (external standard, `@agentclientprotocol/sdk`).
4. Config surface: profile `cordis.patch.yml`/`--patch` overlays with documented rows (`llm-pi-ai.providers`, `agent-default-model`, `session-log-deepseek.disabled`, `sandbox-policy`, `approval`, MCP server rows), `DSH_HOME`, `DSH_PERMISSION_MODE` (`read-only`/`workspace-write`/`danger-full-access`).
5. `SKILL.md` skill files and MCP servers (Nexar-owned, portable).

Do NOT couple to:
- Any `@deepseek-ai/dsh-*` internal package import (`dsh-agent`, `dsh-session`, `dsh-llm` services, `ctx.*` events), Cordis context/loader semantics, or the plugin `apply` API from Nexar core. All churn rapidly and are lockstep-versioned.
- On-disk session JSONL/Zstd format, `SessionEvent` payload shapes beyond treating them as opaque JSON (they are in the SDK notification payloads, typed by `dsh-session`), `$DSH_HOME/profiles/*` layout, `.credentials.yaml`.
- Bundle/profile row ids in `packages/bundle/*/cordis.patch.yml` beyond the few documented ones (a patch replaces a row's whole config, so renames break overlays silently or loudly).
- `packages/experimental/*`, `packages/client/*`, `apps/web`, `apps/desktop`.

## Integration opportunities

- Headless, multi-provider agent executor via the SDK with no fork: pi-ai routes give Anthropic/OpenAI/others plus custom OpenAI-compatible gateways through config only (verified handshake).
- Long-lived runtime with persisted sessions, steering by repeated `session/prompt`, a streaming event feed (`session.event`) that maps well to Nexar's own event/trace layer.
- Orchestrating Claude Code and Codex as subagents (`subagent-claude-code`/`-codex`) and delegating to other ACP agents (`subagent-acp`) reuses their native auth.
- MCP and SKILL.md support align with Nexar's tool and skill portability goals.
- Sandbox (`workspace-write` default, native addon) and approval policy are built in.
- ACP gives Nexar a standards-based second adapter with cancel and approval round-trips.
- Python and TypeScript SDK share one protocol, so a thin Nexar-owned client of the wire protocol is feasible.

## Integration risks

- Developer preview with explicit breaking-change warnings; near-daily prereleases and lockstep versions; Session format V4 not yet recorded as released.
- Heavy footprint: installing the SDK pulled 541 npm packages; it spawns a full Cordis runtime per `DeepSeekHarness`/process; the native addon and sandbox are platform-specific; Node `^22.19 || >=24`.
- The SDK has no cancel, no approval round-trip, no protocol version negotiation, no per-prompt result; `finalResponse` is not causally tied to a prompt; one provider/model route per runtime (per-session switching not possible via SDK).
- Approvals: base sets `approval: ask` for `workspace-write`; an SDK/headless run with no answerer "fails closed" (`unavailable`) for sensitive actions. Autonomy requires `DSH_PERMISSION_MODE=danger-full-access` (approval `never`, no sandbox) or an ACP client that answers permission requests. Headless permission behavior in practice was not exercised (UNVERIFIED).
- Privacy defaults: session-log upload to the official DeepSeek API, anonymous ID file, OTel plugins; agent tool processes run as the same OS user and can read `.credentials.yaml`. `SAFETY.md`: no security audit. Nexar should launch with an explicit scrubbed `env`, isolated `DSH_HOME`, and `session-log-deepseek` disabled.
- Persona and prompts are DeepSeek-tuned ("You are a coding agent powered by the {{model}} model", `sdk-app` patch); DeepSeek-specific request extensions (`deepseek-llm-api-extensions`) apply to official DeepSeek requests only. Behavior quality on non-DeepSeek models is UNVERIFIED.
- pi-ai routes: no `stop` sequences; provider OAuth (Codex) not supported in UI; catalog models depend on the installed pi-ai version (0.87.x range while 0.99.x exists).
- Licensing: MIT for dsh; third-party notices in `THIRD_PARTY_NOTICES.md`. One npm manifest (`@deepseek-ai/dsh-acp@0.0.1-rc.1`, old) reported BSD-3-Clause; current rc.2 is MIT. Vendored Cordis originates from `cordiverse/cordis` (license of upstream not re-verified, UNVERIFIED).

## Recommended Nexar boundary

Use a subprocess adapter in its own package, `@nexar/adapter-deepseek-harness`, that implements a Nexar-owned `AgentRuntime` port (`startSession`, `send`, `events()`, `close`) and is the only place that names `@deepseek-ai/*`.

1. Primary: drive the SDK wire protocol (either via `@deepseek-ai/dsh-sdk-client` pinned to an exact version, or a ~150-line Nexar-owned JSON-RPC client of the four-notification protocol, which removes the peer-dependency and Node-version coupling). Spawn `dsh --profile sdk` with: isolated `DSH_HOME`, explicit minimal `env` (inject only the needed provider key for that launch), a Nexar-generated `--patch` overlay (pi-ai routes, `session-log-deepseek` disabled, permission mode, MCP servers), and `cwd` per Nexar workspace. Normalize `session.event` into Nexar's own event schema, treating payloads as opaque JSON with a version-tag check.
2. Secondary: an ACP adapter over `dsh --profile acp` if Nexar needs cancel/approval round-trips; since ACP is a standard, this adapter is reusable for other agents.
3. Fallback/test: `dsh --profile headless --json` for one-shot tasks and contract tests.
4. Avoid: a Cordis plugin inside dsh, in-process imports, and forking. Justification: the plugin API is unstable and lockstep-versioned, Cordis context semantics would leak into Nexar, process isolation matches Nexar's local-first security model, and the SDK's documented surface is the only part with explicit (if pre-release) protocol docs and a Python twin.
5. Guardrails: pin an exact version (e.g. `0.2.0-rc.2`) and upgrade deliberately; run a contract test suite using `mock:llm` / recorded sessions (repo ships `packages/test-support/llm-mock-server`); fail closed on an unexpected `serverInfo`/protocol shape; keep Nexar's own session store as source of truth and treat dsh's JSONL as disposable; resume via the same `sessionId` only within one pinned version.
6. Note for Nexar's "agent-agnostic" goal: the SDK handshake fixes one provider/model per process, so model switching means a new runtime process (or a new `initialize`-scoped runtime per model).

## Open questions

- Does `harness.run()` work end-to-end with a pi-ai route (tools, persistence, approval fail-closed behavior) on real credentials? Not exercised (no paid calls).
- Exact headless permission behavior under `workspace-write` + `ask` without an answerer, and whether the SDK profile offers any approval channel beyond `DSH_PERMISSION_MODE`.
- When will Session format V4 and the `0.2.0` line reach stable, and what migration guarantees apply from `0.2.0-rc.x`?
- Is there a supported way to switch provider/model per session inside one SDK runtime (the `session/prompt` params carry none)?
- Are `.claude/skills` and `CLAUDE.md` discovered for third-party projects (UNVERIFIED)?
- Telemetry defaults (OTel, product analytics) per profile and how to disable fully; network egress other than model calls.
- Upstream license chain for vendored Cordis and pi-ai transitive dependencies (`THIRD_PARTY_NOTICES.md` not audited).
- GitHub Releases/changelog: only tags and npm were available; no CHANGELOG.md was found at repo root (UNVERIFIED that none exists).

## Sources

Permalinks use commit `639ed015397290b3745d163aafe02ffee4aa3f84` (base: https://github.com/deepseek-ai/deepseek-harness/blob/639ed015397290b3745d163aafe02ffee4aa3f84/).
- Repo: https://github.com/deepseek-ai/deepseek-harness ; docs site per README: https://deepseek-harness.github.io/deepseek-harness/
- `README.md`, `LICENSE`, `SAFETY.md`, `package.json`
- `apps/cli/README.md`, `apps/cli/package.json`
- `packages/sdk/README.md`, `packages/sdk/client/README.md`, `packages/sdk/client/src/{api,client,launch,types,index}.ts`, `packages/sdk/protocol/README.md`, `packages/sdk/protocol/src/types.ts`, `packages/sdk/server/README.md`
- `packages/bundle/headless/README.md`, `packages/bundle/sdk-app/{README.md,cordis.patch.yml}`, `packages/bundle/base/cordis.patch.yml`
- `packages/acp/acp/README.md`
- `packages/llm/llm/src/index.ts`, `packages/llm/llm/README.md`, `packages/llm/llm-pi-ai/{README.md,package.json}`
- `packages/subagent/README.md`, `packages/subagent/subagent-{claude-code,codex,acp,dsh-sdk}/README.md`
- `packages/mcp/mcp-client/README.md`, `packages/skill/skill-filesystem/README.md`, `packages/hooks/hooks-{claude-code,codex}/README.md`
- `packages/session/session-persistence-jsonl/README.md`, `docs/session-format-status.md`, `docs/persistence-catalog.md`, `packages/core/session/src/types.ts`
- `packages/credentials/credentials-local/README.md`, `packages/session/session-log-deepseek/README.md`, `packages/util/home-paths/README.md`
- `docs/cordis-primer.md`, `docs/user/develop/basic/{index,publish}.md`, `docs/cookbook/adding-an-llm-adapter.md`, `docs/user/guide/{providers,python-sdk}.md`, `packages/AGENTS.md`, `vendor/README.md`
- npm registry: `@deepseek-ai/dsh`, `@deepseek-ai/dsh-sdk-client`, `@deepseek-ai/dsh-sdk-protocol`, `@deepseek-ai/dsh-acp`, `@deepseek-ai/dsh-llm-pi-ai`, `@deepseek-ai/dsh-headless`, `@deepseek-ai/dsh-mcp-client`, `@deepseek-ai/dsh-subagent-claude-code`, `@earendil-works/pi-ai`, `deepseek-harness` (queried 2026-09-30)
- Tag `dsh-v0.2.0-rc.2` == commit `639ed015397290b3745d163aafe02ffee4aa3f84`
- Local experiment artifacts (not committed): scratchpad `dshtry/probe.mjs`, `probe2.mjs`, `route.patch.yml`
