# Resource orchestration: architecture and implementation plan

The decision is [ADR-027](../adr/027-resource-orchestration-architecture.md), revision 2. The
compatibility evidence is in [`subscription-control-compatibility.md`](../research/upstream/subscription-control-compatibility.md).
Baseline: `main @ 76de2e1` (PR #36 merged), audited on 2026-10-04 against source, not only ADRs.

## Dynamic inventory revision (2026-10-06)

The baseline audit below is historical. NXR-059–065 and NXR-067a are implemented on draft PR #39;
NXR-067b is partial, and NXR-066b is blocked by NXR-068. The owner smoke confirmed authentication
but the account route rejected the assumed model; OpenWorker's unavailability is a separate host
prerequisite. Current implementation/evidence is in
[`project-current-state.md`](../devlog/project-current-state.md).

[ADR-028](../adr/028-dynamic-provider-sessions-and-model-inventory.md) inserts a provider runtime
inventory layer before the registry: provider → connection → runtime/route → inventory → stable
model-level resources → existing strategy/NRC → Engine Gateway. It preserves ADR-027 engines and
control-loop pinning. [NXR-068](../backlog/068-dynamic-provider-model-catalogs.md) proceeds in bounded
units: contracts/materialization, OpenAI account catalog/execution first, Claude native inventory,
Google native inventory, UI and regression. No static default model or generic vendor catalog
establishes subscription availability. API/local pi-ai stays, ACP and Goose engine migration defer.

Architecture documentation is pushed. GitHub billing currently prevents completing its CI gate.
The owner's 2026-10-07 revision permits implementation with strengthened local gates: focused tests,
full pinned Node 22 check, Desktop E2E, Windows packaging and packaged E2E, followed by review,
commit and push. Track CI as unavailable; full exact-head CI is mandatory before merge/release.
Live auth and quota acceptance wait for owner initiation after NXR-068 and its CI gate.

## 1. Current-state audit (what the code does today)

| Flow               | Implementation                                                                                                                                                                                                    | Who chooses the resource                                                                                                 |
| ------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| API keys           | Desktop `providers.ts`: the key goes to the key store; the provider is added to `discovery.sources.piCatalog.providers`; pi-ai catalog models become `model` resources (adapter `pi`, `access: api`)              | NRC                                                                                                                      |
| Subscriptions      | Native adapters (`claude-code`, `codex`, `antigravity`); Desktop `subscriptions.ts` starts vendor logins and probes; resources appear only through **CLI discovery** (`cli:<runtime>` stats the binary on `PATH`) | NRC                                                                                                                      |
| Local / custom     | `local-endpoints.ts`: owner-listed endpoints, discovered models (`access: local`)                                                                                                                                 | NRC                                                                                                                      |
| Desktop Auto       | First-run config: `resources: [local-echo]`, `defaultResourceId: local-echo`, `resource-intelligence` + `preferences: authoritative`                                                                              | **echo wins.** On the owner machine Auto routed to `local-echo` while `claude-code` was discovered **and authenticated** |
| Direct turn        | `OperatingService.executeDirect` → NRC → adapter                                                                                                                                                                  | NRC                                                                                                                      |
| Code turn          | Plane `run` → `EngineeringRunner` → lane plan → **NRC per lane** (`laneRole`, `lanePreferences`, review diversity) → adapter in bwrap. Plane resources are the plane's own (ADR-025)                              | NRC per lane; no plan-level view                                                                                         |
| DSH                | SDK and ACP adapter; an `agent` resource with `DEEPSEEK_API_KEY` (`piAiProviders` for other keys). DSH's planning and sub-agents are unused                                                                       | NRC picks DSH like any lane resource                                                                                     |
| Cowork turn        | `CoworkService`: NRC routes among **owner-allowed pi API resources that OpenWorker maps**; the key is configured into the private server; one `provider:model` per turn                                           | NRC, one model; **subscriptions excluded (ADR-026 §4)**                                                                  |
| OpenWorker → Nexar | MCP server (`submit_work`, `work_status`, `route`, `resources`, `workflows`; ADR-015 scopes) exists, but the private server registers **no** MCP servers                                                          | n/a                                                                                                                      |
| Lineage            | `@nexar/operating` correlation (`MAX_DELEGATION_DEPTH = 2`, re-entry refused)                                                                                                                                     | —                                                                                                                        |
| Cost and quota     | `CostProfile.subscription`, `CostClass: subscription-allowance`, `QuotaObservation` with provenance, reservations, allowances                                                                                     | NRC                                                                                                                      |

## 2. Gap analysis

| #   | Gap                                                                                                                                  | Unit             |
| --- | ------------------------------------------------------------------------------------------------------------------------------------ | ---------------- |
| G1  | Auto routes to the echo test double in real Desktop configs                                                                          | NXR-060          |
| G2  | No first-class connection or support class; subscriptions only through PATH discovery; no compatibility metadata                     | NXR-060          |
| G3  | No plan-level allocation (diversity, reservations and budget decided per lane, reactively)                                           | NXR-061          |
| G4  | No engine gateway: neither a control-model contract nor a work-unit bridge                                                           | NXR-062          |
| G5  | Cowork can't delegate substantive units to Nexar                                                                                     | NXR-059          |
| G6  | OpenWorker's control model is an API key OpenWorker holds directly (ADR-026 §4); no Nexar provider; no owner control-resource policy | NXR-063, NXR-065 |
| G7  | DSH is not an orchestrator; its control is hard-wired to an API key                                                                  | NXR-064          |
| G8  | No owner-enabled subscription model-turn adapter, so subscriptions can't drive control loops                                         | NXR-067          |
| G9  | Providers UI organized by implementation; no orchestration-control settings                                                          | NXR-065          |

Kept as-is: the key store, native auth and probes, key checks, discovery merge, NRC hard filters, the
WSL plane and sandbox, `EngineeringRunner`, the OpenWorker supervisor and policy approvals, sessions,
the Artifact Store, telemetry.

## 3. Target architecture

```text
                          Nexar Desktop · Operating Layer (sessions · intent · context · policy)
                               │                                      │
                             Cowork                                  Code (WSL plane)
                               │                                      │
                          OpenWorker                       DSH inside EngineeringRunner envelope
                       (workflow plan)                     (lane plan = engineering work graph)
                               │                                      │
                ┌──────────────┴──────────────┐        ┌──────────────┴──────────────┐
         Control Model Gateway     Intelligence Bridge   Control Model Gateway  Intelligence Bridge
         (NexarProvider, pinned    (NXR-059, per-unit)   (plane, pinned per     (plane, lane-scoped)
          per engine turn)                                lane loop)
                └──────────────┬──────────────┘        └──────────────┬──────────────┘
                               └────────── Nexar Engine Gateway ──────┘
                                                │
                         Resource Strategy Planner (strategy@1: WorkGraph or turn ledger)
                                                │
                         NRC runtime revalidation (resource-intelligence@1 hard filters)
                                                │
                   Resource Registry (Desktop connections · plane connections, read-only in UI)
          ┌──────────────────────────┬──────────┴──────────────┬───────────────────────────┐
   subscription (vendor-native:   subscription (experimental   api (pi-ai):             local/custom (pi-ai):
   Claude Code, Codex, agy: work  model adapters, NXR-067:     Anthropic, OpenAI,       Ollama, LM Studio,
   resources)                     model-turn, owner-enabled)   Gemini, DeepSeek, …      vLLM, custom
```

## 4. Contract migration design (additive; no existing field changes meaning)

- **`ProviderConnection`** (`@nexar/contracts`):
  - `{ id, provider, method: subscription|api|local|custom, authClass: vendor-native|official-api|official-account|experimental-client-compat|none, support: official|experimental, enabled, status, machine: desktop|plane }`.
  - No secrets.
- **`ResourceDescriptor.metadata.connection`** = `{ id, provider, method, authClass, support }`, set by
  every source. `kind.access` and `auth.mode` stay authoritative for existing filters.
- **Capabilities.** The new well-known capability is **`model-turn`**: the resource accepts
  caller-supplied messages and tool schemas and returns an assistant turn whose tool calls the caller
  executes. Set it on pi-ai catalog `model` resources, on local endpoints whose owner declares `toolCalling`, and on experimental
  subscription model adapters. Never set it on native CLI agents.
- **Engine control requirements** are data:
  `ENGINE_CONTROL_REQUIREMENTS = { openworker: ['model-turn'], dsh: ['model-turn'] }`. `tool-use` keeps
  its meaning (the resource runs tools itself; `automation` tasks require it).
- **Owner policy** extends the existing config:
  - per mode: `orchestration.<mode>.controlResource = { mode: auto|pinned, resourceId?, fallback: auto|none }`;
  - `resourcePolicy.experimental.enabled` (default `false`) plus a per-connection enable flag;
  - allowed lanes, preference tier and prefer-subscription, folded into the ADR-020 `preferences`
    and `allowances` config.
  - Every change bumps `configId`.
- **New planning types:**
  - **`QualityClass`** (`basic|standard|high`), an optional `TaskRequirements` field;
  - **`WorkGraph`**, **`ResourceStrategy`** (reuses `RouteDecision`) and the turn ledger (NXR-061).
- **Gateway types:**
  - **`ControlTurnRequest` and `ControlTurnResult`** (NXR-062 A);
  - **`IntelligenceRequest` and `IntelligenceResult`** (NXR-062 B).
- **Unchanged:** `deterministic@1`.

## 5. Provider connections → resources (NXR-060)

- **Desktop sources:**
  - vendor-native subscription source (probe-backed: Claude Code, Codex; Antigravity experimental);
  - pi catalog (API);
  - local endpoints.
  - Each sets `metadata.connection`.
- **Plane sources:** the same sources inside the plane. The plane reports its connections and
  resources (ids, method, support, auth state; never secrets) in the `ready` readiness, as an additive
  protocol field. Desktop shows them read-only under "Engineering plane".
- **First-run Desktop config** has no `local-echo` and no `defaultResourceId: local-echo`. With
  nothing eligible, Auto reports `NO_ELIGIBLE_RESOURCE` with reasons.
- **Migration:** an existing config whose only configured resource is the untouched echo descriptor
  and whose default is `local-echo` is upgraded once, with a backup. Echo remains for tests and the
  CLI built-in default.
- **States stay distinct and are never inferred from each other:** `installed`, `authenticated`,
  `available`, `compatible`, `eligible`, `selected`.

## 6. Resource Strategy Planner (NXR-061)

- **`planStrategy({ graph, snapshot, history, facts, constraints, policy }) → ResourceStrategy`.** It
  is pure, uses an injected clock and never sees prompts.
- **Algorithm:**
  1. Run the `resource-intelligence@1` hard filters for every unit (identical code path).
  2. Greedy in topological order, highest quality class first. Each unit's score adds plan factors:
     - diversity (`reviewOf`);
     - reservation (premium allowance for `high` units);
     - plan budget;
     - quality fit;
     - balance across subscriptions;
     - support class (experimental only when owner policy allows, ranked after official);
     - control compatibility for control units.
  3. Each unit keeps its ranked alternatives.
- **Turn ledger:** `allocateNext(ledger, unit, snapshot)` for dynamic engines.
- **Revalidation:** `revalidate(planned, snapshot)` at execution time.
- **Code:** `EngineeringRunner` builds the graph from the lane plan and plans it upfront.
- **Explainability:** factors are `ScoreFactor`s and reasons are `RouteReason`s (`strategy.*`).

## 7. Engine Gateway (NXR-062)

Shared foundations: lineage (`childTask`, depth ≤ 2, re-entry refused), ADR-015 turn- or lane-scoped
identity, budget, cancellation, timeout, and telemetry (ids, codes, `Measured` usage; no content).

**A. Control Model Gateway**

- `ControlTurnRequest{ lineage, engine, controlDecisionId, messages, tools, settings }`
  → `ControlTurnResult{ text?, toolCalls[{ id, name, arguments }], finishReason, usage, extras }`.
- `selectControl(engine, mode, policy)` runs at an engine-turn boundary:
  - **Auto:** the NRC over resources that meet `ENGINE_CONTROL_REQUIREMENTS[engine]`.
  - **Pinned:** the owner's resource, unless it is unavailable or incompatible; then the `fallback`
    setting applies.
- It records `controlDecisionId` and pins the resource for the loop.
- Model adapters implement one internal port, `ModelTurnPort.turn(request, signal)`:
  - **pi-ai:** messages, tools, streaming and usage.
  - **Experimental subscription adapters:** NXR-067.
- `extras` are opaque and keyed by `controlDecisionId`. They are only ever passed back to the same
  resource.
- **Failure handling:**
  1. a bounded retry on the same resource;
  2. otherwise `control-resource-failed`;
  3. with `fallback: auto`, restart the whole engine turn from canonical history on the next-ranked
     resource;
  4. never a mid-loop switch.

**B. Intelligence Execution Bridge**

- `IntelligenceRequest{ lineage, unitId, requirements, qualityClass?, access: read-only|draft, input (untrusted, bounded), documentRefs?, timeoutMs, budgetUsd? }`
  → `IntelligenceResult{ unitId, outcome, text?, draftRefs?, usage, decisionId, errorCode? }`.
- Flow: ledger allocation → revalidation → child task (no turn) → work resource adapter with a
  draft-only workspace → telemetry.
- Transports:
  - **OpenWorker:** a turn-scoped stdio MCP server with `nexar.intelligence_submit` and
    `nexar.intelligence_status`, submit-and-poll under the 120 s tool limit (NXR-059).
  - **DSH:** a lane-scoped relay (NXR-064).

## 8. OpenWorker NexarProvider (NXR-063)

Upstream has no provider extension seam (registry `DESCRIPTORS` is hard-coded). Options, in order:

1. **Upstream provider-extension seam:** for example, entry-point-registered `ProviderClient`s.
   Contribute it upstream. If accepted, `NexarProvider` is a small Python package speaking stdio to a
   Nexar-supervised gateway process. No listener.
2. **Supervised loopback gateway child (zero-patch):** OpenWorker's `openai` provider with
   `base_url = http://127.0.0.1:<port>/v1` (Chat Completions), and `api_key` = a per-launch random
   gateway token. **Security rationale** (required before shipping):
   - **Process and binding:** a separate supervised child of Desktop main, not main itself
     (ADR-021's "no listener in the app" stays true for main). It binds `127.0.0.1` only, on a free
     port, and exits with its parent.
   - **Authentication:** a per-launch 256-bit bearer, compared in constant time, held in memory
     only. OpenWorker receives it through its provider API, the same path ADR-026 uses for keys
     today.
   - **Request surface:** only `POST /v1/chat/completions` and `GET /v1/models` (one alias,
     `nexar/control`). It accepts only the pinned control decision of the current turn, with bounded
     bodies, and has no CORS, no redirects, no upstream URL parameters and no request field that
     selects a provider or secret.
   - **Credentials:** API keys, local endpoints and experimental tokens are resolved inside the
     gateway or main at call time and never leave them.
   - **Threat comparison:** a local process that obtains the token can spend the owner's control
     resource for the turn's lifetime. That is the same class of exposure ADR-026 already accepted
     for API keys held by `openworker-server`, but narrower: one resource, one turn, no key material.
   - **Gaps:** Chat Completions drops provider-private extras on OpenWorker's side. The gateway
     keeps them server-side, keyed by tool-call id within the pinned decision. Streaming uses
     server-sent events.
3. **Minimal maintained patch** adding a `nexar` descriptor (stdio `ProviderClient`). Use it only if
   options 1 and 2 are insufficient; pin it and contract-test it.

Interim: direct OpenWorker provider configuration with an owner-allowed API key (ADR-026 §4)
remains a recorded compatibility path until option 1 or 2 ships. OpenWorker's `openai-codex` auth
store is never a Nexar connection. Before any change, verify OpenWorker's at-rest storage of keys and
tokens in its private state; prefer per-launch configuration plus wiping the private state.

## 9. DSH (NXR-064)

DSH runs in plane lanes (bwrap, no network). Time-boxed spike:

- whether DSH's LLM route accepts an OpenAI-compatible base URL, so it can point at a plane-local
  Control Model Gateway over a launcher-owned descriptor or socket relayed into the sandbox, like the
  existing egress proxy;
- whether its MCP client can reach a lane-local Intelligence Bridge relay.

Then implement:

- control through the plane gateway (plane resources with `model-turn`, owner policy as for
  Cowork);
- work units through the bridge;
- DSH sub-agent providers not used as Nexar routes;
- without a compatible control resource, native-agent lanes (`executor: native`).

The sandbox, patch policy, gates, review, approval and commit are unchanged.

## 10. Experimental subscription model adapters (NXR-067, optional, owner-enabled)

- **ChatGPT first.** OpenWorker's `CodexProvider` is the reference design: a Responses-style backend
  with encrypted reasoning items in `extras`. It uses Nexar's own PKCE login, an isolated token in
  Nexar's key store under the connection, and refresh handled in main.
- **Claude** only after re-verifying Anthropic's current terms on third-party subscription OAuth
  (high risk).
- **Gemini CLI** only after research.
- **Antigravity** is excluded (terms §6).
- **Per-adapter documentation:** vendor support status, breakage risk, account and terms risk, token
  storage, refresh behaviour and backend assumptions.
- **Behaviour:** disabled by default. History down-ranks unreliable adapters.

## 11. Security analysis

| Threat                               | Mitigation                                                                                                                                        |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| Engine escalates through a gateway   | Turn- or lane-scoped ADR-015 identity; tool, project and access scopes; budget; TTL; request fields cannot widen scope; audited (field allowlist) |
| Recursion or fan-out                 | Lineage depth ≤ 2; re-entry refused; per-turn unit cap; budget                                                                                    |
| Secrets reach engines                | Engines see turns, results and usage only; credentials are resolved in main, the gateway or adapters at call time; tokens passed by reference     |
| Loopback gateway abuse               | §8 option 2 rationale: loopback only, per-launch token, one alias, pinned decision, bounded bodies, child process, no listener in main            |
| Experimental auth                    | Owner-enabled per connection; Nexar's own isolated login; never harvested; labelled; terms risk documented; Antigravity excluded                  |
| Prompt injection via delegated input | Untrusted wrapping (ADR-017); children are read-only or draft-only; no outward executors, approvals or commits                                    |
| Sandbox breach via DSH relays        | Launcher-owned descriptor or socket; no network; patch policy, gates, review and approval unchanged                                               |
| Continuation-state corruption        | Control resource pinned per engine turn; extras scoped to the decision; restart from canonical history at clean boundaries only                   |
| Quota honesty                        | Unknown stays unknown; no scraping; subscriptions are `subscription-allowance`, never `$0`                                                        |

## 12. Sequence

| Order | Id      | Unit                                                                                          | Depends on                 |
| ----- | ------- | --------------------------------------------------------------------------------------------- | -------------------------- |
| 1     | NXR-060 | Provider connections, compatibility metadata, resource normalization; remove the echo default | —                          |
| 2     | NXR-061 | Resource Strategy Planner (`strategy@1`) and Stage 2 revalidation                             | 060                        |
| 3     | NXR-062 | Engine Gateway: Control Model Gateway and Intelligence Execution Bridge cores                 | 061                        |
| 4     | NXR-059 | OpenWorker → Nexar bounded work delegation (MCP transport)                                    | 062                        |
| 5     | NXR-063 | OpenWorker NexarProvider and control-resource policy                                          | 062                        |
| 6     | NXR-064 | DSH control and work through the plane's Engine Gateway                                       | 061, 062                   |
| 7     | NXR-065 | Providers UX and orchestration-control settings                                               | 060, 063                   |
| 8     | NXR-067 | Experimental subscription model adapters (optional; ChatGPT first)                            | 062, owner enablement      |
| 9     | NXR-066 | Offline E2Es and owner live acceptance                                                        | 059–065 (067 when enabled) |

NXR-054, Memory, Automation, Mobile and the control plane wait for NXR-066.

## 13. Testing plan (offline, deterministic)

- **Fakes:** native CLIs, pi `fauxProvider`, the fake OpenWorker (MCP tool calls, provider turns),
  the fake plane, a fake DSH and a fake model-turn adapter (including extras).
- **Control gateway:**
  - provider-agnostic turns and tool-call normalization;
  - streaming;
  - extras round-trip on the same resource only;
  - pinning, safe fallback and restart;
  - cancellation and timeout;
  - unsupported-resource rejection;
  - the experimental policy gate;
  - no secret in the engine's view.
- **Intelligence bridge:**
  - identity, scope-widening and depth rejection;
  - budget;
  - cancel propagation and timeout;
  - the draft-only boundary;
  - strategy and revalidation;
  - telemetry.
- **Planner:** seeded invariants (no re-admission, determinism, diversity under `required`,
  reservations).
- **Live:** behind `NEXAR_LIVE_TESTS` and owner acceptance only.

## 14. Live acceptance (NXR-066)

1. **Providers:** connected once. Desktop: Claude and ChatGPT subscriptions plus at least one
   `model-turn` resource (API, local, or an owner-enabled experimental subscription adapter). The
   plane: a signed-in subscription agent.
2. **Cowork:** "Create a professional SOW using this project." OpenWorker orchestrates. Its control
   loop goes through the Control Model Gateway on the NRC-selected control resource. At least one
   substantive unit runs on a subscription agent through the bridge. The strategy is visible. Nexar
   saves the artifact.
3. **Code:** one small change. DSH orchestrates; or, if no DSH control resource exists, honest
   `executor: native`. The strategy assigns `feature` and `review` to different resources.
   Sandbox, gates, approval and local commit; no push.
4. **Integrated:** proposal → repository review → implementation, in one conversation, with no
   vendor chosen by hand.
