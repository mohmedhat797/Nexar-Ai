# NXR-057: Persistent Operating Sessions

**Milestone:** v0.5 — Nexar Desktop (Operating Layer) · **Labels:** operating-layer, sessions, desktop ·
**Depends on:** NXR-050, NXR-051 · **ADR:** [ADR-024](../adr/024-operating-layer-and-sessions.md)

## Summary

Add durable, multi-turn Operating Sessions: a headless `@nexar/sessions` domain and store first, then
Desktop chat as session → turn → task.

## Problem

Every Desktop chat message is an isolated task. There is no conversation, no lineage between messages
and tasks, nothing survives a restart, and a retried submit could start a second paid task.

## Objective

The owner can create a session for a project, send several turns, close Desktop, reopen the same
session and continue, with each turn linked to its tasks, artifacts and approvals.

## Scope

- `@nexar/sessions`: `OperatingSession`/`Turn` types, `ses_`/`turn_` ids, turn state machine, schema
  validation, `FileSessionStore` (one file per session, atomic, bounded, link-refusing), the sessions
  lease, revision-checked `update`, durable `submissionKey` idempotency, one active turn per session,
  `markInterrupted` recovery, cancellation bookkeeping, link task/artifact/approval to a turn.
- `@nexar/contracts`: `CONFLICT` error code; optional `TaskOrigin.sessionId`/`turnId`.
- `@nexar/host`: compose the store for Desktop (lease holder) only.
- Desktop: bridge channels `sessions.list|create|get|submitTurn|cancel|setMode|rename` with zod schemas
  and narrow DTOs; chat UI becomes a session transcript with a session list; progress and artifacts
  bound to turns.
- Offline Electron E2E: create project → session → turn 1 → result → turn 2 → close → relaunch →
  reopen session → continue (echo resource, no paid call).

## Out of scope

- Lane orchestration and intent rules (NXR-058); OpenWorker/DSH lanes (NXR-055/056).
- Session summaries, vector memory, search across sessions, queuing, multi-writer sync, CLI session
  commands.

## Technical notes

- Reuse the approval store's atomic-replace and Windows sharing-retry patterns; do not add a weaker
  duplicate. Sessions live under `<stateDir>/.nexar/sessions/` inside the ACL-guarded Desktop tree.
- `submitTurn` writes the turn (with its key) before any task starts; a duplicate key returns the
  existing turn. A busy session returns `CONFLICT` `{ reason: 'session-busy', activeTurnId }`.
- Recovery on lease acquisition marks `running` turns `interrupted`; it never replays and never calls
  `recoverAfterRestart`.
- Inject clock and id generators for determinism.

## Acceptance criteria

- [ ] Sessions, turns and tasks have distinct ids; tasks record `sessionId`/`turnId`.
- [ ] A session's project cannot change; another project needs another session.
- [ ] Stale revisions and writes without the lease fail with `CONFLICT`; no last-write-wins.
- [ ] Repeating a `submissionKey` (including after restart) starts no second task.
- [ ] A second submit during an active turn is rejected with the active turn id.
- [ ] Restart marks running turns `interrupted` and replays nothing.
- [ ] Cancel ends execution, keeps the turn, history and artifacts; the session stays usable.
- [ ] Corrupt, oversized, linked or non-regular session files fail closed and are not rewritten.
- [ ] Desktop reopens and continues a session after relaunch (offline E2E).

## Testing expectations

Unit tests for the state machine, store bounds, link refusal (junctions on Windows), revision and lease
conflicts, idempotency across a simulated restart, recovery and cancellation; bridge negative tests for
every new channel; the offline restart E2E on Linux and Windows CI.

## Security considerations

Session files hold private conversation text: 0600 files in the owner-private state tree, never in
telemetry, audit or logs. Renderer DTOs carry no paths, stacks or secrets. Request fields never widen
the project or scope.
