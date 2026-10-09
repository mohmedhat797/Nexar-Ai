# ADR-020: Resource Intelligence — an explainable, quota- and cost-aware scheduler

**Status:** Accepted (2026-10-01) · Issues: #18 (NXR-030), #19 (NXR-031), #20 (NXR-032), #28 (NXR-034),
#21 (NXR-033) · Builds on ADR-005 (Resource Controller ownership), ADR-007 (AI resource abstraction),
ADR-019 (engineering lanes) · Evidence: [`docs/research/upstream/v0.4/`](../research/upstream/v0.4/)

## Context

`deterministic@1` answers _which resources are eligible_ and orders them by fixed preference tiers.
v0.4 must also answer _which eligible resource to spend now, and why_. It has to account for quota
and allowance, expected cash cost, recent performance and engineering-lane outcomes.

Several constraints shape the design:

- **Quota visibility is limited.** Most subscription runtimes expose no supported allowance
  interface (see the v0.4 research note). Nexar must not scrape vendor dashboards, read credentials
  or infer limits.
- **Cost estimates are not bills.** The routing policy must never see prompt content.
- **Routing must stay reproducible.** It has to remain pure, deterministic and versioned, so a
  decision can be reproduced from telemetry.
- **Security comes first.** No score may relax a security control (ADR-018/019).

## Decision

### 1. Pipeline: hard filters, then soft scoring

```text
task ─► facts (size estimate, lane role, now) ─┐
registry snapshot (descriptor + state + quota) ├─► HARD FILTERS ─► eligible set ─► SCORING ─► ranking
routing history (aggregates, read outside) ────┘        │                                       │
                                                  rejected + reasons                 factor breakdown
```

- **Hard filters are pure predicates that reject.** They cover:
  - excluded resource
  - missing capability
  - availability `unavailable`
  - unauthenticated
  - privacy (`local-only` versus third-party)
  - context window
  - quota exhausted
  - reservation protected
  - strict-quota unknown
  - cost exceeds `maxCostUsd`
  - cost not estimable under a strict budget
  - review diversity (supplied by the engineering runner through `excludedResourceIds`, as today)

  Sandbox requirements, patch policy, gates, approval and commit ownership remain enforced by
  adapters and the engineering runner, outside routing. Routing can only _narrow_ choices; it can
  never authorize.

- **Scoring sees only the eligible set.** A score can reorder eligible resources. It can never
  re-admit a rejected one. Invariant tests enforce this.

### 2. Purity and inputs

`RoutingPolicy.evaluate(input)` stays a pure function. The controller assembles everything else
before calling it:

- **`input.facts.size`:** a `TaskSizeEstimate`. Estimated input tokens are `ceil(chars / 4)` of the
  prompt plus the system prompt. It also carries attachment count, document count and requested
  output tokens. The prompt itself never reaches the policy.
- **`input.facts.laneRole`:** the engineering lane role taken from validated task metadata (one of
  `architecture | feature | tests | debugging | review`).
- **`input.facts.now`:** the injected clock.
- **`input.history`:** a `RoutingHistory` of aggregates computed by history readers _outside_ the
  policy (§7). The policy never opens files.

The same inputs and the same history always produce the same output.

### 3. Static descriptor versus dynamic state

The split stays as it was: the descriptor is configured or discovered, and the state is probed.
Quota is dynamic state, kept in `ResourceState.quotas` as a list of `QuotaObservation`s (one
resource can have several windows, for example a 5-hour window and a weekly window).

### 4. Quota semantics (NXR-030)

A `QuotaObservation` has:

- `unit`: `requests | tokens | usd | percent`
- `limit?`, `used?`, `remaining?`
- `window?`: `daily | weekly | monthly | { hours }`, or an explicit `resetsAt`
- `observedAt`
- `provenance`: `{ limit: vendor-probe | vendor-reported | owner-declared, usage: vendor-probe | vendor-reported | nexar-accounting }`
- `unaccountedRuns`: runs whose usage was `unavailable`

**Sources.** Only these are allowed:

1. **Vendor probe.** A documented, free, non-secret status interface, verified per runtime. The v0.4
   research found **none that qualifies** for Claude Code, Codex, Antigravity or DSH:
   - Codex's `account/rateLimits/read` is on the app-server surface that OpenAI marks experimental
     and not for production.
   - Antigravity's `-p "/quota"` has an unverified shape and needs a `-p` invocation.

   Both are recorded as candidates for a later, owner-tested change. No vendor probe ships in v0.4.

2. **Vendor-reported during a run.** These are allowance signals that a runtime emits on a call
   Nexar already makes, through a documented interface:
   - Claude Code's `rate_limit_event` (`status`, `resetsAt`, `utilization`) in stream-json;
   - any adapter's `QUOTA_EXHAUSTED` failure, recorded as an exhausted observation until its
     reset, or for a default hold of 1 h when no reset is reported.

   Adapters return them on the result. The engine records them as `quota.observed` telemetry,
   and the next routing decision reads them back.

