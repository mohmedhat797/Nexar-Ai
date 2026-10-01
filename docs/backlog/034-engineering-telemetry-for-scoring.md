# NXR-034: Engineering lane outcomes as scoring input

**Milestone:** v0.4 · **Labels:** resource-controller, telemetry · **Depends on:** [NXR-032](032-history-scoring-routing-policy.md)

**Status:** not implemented in v0.3. v0.3 records the data; it does not use it.

## Summary

Feed per-lane engineering outcomes into the scoring routing policy, so the Resource Controller can
prefer resources that implement and review well for a given kind of work.

## Problem

[ADR-019](../adr/019-engineering-lanes-and-resources.md) section 10 records, for every engineering
task, the data v0.4 scoring needs: the resource per lane, usage as `Measured`, gate results, review
verdict and finding counts, the approval decision and the commit. Nothing reads it. Routing in v0.3 is
the deterministic policy plus owner preferences (`preferredResourceIds`).

## Objective

A documented, explainable mapping from engineering records to routing signals, behind the v0.4 scoring
policy, with the reason codes visible in each `RouteDecision`.

## Scope

- A reader over `.nexar/engineering/<task>/record.json` and telemetry events (`engineering.lane.completed`, `engineering.gate.completed`, `engineering.review.completed`, `engineering.commit.created`).
- Per-resource, per-lane-role signals: gate pass rate after the first round, rework rounds, review verdicts, owner approval rate, latency, usage (only measured values; never treat `unavailable` as `0`).
- Minimum-sample rules so a single run cannot dominate; stale data decays or is windowed.
- New reason codes for the score components, shown by `nexar route`.
- Treat the reviewer's verdict about the implementer and gates separately from the reviewer's own quality.

## Out of scope

- Machine learning, cost estimation ([NXR-031](031-pre-execution-cost-estimation.md)) and quota tracking ([NXR-030](030-quota-and-allowance-tracking.md)), which are separate items.
- Changing review diversity or approval rules: scoring never relaxes a security control.

## Technical notes

- Records contain ids, counts and hashes only, so signals must be computable without prompts, diffs or paths.
- Owner preferences keep precedence over learned scores unless the owner opts in.

## Acceptance criteria

- [ ] Given recorded outcomes, the policy ranks eligible resources deterministically and explains why.
- [ ] Missing or unavailable usage never counts as zero.
- [ ] Scoring cannot select a resource that is ineligible by capability, privacy or review diversity.

## Testing expectations

Fixture records and a fake clock; no live calls.

## Security considerations

Scores are advisory routing input. They must not weaken the sandbox, patch policy, gates or approval.
