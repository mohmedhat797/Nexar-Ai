# ADR-025: Code lane — Desktop to WSL2 engineering-plane bridge

**Status:** Accepted (2026-10-03) · Builds on ADR-016 (approvals), ADR-018 (engineering plane), ADR-019
(lanes, acceptance, Nexar-owned commit), ADR-021 (Desktop), ADR-024 (Operating Layer) · Implements
NXR-055

## Context

ADR-024 routes engineering turns to the `code` lane, which reports unavailable today. ADR-018 already
places the engineering engine inside a hardened WSL2 distro (`nexar-plane`) and reaches it from
Windows over `wsl.exe … --exec nexar` and stdio. Automount is disabled there, so the plane cannot see
Windows folders: engineering repositories live on the plane's ext4 filesystem. ADR-019 already defines
the runner, the NRC-selected lanes, gates, review, the `engineering.commit` approval and the
Nexar-owned commit. What is missing is the seam between Desktop and that plane.

## Decision

### 1. One small, versioned stdio protocol

The plane gains one entrypoint, `nexar plane serve --stdio`, run inside WSL. Frames are
newline-delimited JSON, at most 1 MiB each, validated with strict schemas on both sides; stdout
carries frames only, logs go to stderr. Protocol id `nexar-plane/1`; an unknown version or frame type
ends the connection with a clear error.

| Desktop → plane                                      | Plane → Desktop                                    |
| ---------------------------------------------------- | -------------------------------------------------- |
| `initialize { protocol }`                            | `ready { protocol, planeVersion, readiness }`      |
| `run { runId, planeProject, goal, intent, lineage }` | `progress { runId, … scalars }`                    |
| `cancel { runId }`                                   | `approval-required { runId, approvalId, summary }` |
| `decide { approvalId, decision }`                    | `completed { runId, outcome }`                     |
| `diff { taskId }`                                    | `diff { taskId, text, truncated }`                 |
| `shutdown {}`                                        | `error { runId?, code, message }`                  |

There is no generic command, path, environment or executable field anywhere in the protocol.

### 2. Launch

Desktop main launches `%SystemRoot%\System32\wsl.exe` with fixed arguments
`-d <distro> --exec <command> plane serve --stdio`: no shell, a minimal explicit environment (no
`WSLENV`), bounded startup (handshake deadline), bounded stderr that is never echoed, and process-tree
cleanup on cancel, timeout or exit. `distro` (default `nexar-plane`) and `command` (default
`/usr/local/bin/nexar`, an absolute POSIX path) come only from owner configuration and are
pattern-validated; the renderer cannot supply either.

### 3. Projects map by id, never by path

A Desktop project names its plane project with `engineering.planeProject: "<id>"` in Desktop
configuration. The bridge carries only that id; the plane resolves the repository from its own
configuration under its own path policy (ADR-012/018). No Windows or WSL path crosses the bridge, and
the renderer only ever sends the Desktop project id. A project without a mapping cannot use the Code
lane and says so.

### 4. Availability reflects safe prerequisites

`ready.readiness` reports what the plane verifies itself at handshake: sandbox availability and the
Nexar sandbox self-test (A4/A5), `/etc/wsl.conf` hardening — automount and interop disabled
(A2/A3) — engineering plan catalog and executor availability, and the kernel string (A6, recorded).
Desktop maps launch and readiness results to explicit states: `ready`, `wsl-unavailable`,
`plane-missing`, `plane-unreachable`, `protocol-mismatch`, `sandbox-unavailable`,
`hardening-drift`, `project-unmapped` and `engineering-unavailable`. The Code lane is available only
in `ready`; every other state carries an actionable reason. Readiness is cached briefly and
re-probed on demand. Owner acceptance (A1–A6 with the runbook) remains a separate, recorded step;
`ready` is not "owner-accepted".

### 5. Execution stays inside the Engineering Machine

`run` starts the existing `EngineeringRunner` in the plane: NRC-selected lanes (DSH-first through
owner preferences, never hard-coded), sandbox, patch policy, gates, review and owner approval exactly
as ADR-019. Engineering-write turns (`coding`) use the project's default write plan. Read-only turns
(`review`) use a report-only plan: read-only lanes, no patch, no approval, no commit; the report
returns as the turn's text.

### 6. Approval uses the plane's own approvals

The plane's runner waits on its file-backed `engineering.commit` gate, unchanged. The plane reports
the pending approval (`approval-required`) with a bounded summary: diff stat, gate results, review
verdict, resources, branch. Desktop shows it in its existing Approvals surface; the owner's decision
travels as `decide { approvalId, decision }` and the plane records it with `decide()` (decider
`desktop:<user>`), still fingerprint-bound and single-use. Desktop never decides on its own, never
re-sends a decision after a restart, and accepts `decide` only for a pending approval of a run it
started.

### 7. Lineage, results and diffs

`run.lineage` carries `sessionId`, `turnId` and the ADR-024 correlation (`depth`, chain); the plane
writes them into the engineering record and telemetry as ids. `completed` carries status, task id,
branch and commit (when committed), file count, gate results, review verdict and approval id. The
diff is fetched by task id, bounded to 256 KiB with a truncation flag, from the plane's own patch
artifact; file paths are repository-relative and already passed the patch policy.

### 8. Cancellation and restart

Cancel propagates turn → `cancel` → runner abort → runtimes; Desktop also ends the `wsl.exe` tree on
timeout or exit. After a Desktop restart the turn is `interrupted` (ADR-024); Desktop never re-sends
a run or a decision, and the plane's engineering record stays inspectable. Nothing is committed
without a fresh owner approval.

### 9. Credentials

No credential crosses the bridge. The plane's runtimes authenticate with the plane's own owner-declared
credential mounts (ADR-018 §7); Desktop key-store values are never sent to WSL.

## Rationale

- ADR-018 already chose `wsl.exe` + stdio; a tiny frame protocol keeps the bridge auditable and
  avoids exposing a general RPC or the MCP surface with engineering scope.
- Id-only project mapping removes path translation from the trust boundary entirely.
- Reusing the plane's approvals keeps one fail-closed approval system; Desktop is only the owner's
  surface for it.

## Alternatives considered

- **MCP with an engineering scope (NXR-028):** broader surface and client-credential plumbing for a
  single trusted caller; deferred.
- **Translating Windows project paths into the plane:** impossible with automount disabled and would
  make WSL paths renderer-adjacent.
- **A long-lived plane daemon:** a process per run plus a short-lived probe is simpler to bound and
  clean up; revisit if startup cost matters.

## Consequences

- New CLI command `nexar plane serve --stdio` (inside WSL), a Desktop bridge client, a Desktop
  project setting `engineering.planeProject`, Desktop config `engineering.plane.{distro,command}`,
  a report-only plan, and Code-lane UI.
- CI uses a fake bridge; real WSL acceptance (A1–A6 and one engineering E2E) stays owner-run.

## Risks

- **WSL message/exit semantics vary by version.** Launch failures map to coarse, safe states; detail
  stays out of the UI and logs.
- **Plane and Desktop version skew.** The handshake protocol id fails clearly; `planeVersion` is shown.
