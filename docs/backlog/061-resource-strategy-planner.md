# NXR-061: Resource Strategy Planner (`strategy@1`)

**Milestone:** v0.6 — Resource orchestration · **Labels:** resource-intelligence, routing · **Depends on:** NXR-060 · **ADR:** [ADR-027](../adr/027-resource-orchestration-architecture.md) ([plan](../architecture/resource-orchestration-plan.md))

## Objective

Allocate resources across a whole work graph (plan-level), then revalidate each unit at run time.

## Problem

Routing is per task: review diversity, reservations and budget are decided reactively per lane, never for the plan.

## Scope

- `WorkGraph`, `ResourceStrategy` (reusing `RouteDecision`), optional `qualityClass`.
- Pure `planStrategy` reusing `resource-intelligence@1` hard filters; plan factors diversity, reservation, budget, quality fit, balance.
- Turn ledger `allocateNext` for dynamic engines; Stage 2 `revalidate` with ranked-alternative fallback (`strategy.fallback`).
- `EngineeringRunner` plans the lane plan upfront; lanes revalidate before they run.

## Acceptance criteria

- [ ] Seeded invariants: never re-admits a rejected candidate; deterministic; review unit avoids the implementer under `required`; reservations hold for `high` units.
- [ ] Code fake-plane E2E shows the planned strategy per lane.

## Security considerations

Planner is pure (no IO, no prompt); `deterministic@1` byte-for-byte unchanged.
