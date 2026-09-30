# NXR-031: Pre-execution cost estimation and `maxCostUsd` enforcement

**Milestone:** v0.4 — Resource Intelligence · **Labels:** resource-controller · **Depends on:** none

## Summary

Estimate a task's cost before execution and reject resources that would exceed `requirements.maxCostUsd`,
replacing today's neutral `cost.not-evaluated` reason.

## Problem

`TaskRequirements.maxCostUsd` exists in [`@nexar/contracts`](../../packages/contracts/src/task.ts), but the v0.1
policy only emits reason `cost.not-evaluated`; the limit is not enforced. Owners cannot cap spend per task,
and cost-aware routing ([ADR-005](../adr/005-resource-controller-ownership.md)) has no input.

## Objective

Routing computes an explicit, labeled cost estimate per candidate and honors `maxCostUsd`, while being
honest about estimate quality.

## Scope

- A cost estimator: input tokens (from prompt/attachments size), expected output tokens (from `limits.maxOutputTokens` or a configured default), and the resource's `CostProfile`.
- Per-profile rules: `per-token` → computed USD; `subscription`, `local-compute`, `free` → zero marginal cash cost but flagged; `unknown` → not estimable.
- Decision reasons: `cost.within-limit`, `cost.exceeds-limit`, `cost.not-estimable`, each carrying the estimate and its basis.
- Policy for not-estimable when `maxCostUsd` is set: configurable reject or allow-with-warning; default reject.
- Execution-time guard: pass a budget to adapters that support it (for example Claude Code or relay `--max-budget-usd`; verify per runtime).
- Compare estimates with actual `ExecutionRecord` cost and log the error.

## Out of scope

- Quota and allowance ([NXR-030](030-quota-and-allowance-tracking.md)); learning from history ([NXR-032](032-history-scoring-routing-policy.md)).
- Billing reconciliation with provider invoices.
- Precise tokenization per model (a documented approximation is acceptable).

## Technical notes

- `RoutingInput` currently excludes the task payload (id, kind, requirements only), so the estimator needs a
  new `estimatedInputTokens` (or similar) passed in, without leaking prompts into the policy. Design this in an ADR note.
- Use `Measured<number>` with the `estimated` variant and a basis string; never return a fabricated `0` for unknown.
- pi-ai cost figures are catalog-estimated, not a bill ([ADR-003](../adr/003-pi-ai-multi-provider-layer.md)); label them so.
- Policy must stay pure and deterministic; bump the policy version.

## Acceptance criteria

- [ ] `cost.not-evaluated` is no longer emitted when an estimate is possible.
- [ ] A candidate exceeding `maxCostUsd` is rejected with `cost.exceeds-limit` and the numbers in the explanation.
- [ ] Unknown-cost resources follow the documented not-estimable policy.
- [ ] Estimates are labeled `estimated` with a basis, and the prompt text never enters the policy.
- [ ] Estimate vs actual cost is recorded in telemetry.

## Testing expectations

Offline policy and estimator tests with table-driven cases per `CostProfile`, boundary values and missing
limits. No live tests; any opt-in live check only compares real vs estimated cost.

## Security considerations

Prompt content must not be logged or sent to the policy, only its size. Budget caps are a safety
control, so fail closed when `maxCostUsd` is set and cost is unknowable.
