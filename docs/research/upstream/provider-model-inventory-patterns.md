# Provider model inventory patterns (NXR-068)

Inspected 2026-10-06 through current primary source and official documentation. No login, credential
inspection, installed-runtime execution or inference. Repository code wins over older prose.

## Versioned evidence

| Project | Snapshot |
| --- | --- |
| T3 Code | `8c61e254fd07249b8c420c44d62e8ecd72a78a20`, committed 2026-10-06 19:32:09 UTC |
| Goose | `540df77c30e3c1f3b51915cb18ae081931c96851`, committed 2026-10-06 04:24:32 UTC |
| OpenAI SIWC devkit | `f723814abdccec135b519c451fb6e1992ee5e933`, committed 2026-09-29 09:08:54 −0700 |
| Codex | stable `rust-v0.160.1`, released 2026-10-05; peeled commit `d27764b82f7118f674371e6d6e76271d9d606edb`; current main `5679e675f49e4316f6fda592314d83f9ab3c90c6` |
| Google CLI | latest documented `1.2.14`, 2026-09-30; proprietary, no verified source SHA |
| Google ACP registry | `5ee671f8f809ff099d3f73d9fae9d4570b1b9a6a`, 2026-10-06 16:26:14 UTC; separate `agy_acp_server` 1.3.0 |

## T3 Code

Source links below use the inspected SHA, not floating `main`.

