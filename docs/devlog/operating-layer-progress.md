# Operating Layer continuation

Branch: `feat/nexar-operating-layer` · Baseline: `9eaf725` (Desktop foundation, PR #35 merged).
Date: 2026-10-02.

The supplied folder was a source archive without `.git`. Its tracked contents matched GitHub main
exactly. Git history was recovered without changing source files; the feature branch was pushed.

## LAST COMPLETED

Windows foundation implementation: shell-free executable/Node npm-shim launches (`@nexar/process`),
Windows Codex environment allowlist, native abort/timeout tree cleanup, atomic approval-store
replacement/read locking, nonregular telemetry-file rejection, and a separator-safe artifact config
check. Windows fixtures retain directory containment through junctions and capability-skip file links
only after Windows refuses their creation. CI now runs checks and Electron E2E on Linux and Windows.

Checkpoint commit: `c749af2` (pushed). Draft PR: https://github.com/mohmedhat797/Nexar-Ai/pull/36.
Validation: full Windows `pnpm check` passed with pinned pnpm 10.33.0: format, lint, boundaries,
typecheck, 1,766 tests passed / 115 skipped, and build. Native Electron offline E2E passed (project,
preview, draft, theme and relaunch persistence). GitHub CI initially found Windows checkout CRLF
conversion; `.gitattributes` now preserves LF (`33031d2`). Linux CI passed at both checkpoints.
Windows CI then exposed dangling-link publication and record-reading gaps: the follow-up uses
exclusive hard-link artifact publication, file identity checks, and Node-injected public environment
assertions. The follow-up full local gate passed: 1,774 tests / 116 skips and build; its privileged
Windows file-link cases passed on CI at `6e060db`. That CI run found unrelated fixture races: the
ACP test record writer now publishes atomic snapshots and the 520-file Desktop cap fixture uses
bounded parallel setup with a Windows allowance. The next checkpoint secures dedicated Windows
Desktop state ACLs before configuration reads; native tests cover protected grants and redirected
path refusal. Windows enforcement finishes synchronously before Electron readiness; the original
asynchronous startup was rejected by the rebuilt E2E and corrected. Bounded approval-store sharing
retries cover transient lock/read/release failures without retrying approval decisions.

The unsigned per-user x64 NSIS build succeeded (118,105,049 bytes) and emits a SHA256 sidecar in
`release/desktop`. Source and packaged Electron offline E2E both passed with the native sandbox,
a project path containing spaces, shipped workflow catalogs, drafts and relaunch persistence.
The installer is configured without elevation and preserves data on uninstall; actual installer
execution and owner acceptance remain pending. The final full gate passed: format, lint, boundaries,
typecheck, 1,800 tests passed / 118 skipped, and build. Delivery checkpoint
`6255415748bb655f1d8577e0b41ab2d46ce35004` is pushed; local and remote SHA matched and the tree was
clean. CI acceptance at that commit remains pending until both matrix jobs finish. Usage reached
92%, so the next implementation unit waits for continuation; reset credits remain unused.

## CURRENT STATE

NXR-051 is **in progress**, not complete. No Operating Session domain has been implemented yet.
The Electron main/renderer boundary, no-listener policy, NRC routing, draft-only workflows, approvals
and Linux/WSL engineering controls remain authoritative. No paid AI calls were made.

## NEXT EXACT TASK

Verify the Windows delivery checkpoint in both CI jobs on draft PR #36 and perform the owner checklist in
[`windows-validation.md`](../guides/windows-validation.md). After that, define ADR-024 (if still free)
for Operating Sessions and intent/lane selection; allocate the next unused backlog ids (currently
057/058), defer Mobile, and implement sessions before provider/Code/Cowork settings integration.

ADR-024 and NXR-057/058 were checked against repository indexes and all-state GitHub issues and are
unused. Write those specifications and issue mirrors first. The session implementation should be
headless: immutable project, distinct session/turn/task ids, durable lineage and per-turn policy,
private atomic storage with revision checks and exclusive writer ownership, one foreground run,
and durable idempotency. Restart marks interruption without replay or approval; cancellation keeps
history. Context is bounded and inspectable. The Operating Router chooses the lane, NRC the
resource; a mode mismatch requires explicit confirmation without changing permission policy.

## BLOCKERS

- Windows descendants of a leader that exits before cancellation are not contained by `taskkill`;
  complete lifecycle containment needs a Windows Job Object. Abort/timeout cleanup of live trees is
  tested. Write-capable engineering still requires WSL2/bubblewrap, with no native fallback.
- Arbitrary batch launchers are refused; supported Node npm shims resolve their script and Node
  directly. Unsupported shim formats need a supported launcher, never shell interpolation.
- POSIX modes do not implement Windows ACL protection. Desktop's dedicated data tree now has an
  explicit startup guard; configured external state directories still require a separate ACL audit.
- WSL A1–A6, provider keys, OpenWorker reverse supervision, and installer execution are not yet validated.
- The first checkpoint was pushed before the five-hour usage limit. The owner resumed after the
  natural reset; no reset credits were consumed. Windows CI exposed link-handling gaps addressed
  before installer work. Windows artifact storage requires hard-link support (for example NTFS).

## OWNER ACTION

Installer and real-resource acceptance remain pending. Follow the exact Windows checklist after the
installer is available; do not mark manual acceptance complete based on offline echo tests.

## LIVE TESTS PENDING

Installed Windows Desktop Cowork task with Claude Code; WSL A1–A6 and one engineering E2E; synthetic
OpenWorker Cowork E2E. Subscription tests remain opt-in. NXR-054 scheduled work and Mobile stay deferred.
