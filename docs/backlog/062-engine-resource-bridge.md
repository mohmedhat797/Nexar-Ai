# NXR-062: Engine Resource Bridge

**Milestone:** v0.6 — Resource orchestration · **Labels:** operating-layer, routing, security · **Depends on:** NXR-061 · **ADR:** [ADR-027](../adr/027-resource-orchestration-architecture.md) ([plan](../architecture/resource-orchestration-plan.md))

## Objective

One Nexar-owned contract through which engines request intelligence units.

## Problem

There is no engine-agnostic way for OpenWorker or DSH to ask Nexar for a resource-executed unit.

## Scope

- `IntelligenceRequest`/`IntelligenceResult` contracts (bounded, untrusted input, document refs, access read-only|draft, `Measured` usage, decision id).
- Core service: ledger allocation → revalidation → child task (`childTask`) → adapter with draft-only workspace → telemetry (ids, codes, usage; no content).
- Cancellation, timeout and budget enforcement.

## Acceptance criteria

- [ ] Fake resources (native, pi faux, local) execute units; lineage, budget, cancellation and telemetry assertions.

## Security considerations

No new listener; credentials stay in worker adapters; children cannot write projects or reach outward executors.
