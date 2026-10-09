# ADR-027: Nexar-owned resources, Engine Gateway and plan-level resource strategy

- **Status:** Accepted (architecture, revision 2); implementation tracked in NXR-059 to NXR-067
- **Date:** 2026-10-04
- **Amends:** ADR-002, ADR-003, ADR-004, ADR-005, ADR-019, ADR-020, ADR-022, ADR-024, ADR-026 (each
  carries a short amendment pointing here)
- **Plan and audit:** [`docs/architecture/resource-orchestration-plan.md`](../architecture/resource-orchestration-plan.md)
- **Compatibility spike:** [`subscription-control-compatibility.md`](../research/upstream/subscription-control-compatibility.md)

Revision 2 (same day, before any implementation) replaces revision 1's assumptions that engines
need a local model or API key and that one bridge serves both purposes. It adds the Engine Gateway
(§7), configurable control resources (§8), connection support classes (§3) and the owner's
authentication policy (ADR-022 amendment 2026-10-04).

## Invariant

> Nexar is the unified intelligence gateway. OpenWorker and DSH orchestrate work, but they do not
> own the owner's provider universe. Engines consume Nexar through engine-compatible gateway
> contracts. Nexar normalizes subscriptions, APIs and local resources into one registry, plans their
> use across the job, and the NRC validates and routes execution according to owner policy.
> Control resources and work resources are separate. Both come from the same registry. Either may be
> subscription, API, local or custom when compatible, and both are owner-configurable or chosen by
> NRC Auto.

## Context

The v0.5 Operating Layer merged with these couplings:

- Cowork's single OpenWorker model was limited to owner-allowed API keys (ADR-026 §4).
- DSH was only a lane resource needing `DEEPSEEK_API_KEY`.
- Desktop's first-run config made the `local-echo` test double the default. Under `authoritative`
  preferences, Auto ignored an authenticated Claude Code.

Upstream facts, from the spike:

