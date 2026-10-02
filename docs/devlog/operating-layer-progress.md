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
clean. CI run `36995606985` passed Linux and the secret scan, but Windows failed eight cases:
seven native ACL fixture PowerShell invocations and an Antigravity fixture cleanup `EBUSY`.
Local full checks and source/packaged E2E passed; Windows CI acceptance remains unresolved. Usage reached
92%, so the next implementation unit waits for continuation; reset credits remain unused.

## CURRENT STATE

Claude Code continuation (2026-10-02). `9a07693` (`fix(desktop): stabilize Windows ACL validation on
CI runners`) is pushed to PR #36. Diagnosis from the earlier CI evidence (seven native ACL tests failing
after ~15 s, including the hard-link case whose production tool call is mocked, so the slow process was
the _test_ helper): the helpers used `Get-Acl`/`Get-Item`/`ConvertTo-Json`, whose module auto-loading
runs PowerShell's "Preparing modules for first use" step; under the stripped environment `PSModulePath`
even contains an unexpanded `%ProgramFiles%`. Locally that step is cheap (5 modules); GitHub images
ship far more. Fix: .NET-only helpers with `$PSModuleAutoLoadingPreference = 'None'` and bounded,
path-free failure summaries; the production guard also disables auto-loading, prints a readiness
marker and maps failures to fixed categories (`PrivateStateError.diagnostic`: category, phase
preflight/startup/execution, exit code, elapsed ms). The git-integration `createTaskWorktree` suite has
a Windows-only 20 s allowance (about twelve sequential git processes per case); the Antigravity fixture
cleanup retries a transient `EBUSY` with Node's bounded `rmSync` retry. ACL policy, ownership checks,
redirect refusals and helper timeouts are unchanged.

Local Windows evidence at `9a07693`: `pnpm check` (1,802 passed / 118 skipped, build), source and
packaged Electron E2E, `doctor`, installer build (`Nexar-0.1.0-windows-x64-setup.exe`, SHA256
`256bc9192bacdd52202321dcad8a72c7e5adf6c6954aa4c329bf7370d3659a31`). CI at `9a07693`: Linux and the
secret scan pass; **Windows fails and its log has not been read**: this session has no GitHub API
access (`gh` unauthenticated, private repository). The cause may differ from the diagnosis above.

Architecture and sessions are ready but intentionally **not on this branch** until Windows CI is
green: `origin/wip/sessions-impl` holds `b4a6d9d` (ADR-024, NXR-057/058, indexes, Mobile deferred)
and `9206a47` (`@nexar/sessions`, the `CONFLICT` error code, `TaskOrigin.sessionId/turnId`; full
`pnpm check` passed there: 1,878 passed / 119 skipped). ADR-024 and NXR-057/058 were unused when
written. NXR-051: implementation complete; automated acceptance pending Windows CI; owner/manual
acceptance pending.

## NEXT EXACT TASK

1. Read the Windows job log of the latest PR #36 run (`gh run view --log-failed`), fix the cause
   without weakening ACL policy, `pnpm check`, commit, push, until Linux, Windows and the secret scan
   pass on the same commit.
2. Cherry-pick `b4a6d9d` and `9206a47` from `origin/wip/sessions-impl` onto this branch, re-run
   `pnpm check`, push, confirm CI; then delete the `wip/sessions-impl` branch.
3. Mirror NXR-057/058 as GitHub issues (next free numbers) and add them to the backlog issue table.
4. NXR-057 Desktop integration: compose `FileSessionStore` in Desktop main (`<userData>/.nexar/sessions`,
   lease at startup), bridge channels `sessions.list|create|get|submitTurn|cancel|setMode|rename`
   (zod, narrow DTOs, no paths: artifact URIs map to project-relative names), session list + transcript
   UI, progress bound to turns, offline restart E2E. Then NXR-058 (`@nexar/operating`).

## BLOCKERS

- **GitHub API access** in this Claude session (`gh auth login`), needed for CI logs, issue mirrors
  and PR updates. The app's Auto-fix monitor reports failing check names only.
- The `claude` CLI on this machine is not logged in, so the `claude-delegate` relay cannot run;
  Sonnet work used an in-session Sonnet subagent instead.
- A reused process id can make a stale sessions lease look live; it fails closed (`CONFLICT`).
  Follow-up: a stronger liveness proof.
- Windows descendants of a leader that exits before cancellation are not contained by `taskkill`;
  complete lifecycle containment needs a Windows Job Object. Write-capable engineering still requires
  WSL2/bubblewrap, with no native fallback.
- Arbitrary batch launchers are refused; unsupported npm shim formats need a supported launcher.
- Desktop's dedicated data tree has an explicit ACL startup guard; configured external state
  directories still require a separate ACL audit. Windows artifact storage requires hard-link support.
- WSL A1–A6, provider keys, OpenWorker reverse supervision and installer execution are not validated.

## OWNER ACTION

- Run `gh auth login` on this machine (or give this session another GitHub read path).
- Installer and real-resource acceptance in [`windows-validation.md`](../guides/windows-validation.md)
  remain pending; do not mark them complete from offline echo tests.

## LIVE TESTS PENDING

Installed Windows Desktop Cowork task with Claude Code; WSL A1–A6 and one engineering E2E; synthetic
OpenWorker Cowork E2E. Subscription tests remain opt-in. NXR-054 scheduled work and Mobile stay deferred.