3. **Nexar accounting.** Consumption is summed from measured `ExecutionRecord` usage inside the
   current window. A run with `unavailable` usage is counted in `unaccountedRuns`; it is never
   counted as 0.
4. **Owner declaration.** The owner sets a limit, unit and window in config.

Anything else is `unknown`. Unknown is a first-class state. It is never treated as infinite and
never as zero.

**Freshness.** Freshness is computed by the policy from `now`:

| State           | When                                                                                                                                  |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `exhausted`     | `remaining <= 0` (or `used >= limit`) and the window has not reset                                                                    |
| `known-current` | observed within the source's staleness bound, which defaults to 15 min for vendor probes; Nexar accounting is recomputed per decision |
| `known-stale`   | older than that bound and the window has not reset; scored as unknown, but an exhausted value still rejects until `resetsAt`          |
| `unknown`       | no observation, or the reset time has passed since the observation                                                                    |

**Headroom.** Headroom is `remaining / limit`. With several observations, the minimum wins.

**Unknown quota policy.** The default is to allow the resource with an uncertainty reason
(`quota.unknown`) and give the quota factor the configurable neutral value `unknownQuotaScore`
(default `0.5`). A task or task kind can require known quota (`requireKnownQuota`). In that case an
unknown or stale quota is a hard rejection (`quota.unknown-strict`).

**Reservation.** Reservations are configuration only and never hard-coded per vendor:

```json
{
  "resourceId": "claude-code",
  "reserveFraction": 0.3,
  "reservedFor": { "taskKinds": ["review"], "laneRoles": ["review", "architecture"] }
}
```

If headroom is known-current and at or below `reserveFraction`, and the task is not covered by
`reservedFor`, the candidate is rejected with `quota.reserved`. The explanation states the headroom
and the protected share. If quota is unknown, the reservation cannot be verified: the reason
`quota.reservation-unverifiable` is recorded and the unknown-quota policy applies.

### 5. Cost semantics (NXR-031)

A pure estimator maps (`CostProfile`, `TaskSizeEstimate`) to a `CostEstimate`. Its `class` is one of:

| `class`                  | `cashUsd`                                                                   |
| ------------------------ | --------------------------------------------------------------------------- |
| `cash`                   | `estimated` from `(in × inRate + out × outRate) / 1e6`, with a basis string |
| `subscription-allowance` | `estimated 0` with basis "marginal cash; consumes subscription allowance"   |
| `local-compute`          | `estimated 0`, basis "local compute"                                        |
| `free`                   | `estimated 0`, basis "free resource"                                        |
| `unknown`                | `unavailable` (never a fabricated 0)                                        |

- **Output tokens** come from `requestedMaxOutputTokens`. If that is absent, they come from
  `routing.cost.defaultOutputTokens` (default 4096), capped at the resource's `maxOutputTokens`.
- **Enforcement.**
  - `cashUsd > maxCostUsd` rejects with `cost.exceeds-limit`. The estimate, the limit and the basis
    are in the reason detail.
  - If `maxCostUsd` is set and the class is `unknown`, the candidate is rejected with
    `cost.not-estimable`, unless `routing.cost.unknownUnderLimit: "allow"`. Fail closed is the
    default.
- **Labelling.** Catalog rates (pi-ai) are labelled `catalog` in the basis.
  - A catalog price of `0` for input _and_ output means "free, unknown or plan-billed" in pi-ai,
    so it is class `unknown` unless the owner declares the resource `free`.
  - Peak-rate catalogs make estimates an upper bound for providers with off-peak discounts
    (DeepSeek).
  - The estimator version (`estimator@1`) is recorded.
- **Execution-time budget.** The budget is passed through only where a runtime documents a budget
  flag. Only Claude Code has one, `--max-budget-usd` (an estimated-cost ceiling). Codex,
  Antigravity and DSH document none. The routing estimate stays the pre-execution safety layer
  everywhere.
- **Estimate versus actual.** After execution, `ExecutionRecord.costEstimate` records the
  estimate, the measured actual (when it exists), the absolute error, the relative error (when the
  actual is above 0) and the estimator version. This is for observability only; Nexar does not
  learn prices.

### 6. Scoring (NXR-032, NXR-034)

There is a new policy, `resource-intelligence@1`. `deterministic@1` stays unchanged for
compatibility and remains the default until the owner selects the new policy in config.

**Ranking key.** Ranking compares three things in order:

1. **Owner preference tier (authoritative).** The task's `preferredResourceIds` give tier 3, a lane
   or task-kind preference gives tier 2, and no explicit preference gives tier 1.
