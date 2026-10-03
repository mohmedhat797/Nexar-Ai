# NXR-066: Resource orchestration E2E and live acceptance

**Milestone:** v0.6 — Resource orchestration · **Labels:** testing, acceptance · **Depends on:** NXR-059..065 · **ADR:** [ADR-027](../adr/027-resource-orchestration-architecture.md) ([plan](../architecture/resource-orchestration-plan.md))

## Objective

Prove the ADR-027 architecture offline, then live on the owner machine.

## Problem

The architecture is only accepted once Cowork and Code use Nexar-owned resources end to end.

## Scope

- Offline: Cowork SOW (OpenWorker → strategy: extraction / drafting / review on different resources → artifact); Code regression (lane strategy, diversity, sandbox, approval, commit); integrated three-turn flow.
- Owner live: Claude + ChatGPT subscriptions and one local/API control resource; one Cowork SOW with ≥ 1 subscription-backed unit; one small Code change; the integrated flow.

## Acceptance criteria

- [ ] Recorded route decisions per unit; no secret extraction; no push; evidence under `docs/devlog/evidence/`.

## Security considerations

Live runs are explicit owner acceptance, never CI.
