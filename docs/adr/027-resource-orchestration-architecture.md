# ADR-027: Nexar-owned resources, engine orchestration and plan-level resource strategy

- **Status:** Accepted (architecture); implementation tracked in NXR-059 to NXR-066
- **Date:** 2026-10-04
- **Amends:** ADR-002, ADR-003, ADR-004, ADR-005, ADR-019, ADR-020, ADR-022, ADR-024, ADR-026 (each
  carries a short amendment pointing here)
- **Plan and audit:** [`docs/architecture/resource-orchestration-plan.md`](../architecture/resource-orchestration-plan.md)

## Context

The owner connects subscriptions (Claude, ChatGPT/Codex, Google), API keys and local models once, and
expects Nexar to decide how to use them across Cowork and Code. The v0.5 Operating Layer merged with
three couplings that contradict this:

1. **Cowork's model is limited to API keys.** ADR-026 §4 restricts OpenWorker to pi-ai model
   resources whose key the owner allowed for OpenWorker. A Cowork turn can never use a
   subscription-backed resource, not even for one substantive step.
2. **DSH is a resource, not the Code engine.** ADR-002 models DSH as an `agent` resource that the
   NRC may pick for a lane. Nexar's `EngineeringRunner` orchestrates lane plans. DSH's own planning
   and sub-agents are never used.
3. **Desktop's Auto routes to a test double.** The first-run Desktop config makes `local-echo` the
   default resource. Under the `authoritative` preference mode it wins over a discovered,
   authenticated Claude Code. The owner's subscription is ignored on Auto.

Upstream facts that bound the design (verified against pinned sources; details in the plan):

- **OpenWorker's control model.** OpenWorker's agent loop needs a model from its own provider
  registry: provider API keys, `ollama` or an OpenAI-compatible `base_url`, or `openai-codex`.
  `openai-codex` runs OpenWorker's own OAuth with the **Codex CLI's client id**
  (`app_EMoamEEZ…`) against `chatgpt.com/backend-api/codex`. That is a third party emulating a
  first-party client, so it is **not an accepted route** (ADR-022 §1).
- **OpenWorker's MCP client.** OpenWorker can call stdio MCP servers registered at runtime, with a
  hard 120 s per tool call. Nexar's MCP server already has `nexar.submit_work` plus
  `nexar.work_status` (submit, then poll).
- **DSH's control model.** DSH's agent loop needs a model through its provider route: DeepSeek, or
  pi-ai providers with keys. Its Claude Code and Codex sub-agents reuse native logins through vendor
  SDKs. ADR-022 already forbids subscriptions powering DSH.
- **No vendor subscription is a model API.** Claude Code, Codex and Antigravity are agents. None of
  them can serve as a raw chat-completions backend for another engine's tool-calling loop without
  breaking vendor rules or emulating protocols.

## Decision

### 1. Nexar owns providers, connections and resources (Resource Gateway)

The **Resource Gateway** is not a new process. It is the existing Resource Registry, fed by provider
connections. It is the only place resources come from. OpenWorker, DSH, pi-ai and native agents never
own a provider choice: they receive a Nexar-selected resource or a Nexar-configured connection.

### 2. Provider, connection, resource, adapter

| Term                     | Meaning                                                                                        | Example                                                                     |
| ------------------------ | ---------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| **Provider**             | A vendor or ecosystem                                                                          | Anthropic, OpenAI, Google, DeepSeek, Local                                  |
| **Connection**           | One configured way Nexar reaches a provider; method `subscription`, `api`, `local` or `custom` | Anthropic + Claude subscription; Anthropic + API key                        |
| **AI Resource**          | An executable capability derived from a connection (ADR-007 `ResourceDescriptor`)              | `claude-code` (subscription agent), `anthropic-api.claude-sonnet-…` (model) |
| **Adapter**              | How Nexar executes a resource                                                                  | `claude-code`, `codex`, `antigravity`, `pi`, `deepseek-harness`             |
| **Mode**                 | Owner-facing context                                                                           | Cowork, Code                                                                |
| **Orchestration engine** | How work is decomposed                                                                         | Cowork → OpenWorker; Code → DSH inside Nexar's engineering envelope         |

- A connection may yield many resources: an API key yields one model resource per catalog model.
- A resource records its connection (`metadata.connection: { provider, method, id }`) next to the
  existing fields. `kind.access` (`api | subscription | local`) and `auth.mode` stay authoritative
  for routing.
- Connection method is a **resource feature, not a separate router**.

### 3. Connection classes

| Method             | Execution                                                                                         | Authentication                                                           |
| ------------------ | ------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| `subscription`     | Native agent adapters only (Claude Code, Codex, Antigravity), through the vendor's official CLI   | Runtime-managed: the vendor's own login; Nexar probes status only        |
| `api`              | pi-ai (`model` resources); also configured into OpenWorker or DSH as their **control** model (§7) | Encrypted key store (ADR-022), resolved in the trusted host at call time |
| `local` / `custom` | pi-ai through OpenAI-compatible endpoints (Ollama, LM Studio, vLLM, custom)                       | None, or a key-store key                                                 |

