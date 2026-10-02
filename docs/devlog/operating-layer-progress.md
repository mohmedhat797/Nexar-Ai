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

Claude Code continuation (2026-10-02). **Automated Windows gate is green**: CI run `37004390748` at
`747c8bb` passed Linux, Windows (tests, native Electron E2E, installer packaging, packaged E2E) and
the secret scan. Root causes, from the CI logs:

- Native ACL test helpers used `Get-Acl`/`Get-Item`/`ConvertTo-Json`; their module auto-loading
  ("Preparing modules for first use") exceeded the 15 s helper budget on GitHub runners. Helpers are
  now .NET-only with `$PSModuleAutoLoadingPreference = 'None'`; the production guard also disables
  auto-loading and reports `PrivateStateError.diagnostic` (category, phase, exit code, elapsed ms).
- GitHub's Windows runner is elevated: a file Node creates after the guard is owned by
  `BUILTIN\Administrators` (an elevated token's default owner). The test accepts that only under
  elevation and re-runs the guard to prove normalization to the user.
- Fake-runtime cleanup `EBUSY`: `rmSync` ignores `maxRetries` on current Node; harnesses now await
  `fs.promises.rm` with the bounded retry. `createTaskWorktree` has a Windows-only 20 s allowance.

NXR-051: implementation complete, automated acceptance complete, **owner/manual acceptance pending**
([checklist](../guides/windows-validation.md)). Locally on the owner machine: `pnpm check`, source and
packaged E2E, `doctor`, installer build all passed.

Operating Layer on this branch: ADR-024 (`687ae93`), NXR-057/058 (issues #37/#38), Mobile deferred
in the roadmap; `@nexar/sessions` (`06f873d`); Desktop persistent multi-turn sessions (`10a6c59`):
seven validated `sessions:*` channels, background turn execution with session/turn lineage on
tasks, restart interruption, cancel, idempotent submit, a conversation list, and an offline E2E that
relaunches and continues the same conversation. Full gate at `10a6c59`: 1,907 passed / 119 skipped;
both E2E scenarios pass. Turns still see only their own text (context@1 is NXR-058).

## NEXT EXACT TASK

1. NXR-058: new `@nexar/operating` package — `intent-rules@1` (explicit kind wins, keyword rules →
   `TaskKind` with rule ids), `lanes@1` router (affinity `coding → code`,
   `documentation|meeting-preparation → cowork`, else the mode's lane), mismatch →
   `pending-confirmation` with confirm/decline, honest `direct` fallback while the orchestrated
   lanes are unavailable (engineering writes never fall back), `context@1` builder with a stored
   manifest, correlation envelope on tasks. Then wire Desktop: lane + fallback shown per turn,
   `sessions:confirmLane`, mode switch in the UI.
2. Then NXR-052 providers → NXR-055 Code/WSL2 → NXR-056 Cowork/OpenWorker → NXR-053 behavior →
   integrated Operating Layer E2E. NXR-054 and Mobile stay deferred.

## BLOCKERS

- `sessions:list` reads at most 200 sessions across all projects before filtering by project; a
  per-project index or paging is a follow-up before heavy use.
- A reused process id can make a stale sessions lease look live; it fails closed (`CONFLICT`,
  sessions unavailable). Follow-up: a stronger liveness proof. A non-`CONFLICT` lease failure (for
  example an unsafe sessions directory) stops Desktop startup, consistent with the state guard.
- If every store write fails while a turn completes, the turn stays `running` until the next restart
  marks it `interrupted`.
- The `claude` CLI on this machine is not logged in, so the `claude-delegate` relay cannot run;
  Sonnet work used in-session Sonnet subagents.
- Windows descendants of a leader that exits before cancellation are not contained by `taskkill`;
  complete containment needs a Windows Job Object. Write-capable engineering still requires
  WSL2/bubblewrap, with no native fallback. Arbitrary batch launchers are refused.
- External config state-directory overrides still need their own ACL audit. Windows artifact storage
  requires hard-link support.
- WSL A1–A6, provider keys, OpenWorker reverse supervision and installer execution are not validated.

## OWNER ACTION

- Owner acceptance in [`windows-validation.md`](../guides/windows-validation.md): install the CI
  installer artifact (or the local build), confirm `%APPDATA%\Nexar` ACLs, run an echo and a Claude
  Code Cowork task, relaunch persistence, cancel, uninstall/reinstall. New: confirm a conversation
  survives a relaunch and can be continued.
- Optional: `claude /login` so the `claude-delegate` relay works.

## LIVE TESTS PENDING

Installed Windows Desktop Cowork task with Claude Code; WSL A1–A6 and one engineering E2E; synthetic
OpenWorker Cowork E2E. Subscription tests remain opt-in. NXR-054 scheduled work and Mobile stay deferred.
