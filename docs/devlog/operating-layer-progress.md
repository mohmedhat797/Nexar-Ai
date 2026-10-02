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

Claude Code continuation (2026-10-02). PR #36 ("Nexar Desktop — Windows foundation and Operating Layer
integration", draft) at `4c05cf28172224ac1468383a1c9ff0a0b46903c2`.

Codex continuation verification (2026-10-02): fetched origin; local HEAD, remote branch and PR #36
agree on that SHA, with a clean working tree. CI run `37012870983` passed Windows, Ubuntu and the
secret scan. The older Windows CI failures above are historical and resolved. Codex usage was
already 98% at takeover, so this checkpoint corrects the handoff without starting NXR-052b.

**Windows (NXR-051):** implementation complete, automated acceptance complete (CI green at
`747c8bb`, `4e23de2`, `660fbbf`: Linux, Windows tests, native and packaged Electron E2E, installer
packaging, secret scan), **owner/manual acceptance pending**
([checklist](../guides/windows-validation.md)). Root causes fixed from CI logs: PowerShell module
auto-loading in ACL test helpers (now .NET-only; production guard disables auto-loading and reports
`PrivateStateError.diagnostic`), the elevated runner's `BUILTIN\Administrators` default owner
(accepted only under elevation, then normalized by the guard), fake-runtime cleanup `EBUSY`
(`rmSync` ignores retries; harnesses await `fs.promises.rm`), and a CLI SIGINT test race.

**Operating Layer:**

- ADR-024 (`687ae93`, amended in `660fbbf`: `review` has `code` affinity); NXR-057 (#37), NXR-058
  (#38); Mobile deferred.
- `@nexar/sessions` (`06f873d`): durable sessions/turns, lease, revisions, idempotent submission,
  one active turn, restart interruption without replay, link-refusing bounded storage.
- Desktop multi-turn sessions (`10a6c59`): conversation list, transcript, cancel, relaunch E2E.
- `@nexar/operating` (`660fbbf`): `intent-rules@1`, `lanes@1`, `context@1` with manifest,
  correlation/recursion guard (depth 2), `OperatingService` over injected ports.
- Desktop through the Operating Layer (`59afa19`): turns get bounded prior context; lane, fallback
  and refusal shown per turn; `sessions:confirmLane` confirmation card (non-authorizing); mode
  switch per conversation. Both orchestrated lanes report unavailable (`laneAvailable()` in
  `apps/desktop/src/main/operating.ts`), so read/draft work runs `direct` with a visible,
  recorded fallback and engineering writes are refused (`SANDBOX_UNAVAILABLE`).
- Gate at `59afa19`: 2,142 passed / 119 skipped; three offline E2E scenarios pass (first run,
  relaunch-and-continue, confirm/fallback/refusal).

## NEXT EXACT TASK

Usage limit reached on 2026-10-02 after `8fd6efb` (approvals expiry test race fixed; CI on it not yet
confirmed). NXR-052a is merged (`979db5a`: keystore `CredentialRef`, resolver injection into pi and
DSH, ADR-022 amendment: keystore names = credential variable, clipboard-only key entry in main,
header-only non-generating key checks).

1. CI is verified green on current head `4c05cf2`, including the approval expiry race fix
   `8fd6efb` and NXR-052a `979db5a`. Begin NXR-052b from the current clean PR tip; do not revisit
   resolved Windows failures.
2. NXR-052b (interrupted, not committed): an unfinished attempt may remain in the disposable worktree
   `D:
exar-operating-wt` (branch `wip/operating`); treat it as untrusted scratch, re-dispatch from a
   clean worktree at the PR tip. Scope: `discovery.credentialSource: 'env' | 'keystore'` for
   discovered pi/DSH resources; Desktop `DesktopKeyStore` (`safeStorage`, `<userData>/credentials.json`,
   refuse without a real backend); `providers:list|saveKeyFromClipboard|removeKey` (no key value over
   IPC; main reads and clears the clipboard; config update + engine reload); Settings → Providers tab;
   leak tests over IPC, events and logs.
3. NXR-052c key checks (pi integration, documented model-listing endpoints, key in header); NXR-052d
   subscription sign-in commands (verify per pinned runtime).
4. Then NXR-055 Code lane, NXR-056 Cowork lane, NXR-053 behavior, integrated E2E.

## BLOCKERS

- A pending confirmation's run options (preferred resources, cost ceiling) live in memory; after a
  restart the owner can only decline it (`CONFLICT confirmation-expired`) and resend.
- In Code mode the Desktop chat area still shows the Code placeholder (existing E2E); revisit with
  NXR-055.
- `sessions:list` reads at most 200 sessions across projects before filtering; a reused process id
  can make a stale sessions lease look live (fails closed); a non-`CONFLICT` lease failure stops
  startup; a turn whose completion writes all fail stays `running` until the next restart.
- The `claude` CLI on this machine is not logged in, so the `claude-delegate` relay cannot run;
  Sonnet work used in-session Sonnet subagents in disposable worktrees.
- Windows descendants of an exited leader need a Job Object for containment. Write-capable
  engineering still requires WSL2/bubblewrap, with no native fallback.
- External config state-directory overrides still need their own ACL audit. Windows artifact storage
  requires hard-link support.
- WSL A1–A6, provider keys, OpenWorker reverse supervision and installer execution are not validated.

## OWNER ACTION

- Owner acceptance in [`windows-validation.md`](../guides/windows-validation.md), plus: a
  conversation survives a relaunch and continues; a Cowork "verify the repository" request asks for
  confirmation and shows the direct fallback; "Implement …" is refused while the Code lane is absent.
- Optional: `claude /login` so the `claude-delegate` relay works.

## LIVE TESTS PENDING

Installed Windows Desktop Cowork task with Claude Code; WSL A1–A6 and one engineering E2E; synthetic
OpenWorker Cowork E2E. Subscription tests remain opt-in. NXR-054 scheduled work and Mobile stay deferred.