A subscription option is shown only where an official runtime login exists. Unsupported routes are
shown as `unsupported` with a reason, never faked.

### 4. pi-ai and native adapters keep their roles

- pi-ai (ADR-003) is the direct multi-provider execution adapter for API and local or custom models.
  Its OAuth and subscription flows stay disabled.
- Native agents (ADR-011) are the only subscription-backed execution path.

### 5. Responsibility formula

```text
Operating Layer  = what kind of work is this? (intent, lane, policy, context)      ADR-024
OpenWorker / DSH = how is the work decomposed and orchestrated?                   ADR-026 / §8
NRC              = who executes each intelligence unit? (strategy + runtime)      ADR-005/020, §6
```

The NRC never decomposes work. Engines never choose among Nexar resources by themselves.

### 6. Two-stage resource intelligence

- **Stage 1, Resource Strategy Planner** (inside `@nexar/resource-controller`, pure and
  deterministic):
  - Input: a `WorkGraph` of work units. Each unit carries requirements (capabilities, quality class,
    access, cost sensitivity, review-of relations), plus the snapshot, history, constraints and owner
    policy.
  - Output: a `ResourceStrategy`, which is one planned `RouteDecision` (selected plus ranked
    alternatives plus reasons) per unit, plus plan-level reasons.
  - Plan-level factors that per-task routing cannot see:
    - review diversity decided upfront;
    - reservation of premium allowance for high-judgment units;
    - a cheaper or local resource for low-judgment units;
    - one budget across the whole plan;
    - balancing load across subscriptions.
  - It reuses `resource-intelligence@1` candidate evaluation. The hard filters are identical, and a
    plan factor can only reorder eligible candidates.
- **Stage 2, runtime revalidation.** Immediately before a unit executes, the NRC re-checks the
  planned resource: auth, availability, quota, cost, health and policy. If it fails, it falls to the
  next ranked alternative and records `strategy.fallback` with the reason. The runtime check can only
  narrow. It never selects a resource that the plan's hard filters rejected.
