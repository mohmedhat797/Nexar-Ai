# Resource orchestration: architecture and implementation plan

The decision is [ADR-027](../adr/027-resource-orchestration-architecture.md). Baseline: `main @
76de2e1` (PR #36 merged), audited on 2026-10-04. Everything here was checked against source, not
only ADRs.

## 1. Current-state audit (what the code does today)

| Flow               | Implementation                                                                                                                                                                                                                                | Who chooses the resource                                                                                                 |
| ------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| API keys           | Desktop `providers.ts`: the key goes to the key store; the provider is added to `discovery.sources.piCatalog.providers`; pi-ai catalog models become `model` resources (adapter `pi`, `access: api`)                                          | NRC                                                                                                                      |
| Subscriptions      | `@nexar/integration-*` native adapters (`claude-code`, `codex`, `antigravity`); Desktop `subscriptions.ts` starts vendor logins and runs probes; resources appear only through **CLI discovery** (`cli:<runtime>` stats the binary on `PATH`) | NRC                                                                                                                      |
| Local / custom     | `local-endpoints.ts`: owner-listed endpoints, discovered models (`access: local`)                                                                                                                                                             | NRC                                                                                                                      |
| Desktop Auto       | First-run config: `resources: [local-echo]`, `defaultResourceId: local-echo`, `resource-intelligence` with `preferences: authoritative`                                                                                                       | **echo wins**: on the owner machine Auto routed to `local-echo` while `claude-code` was discovered **and authenticated** |
| Direct turn        | `OperatingService.executeDirect` → NRC → adapter                                                                                                                                                                                              | NRC                                                                                                                      |
| Code turn          | Plane `run` → `EngineeringRunner` → lane plan → **NRC per lane** (`laneRole`, `lanePreferences`, review diversity through `excludedResourceIds`) → native or DSH adapter in the bwrap sandbox                                                 | NRC, per lane only; no plan-level view                                                                                   |
| DSH                | Integration package with the SDK and ACP paths. An `agent` resource (`underlying: deepseek-official/deepseek-v4-flash`, `DEEPSEEK_API_KEY`); `piAiProviders` route other API providers. Nexar never uses DSH's planning or sub-agents         | NRC picks DSH like any lane resource                                                                                     |
| Cowork turn        | `CoworkService`: NRC routes the turn among **pi model resources whose provider maps to OpenWorker and is owner-allowed**; that key is configured into the private `openworker-server`; one `provider:model` per turn                          | NRC chooses one model; **subscriptions excluded by design (ADR-026 §4)**                                                 |
| OpenWorker → Nexar | ADR-004's MCP seam exists (`nexar mcp serve`: `submit_work`, `work_status`, `route`, `resources`, `workflows`; ADR-015 scopes), but the private server registers **no** MCP servers (ADR-026 §5)                                              | n/a                                                                                                                      |
| Lineage            | `@nexar/operating` correlation: `rootCorrelation`, `delegate`, `childTask`, `MAX_DELEGATION_DEPTH = 2`, re-entry refused                                                                                                                      | —                                                                                                                        |
| Cost and quota     | `CostProfile.subscription`, `CostClass: subscription-allowance`, `QuotaObservation` with provenance, reservations and allowances (ADR-020)                                                                                                    | NRC                                                                                                                      |

## 2. Gap analysis

| #   | Gap                                                                                                                         | Where an engine owns provider choice, or Nexar under-delivers | Unit                                                 |
| --- | --------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------- | ---------------------------------------------------- |
| G1  | Auto routes to the echo test double in real Desktop configs                                                                 | `config-store.ts` `firstRunConfig`                            | NXR-060                                              |
| G2  | No first-class connection; subscriptions exist only through PATH discovery; the provider UI is per method, not per provider | `providers.ts`, `subscriptions.ts`, registry                  | NXR-060, NXR-065                                     |
| G3  | Cowork cannot use subscriptions; OpenWorker's single model does all the work                                                | ADR-026 §4, `cowork.ts`                                       | NXR-059, NXR-062, NXR-063                            |
| G4  | No plan-level allocation (review diversity is decided reactively per lane; no plan budget or reservation awareness)         | `execution.ts` lane routing                                   | NXR-061                                              |
| G5  | DSH is not an orchestrator; its control model is hard-wired to an API key                                                   | ADR-002, `deepseek-harness/resource.ts`                       | NXR-064                                              |
| G6  | No engine-agnostic bridge for intelligence requests                                                                         | —                                                             | NXR-062                                              |
| G7  | OpenWorker holds API keys in its private process (and possibly its private state)                                           | ADR-026 §4                                                    | NXR-063 (verify upstream at-rest handling; minimize) |

Correct and kept: the key store, native auth probes, key checks, discovery merge, NRC hard filters,
the WSL plane and sandbox, `EngineeringRunner` controls, the OpenWorker supervisor and policy
approvals, Operating Sessions, the Artifact Store, telemetry.

## 3. Target architecture

```text
                    Nexar Desktop (Operating Layer: sessions · intent · lane · policy)
                         │                                   │
                       Cowork                               Code
                         │                                   │
          OpenWorker (control model: NRC-selected      EngineeringRunner envelope (sandbox, gates,
          API/local resource)                          review, approval, commit)
                         │                                   │ lane plan = work graph
             delegated units (MCP, turn-scoped)        DSH orchestrates inside lanes (control:
                         │                             NRC-selected API/local) ── lane-scoped bridge
                         └──────────────┬────────────────────┘
                              Engine Resource Bridge (IntelligenceRequest)
                                        │
                     Resource Strategy Planner (WorkGraph or turn ledger) ── Stage 1
                                        │
                     NRC runtime revalidation (resource-intelligence@1) ── Stage 2
                                        │
                      Resource Registry = Resource Gateway (connections → resources)
             ┌──────────────────────────┼───────────────────────────┐
     subscription (native agents)   api (pi-ai)            local/custom (pi-ai)
     Claude Code · Codex · agy      Anthropic · OpenAI ·   Ollama · LM Studio ·
                                    Gemini · DeepSeek · …  vLLM · custom
```

## 4. Contract migration design

All changes are additive; no existing field changes meaning.

- **`ProviderConnection`** (new, `@nexar/contracts`):
  - fields: `{ id, provider, method: 'subscription' | 'api' | 'local' | 'custom', status, adapterIds, label }`;
  - the status never includes a secret.
  - Desktop derives connections from the key store, subscription probes and local endpoints.
- **`ResourceDescriptor`:**
  - `metadata.connection = { id, provider, method }` is set by every source;
  - a new well-known capability `agent-loop-control:<engine>` is added only to resources an engine
    can legitimately use as its control model.
- **`QualityClass`** (`basic | standard | high`) is an optional `TaskRequirements` field. Resource
  quality comes from owner-declared tiers or tags; there are no vendor heuristics in code.
- **`WorkGraph`** (new):
  - `units[]`: `{ unitId, kind, laneRole?, requirements, dependsOn, reviewOf?, access }`;
  - `budget`.
- **`ResourceStrategy`** (new):
  - `{ policy stamp, units: [{ unitId, decision: RouteDecision }], reasons[] }`;
  - reuses `RouteDecision` and `CandidateAssessment`.
- **`IntelligenceRequest` and `IntelligenceResult`** (new): see §7.
- **Owner resource policy:** extends ADR-020 config (`preferences`, `reservations`, `allowances`)
  with `allowedLanes`, `preferSubscription` and `privacy`. Every change bumps `configId`.
- **`deterministic@1`** is untouched. The planner is `strategy@1` in the resource controller.

## 5. Provider Gateway design (NXR-060)

- **Connections become resources** through the existing sources:
  - **Subscription:** the probe-backed native source registers `claude-code`, `codex` and
    `antigravity` (experimental) when the runtime is installed. Auth comes from the existing free
    probes. Discovered never means authenticated.
  - **API:** the pi catalog source yields one resource per model, with
    `metadata.connection.method = api`.
  - **Local / custom:** the local-endpoints source.
- **First-run Desktop config:**
  - no `local-echo` and no `defaultResourceId: local-echo`;
  - with no eligible resource, Auto reports `NO_ELIGIBLE_RESOURCE` with the reasons, as
    `config/README.md` already prescribes.
  - **Migration:** an existing Desktop config whose only configured resource is the untouched echo
    descriptor and whose default is `local-echo` is upgraded once, with a backup. The echo stays
    for tests and the CLI built-in default.
- **One provider can have several connections.** They coexist without separate routers. All
  resources go into one registry snapshot, and the NRC sees `kind.access` and `metadata.connection`.

## 6. Resource Strategy Planner design (NXR-061)

- **API:** `planStrategy({ graph, snapshot, history, facts, constraints, policy }) →
ResourceStrategy`. It is pure, takes an injected clock and never sees prompts.
- **Algorithm:**
  1. Evaluate every unit with the `resource-intelligence@1` hard filters (identical code path).
  2. Greedy in topological order, highest quality class first. Each unit's score adds plan factors:
     - `diversity`: a `reviewOf` unit penalizes the resource of the unit it reviews (hard when the
       project policy is `required`);
     - `reservation`: premium allowance is held for `high` units when known headroom is at or below
       the threshold;
     - `budget`: estimated cash cost against the remaining plan budget (unknown cost is handled by
       `unknownUnderLimit`);
     - `quality-fit`: a `basic` unit prefers `local-compute`, `free` or a cheaper class, and a `high`
       unit prefers higher owner tiers;
     - `balance`: units spread across subscriptions when ties remain.
  3. Each unit keeps its ranked alternatives for Stage 2.
- **Factors are explainable:** each one is a `ScoreFactor`, and each reason is a `RouteReason`
  (`strategy.diversity`, `strategy.reserved`, …).
- **Turn ledger:** for OpenWorker, `allocateNext(ledger, unit, snapshot)` applies the same factors to
  one arriving unit and updates the ledger.
- **Stage 2:** `revalidate(planned, snapshot)` re-runs the hard filters on the planned resource and
  its alternatives at execution time.
- **Code:** `EngineeringRunner` builds the `WorkGraph` from the lane plan (feature, tests,
  review `reviewOf: feature`, rework units) and plans once before lanes start.

## 7. Engine Resource Bridge and NXR-059

- **`IntelligenceRequest`:**
  - `{ lineage, unitId, requirements, qualityClass?, access: 'read-only' | 'draft', input: untrusted text (bounded), documentRefs?, timeoutMs, budgetUsd? }`.
- **`IntelligenceResult`:**
  - `{ unitId, outcome: 'succeeded' | 'failed' | 'cancelled', text?, draftRefs?, usage: Measured, decisionId, errorCode? }`.
- **Core service** (`@nexar/core` or `@nexar/operating`): ledger allocation → revalidate → create a
  child task (`childTask(correlation)`, no turn) → adapter execution with a draft-only workspace →
  telemetry.
- **OpenWorker transport (NXR-059):**
  - At turn start, Desktop mints a turn-scoped client: ADR-015 scopes are limited to
    `nexar.intelligence_submit`, `nexar.intelligence_status`, the session's project, `access ≤ draft`,
    a TTL of the turn timeout, and a budget.
  - It registers a stdio MCP server entry for the private OpenWorker (`POST /v1/mcp`). The token is
    passed as a `${…}` reference resolved from the private server's environment, so there is no
    literal token in `mcp.json`.
  - It removes the entry and revokes the token at turn end.
  - The tool contract is submit-and-poll, so each call returns under OpenWorker's 120 s limit.
  - Policy: OpenWorker's MCP permission requests for exactly this server and tools are allowed by
    Nexar policy and recorded. Everything else stays denied (ADR-026 §3).
  - Recursion: the child's chain is `nexar, openworker`. A child never starts an engine, and the
    bridge refuses `depth > MAX_DELEGATION_DEPTH`.
- **DSH transport (NXR-064):** researched in a time-boxed spike:
  - DSH's MCP client against a lane-local stdio relay, versus an ACP client capability;
  - the bwrap profile keeps no network;
  - the relay is a pre-opened file descriptor or stdio pipe owned by the launcher.

## 8. OpenWorker control-model solution (NXR-063)

Preferred order, evaluated against upstream (`074ad3f`):

1. **Official subscription route.** None exists: `openai-codex` emulates the Codex CLI's client, so it
   is rejected.
2. **Nexar-controlled provider seam (loopback gateway).** Deferred; needs a listener and a security
   ADR, and does not unlock subscriptions.
3. **Chosen: an NRC-selected control resource.** It is an `api` connection the owner allows for
   OpenWorker, or a `local` endpoint mapped to OpenWorker's `ollama` provider or `openai`
   `base_url`. It is selected with `agent-loop-control:openworker` plus `tool-use`, a small context
   minimum and a latency preference.
4. **None available.** The Cowork lane is unavailable with a precise reason ("OpenWorker needs a
   control model: add a local model (free) or allow an API key"). Turns fall back to `direct`.

Before any change, also verify how OpenWorker stores provider keys under its private state dir
(G7). If they are persisted, prefer per-launch configuration and wipe the private state on exit.

## 9. DSH control-model solution (NXR-064)

- DSH's control model is NRC-selected among DSH-compatible `api` connections (the pi-ai route with
  a key) or `local` endpoints. Verifying the local base-URL route is part of the spike.
- `DEEPSEEK_API_KEY` stops being a product prerequisite.
- DSH's Claude Code and Codex sub-agent providers are **not** used as Nexar routes. Subscription
  workers are Nexar native adapters, reached through the lane-scoped bridge.
- With no DSH control resource, lanes run the NRC-selected native agent directly (the live-validated
  NXR-055 path), recorded as `executor: native`.

## 10. Security analysis

| Threat                               | Mitigation                                                                                                                                                                     |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Engine escalates through the bridge  | Turn-scoped ADR-015 identity; tool, project and access scopes; budget; TTL; request fields can't widen scope; every call audited (field allowlist)                             |
| Recursion or fan-out loop            | ADR-024 lineage; `MAX_DELEGATION_DEPTH = 2`; re-entry refused; per-turn unit cap; budget                                                                                       |
| Secret leakage to engines            | Engines get only their control key (unchanged from ADR-026) and a scoped token; worker credentials stay in worker adapters; tokens by reference, never literal in engine files |
| Prompt injection via delegated input | Input wrapped as untrusted (ADR-017); children are read-only or draft-only, with no outward executors, approvals or commits                                                    |
| Sandbox breach via the DSH bridge    | Lane relay over a launcher-owned descriptor; no network; patch policy, gates, review and approval unchanged                                                                    |
| Subscription terms                   | Only official CLIs run subscriptions; no token handling; emulated OAuth rejected                                                                                               |
| Quota honesty                        | Unknown stays unknown; no scraping; subscriptions are `subscription-allowance`, never `$0`                                                                                     |

## 11. Backlog decomposition and sequence

| Order | Id      | Unit                                                                                                       | Depends on |
| ----- | ------- | ---------------------------------------------------------------------------------------------------------- | ---------- |
| 1     | NXR-060 | Provider connections and resource normalization; remove the echo default                                   | —          |
| 2     | NXR-061 | Resource Strategy Planner (`strategy@1`), Stage 2 revalidation, Code lane-plan graph                       | 060        |
| 3     | NXR-062 | Engine Resource Bridge core (`IntelligenceRequest`), fake resources                                        | 061        |
| 4     | NXR-059 | OpenWorker → Nexar turn-scoped delegation (MCP transport, identity, policy)                                | 062        |
| 5     | NXR-063 | OpenWorker control resource (NRC-selected API/local; key-at-rest check)                                    | 060, 059   |
| 6     | NXR-064 | DSH as the Code orchestrator inside lanes: control resource, lane bridge spike, then implementation        | 061, 062   |
| 7     | NXR-065 | Providers UX: provider cards × connection methods; advanced resource view; owner policy contract           | 060        |
| 8     | NXR-066 | Offline E2Es: Cowork SOW strategy, Code regression, integrated three-turn flow; then owner live acceptance | all        |

NXR-054 (scheduled tasks), Memory, Automation, Mobile and the control plane stay deferred until
NXR-066's live acceptance.

## 12. Testing plan

All tests run offline in CI:

- **Fakes:** fake native CLIs, pi `fauxProvider`, the fake OpenWorker (extended with MCP tool calls
  and plan events), the fake plane and fake DSH.
- **Planner invariants** (seeded, like ADR-020's):
  - the planner never admits a candidate that the hard filters rejected;
  - the same inputs produce the same strategy;
  - with a known alternative, a review unit never shares the implementer's resource under
    `required`;
  - reservations hold for `high` units.
- **Bridge:** scope widening, expiry, depth, re-entry, budget and cancellation negatives.
- **Live tests** stay behind `NEXAR_LIVE_TESTS` and owner acceptance.

## 13. Live acceptance plan (NXR-066)

1. **Providers:** Claude subscription and ChatGPT (Codex) subscription connected; one local model
   (Ollama) or API key for engine control.
2. **Cowork:** "Prepare an SOW for this project." OpenWorker orchestrates. At least one substantive
   unit runs on a subscription agent through the bridge. The strategy is visible in the turn. Nexar
   saves the artifact. No secret leaves its owner.
3. **Code regression:** one small change. The strategy picks a subscription agent for `feature` and a
   different resource for `review`. Sandbox, gates, approval and local commit; no push.
4. **Integrated:** proposal → repository review → implementation, in one conversation, with no vendor
   chosen by hand.