2. **Weighted score**, rounded to 6 decimals.
3. **Resource id** (ascending) as the final tie-breaker.

Owner preferences therefore always beat learned signals, unless the owner sets
`routing.preferences: "weighted"`, which turns the tier into a factor instead.

**Factors.** Each factor `f ∈ [0, 1]` is clamped. Weights come from `routing.weights`, are
non-negative and are recorded in the decision.

| Factor                    | Value                                                                                                                         | Neutral at cold start |
| ------------------------- | ----------------------------------------------------------------------------------------------------------------------------- | --------------------- |
| `default`                 | 1 if this is `defaultResourceId`, otherwise 0                                                                                 | —                     |
| `availability`            | available 1 · degraded 0.5 · unknown 0.5                                                                                      | —                     |
| `auth`                    | ok 1 · unknown 0.5                                                                                                            | —                     |
| `quota`                   | known headroom; unknown or stale → `unknownQuotaScore`                                                                        | —                     |
| `cost`                    | cash: `1 / (1 + cashUsd / costScaleUsd)` · subscription `subscriptionCostScore` (default 0.9) · local or free 1 · unknown 0.5 | —                     |
| `latency`                 | `1 / (1 + p50 / latencyScaleMs)` from history                                                                                 | 0.5                   |
| `success`                 | Laplace-smoothed resource-fault success rate `(s + 1) / (n + 2)` from history                                                 | 0.5                   |
| `lane` (engineering only) | role-specific signal (§8)                                                                                                     | 0.5                   |

The score is `Σ wᵢ · fᵢ`. Every contribution is reported. A
configuration snapshot id (the first 12 hex characters of the sha256 of the canonical routing
config) is recorded with the policy name and version.

**Cold start.** Below `history.minSamples` (default 5), the history factors use the neutral value.
With uniform quota, cost and history, the ranking reduces to deterministic@1's ordering:
preference tier, then default resource, then availability, then id. Tests cover this.

### 7. History (NXR-032)

History readers sit outside the policy and produce `RoutingHistory`:

- **Execution history** comes from telemetry `execution.finished` records. Aggregates are kept per
  (resource, task kind) inside a configurable window (`history.windowDays`, default 30): `samples`,
  `resourceFaults`, `successes`, `timeouts`, p50 and p95 latency, and average measured cost (only
  measured values count).
- **Fault classification** decides what counts against a resource:
  - **Resource faults:** `PROVIDER_ERROR`, `EXECUTION_TIMEOUT`, `RESOURCE_UNAVAILABLE`,
    `QUOTA_EXHAUSTED`, `INTEGRATION_UNAVAILABLE`, `AUTH_REQUIRED` and `INTERNAL_ERROR`.
  - **Caller and policy outcomes, excluded:** `VALIDATION_ERROR`, `POLICY_REJECTED`,
    `CONFIGURATION_ERROR`, `APPROVAL_DENIED`, `SANDBOX_UNAVAILABLE` and caller cancellation.
- **Poisoned-history defence.** History files are untrusted:
  - only the last 8 MiB of a file and at most 50 000 lines are read;
  - malformed and unknown-schema lines are skipped;
  - numbers are clamped (latency between 0 and 24 h, tokens and cost non-negative and finite);
  - nothing is executed or evaluated;
  - no prompt fields exist to read.

### 8. Engineering signals (NXR-034)

These are read from `.nexar/engineering/*/record.json` (bounded, same defences). They are kept per
(resource, lane role), and implementer and reviewer quality stay separate:

- **Implementer roles (`feature`, `tests`, `debugging`):**
  - first-round gate pass rate
  - rework rounds per task
  - share of the implementer's work that the review approved
  - owner approval rate (decided approvals only; `not-required` is excluded)
  - latency

  In a multi-lane round, outcomes are attributed to every read-write lane resource of that round.

- **Reviewer role (`review`):**
  - verdict validity rate (parseable, consistent verdicts)
  - latency

  A reviewer's `request-changes` verdict counts against the _implementer_, never against the
  reviewer.

Defaults combine the implementer signals into `lane = mean(gatePassRate, 1 − min(rework, 3)/3,
reviewApproveRate, ownerApprovalRate)` over the available signals, and the reviewer signals into
`lane = validVerdictRate`. Below `minSamples`, the value is neutral.

### 9. Discovery (NXR-033)

- **Discovery finds candidates; probes decide usability.** A discovered resource starts as
  `unknown` and is never `authenticated` until its adapter probe says so.
- **Sources live in their integrations (ADR-008):**
  - **pi catalog** (`integrations/pi`): needs a provider allowlist, and rates are labelled
    `catalog`.
  - **Installed CLIs:** each native integration detects its own binary on `PATH` (a `stat` only;
    the existing probe runs `--version` and the status command).
  - **Owner-configured local endpoints** (`integrations/pi`; Ollama `GET /api/tags` or
    OpenAI-compatible `GET /v1/models`): loopback or owner-listed hosts only, with a bounded
    response and no LAN scanning.