- **OpenWorker's provider contract is provider-agnostic.** The contract is `ProviderClient.complete(model, messages, tools) →
AssistantTurn{text, tool_calls, usage, reasoning, extras}`. `TurnEngine` owns the loop. Its
  `openai-codex` provider (present in pinned v0.3.0) drives the loop with a ChatGPT subscription,
  through its own PKCE login using the Codex CLI's client id. OpenWorker has **no provider
  extension seam**. Its `openai` provider with a custom `base_url` speaks Chat Completions.
- **Native subscription CLIs are agents, not model-turn backends.** Claude Code, Codex, Antigravity
  and Gemini CLI run their own loops and tools. They are **work resources**.
- **Antigravity's terms rule it out.** Its Additional Terms §6 call third-party access with
  Antigravity OAuth a breach.
- **Code resources live in the plane.** Code runs in the WSL plane, which owns its own connections
  (ADR-025: no credentials cross the bridge).

## Decision

### 1. Nexar owns providers, connections and resources

The Resource Registry is the single resource gateway, fed by provider connections. Engines,
pi-ai and native agents never own a provider choice. They receive a Nexar-selected resource through
an Engine Gateway contract (§7).

### 2. Terms

| Term                 | Meaning                                                                                                 |
| -------------------- | ------------------------------------------------------------------------------------------------------- |
| Provider             | Vendor or ecosystem (Anthropic, OpenAI, Google, DeepSeek, Local, …)                                     |
| Connection           | One configured way to reach a provider. A provider may hold several at once                             |
| AI Resource          | An executable capability derived from a connection (ADR-007 descriptor and state)                       |
| Adapter              | How Nexar executes a resource (`claude-code`, `codex`, `antigravity`, `pi`, a gateway model adapter, …) |
| Orchestration engine | How work is decomposed: Cowork → OpenWorker; Code → DSH inside Nexar's engineering envelope             |
| Control resource     | Drives an engine's own model and tool loop (needs `model-turn`, §6)                                     |
| Work resource        | Executes one bounded substantive unit (draft, review, implement, …)                                     |

The NRC routes resources, never provider names.

### 3. Connections: method and support class

Each connection records three things (resource metadata `connection`; see the plan):

- **Method:** `subscription`, `api`, `local` or `custom`.
- **Auth class:**
  - `vendor-native`: the official runtime's own login;
  - `official-api`: an API key;
  - `official-account`: a documented OAuth or SDK account mechanism;
  - `experimental-client-compat`;
  - `none`.
- **Support:** `official` or `experimental`.

Experimental connections are visible, labelled, disabled until the owner enables them, never
preferred over stable ones unless owner policy says so, and down-ranked by history when unreliable.
The **preference order** for a subscription is:

1. vendor-native runtime;
2. official account mechanism;
3. experimental client-compat, owner-enabled only (ADR-022 amendment).

### 4. Execution adapters keep their roles

- pi-ai (ADR-003) runs `api` and `local`/`custom` model resources; its own OAuth flows stay disabled.
- Native agents (ADR-011) run vendor-native subscription resources as work resources.
- Experimental subscription model adapters (NXR-067) are Nexar-owned. They run Nexar's own isolated
  login, keep tokens in Nexar's key store under that connection, and never read another
  application's credentials.

### 5. Responsibility formula

```text
Operating Layer          what kind of work is this?                     ADR-024
OpenWorker / DSH         how is the work decomposed and orchestrated?   ADR-026 / §9
Resource Strategy        how are resources allocated across the job?    §10
NRC runtime routing      is this resource still the right executor now? ADR-005/020
```

The NRC never decides workflow steps, tool sequences or engineering plans.

### 6. Compatibility is modelled, not inferred

- **Separate states.** These six never imply each other: `installed`, `authenticated`,
  `available`, `compatible`, `eligible`, `selected`.
- **`model-turn` capability.** Compatibility is expressed with capabilities, an open set. The new
  well-known capability `model-turn` marks a resource that accepts caller-supplied messages and tool
  schemas and returns one assistant turn whose tool calls the caller executes.
- **Engine control requirements.** Each engine declares its control requirements:
  - OpenWorker: `model-turn`.
  - DSH: `model-turn`, from plane resources (§9, §11).
  - `model-turn` includes caller-executed tool calling by definition. `tool-use` keeps its existing
    meaning (the resource runs tools itself; `automation` tasks require it).
- **Subscriptions are not excluded by default.** A subscription resource is control-eligible exactly
  when a verified adapter gives it `model-turn`. As of the spike:
  - API models and tool-capable local models qualify.
  - Native CLIs do not.
  - Experimental ChatGPT (and possibly Claude or Gemini) model adapters would, once built and
    enabled.

### 7. Engine Gateway: two contracts

They share infrastructure (lineage, identity, telemetry) and serve different purposes.

- **A. Control Model Gateway.** It drives an engine's loop.
  - Request: `ControlTurnRequest{lineage, engine, controlDecisionId, messages, tools, settings}`.
  - Result: `ControlTurnResult{text, toolCalls, finishReason, usage: Measured, extras}`.
  - The gateway calls the pinned control resource's adapter and normalizes back to the engine's
    shape.
  - `extras` stay opaque, scoped to the decision, and are never forwarded to another resource.
- **B. Intelligence Execution Bridge.** It executes bounded work units.
  - Request: `IntelligenceRequest{lineage, unitId, reviewOf?, requirements, input, access, timeout, budget}`;
    `reviewOf` names an earlier unit of the same grant, so the strategy keeps the review on a
    different resource when one is eligible.
  - Result: `IntelligenceResult{text, draftRefs, usage, decisionId, errorCode}`.
  - The resource is chosen by the strategy ledger and NRC revalidation.
  - NXR-059 is this bridge's OpenWorker transport.

Engines receive results and usage, never provider secrets. An experimental adapter's tokens stay
inside its connection boundary.

### 8. Control resources: configurable, pinned, explicit fallback

- **Owner policy per mode** (Settings → AI Behavior / Orchestration):
  `controlResource: { mode: auto | pinned, resourceId?, fallback: auto | none }`.
  - **Auto:** the NRC evaluates only control-compatible resources for that engine.
  - **Pinned:** honored unless the resource is unavailable or incompatible; then `fallback` applies.
- **Pinning per engine turn.** The control resource is selected at an engine-turn boundary and pinned
  for the whole loop. Nexar records the `controlDecisionId`, the resource, the boundary and any
  fallback.
- **Failure boundaries:**
  1. Retry the same resource (bounded).
  2. Otherwise the engine turn fails with `control-resource-failed`.
  3. With `fallback: auto`, Nexar restarts the whole engine turn from the engine's canonical history
     on the next-ranked compatible resource. This is safe because a Cowork turn's effects are confined
     to its private scratch (ADR-026 §3), and a Code lane restarts from its worktree base.
  4. Never switch resources mid-loop.
- **Delegated work units route independently** (§7B, §10).

### 9. Engines

- **Cowork → OpenWorker.**
  - Its control loop uses a Nexar provider (§7A) when available. With no extension seam upstream,
    the transport is chosen in NXR-063, in this order:
    1. an upstream provider-extension seam (contributed);
    2. a supervised loopback **gateway child** reached through OpenWorker's `openai` `base_url`;
    3. a minimal maintained patch.
  - Option 2 is the only zero-patch route. It requires the security rationale in the plan §8, which
    holds this child to the same posture ADR-026 accepted for `openworker-server`. Desktop main
    still opens no listener.
  - Until NXR-063 lands, direct OpenWorker provider configuration (ADR-026 §4, API keys) remains a
    temporary compatibility path, recorded as such.
  - OpenWorker's own `openai-codex` (OpenWorker-owned auth) is not used as a Nexar connection.
  - Substantive units are delegated through §7B (NXR-059).
- **Code → DSH inside Nexar's engineering envelope.**
  - `EngineeringRunner` keeps the sandbox, worktrees, lane plans as the work graph, patch policy,
    gates, review, approval and local commit, with no push.
  - DSH orchestrates planning and write lanes. Its control loop and its units go through the plane's
    Engine Gateway, which serves plane resources (§11; NXR-064). DSH's own sub-agent providers are
    not Nexar routes.
- **Fallbacks are honest.**
  - Without a compatible OpenWorker control resource: `requestedLane=cowork`,
    `effectiveLane=direct`, `fallbackReason=openworker-control-unavailable`.
  - Without a DSH control resource: the lane runs the NRC-selected native agent directly as
    `executor: native`. The UI shows it.

### 9a. NXR-059 transport decision (2026-10-04)

OpenWorker keeps **one long-lived stdio MCP process per server name**, shared by its sessions, with
the environment fixed at spawn; tool calls are capped at 120 s and carry no session context.
Therefore:

- **Bridge endpoint in Desktop main:** a per-launch, randomly named local IPC endpoint — a Windows
  named pipe, or a `0600` unix socket in the private runtime directory elsewhere. It is not a network
  port (ADR-021 §network still holds; same class as the sandbox egress proxy's unix socket). It
  serves only `intelligence_submit` / `intelligence_status`, framed and size-bounded, and every
  request must carry a valid, unexpired turn grant token (compared in constant time).
- **Endpoint lifetime and access:** started lazily with the first grant and closed at quit, so no
  pipe or socket exists unless delegation is used. Node cannot set an explicit Windows pipe ACL; the
  per-launch random name plus the per-request turn token are the access control (a process that
  can open the pipe but holds no token gets `AUTH_REQUIRED` and nothing else).
- **Relay:** `integrations/mcp` gains a stdio MCP relay entry exposing exactly those two tools; it
  holds no engine, no keys and no state, and forwards to the endpoint named in its environment.
- **Per-turn registration:** at turn start Desktop mints the grant (ADR-015 scope: these two tools,
  the session's project, `access ≤ draft`, budget, unit cap, TTL = turn timeout) and registers the
  `nexar` MCP entry through OpenWorker's REST API with the endpoint name and the token in its `env`;
  at turn end it deletes the entry (OpenWorker tears the relay down) and revokes the grant. The token
  is therefore a literal in OpenWorker's private `mcp.json` for the turn's lifetime only — private
  state directory, short-lived, scoped, revoked at turn end.
- **Serialization:** while delegation is enabled, Cowork turns on one OpenWorker server run one at a
  time (the relay process is shared).
- **Approvals:** OpenWorker's permission request for exactly `mcp__nexar__nexar_intelligence_submit`
  and `..._status` is allowed by Nexar policy and recorded; every other MCP tool stays denied.

### 9b. NXR-064 transport decision (2026-10-04)

Spike evidence: [`dsh-control-routing.md`](../research/upstream/dsh-control-routing.md) (DSH
`0.2.0-rc.2`, `639ed01`). Code lanes already run `dsh --profile acp` inside the bwrap sandbox, so:

- **Control route:** the Nexar-rendered DSH patch overlay declares one pi-ai route, `nexar`
  (`api: openai-completions`, `baseURL: http://127.0.0.1:<in-sandbox port>/v1`,
  `models: [{ id: nexar-control }]`, `apiKeyEnv: NEXAR_CONTROL_TOKEN`), and the ACP session selects
  it. DSH needs no `DEEPSEEK_API_KEY` on this path.
