# NXR-066: Resource orchestration E2E and live acceptance

**Milestone:** v0.6 — Resource orchestration · **Labels:** testing, acceptance · **Depends on:** NXR-059..NXR-065 (NXR-067 when enabled) · **ADR:** [ADR-027](../adr/027-resource-orchestration-architecture.md) ([plan](../architecture/resource-orchestration-plan.md))

## Objective

**Status (2026-10-09): Accepted in the owner-finalized v0.6 scope.**
PR39 merged as `2f856f935a1ca51fc0f2c179386baa31bd82c3bd`; [CI 37955286149 attempt 1](https://github.com/mohmedhat797/Nexar-Ai/actions/runs/37955286149/attempts/1) passed at the merge SHA.
Historical SOW, native Code and integrated acceptance passed at `2f26b36`.
The final matching `9e71014979db7a7619bb6ac909b8418a0d198573` deployment passed one
read-only standalone Claude Code delegation, result return, parent completion,
one-unit/schema enforcement and cleanup. See [acceptance evidence](../devlog/evidence/nxr-066-owner-acceptance.md)
and the [official baseline](../devlog/evidence/Nexar_v0.6_Official_Baseline.md).

The owner's finalization scope explicitly retains unconfigured Plane DSH Control
as a known limitation. Native Claude/Codex live Code evidence and DSH offline
protocol coverage are distinct; the DSH Control loop is not claimed live-validated.
No additional paid acceptance or DSH configuration is authorized by this record.

Prove ADR-027 offline, then live on the owner machine.

## Problem

The accepted v0.6 scope requires configured resources, Auto routing, real OpenWorker Cowork delegation and supported native Code execution. DSH integration is covered offline; its unconfigured Plane Control loop remains a documented limitation under the owner's finalization direction.

## Scope

- Offline: Cowork SOW (OpenWorker control via gateway; extraction / synthesis / draft / review units on different resources; artifact); Code (DSH control, lane strategy, diversity, sandbox, approval, commit); integrated three-turn flow.
- Owner live: Desktop and plane connections configured once; Auto; one Cowork SOW with ≥ 1 subscription-backed unit; one small Code change; the integrated flow; no vendor chosen per task.

## Acceptance criteria

- [x] Recorded strategy, control and route decisions per unit; honest fallbacks; no secret extraction or acceptance-task repository push; evidence under `docs/devlog/evidence/`. Finalization merge/documentation publication is a separately owner-authorized operation.

## Security considerations

Live runs are explicit owner acceptance, never CI; no live auth or quota use without owner initiation.

## Historical preparation status (superseded)

**Status (2026-10-07):** 066a offline acceptance implemented; NXR-068 implementation and full
exact-head [CI for `0244d97`](https://github.com/mohmedhat797/Nexar-Ai/actions/runs/37553210679/attempts/2)
passed. **066b prepared; owner environment setup and live acceptance pending.**
The owner reported successful ChatGPT sign-in, but the first Cowork smoke fell back to Direct because
OpenWorker was unavailable and then the account route rejected Nexar's assumed `gpt-5.2`. The
OpenWorker prerequisite and model inventory defect are independent. No v0.6 acceptance or merge.
Previous preparation installed isolated Windows OpenWorker 0.3.0 and rebuilt Desktop/plane at
`c68c7bd`, whose full CI passed. This maintenance update requires **0.3.1** (`>=0.3.1 <0.4.0`),
matching new-head builds and full exact-head CI before preparation resumes. See the
[compatibility review](../research/upstream/openworker-0.3.1-compatibility.md) and revised
[owner runbook](../devlog/evidence/nxr-066-live-acceptance-runbook.md). Final handoff records actual
environment results. Preparation stops before existing-profile launch, provider login/catalog
refresh, native metadata initialization and allowance-consuming turns. Live acceptance is pending.