- **Merge order is deterministic:** discovered descriptor, then config overrides, then the
  effective resource. On an id collision, config wins. Owners can disable any source and exclude
  discovered ids.
- **Provenance** (`configured | discovered:<source>`) appears in `nexar resources`.
- **Caching.** Results are cached with a refresh interval and the injected clock. A failing source
  is recorded and skipped; it never breaks the registry.

### 10. Explanations

Each `CandidateAssessment` gains optional structured fields. Existing `reasons` stay.

- `quota`: freshness, headroom and source
- `cost`: class, estimate and basis
- `factors`: name, value, weight and contribution
- `tier`

`RouteDecision.policy` gains `configId` and `fallback?`. `nexar route` stays concise. `nexar route
--explain` prints the full breakdown for every candidate.

### 11. Fallback

If `resource-intelligence@1` throws, the controller uses `deterministic@1` ranking **over the
result of the same hard-filter stage**. It records `policy.fallback = { from:
"resource-intelligence@1", reason: <error code> }` and logs at warn. Fallback never bypasses any
hard filter, and it never happens silently.

### 12. Telemetry versus audit

Routing intelligence is performance telemetry. It travels in `route.decided` (structured fields
above) and in `execution.finished` (`costEstimate`). It never includes prompts, code, documents,
credentials or account identifiers. The security audit (ADR-015) is unchanged.

## Consequences

- Owners get honest uncertainty. "Quota unknown (no supported source)" is a normal answer.
- Config grows a `routing.resourceIntelligence` block covering weights, history, quota, cost,
  reservations and allowances. Absent config keeps v0.3 behaviour.
- Every new reason code is stable and documented, so it can serve as a feature for any future
  learned policy. v0.4 adds no machine learning.

## Alternatives considered

- **ML or bandit routing:** rejected for v0.4; it is not explainable or reproducible, and there is
  too little data.
- **Treating unknown quota as available, or as exhausted:** rejected; both are dishonest.
- **Letting history override owner preferences by default:** rejected; the owner stays
  authoritative.
- **Reading vendor dashboards or tokens for quota:** rejected; it is forbidden and unsafe.

## Risks

- Owner-declared allowances can drift from the vendor's real limits. They are labelled
  `owner-declared`.
- Token estimation by characters ÷ 4 is approximate. It is labelled `estimated` with a basis.
- Sparse history keeps factors neutral for a long time. This is intended.

## Implementation notes (v0.4, 2026-10-01)

These record how the build resolved details the decision above left open. None changes a decision.

- **Lane preferences are tier 3.** The engineering runner passes `lanePreferences` as task
  `preferredResourceIds`, so they rank with task preferences (tier 3). Task-kind preferences are tier 2. Inside a tier, the owner's list order decides before any score.
- **`preferences: "weighted"`** sets every tier to 1 and turns the `default` factor into a preference
  value (task 1, task kind 0.75, default resource 0.5, none 0), so strong history can outrank a weak
  preference.
- **The `lane` factor appears only when the task carries a lane role.** Without one it is omitted, so
  it never shifts non-engineering scores.
- **Latency percentiles use successful runs only.** A fast failure must not look like good latency.
  Timeouts count as resource faults.
- **Fallback stamp.** The fallback decision is stamped `deterministic@1` with
  `fallback: { from: "resource-intelligence@1", reason: <code> }` and keeps the original `configId`.
  It is implemented as an optional `evaluateFallback` on the policy, so the hard-filter stage is
  shared code, not a copy.
- **Discovery plumbing.** The `DiscoverySource` port lives in `@nexar/contracts`. `PATH` lookup and
  the merge and cache live in `@nexar/resource-registry`, and each CLI integration supplies its own
  binary name and descriptor. Discovered ids cannot be referenced from routing rules in v0.4; owners
  add a config entry instead. Discovery is off for routing by default; `nexar resources --discovered`
  always shows it.
- **Allowance accounting needs a telemetry file.** Without `telemetry.jsonlPath`, declared allowances
  stay `unknown`, never "0 used".
- **Per-task flags.** `--max-cost` and `--require-known-quota` on `nexar route` and `nexar run` set
  `maxCostUsd` and `requireKnownQuota`.

## Amendment (2026-10-04): resource orchestration

`resource-intelligence@1` hard filters and factors are reused unchanged by the plan-level
planner `strategy@1` ([ADR-027](027-resource-orchestration-architecture.md) §10); plan factors (diversity, reservation, budget, quality fit,
balance) only reorder eligible candidates. `deterministic@1` is unchanged.
