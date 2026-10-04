# ADR-024: Nexar Operating Layer and Operating Sessions

**Status:** Accepted (2026-10-02) · Builds on ADR-004 (OpenWorker), ADR-005 (NRC ownership), ADR-012
(path policy), ADR-013 (artifacts), ADR-015 (client identity and audit), ADR-016 (approvals), ADR-017
(untrusted input), ADR-018/019 (engineering plane and lanes), ADR-020 (resource intelligence), ADR-021
(Desktop) · Implemented by NXR-057 (sessions) and NXR-058 (intent and lane orchestration)

## Context

Nexar Desktop (ADR-021) sends every chat message as an isolated task: there is no conversation, no
memory of the previous turn, and no record of which orchestrator handled a request. The owner wants to
stay inside one Nexar conversation while Nexar decides what each message needs, which orchestration
path owns it (OpenWorker for productivity work, DeepSeek Harness for engineering, or Nexar's own engine)
and, separately, which AI resource executes it (the NRC, ADR-005/020).

Three questions must stay separate:

1. **What does the turn need, and which orchestration lane owns it?** — the Operating Layer (this ADR).
2. **Which AI resource executes?** — the NRC, unchanged.
3. **How is the provider called?** — adapters and runtimes, unchanged.

Mobile and the remote control plane are deferred behind this work (the owner's current direction).

## Decision

### 1. Packages and ownership

- **`@nexar/sessions`** owns the Operating Session domain: types, the state machine, validation and the
  file store. It has no knowledge of routing, adapters, orchestrators or the network.
- **`@nexar/operating`** owns the Operating Router (intent → lane), the context builder and the
  `OperatingService` that runs a turn: session store → router → lane → engine (NRC) → session store.
- `@nexar/host` composes both. Desktop main is the only writer in v1 (§6). Adapters stay the only code
  that knows an upstream (ADR-008); a lane reaches OpenWorker or DSH only through its adapter.

### 2. Domain model and identity

| Concept    | Id                     | Notes                                                                      |
| ---------- | ---------------------- | -------------------------------------------------------------------------- |
| Session    | `ses_<32 hex>`         | One conversation, bound to one project for its whole life.                 |
| Turn       | `turn_<32 hex>`        | One owner message and its outcome. A turn produces zero or more tasks.     |
| Task       | existing `TaskId`      | Unchanged. `TaskOrigin` gains optional `sessionId` and `turnId` (lineage). |
| Approval   | existing `apr_<hex>`   | Referenced by turns; owned and decided only by `@nexar/approvals`.         |
| Artifact   | existing `ArtifactRef` | Referenced by turns; written only by `LocalArtifactStore`.                 |
| Submission | `submissionKey`        | Client-generated idempotency key for "submit turn" (§7).                   |

Ids are never overloaded: a task id is never a turn or session id, and a session id never names a task.

An `OperatingSession` record holds: `schemaVersion`, `id`, `projectId` (**immutable**), `mode`
(`cowork` | `code`), `title` (owner-editable, bounded), `createdAt`, `updatedAt`, `revision`,
`activeTurnId` (or none) and an ordered list of turns.

A `Turn` holds: `id`, `index`, `submissionKey`, `createdAt`, the owner's text (bounded, private),
the `intent` and `laneDecision` (§9), `state`, linked `taskIds` with their route summaries (resource
id, policy id, fallback), `artifactRefs`, `approvalIds`, the `contextManifest` (§10), and the outcome:
a bounded result text (owner-visible, private), an error `{ code, message }`, usage as `Measured<T>`.

Turn states: `pending-confirmation` → `running` → `succeeded` | `failed` | `cancelled` |
`interrupted`; `pending-confirmation` → `declined`. Terminal states never change again.

### 3. Project binding

A session's `projectId` is set at creation and never changes. Selecting another project in the UI opens
or creates a session for that project; there is no "move session" operation. Every turn of a session
runs with that project's roots, path policy (ADR-012, `project-only` on Desktop) and defaults. This
prevents cross-project context leakage: context assembly (§10) reads only the session's own turns.

### 4. Modes

A mode is an owner preference stored on the session: `cowork` (OpenWorker-first) or `code`
(DSH-first). It selects the default lane and the permission profile; it never grants permissions.
Changing mode is an explicit operation recorded on the session (`modeChangedAt`); it
takes effect on the next turn and never alters a running turn.

### 5. Persistence

- Location: `<stateDir>/.nexar/sessions/<sessionId>.json`, next to approvals and engineering records.
  On Desktop that is `%APPDATA%\Nexar\.nexar\sessions`, inside the ACL-guarded state tree (NXR-051).
  Authoritative state never lives in the renderer (React state, `localStorage`, IndexedDB).
- One JSON file per session: directory 0700, file 0600, write to an exclusive temp file and rename
  (with the bounded Windows sharing retry used by the approval store), never remove the destination.
- Reads are bounded (4 MiB per session file; 200 sessions per listing page), refuse symlinks,
  junctions, non-regular files and hard links (`nlink !== 1`), and resolve inside the sessions
  directory by realpath. Names are derived only from validated ids.
- Records are schema-validated and prototype-safe on read. A corrupt or oversized file fails closed
  for that session (`VALIDATION_ERROR`, listed as unavailable) and is never rewritten automatically.
- Bounds: 1,000 turns per session (then the session is read-only and the owner starts a new one),
  100,000 characters of owner text per turn, 64 KiB of stored result text per turn (truncation is
  flagged, the full output stays in artifacts when the lane produces one).

### 6. Writer ownership and lost updates

- A process acquires the **sessions lease** (`sessions/.lease`, created `O_EXCL`, holding an instance
  id; stale only when its owner process is gone) before writing. Without the lease, a process may read
  sessions but every mutation fails with `CONFLICT`. In v1 only Desktop main takes the lease; the CLI
  and the MCP server never write sessions.
- Inside the lease holder, every mutation is `update(sessionId, expectedRevision, mutate)`, serialized
  per session. A stale `expectedRevision` fails with `CONFLICT` (details `{ reason: 'stale-revision' }`)
  and the caller re-reads. There is no last-write-wins.
- `NexarErrorCode` gains `CONFLICT` (not retryable by default).

### 7. Idempotent submission

`submitTurn` requires a `submissionKey` (`^[A-Za-z0-9_-]{16,64}$`, generated by the client per user
action). The key is stored durably on the turn in the same atomic write that creates it. A repeated key
in the same session returns the existing turn and starts nothing; a key reused with different text is
rejected (`VALIDATION_ERROR`). This survives renderer reloads, IPC retries and restarts.

### 8. One foreground execution

A session has at most one turn in `running` or `pending-confirmation` (`activeTurnId`). A submit while
one is active is rejected with `CONFLICT` (details `{ reason: 'session-busy', activeTurnId }`). There
is no queue in v1. Lanes may parallelize internally under their own model (ADR-019 lanes).

### 9. Intent, lanes and mode mismatch

- **Intent** reuses `TaskKind` (`documentation`, `analysis`, `coding`, `review`, `research`,
  `meeting-preparation`, `automation`, `general`); no new taxonomy. The classifier is deterministic
  and versioned (`intent-rules@1`): an explicit kind chosen in the UI wins; otherwise fixed keyword
  rules over the owner's text. It records the kind and matched **rule ids**, never text.
- **Lanes:** `cowork` (OpenWorker orchestrates), `code` (DSH orchestrates through the engineering
  plane), `direct` (Nexar's engine runs one routed task; no external orchestrator).
- **Router** (`lanes@1`, a pure function of mode, intent and lane availability): `coding` and
  `review` (including checking a repository against a proposal) have `code` affinity;
  `documentation` and `meeting-preparation` have `cowork` affinity; every other intent uses the
  mode's lane. Only `coding` is an engineering write; `review` is read-only and may fall back. The router selects a lane, never a resource. The NRC then routes each task the lane
  creates, with every hard filter, exactly as today.
- **Mode mismatch:** when the intent's affinity lane differs from the mode's lane, the turn enters
  `pending-confirmation` with `{ from, to }`. The owner confirms (run in the other lane for this turn
  only) or declines (`declined`). Confirmation selects an orchestration path only: it grants no scope,
  never bypasses the sandbox, gates, review, approvals or NRC hard filters, and does not change the
  session's mode. A lane's own permission profile still applies (Code writes only in the sandboxed
  private clone, Cowork only drafts).
- **Availability and fallback:** if the selected lane's orchestrator is unavailable, the turn runs in
  `direct` only when that is no broader than the selected lane (read and draft work), recording
  `requestedLane`, `effectiveLane` and `fallbackReason`, and the UI shows it (for example "OpenWorker
  unavailable. Using Nexar direct execution."). Engineering writes never fall back: without the WSL2
  plane a `code` write turn fails with `SANDBOX_UNAVAILABLE`. Nexar never claims an orchestrator ran
  when it did not.
- Until NXR-055/056 ship, both orchestrated lanes report unavailable and turns run `direct` with the
  fallback recorded; this is the honest initial state, not a hidden default.

### 10. Context assembly (`context@1`)

Each turn receives a deterministic, bounded context built only from its own session:

1. a fixed session policy header (mode, lane, project id; no paths);
2. the most recent completed turns, newest first, up to 6 turns and 24,000 characters, each side
   truncated to 2,000 characters; older turns are omitted, not summarized (a summary slot is reserved
   for a later version);
3. references to those turns' artifacts (`ArtifactRef` names and ids, never content) and task outcomes;
4. the project's document-set references, as today.

Prior owner text and prior model output are rendered inside the `<untrusted-input>` wrapper (ADR-017)
and never reach the trusted system prompt. The builder emits a **context manifest** stored on the
turn: included turn ids, truncation flags, character counts, omitted count, artifact ids and a hash of
the rendered context. Tests and debug tooling can answer "why did this turn get this context?" from the
manifest alone. No vector memory in this version.

### 11. Cancellation, restart and approvals

- **Cancel** aborts the running turn's tasks through the existing abort path, marks the turn
  `cancelled`, keeps the owner text, any partial outcome and every artifact, and frees the session.
- **Restart:** when the lease is acquired, every `running` turn is marked `interrupted` and
  `pending-confirmation` turns stay pending (no execution has started). Nothing is replayed: no paid
  call, write, approval or commit is repeated. The owner may submit a new turn after reading the state.
  Session recovery is local to sessions and never calls the approval store's `recoverAfterRestart`.
- **Approvals:** a turn only references approval ids. Restart never grants, consumes or re-requests an
  approval; an approval's state is read from `@nexar/approvals` under ADR-016, never inferred from a turn.

### 12. Orchestrator recursion

Every task carries a server-bound correlation: `rootSessionId`, `turnId`, `rootOrchestrator`
(`nexar`), `currentOrchestrator`, `depth` and a `correlationId`. These are set by Nexar when the lane
starts and are never taken from a request body.

When a Cowork turn starts OpenWorker, Nexar mints a **turn-scoped delegation credential** (an ADR-015
client token restricted to that session and turn, expiring with the turn). If OpenWorker calls Nexar's
MCP server with it, Nexar binds the request to the same turn: the call runs as a `direct` child task
(`depth + 1`) whose result returns to the same OpenWorker run. It never creates a turn or session and
never starts an orchestrated lane. A request whose chain already contains the target orchestrator, or
whose depth would exceed 2, is rejected with `POLICY_REJECTED` (details `{ reason: 'recursion' }`).
OpenWorker approval requests map onto Nexar approvals (deny by default); OpenWorker cannot approve,
widen scope or bypass draft-only rules.

### 13. Telemetry and audit

Telemetry events add `sessionId`, `turnId` and (for tasks) `taskId`, plus lane, intent kind, rule ids,
fallback reason and context-manifest counts and hash. Never owner text, model output, context, paths or
credentials. Session files are private owner state, not telemetry.

### 14. Desktop surface

Desktop exposes sessions through new ADR-021 bridge channels (list, create, get, submit turn, confirm
or decline a lane, cancel, set mode, rename), each with a strict zod schema, narrow DTOs (ids, states,
bounded text the owner already sees, artifact names), no paths, no stacks and no secrets. Progress events
carry `sessionId` and `turnId`. The renderer never holds authoritative transcript state.

## Rationale

- A first-class session gives conversations durable lineage without overloading task ids or giving
  the renderer authority.
- Separating lane choice from resource choice keeps the NRC's explainable, filter-first routing
  (ADR-020) unchanged; orchestrators become callers of the NRC, not replacements for it.
- Mode mismatch as an explicit, non-authorizing confirmation prevents a chat wording change from
  silently escalating to engineering writes, while keeping one conversation.
- Reusing hardened store patterns (approvals) and the ACL-guarded state tree avoids a weaker duplicate.

## Alternatives considered

- **Renderer-held history:** rejected; the renderer is untrusted and history would not survive a
  reload or restart.
- **A conversation id on the task only:** rejected; turns, confirmations, idempotency and interruption
  need their own durable state.
- **Model-based intent classification:** deferred; it costs money, is non-deterministic and would need
  the prompt in a policy. Deterministic rules plus an explicit UI choice suffice for v1.
- **Queuing messages while a turn runs:** deferred; ordering and cancellation semantics add risk for
  little value in a single-owner app.
- **A database (SQLite):** deferred; one file per session matches the existing state model and needs no
  new native dependency on Windows.
- **Automatic replay after restart:** rejected; it could repeat paid calls, writes or approvals.

## Consequences

- New packages `@nexar/sessions` and `@nexar/operating`; `TaskOrigin` gains optional `sessionId` and
  `turnId`; `NexarErrorCode` gains `CONFLICT`; telemetry gains session/turn fields.
- Desktop chat becomes session-based (NXR-057), then lane-aware (NXR-058). Code (NXR-055) and Cowork
  (NXR-056) plug in as lanes; AI behavior (NXR-053) supplies per-mode profiles.
- The roadmap places Mobile after the Operating Layer, Memory and Automation milestones.

## Risks

- **Keyword intent rules misclassify.** Mitigated: the UI can state the kind; a mismatch only asks for
  confirmation; misclassification never widens permissions.
- **Session files hold private conversation text.** Mitigated: they live in the owner-private, ACL-guarded
  state tree with 0600 files and never enter telemetry or audit.
- **Lease staleness after a crash.** A lease is stale only when its owner process is gone; recovery
  marks interruption (turns and their running tasks) and never replays. A reused process id can make a
  stale lease look live; the lease then fails closed (`CONFLICT`) and Desktop reports it rather than
  taking over. A stronger liveness proof (process start time) is a follow-up.

- **Recursion through OpenWorker.** Mitigated by server-bound correlation, turn-scoped credentials and a
  depth limit, with deterministic tests.

## Follow-up work

1. NXR-057: `@nexar/sessions` (headless), then Desktop multi-turn sessions with a restart E2E.
2. NXR-058: `@nexar/operating` intent rules, lane router, mismatch confirmation, context builder.
3. NXR-052 providers, then NXR-055 Code lane (WSL2 bridge) and NXR-056 Cowork lane (OpenWorker), then
   NXR-053 behavior profiles and an integrated Operating Layer E2E.

## Amendment (2026-10-04): resource orchestration

Engine delegation (`nexar → openworker|dsh → nexar child`) uses the existing lineage and
`MAX_DELEGATION_DEPTH = 2`; children create no turn and never start an engine ([ADR-027](027-resource-orchestration-architecture.md) §7). Fallback
reasons gain `openworker-control-unavailable` and `dsh-control-unavailable` (§9).
