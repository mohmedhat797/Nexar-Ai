# NXR-058: Operating intent and lane orchestration

**Milestone:** v0.5 — Nexar Desktop (Operating Layer) · **Labels:** operating-layer, routing, desktop ·
**Depends on:** NXR-057 · **ADR:** [ADR-024](../adr/024-operating-layer-and-sessions.md)

## Summary

Add `@nexar/operating`: deterministic intent classification, the lane router (`cowork` / `code` /
`direct`), explicit mode-mismatch confirmation, bounded context assembly and the `OperatingService`
that runs a session turn through the NRC.

## Problem

Nothing decides which orchestration path owns a message. Mode is only a UI preference, so a request
for engineering work in Cowork has no defined, safe handling, and prior turns never reach the model.

## Objective

Each turn records why it got its intent, lane and context; mismatches require the owner's explicit,
non-authorizing confirmation; resource choice stays with the NRC.

## Scope

- `intent-rules@1`: explicit UI kind wins; otherwise fixed keyword rules → existing `TaskKind`, with
  matched rule ids.
- `lanes@1`: pure router over mode, intent and lane availability; affinity `coding → code`,
  `documentation|meeting-preparation → cowork`, otherwise the mode's lane.
- Mismatch → `pending-confirmation`; confirm/decline operations; `declined` terminal state.
- Visible fallback to `direct` for read/draft work when an orchestrator is unavailable; recorded
  `requestedLane`, `effectiveLane`, `fallbackReason`. Engineering writes never fall back.
- `context@1` builder with a stored context manifest (ids, counts, truncation flags, hash).
- `OperatingService` wiring session store → router → lane → engine; telemetry with session/turn ids.
- Desktop: lane and fallback shown on each turn; confirm/decline channel; mode switch.
- Correlation envelope (`rootSessionId`, `turnId`, orchestrators, `depth`) on tasks, ready for the
  OpenWorker recursion guard (enforced end to end in NXR-056).

## Out of scope

- The Code (NXR-055) and Cowork (NXR-056) lane implementations; model-based intent classification;
  summaries or vector memory; queuing.

## Technical notes

- The router selects a lane only. It never sees resources and never changes NRC hard filters.
- Confirmation is per turn, changes no mode, grants no scope and bypasses no sandbox, gate, review or
  approval.
- Prior turns render inside `<untrusted-input>` (ADR-017), never in the trusted system prompt.

## Acceptance criteria

- [ ] Intent and lane decisions are deterministic and explained by rule ids.
- [ ] Cowork mode + coding intent pauses for confirmation; decline runs nothing.
- [ ] Confirmation leaves permission profiles, NRC filters and the session mode unchanged.
- [ ] An unavailable orchestrator yields a visible, recorded `direct` fallback for read/draft work and
      a `SANDBOX_UNAVAILABLE` failure for engineering writes.
- [ ] Context is bounded (6 turns / 24,000 characters) and its manifest explains inclusion.
- [ ] Telemetry links session, turn and task ids without content.
- [ ] A request carrying a correlation chain that would re-enter an orchestrator, or exceed depth 2,
      is rejected (`POLICY_REJECTED`, `recursion`).

## Testing expectations

Table tests for intent rules and the router; mismatch, confirm and decline flows; fallback honesty;
context bounds and manifest determinism; recursion rejection; Desktop bridge negative tests.

## Security considerations

Lane choice is not authorization. Correlation fields are bound server-side, never read from request
bodies. No owner text, output or context in telemetry.
