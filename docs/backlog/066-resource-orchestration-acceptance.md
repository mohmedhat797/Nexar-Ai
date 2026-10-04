# NXR-066: Resource orchestration E2E and live acceptance

**Milestone:** v0.6 — Resource orchestration · **Labels:** testing, acceptance · **Depends on:** NXR-059..NXR-065 (NXR-067 when enabled) · **ADR:** [ADR-027](../adr/027-resource-orchestration-architecture.md) ([plan](../architecture/resource-orchestration-plan.md))

## Objective

Prove ADR-027 offline, then live on the owner machine.

## Problem

The architecture is accepted only when providers are configured once, Auto routes, OpenWorker genuinely orchestrates Cowork, DSH genuinely orchestrates Code, and subscriptions are used where compatible.

## Scope

- Offline: Cowork SOW (OpenWorker control via gateway; extraction / synthesis / draft / review units on different resources; artifact); Code (DSH control, lane strategy, diversity, sandbox, approval, commit); integrated three-turn flow.
- Owner live: Desktop and plane connections configured once; Auto; one Cowork SOW with ≥ 1 subscription-backed unit; one small Code change; the integrated flow; no vendor chosen per task.

## Acceptance criteria

- [ ] Recorded strategy, control and route decisions per unit; honest fallbacks; no secret extraction; no push; evidence under `docs/devlog/evidence/`.

## Security considerations

Live runs are explicit owner acceptance, never CI; no live auth or quota use without owner initiation.