- **Dynamic engines.** OpenWorker decides its steps while running, so it has no upfront graph. For
  those, the planner keeps a **turn strategy ledger** (budget, reservations and diversity across the
  turn's units) and allocates each delegated unit as it arrives. The ledger gives units the same
  plan-level factors, but incrementally. A static plan, such as an engineering lane plan, is planned
  whole.
- An LLM may later propose unit requirements. It can never bypass hard filters, and routing works
  without one.

### 7. Orchestrator control resource versus worker resources

Every engine run separates two things:

- the **control resource**: the model driving the engine's own agent loop;
- the **worker resources**: the models or agents doing substantive units.

Both are Nexar-selected:

- **Control selection.** The NRC selects the control resource with the engine-compatibility filter
  `capability: agent-loop-control:<engine>`. Only connections the engine can use legitimately qualify:
  - **OpenWorker:** an `api` connection whose provider maps to an OpenWorker provider, or a
    `local`/`custom` endpoint (`ollama`, OpenAI-compatible `base_url`).
  - **DSH:** the pi-ai or DeepSeek route with an API key, or a local endpoint.
- **No subscription control.** No subscription can be a control resource: no official seam exists
  (Context).
- **Worker selection.** Worker units go through the Engine Resource Bridge (§9). There, any eligible
  resource, subscription agents included, can be selected.
- **When no control resource exists.** If the owner has no API or local control resource, the engine
  is unavailable. The lane falls back honestly (§12) to Nexar-native execution on the
  NRC-selected resource. The UI says why and how to enable the engine: add a local model (no cost) or
  an API key.
- **Pattern B deferred.** A Nexar loopback "model gateway" for engines is **not adopted**. It would
  need a listener and a security ADR (ADR-021 §network). It would not unlock subscriptions (no vendor
  allows it). It is a candidate only for keeping API keys out of engine processes later.

### 8. Engines

- **Cowork → OpenWorker** stays the primary Cowork engine:
  - OpenWorker contributes workflows, tools, files, MCP, approvals and artifact-oriented work.
  - Its control model is the NRC-selected control resource (§7).
  - Substantive steps are delegated to Nexar through the Engine Resource Bridge (NXR-059). This is how
    a Cowork turn uses the Claude or ChatGPT subscription.
- **Code → DSH inside Nexar's engineering envelope:**
  - Nexar's `EngineeringRunner` keeps ownership of everything that makes Code safe:
    - lane plans as the engineering work graph;
    - the WSL sandbox;
    - patch policy, gates, review and approval;
    - the local commit.
  - DSH becomes the **default orchestrator inside planning and write lanes** when a DSH control
    resource exists. It runs its agent loop in the lane's sandbox. It reaches worker resources only
    through a lane-scoped bridge, never through its own sub-agent provider registry (§9).
  - Until that bridge is proven (NXR-064), lanes run the NRC-selected native agent directly, as
    validated live in NXR-055. This is recorded as the lane's executor, not hidden.

### 9. Engine Resource Bridge

The Nexar-owned contract through which an engine requests intelligence:
`IntelligenceRequest → IntelligenceResult`.

- **Request:**
  - correlation lineage;
  - unit id and requirements (no vendor names);
  - an untrusted input payload, or document refs (references, not content, per ADR-017);
  - access (`read-only`, or scratch-only for drafts);
  - timeout and budget.
- **Result:**
  - text and draft refs;
  - `Measured` usage;
  - the `RouteDecision` id;
  - an error code.

Implementation rules:

- **One implementation, two transports.** It is implemented once in core: strategy ledger → NRC
  runtime check → adapter. It is exposed through:
  - **OpenWorker:** a turn-scoped stdio MCP entry (`nexar.intelligence_submit` and
    `nexar.intelligence_status`). Submit-and-poll fits OpenWorker's 120 s tool limit.
  - **DSH:** a lane-scoped channel (NXR-064 research decides between DSH's MCP client and an ACP
    extension). It has no network inside the sandbox.
- **Lineage.** Every request carries ADR-024 lineage: the same `rootSessionId`, `turnId` and
  `correlationId`, and `depth + 1`. With `MAX_DELEGATION_DEPTH = 2`, nexar → engine → nexar-child
  is the deepest chain. A child never calls an engine. A request whose chain already contains the
  target engine is refused (fail closed).
- **Identity.** Each request uses an ADR-015 client identity that is:
  - minted per turn (or per lane);
  - scoped to the bridge tools, the session's project, read-only or draft access and the turn's
    budget;
  - expired at turn end or after its TTL;
  - non-escalating.
- **What children can and cannot do.** Children create no conversation and no turn. They may not
  write projects, approve, commit, push or reach outward executors.

### 10. Security boundaries (unchanged invariants, restated)

- No credential extraction, no token copying, no subscription-as-API.
- No secret in config, renderer IPC, logs, telemetry or audit.
- No new network listener.
- Code writes only in the WSL2 bwrap sandbox, with no push and no native Windows write fallback.
- Outward actions require approvals. OpenWorker cannot self-approve; its permission requests are
  answered by Nexar policy (ADR-026 §3).
- Engines receive only:
  - **control:** the key of their selected control connection (OpenWorker: through its provider API
    at launch, as today; DSH: through its explicit environment);
  - **bridge:** their scoped token.
- Workers' credentials stay with the worker adapters.

### 11. Cost, allowance and owner policy

- **Cost classes.** Subscription resources use `CostClass: subscription-allowance` with unknown
  marginal cost, never `$0`. Allowance is `measured`, `estimated`, `owner-declared` or `unknown`
  (ADR-020 §4). Nothing is scraped.
- **Owner resource policy** is a generic contract and no vendor names are hard-coded. Its fields:
  - allowed lanes (Cowork, Code, scheduled);
  - preference tier (preferred, normal, fallback);
  - prefer-subscription;
  - privacy permission;
  - reservations: reserve headroom for named unit classes.
- **Auto is the default.** Optional overrides: prefer subscriptions, prefer local, a provider only,
  or a custom preference.

### 12. Fallback

A requested lane whose engine is unavailable (no engine, no control resource, version mismatch)
runs `direct`:

- It still routes intelligence through the NRC.
- `fallbackReason` is recorded (`openworker-unavailable`, `dsh-control-unavailable`).
- The UI shows it.
- No engine is claimed to have run.

### 13. Telemetry and history

Strategy decisions, runtime revalidations and bridge executions emit structured records: ids,
resource ids, reason codes, `Measured` usage, durations and outcomes. They never carry prompts,
documents or code. The v0.4 history readers feed the planner. Learning stays out of scope;
everything is deterministic and explainable.

### 14. Live validation strategy

Acceptance is proven offline first, with fakes for native agents, pi, OpenWorker and DSH. Then a
small owner live run per area:

- **Cowork:** one turn where OpenWorker (local or API control) delegates at least one substantive
  unit to a subscription agent, and Nexar saves the artifact.
- **Code regression:** one change where the plan-level strategy picks a subscription agent for
  `feature` and a different resource for `review`.
- **Integrated:** the three-turn Operating Layer flow.

## Consequences

- **Cowork turns.** Cowork can use subscriptions for substantive work. OpenWorker still needs a
  local or API control model. The owner is told this plainly, with "add a local model (free)" as the
  zero-cost path.
- **Code engine.** DSH becomes the Code engine without weakening any NXR-055 control. Until NXR-064
  lands, Code honestly runs native-agent lanes.
- **Planner placement.** The NRC gains a planner, not a second orchestrator. `deterministic@1`
  stays byte-for-byte unchanged.
- **Desktop default.** Desktop's first run no longer makes the echo test double the default resource
  (NXR-060).
- **Rejected alternatives:**
  - OpenWorker's `openai-codex` (emulated first-party OAuth).
  - DSH sub-agent providers on vendor SDK logins as a Nexar-selected route.
  - A loopback model gateway (Pattern B).
  - An LLM router that can bypass hard filters.
