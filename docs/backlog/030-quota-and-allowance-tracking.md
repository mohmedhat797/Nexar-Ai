# NXR-030: Quota and subscription-allowance tracking with reservation policy

**Milestone:** v0.4 — Resource Intelligence · **Labels:** resource-controller · **Depends on:** none

## Summary

Populate `ResourceState.quota` with real allowance data (remaining, limit, reset time) and let the
routing policy reserve scarce allowance, such as premium subscription headroom, for high-judgment tasks.

## Problem

`QuotaState` exists in [`@nexar/contracts`](../../packages/contracts/src/resource.ts) (`unit`, `remaining`,
`limit`, `resetsAt`) but nothing fills it, and the `deterministic@1` policy ignores it. The owner has
subscriptions and capped API budgets; without tracking, Nexar can burn a scarce allowance on trivial
tasks or route to a resource that is exhausted ([ADR-005](../adr/005-resource-controller-ownership.md) follow-up).

## Objective

The NRC knows how much allowance each resource has left and when it resets, rejects exhausted
resources with a reason code, and can hold back headroom by configured rules.

## Scope

- Quota sources in the registry: (a) adapter probes that report quota when the runtime exposes it without a paid call, (b) Nexar-side accounting from `ExecutionRecord` usage, (c) owner-declared limits in config.
- Reset handling: `resetsAt` windows (daily/weekly/monthly) and expiry of stale observations.
- Policy: reject when `remaining` is exhausted (`quota.exhausted`), plus reservation rules, for example "keep 30% of resource X for tasks of kind Y".
- Reason codes for every quota-driven outcome; explanation text in `RouteDecision`.
- CLI: `nexar resources` shows quota and reset time.

## Out of scope

- Cost estimation before execution ([NXR-031](031-pre-execution-cost-estimation.md)).
- History-based scoring ([NXR-032](032-history-scoring-routing-policy.md)).
- Scraping vendor dashboards or reading runtimes' credential files.

## Technical notes

- Registry holds state only; reservation logic belongs in the policy, which stays pure and deterministic
  (`RoutingPolicy.evaluate`). Quota is read from `ResourceSnapshot.state.quota`.
- Quota accounting from telemetry uses `Measured<T>`: do not treat `unavailable` usage as `0`; count it as "unknown consumption" and surface that.
- Whether Claude Code, Codex or DSH expose allowance through a supported, free command is unverified:
  investigate per runtime and record findings; only use supported CLIs/SDKs.
- Policy version must be bumped (`deterministic@2` or a new policy name) so decisions stay reproducible from telemetry.
- `NexarError` code `QUOTA_EXHAUSTED` already exists for execution-time failures.

## Acceptance criteria

- [x] Quota is stored in `ResourceState` from at least one real source and from config-declared limits.
- [x] An exhausted resource is rejected with a documented reason code and human text.
- [x] A reservation rule keeps headroom for a configured task kind and is visible in the decision.
- [x] Stale or unknown quota does not silently count as available or exhausted; behavior is documented.
- [x] Policy output stays pure: same inputs give the same decision.

## Testing expectations

Offline policy tests with synthetic snapshots (exhausted, near limit, reset passed, unknown, reservation) and
registry tests with an injected clock. No live tests except opt-in checks of real probe quota.

## Security considerations

Do not read runtime credential stores to obtain quota. Probes must not make paid calls. Quota data
is metadata and must not include tokens or account identifiers in logs.
