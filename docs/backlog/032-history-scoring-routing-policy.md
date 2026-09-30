# NXR-032: Scoring routing policy using telemetry history

**Milestone:** v0.4 — Resource Intelligence · **Labels:** resource-controller, telemetry · **Depends on:** NXR-030, NXR-031

## Summary

Add a routing policy that scores candidates using historical success rate, latency and cost from
telemetry, while keeping every decision explainable and reproducible.

## Problem

The `deterministic@1` policy uses fixed preference tiers. Nexar records an `ExecutionRecord` for every
run (outcome, latency, usage, error category), but nothing consumes it. [ADR-005](../adr/005-resource-controller-ownership.md)
and the [roadmap](../roadmap/ROADMAP.md) call for history-aware scoring, with no ML until data justifies it.

## Objective

A new `RoutingPolicy` implementation that ranks eligible resources by a transparent weighted score
built from recent history, selectable by config, with per-factor reasons in the decision.

## Scope

- A history reader over telemetry (JSONL sink first) producing per-(resource, task kind) aggregates over a configurable window: success rate, p50/p95 latency, average cost, sample count.
- Scoring: weighted sum of normalized factors; weights in config; minimum-sample threshold below which the factor is neutral (cold start).
- Hard filters stay as today (capability, availability, auth, privacy, context, quota, cost limit).
- Each factor emits a `RouteReason` with its value and contribution; `RouteDecision.policy` records name and version.
- Deterministic tie-break by resource id; injected clock for windows.
- CLI: `nexar route --explain` shows the factor breakdown.

## Out of scope

- Machine-learned ranking, exploration/bandit strategies, quality grading of outputs.
- Changing quota/cost logic (NXR-030/031) beyond consuming their outputs.
- Remote or shared telemetry.

## Technical notes

- `RoutingPolicy.evaluate` must be pure ([`routing.ts`](../../packages/contracts/src/routing.ts)): the history is passed in as data, not read inside the policy. Extend `RoutingInput` or add a
  separate `RoutingHistory` input; keep the task payload out.
- Aggregates exclude `unavailable` usage from cost averages instead of treating them as `0` (`Measured<T>`).
- Failed runs are classified by error category from the record: distinguish resource faults (`PROVIDER_ERROR`) from caller faults (`VALIDATION_ERROR`) so they do not penalize unfairly.
- Telemetry lives in `.nexar/telemetry.jsonl`; reading must tolerate malformed lines and schema versions.
- Reason codes become features for any future learned policy; keep them stable and documented.

## Acceptance criteria

- [ ] The policy selects differently from `deterministic@1` when history clearly favors another resource.
- [ ] With no history the result matches the deterministic ordering (documented).
- [ ] Every decision lists each factor's value, weight and contribution.
- [ ] Same inputs and history produce the same decision (pure, deterministic).
- [ ] Malformed or old-schema telemetry lines are skipped without failure.

## Testing expectations

Offline policy tests with synthetic history (cold start, strong winner, latency vs cost trade-off, recent
failures) and reader tests over fixture JSONL. No live tests.

## Security considerations

Telemetry holds metadata only; the history reader must not read or log prompt text. Keep files 0600.
Protect against a poisoned history file (bounded size, clamped values).