- [ProviderDriver](https://github.com/pingdotgg/t3code/blob/8c61e254fd07249b8c420c44d62e8ecd72a78a20/apps/server/src/provider/ProviderDriver.ts)
  creates independent instances with snapshots, generation and disposable scope. **ADOPT** multiple
  connection identity; **ADAPT** its driver to Nexar's composed ports; **DEFER** instance-management UI.
- [App/provider/session contracts](https://github.com/pingdotgg/t3code/blob/8c61e254fd07249b8c420c44d62e8ecd72a78a20/packages/contracts/src/orchestrationV2.ts)
  keep app conversation, runtime session and native thread distinct. **ADOPT** current model versus
  saved preference distinction; **REJECT** replacing Nexar Operating Sessions.
- [ProviderAdapter](https://github.com/pingdotgg/t3code/blob/8c61e254fd07249b8c420c44d62e8ecd72a78a20/apps/server/src/orchestration-v2/ProviderAdapter.ts)
  and [transition policy](https://github.com/pingdotgg/t3code/blob/8c61e254fd07249b8c420c44d62e8ecd72a78a20/apps/server/src/orchestration-v2/ProviderSessionTransitionPolicy.ts)
  classify reuse, next-turn changes, restart/handoff and rejection. **ADAPT** to ADR-027 safe turn
  boundaries; **DEFER** wholesale native-thread resume/fork machinery.
- [ACP probe](https://github.com/pingdotgg/t3code/blob/8c61e254fd07249b8c420c44d62e8ecd72a78a20/apps/server/src/provider/acp/AcpRegistryProbe.ts)
  reads model-group selectors and validates/deduplicates reported ids. Current id is retained only
  when present. **ADOPT** bounded normalization; **REJECT** installing packages or interacting with
  auth during background inventory refresh.
- [Native Codex](https://github.com/pingdotgg/t3code/blob/8c61e254fd07249b8c420c44d62e8ecd72a78a20/apps/server/src/provider/CodexProvider.ts)
  uses app-server account read and paginated model list. Its
  [managed ChatGPT catalog](https://github.com/pingdotgg/t3code/blob/8c61e254fd07249b8c420c44d62e8ecd72a78a20/apps/server/src/provider/CodexChatGptModels.ts)
  separately calls the public account-token model endpoint. **ADAPT** route separation; **REJECT**
  projecting native capabilities into account models without evidence, or hard-coded default ranking.
- [Claude catalog](https://github.com/pingdotgg/t3code/blob/8c61e254fd07249b8c420c44d62e8ecd72a78a20/apps/server/src/provider/ClaudeModelCatalog.ts)
  uses a manifest, version filtering and custom entries. Its
  [probe](https://github.com/pingdotgg/t3code/blob/8c61e254fd07249b8c420c44d62e8ecd72a78a20/apps/server/src/provider/ClaudeProvider.ts)
  initializes SDK account metadata, not account-specific live model entitlement. **REJECT** adopting
  this manifest as subscription availability. **DEFER** custom capability editors.
- [Antigravity provider](https://github.com/pingdotgg/t3code/blob/8c61e254fd07249b8c420c44d62e8ecd72a78a20/apps/server/src/provider/AntigravityProvider.ts)
  reads authenticated session config options, with legacy available/current model fallback. Explicit
  refresh starts a disposable session; [background driver](https://github.com/pingdotgg/t3code/blob/8c61e254fd07249b8c420c44d62e8ecd72a78a20/apps/server/src/provider/Drivers/AntigravityDriver.ts)
  only checks installed files, despite older initialize-only docs. **ADOPT** live replacement and
  per-session switching; **DEFER** ACP execution migration; **REJECT** calling installation health auth.
- [Registry](https://github.com/pingdotgg/t3code/blob/8c61e254fd07249b8c420c44d62e8ecd72a78a20/apps/server/src/provider/ProviderRegistry.ts)
  and [cache](https://github.com/pingdotgg/t3code/blob/8c61e254fd07249b8c420c44d62e8ecd72a78a20/apps/server/src/provider/providerStatusCache.ts)
  retain previous choices on failed probes and replace authoritative successful snapshots.
  **ADAPT** with explicit freshness and account generation. The
  [model UI](https://github.com/pingdotgg/t3code/blob/8c61e254fd07249b8c420c44d62e8ecd72a78a20/apps/web/src/components/settings/ProviderModelsSection.tsx)
  is preferences/presentation, not discovery. **ADAPT** provider rows; **DEFER** favorites/custom slugs.
- [Context handoff](https://github.com/pingdotgg/t3code/blob/8c61e254fd07249b8c420c44d62e8ecd72a78a20/apps/server/src/orchestration-v2/ContextHandoffService.ts)
  renders bounded canonical history and records coverage/omissions; no mandatory paid summary.
  **ADAPT** later; existing Nexar context and sessions remain authoritative.

## Goose

- [Canonical setup types](https://github.com/aaif-goose/goose/blob/540df77c30e3c1f3b51915cb18ae081931c96851/crates/goose-provider-types/src/canonical/catalog.rs)
  separate provider setup/install/auth/status metadata from model choices. **ADOPT** that separation;
  **DEFER** a generalized setup framework beyond the existing three provider cards.
- [Inventory service](https://github.com/aaif-goose/goose/blob/540df77c30e3c1f3b51915cb18ae081931c96851/crates/goose/src/providers/inventory/mod.rs)
  stores successful snapshots transactionally, including empty lists, with configured/available,
  refresh state and attempt/success times; identity-specific single-flight prevents duplicate work.
  **ADOPT** replacement/stale/refresh semantics. **ADAPT** identity to Nexar credential revisions and
  opaque connection generations; **REJECT** copying Goose's hashing of actual secret values into
  cache identity. ACP executable paths alone do not distinguish account/version changes.
- [Provider contract](https://github.com/aaif-goose/goose/blob/540df77c30e3c1f3b51915cb18ae081931c96851/crates/goose-provider-types/src/base.rs)
  enriches live ids with known metadata while retaining unknown future ids. **ADAPT** optional facts
  with provenance; **REJECT** erasing a returned model because a static catalog lacks it.
- [Management handlers](https://github.com/aaif-goose/goose/blob/540df77c30e3c1f3b51915cb18ae081931c96851/crates/goose/src/acp/server/providers.rs)
  expose provider/list, supported models, inventory refresh and custom setup/configuration over ACP.
  Listing constructs the provider and asks for metadata, not completion. **ADAPT** local main/preload
  management; construction can initialize runtime state and is not side-effect-free. The
  [desktop client](https://github.com/aaif-goose/goose/blob/540df77c30e3c1f3b51915cb18ae081931c96851/ui/desktop/src/acp/providers.ts)
  polls async refresh jobs; **ADAPT** owned deadline/cancellation, **REJECT** persisting raw error text.
- [Model context](https://github.com/aaif-goose/goose/blob/540df77c30e3c1f3b51915cb18ae081931c96851/ui/desktop/src/components/ModelAndProviderContext.tsx)
  distinguishes existing-session config-option switching from new-chat defaults; provider change
  resets model selection. **ADAPT** safe next-turn owner preferences, retaining NRC Auto.
- [Claude ACP](https://github.com/aaif-goose/goose/blob/540df77c30e3c1f3b51915cb18ae081931c96851/crates/goose/src/providers/claude_acp.rs)
  and [Codex ACP](https://github.com/aaif-goose/goose/blob/540df77c30e3c1f3b51915cb18ae081931c96851/crates/goose/src/providers/codex_acp.rs)
  use a current-model sentinel and session selectors, not hard-coded model lists. Missing selectors
  are explicit failures. **ADAPT** discriminated provider-default and native choices; **REJECT** ACP
  permission-bypass defaults or treating configuration/install as account entitlement.
- [Google API listing](https://github.com/aaif-goose/goose/blob/540df77c30e3c1f3b51915cb18ae081931c96851/crates/goose-providers/src/google.rs)
  reads names but does not follow page tokens or filter generation methods in this snapshot.
  **DEFER** API catalog convergence; **REJECT** copying that incompleteness. Deprecated
  [Gemini CLI](https://github.com/aaif-goose/goose/blob/540df77c30e3c1f3b51915cb18ae081931c96851/crates/goose/src/providers/gemini_cli.rs)
  static choices and [Gemini OAuth](https://github.com/aaif-goose/goose/blob/540df77c30e3c1f3b51915cb18ae081931c96851/crates/goose/src/providers/gemini_oauth.rs)
  internal token/backend handling are **REJECTED** for Nexar's native subscription source.
- [Custom-provider store](https://github.com/aaif-goose/goose/blob/540df77c30e3c1f3b51915cb18ae081931c96851/crates/goose/src/config/declarative_providers.rs)
  separates descriptors and key references, refreshes registration and may discover models.
  **ADAPT** strict metadata/reference boundaries; **DEFER** arbitrary auth commands/headers.
- Headless [CLI management](https://github.com/aaif-goose/goose/blob/540df77c30e3c1f3b51915cb18ae081931c96851/crates/goose-cli/src/cli.rs)
  supports stdio ACP and optional authenticated HTTP/WebSocket. **ADOPT** a shared management port;
  **DEFER** another transport/server. Goose remains a design reference, not a dependency or Cowork
  replacement. Inventory is provider/route-specific; an API catalog does not prove subscription access.

## OpenAI

The [official route contract](https://developers.openai.com/siwc/token-sharing-open-source/models-and-inference)
requires model discovery with the same account token as inference. Normalize visible rows from
`models`, preserve server order and labels, execute their slugs. Codex's native listing can be cached;
it is not a substitute. Listing remains an observation, not proof every future request succeeds.
The [pinned devkit implementation](https://github.com/openai/sign-in-with-chatgpt-devkit/blob/f723814abdccec135b519c451fb6e1992ee5e933/packages/local/src/models.ts)
exposes ids/names only; it gives no model-specific limits, prices or tool/reasoning guarantee.
**ADOPT** this account/route listing; **REJECT** API-key `data` shape, generic catalog entitlement,
hard-coded replacement model or private backend.

[Preview limitations](https://developers.openai.com/siwc/token-sharing-open-source/preview-limitations)
support function/custom tools subject to route constraints, and exclude several hosted tools.
This is route evidence, not per-model capability discovery. Use public Responses, streaming and
non-stored requests. Unknown model facts stay absent; execution refusals invalidate and refresh.
**ADAPT** to the existing pi model-turn port; **DEFER** hosted-tool expansion and plane account login.

Native Codex discovery is [model/list](https://github.com/openai/codex/blob/rust-v0.160.1/codex-rs/app-server-protocol/schema/typescript/v2/ModelListParams.ts)
with bounded pagination, and [model metadata](https://github.com/openai/codex/blob/rust-v0.160.1/codex-rs/app-server-protocol/schema/typescript/v2/Model.ts).
**ADAPT** for native-agent resources, retaining route identity; **REJECT** treating it as the account
Responses catalog. Native default is invocation omission, not a copied default slug.

**Implementation safety finding (2026-10-07):** upstream
[gateway initialization](https://github.com/openai/codex/tree/0b863c69f50335acd92164aab971cb58d298c2fe/codex-rs/app-server)
can open browser OAuth after initialization unless the newer explicit gateway OAuth capability is
honored. Older servers may ignore that capability; a later account read cannot prevent the earlier
browser action. No safe minimum release was verified. **DEFER** app-server initialization/model-list
discovery; expose a native **provider-default** selection after a bounded, explicit status refresh.
Never map the separate account Responses list onto Codex. This is a safety limitation, not an empty
or invented native catalog.

## Google / Antigravity

[Official CLI headless documentation](https://www.antigravity.google/docs/cli/headless/#select-a-model-effort-or-agent)
provides `agy models` with slug/name columns and per-invocation `--model`. Unknown headless models
fail rather than silently fall back. No JSON model-list flag is verified. Conservatively recognize
only bounded slug/name rows; zero recognized rows means no verified explicit choice. This parsing
policy is Nexar's inference, not a vendor schema. **ADAPT** the current CLI adapter first; **REJECT**
using documentation's sample model names as a production fallback.

[Vendor authentication](https://www.antigravity.google/docs/cli/install/) uses native keyrings/browser
or manual terminal flow; no standalone account-status command was verified. Model listing alone
does not establish auth. Windows support does not share its credentials with WSL's Linux keyring.
**ADOPT** runtime-owned credentials and honest unknown status; **DEFER** a Desktop login shortcut
until its command/interaction is verified. Owner-triggered refresh must explain possible native auth
interaction; no background login. Current quota/cost remains unknown/subscription allowance.

The [pinned ACP registry](https://github.com/agentclientprotocol/registry/blob/5ee671f8f809ff099d3f73d9fae9d4570b1b9a6a/antigravity-acp/agent.json)
ships a separate proprietary server for Windows/macOS/Linux; it does not prove `agy --acp` exists.
[ACP selectors](https://agentclientprotocol.com/protocol/v1/session-config-options) describe optional
live model config options. T3 demonstrates a client implementation; Google's particular negotiation
is not live-validated here. **DEFER** migration until auth, approvals, lifecycle and platform testing
are specified. **REJECT** extracting Antigravity tokens, consistent with its
[published third-party-login restriction](https://www.antigravity.google/docs/faq/#why-cant-i-use-third-party-software-such-as-claude-code-openclaw-or-opencode-with-my-antigravity-login).

## Anthropic native initialization

The official Python SDK [client](https://github.com/anthropics/claude-agent-sdk-python/blob/ee34c4e4b6a8844dd160affd25e0c0c8969265e2/src/claude_agent_sdk/client.py)
starts and initializes before sending any optional prompt. Current
[Claude ACP source](https://github.com/agentclientprotocol/claude-agent-acp/blob/0724b17c581e30b1242cfbec7bce44c21df99525/src/acp-agent.ts)
holds an unfed async input, awaits SDK initialization and reads its models before a prompt.
Published SDK `supportedModels()` reads those initialization models; do not send a dummy user turn.
**ADAPT** this metadata-only lifecycle behind the Claude integration; exact-pin the installed SDK
and verify its API before implementation. Suppress project settings/hooks/plugins/MCP and session
persistence, use a private cwd and minimal environment, close on timeout/cancel. Initialization may
still refresh native auth/load state; it is not a promise of zero side effects. **REJECT** `plan` or
`maxTurns` alone as protection against paid generation; **DEFER** broader SDK execution migration.

The [published SDK environment contract](https://app.unpkg.com/@anthropic-ai/claude-agent-sdk@0.3.193/files/sdk.d.ts)
says explicit `env` replaces inherited subprocess variables. The
[spawn hook contract](https://app.unpkg.com/@anthropic-ai/claude-agent-sdk@0.3.220/files/sdk.d.ts)
exposes command, args, cwd, env and signal. **ADAPT** an allowlisted environment and an owned
deadline/process cleanup, not merely SDK iteration cancellation. The registry reports 0.3.292 on
2026-10-06; its installed types and implementation must be checked before adopting this API.
`settingSources: []` suppresses user/project/local settings; the published types say managed policy
still applies. Reported choices remain observations subject to execution-time validation, not a
complete entitlement guarantee. Verify this isolation contract against the installed exact pin.

**Implementation verification (2026-10-07):** exact npm SDK **0.3.292** types and implementation
were inspected before installation, and its tarball integrity matches
`sha512-C5XI/19uArTg3jjgayN9CSQxJilRciBko007AdPmHXwQqbAzdUldaPUQtDp8Pm6QJg5Aw3jI1G1eIJOBrx4xKQ==`.
`supportedModels()` reads initialization models, the async input is never fed, and explicit `env`
replaces inheritance. The source uses the installed Claude command through the SDK spawn hook,
not the SDK's bundled runtime. Owned tree cleanup precedes input EOF/close and has a separate bounded
cleanup deadline. Fake tests exercise these properties; native execution remains owner-unverified.
The repository boundary permits this one SDK only inside `integrations/claude-code`.

## Nexar application (decision)

Retain pi-ai for API/local, native agent kinds and the Engine Gateway. Compose inventory sources
behind integrations, materialize route-scoped resources, and let NRC/strategy select normally.
Provider default, owner preference and NRC Auto are distinct. Inventory refresh never changes
control resource mid-loop. No Goose dependency or Cowork replacement in this unit.
