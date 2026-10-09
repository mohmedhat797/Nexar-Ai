# NXR-062: Nexar Engine Gateway: Control Model Gateway and Intelligence Execution Bridge

**Milestone:** v0.6 — Resource orchestration · **Labels:** operating-layer, routing, security · **Depends on:** NXR-061 · **ADR:** [ADR-027](../adr/027-resource-orchestration-architecture.md) ([plan](../architecture/resource-orchestration-plan.md))

## Objective

The common Nexar foundation through which engines (A) drive their own model loop and (B) execute bounded work units, both on Nexar-owned resources.

## Problem

Engines either hold their own provider (OpenWorker) or are hard-wired to one (DSH); there is no Nexar contract for either purpose.

## Scope

- Shared: lineage (`childTask`, depth ≤ 2, re-entry refused), ADR-015 turn/lane-scoped identity, budget, cancellation, timeout, telemetry (ids, codes, `Measured`).
- A — `ControlTurnRequest`/`ControlTurnResult`; `selectControl(engine, mode, policy)` (Auto via NRC over `ENGINE_CONTROL_REQUIREMENTS`, or owner-pinned with `fallback: auto|none`); pin per engine turn with `controlDecisionId`; `ModelTurnPort` implemented first by pi-ai (messages, tools, streaming, usage); opaque `extras` scoped to the decision; bounded retry, `control-resource-failed`, restart-from-canonical-history fallback, never mid-loop switching.
- B — `IntelligenceRequest`/`IntelligenceResult`; ledger allocation → revalidation → child task → work adapter with draft-only workspace.
- Config: `orchestration.<mode>.controlResource` and `resourcePolicy.experimental` (default disabled).

## Acceptance criteria

- [ ] A: provider-agnostic turn, tool-call normalization, streaming, extras round-trip only on the same resource, pinning, fallback/restart, cancellation, timeout, unsupported-resource rejection, experimental gate, no secret in the engine view.
- [ ] B: identity, scope widening, depth, budget, cancel propagation, timeout, draft-only boundary, strategy + revalidation, telemetry.

## Security considerations

No new listener in this unit; credentials stay in adapters/main; engines see turns, results and usage only.
