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
Windows file-link CI cases remain pending until the follow-up is pushed and CI completes.

## CURRENT STATE

NXR-051 is **in progress**, not complete. No Operating Session domain has been implemented yet.
The Electron main/renderer boundary, no-listener policy, NRC routing, draft-only workflows, approvals
and Linux/WSL engineering controls remain authoritative. No paid AI calls were made.

## NEXT EXACT TASK

Finish NXR-051: verify the link-hardening checkpoint in both CI jobs on draft PR #36, deliver and test the per-user x64 NSIS installer, audit default
state-directory ACLs and packaged resource/catalog paths, then perform the owner checklist in
[`windows-validation.md`](../guides/windows-validation.md). After that, define ADR-024 (if still free)
for Operating Sessions and intent/lane selection; allocate the next unused backlog ids (currently
057/058), defer Mobile, and implement sessions before provider/Code/Cowork settings integration.

## BLOCKERS

- Windows descendants of a leader that exits before cancellation are not contained by `taskkill`;
  complete lifecycle containment needs a Windows Job Object. Abort/timeout cleanup of live trees is
  tested. Write-capable engineering still requires WSL2/bubblewrap, with no native fallback.
- Arbitrary batch launchers are refused; supported Node npm shims resolve their script and Node
  directly. Unsupported shim formats need a supported launcher, never shell interpolation.
- POSIX modes do not implement Windows ACL protection. Default `%APPDATA%\Nexar` inherits the
  owner's profile ACL; overrides/shared paths require an explicit ACL audit before secure-state claims.
- WSL A1–A6, provider keys, OpenWorker reverse supervision, and the installer are not yet validated.
- The first checkpoint was pushed before the five-hour usage limit. The owner resumed after the
  natural reset; no reset credits were consumed. Windows CI exposed link-handling gaps addressed
  before installer work. Windows artifact storage requires hard-link support (for example NTFS).

## OWNER ACTION

Installer and real-resource acceptance remain pending. Follow the exact Windows checklist after the
installer is available; do not mark manual acceptance complete based on offline echo tests.

## LIVE TESTS PENDING

Installed Windows Desktop Cowork task with Claude Code; WSL A1–A6 and one engineering E2E; synthetic
OpenWorker Cowork E2E. Subscription tests remain opt-in. NXR-054 scheduled work and Mobile stay deferred.