- **Plane hosting:** the plane process that runs the lane hosts, for that lane only, the same bridge
  endpoint and Chat Completions translator Desktop uses (moved to shared packages), each on a `0600`
  unix socket in the lane's private `0700` run directory. No TCP port on the plane host; the plane is
  not Desktop main, and a private unix socket is the same class as the egress proxy socket.
- **Into the sandbox:** the launcher mounts the run directory (as it does for `proxy.sock`), bridges
  `127.0.0.1:<in-sandbox port>` → `gateway.sock` with socat (proxy-mode pattern) and sets
  `NO_PROXY=127.0.0.1` only when this service is mounted; otherwise Node's env proxy
  (`NODE_USE_ENV_PROXY=1`) would send loopback calls to the egress proxy, which denies them. The
  egress allowlist is unchanged: the gateway adds no external host.
- **Units:** ACP `session/new` mounts one stdio MCP server, `nexar` (the bundled relay, read-only
  mount, run by the sandbox's Node), with `NEXAR_BRIDGE_ENDPOINT` = the in-sandbox `bridge.sock` path
  and the lane token. Child units run on plane resources with no workspace (§7B). DSH normalizes the relay's
  tool names (`nexar.intelligence_submit` → `mcp__nexar__nexar_intelligence_submit_<hash>`, per
  `dsh-mcp-client` `publicToolName`); Nexar's ACP permission policy allows exactly those two
  computed names in gateway mode. The relay is offered only when the plane's Node is inside a
  configured toolchain mount (visible in the sandbox at the same path); otherwise the lane runs on
  the gateway without the bridge, since DSH rolls back a session whose MCP server cannot start.
- **Grant:** one grant per lane run, control decision pinned per lane loop (§8), revoked when the lane
  ends. The token reaches DSH through the sandbox environment (the launcher's `--setenv` known gap
  applies; host trusted, token lane-scoped and short-lived).
- **No control resource:** the lane runs the NRC-selected native agent (`executor: native`,
  NXR-055 path), recorded. Plane `model-turn` resources today are pi catalog models with plane API
  keys and owner-declared local endpoints; subscription CLI agents (Claude Code, Codex) are native
  agents, not control resources, until NXR-067 adds experimental subscription model adapters.

### 10. Two-stage resource intelligence

- **Stage 1, `strategy@1`.** It plans a `WorkGraph`: a lane plan, or a turn ledger for dynamic
  engines.
  - It reuses `resource-intelligence@1` hard filters.
  - Its plan factors only reorder eligible candidates. The factors are diversity, reservation,
    budget, quality fit, balance, support class and control compatibility.
- **Stage 2.** It revalidates each unit just before execution. On failure it falls back to a ranked
  alternative and records `strategy.fallback`.
- **Deterministic.** There is no mandatory LLM router. An LLM may only propose unit requirements.

### 11. Engineering plane resources

- **Plane connections.** The WSL plane is a separate engineering machine. Its connections
  (subscriptions signed in inside the plane, plane API keys) produce plane resources.
- **No credentials cross the bridge.** No credential crosses `wsl.exe` (ADR-025). Desktop shows
  the plane's connections and resources read-only (ids, status, support) through the plane protocol
  and labels them "Engineering plane".
- **Signing in the plane.** Sign-in for the plane happens inside the plane, through vendor login or
  a plane-side Nexar login for experimental adapters.
- **"Configure once"** means once per machine boundary. Code and Cowork are planned with the same
  strategy and policy.

### 12. Cost, allowance and policy

- **Subscriptions are never `$0`.** They are `subscription-allowance`, with quota `measured`,
  `estimated`, `owner-declared` or `unknown`.
- **Owner policy is generic**, never vendor-hard-coded. It covers:
  - allowed lanes;
  - preference tier;
  - prefer-subscription;
  - privacy;
  - reservations;
  - experimental enablement;
  - control resource per mode.
- **Auto is the default.**

### 13. Security boundaries

- No harvesting of other applications' credentials, cookies or keyrings.
- No secret in config, renderer IPC, logs, telemetry or audit.
- No listener in Desktop main. Any gateway child is supervised, loopback-only and token-bound, with
  the rationale written first.
- Code writes only in WSL bwrap, with no push and no native write fallback.
- Approvals stay fail-closed. OpenWorker cannot self-approve.
- Bridge identities are turn-scoped and non-escalating (ADR-015).
- Lineage depth is at most 2.

### 14. Telemetry and validation

- **Telemetry.** Strategy decisions, control decisions (`controlDecisionId`), revalidations and
  bridge executions are recorded as structured records with ids, codes and `Measured` usage, never
  content. History feeds the planner.
- **Validation.** Everything is validated offline with fakes. Owner live acceptance (NXR-066)
  proves:
  - providers are configured once;
  - Auto routing works;
  - OpenWorker genuinely orchestrates Cowork and DSH genuinely orchestrates Code;
  - subscriptions are used where compatible;
  - no vendor is chosen by hand.

## Consequences

- Subscriptions power work units now, and control loops wherever an adapter provides `model-turn`.
- Experimental routes are possible but opt-in, labelled and isolated. The owner carries documented
  terms risk; Antigravity is excluded.
- A loopback gateway child may be added under the plan's security rationale. Desktop main still
  opens no listener.
- **Rejected:**
  - harvesting another application's tokens;
  - reusing OpenWorker's auth store as a Nexar connection;
  - switching control resources mid-loop;
  - an LLM router that bypasses hard filters;
  - an OpenWorker or DSH fork when a seam or a minimal patch suffices.
