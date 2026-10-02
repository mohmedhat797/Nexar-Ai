# Operating Layer continuation

Branch: `feat/nexar-operating-layer` · Baseline: `9eaf725` (Desktop foundation, PR #35 merged).
Date: 2026-10-03.

The supplied folder was a source archive without `.git`. Its tracked contents matched GitHub main
exactly. Git history was recovered without changing source files; the feature branch was pushed.

## LAST COMPLETED

NXR-052e checkpoint adds keyless Local / Custom endpoint address-entry, edit/remove/rediscovery,
cached candidate model counts, strict public-URL main/preload IPC and serialized reload/rollback.
OpenAI-compatible discovery and execution now share one `/v1` API base for root, API-base, tenant
and trailing-slash forms; Ollama semantics are retained. Endpoint/network/UI validation is recorded
after the full gate below. No credential or arbitrary command fields are added.
Validation: full Windows pinned `pnpm check` passed: format, lint, boundaries (698 tracked files),
types, 2,592 tests passed / 122 skipped and build. Endpoint main/preload tests passed 88/88;
discovery/execution tests passed 30/30; Provider Electron E2E passed 1/1 (20.20 seconds), covering
server add/edit/refresh, busy controls, relaunch persistence/removal and existing conversations,
subscription controls and encrypted API keys. Independent integrated review found no blocker.
Allowance reached 96%; no further subsystem starts. Push this checkpoint immediately and inspect
its CI. Reset credits remain unused; NXR-055/056/053 remain unfinished.

NXR-052d implementation checkpoint: native Claude Code/Codex browser sign-in and safe account-status
ports, shell-free bounded process runner, runtime-only main/preload IPC, independent Subscription UI,
cancel/recheck/poll lifecycle, and explicit unsupported Antigravity authentication. No vendor
credential-store reads or login-output capture. Version/command research and browser/manual-terminal
limitations are recorded in `docs/research/upstream/native-subscription-auth.md`.

Continuation baseline verified on 2026-10-03: local HEAD, origin and draft PR #36 all matched
`4f63caaa50fda0c6ae877c8d8ae51f74d94f7637`. CI `37027946905` passed Windows, Ubuntu and secret scan;
NXR-052b/c and their CI repairs are complete. NXR-052d full Windows gate passed: pinned pnpm 10.33.0,
format, lint, boundaries (693 tracked files), types, 2,484 tests passed / 122 skipped and build.
Focused native/process/main/preload tests passed 151 / 1 platform skip; the real Electron Provider
E2E passed 1/1 (41.25 seconds) with fake native ports and preserved conversation/API-key checks.
All four source Electron E2E scenarios subsequently passed (91.38 seconds).
An independent integrated review found no remaining actionable issues after lifecycle and schema
fixes. Checkpoint `5b56a15` is pushed. CI `37070197604` passed Ubuntu and the secret scan; Windows
passed termination assertions but failed cleanup of the new auth process-tree fixture with `EBUSY`.
The follow-up adds bounded asynchronous test-directory removal retries without weakening process
assertions or production behavior. Recheck follow-up CI before further feature work.
The cleanup follow-up passed three focused Windows process runs (15 passed / 1 POSIX skip each),
then full pinned `pnpm check` again (2,484 passed / 122 skipped, format, lint, boundaries, types and
build). The lone fixture lint warning was removed. Source/production code remains at `5b56a15`.
No reset credits were used.
NXR-052d cleanup checkpoint `0ab5b79` then passed CI `37070938000`: Windows (including native and
packaged Electron E2E, installer packaging), Ubuntu and secret scan. Source and remote matched.
The following foundation delivery notes are historical.

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

**2026-10-03:** NXR-052d is implemented with offline native port/process tests and Provider Electron
E2E. Connected requires recognized vendor-account auth; API-key/injected-token modes cannot become
subscription-connected. Login success is re-probed. No real sign-in, paid generation or private
vendor state inspection was performed. Installed Claude public version metadata is 2.1.287.0;
installed Codex/Antigravity semantic versions remain unverified because the lean-ctx shell allowlist blocked
CLI execution. Default native CLI profiles are separate from custom resource binary/home settings.
NXR-052e delivers keyless Local / Custom address-entry; keyed custom resources retain their existing
explicit config credential path. NXR-052 remains live-unverified; acceptance
criteria now distinguish automated resolver/security evidence from real provider execution.

Claude Code handoff baseline (2026-10-02). PR #36 ("Nexar Desktop — Windows foundation and Operating
Layer integration", draft) was at `4c05cf28172224ac1468383a1c9ff0a0b46903c2`.

Codex continuation verification (2026-10-02): fetched origin; local HEAD, remote branch and PR #36
agree on that SHA, with a clean working tree. CI run `37012870983` passed Windows, Ubuntu and the
secret scan. The older Windows CI failures above are historical and resolved. Codex usage was
already 98% at takeover, so this checkpoint corrects the handoff without starting NXR-052b.

The allowance then reset naturally. Verification checkpoint `3dbb364` is pushed and its CI run
`37020551940` passed Linux, Windows and the secret scan. NXR-052b continues from that clean baseline,
without using the interrupted scratch worktree. The PR stays draft.

**NXR-052b:** Desktop `safeStorage` key store with call-time resolution, strict bounded encrypted
state, file/parent identity and link checks, serialized atomic writes, real Windows inherited ACL
tests, and refusal of insecure/unavailable Linux backends. Strict discovery source selection defaults
to `env`; Desktop setup selects `keystore` references without fallback. Clipboard-only main ingestion,
strict provider IPC inputs/outputs (also validated in preload), eight supported API provider rows and
Settings → Providers replace the placeholder. Config changes/reload/rollback share one queue across
provider and project mutations; existing conversations and pending approvals survive reload. Network
validity stays explicitly unchecked. Native login/local setup remain separate. Targeted security,
provider, preload and config tests pass. Native Windows Provider E2E passed (encrypted sentinel,
IPC leak checks, clipboard cleanup, removal, relaunch/conversation continuity and owner state
preservation). Full Windows `pnpm check` passed (2,267 tests / 121 skips, format, lint, boundaries,
types and build); all four source Electron E2E scenarios passed. The skips cover the existing
platform/live requirements plus unavailable Windows file-link privileges and POSIX mode checks.

**NXR-052c:** explicit metadata checks for eight API providers, owned by the pi integration with
header-only keys, no generation, no redirects, no retries/pagination, a five-second deadline and
64 KiB streamed response cap. Host resolves only the chosen keystore reference at call time;
main exposes normalized status through strict provider-only IPC. UI separates encrypted storage
from network authentication, disables controls while checking and resets results on key changes
or restart. Full Windows `pnpm check` passed: 2,333 tests / 121 skips, format, lint, boundaries,
types and build (archive `61c240bb45beb1ba`). The updated native Windows Provider E2E passed,
including busy controls and provider-only check IPC (archive `b5d21274615bcb83`). Fake HTTP tests
cover all endpoint mappings, status normalization, redirects, aborts, stalled headers/body,
malformed responses and byte caps; no real provider credentials or paid generation were used.
Allowance reached 89% after validation; reset credits remain unused. Finish this checkpoint and
verify CI before starting NXR-052d. PR #36 stays draft; owner acceptance remains pending.

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

**NXR-052 closure (2026-10-03, Claude Code):** PR #36 head `ba4a2c6`; CI run `37072932090` passed
Linux, Windows and the secret scan. NXR-052a–e are **implemented, offline-tested and CI-validated**;
real provider execution remains **live-unverified** and owner acceptance pending:

| Unit | Delivered                                                                             | Evidence                         | Live status                                      |
| ---- | ------------------------------------------------------------------------------------- | -------------------------------- | ------------------------------------------------ |
| 052a | keystore `CredentialRef`, resolver injection (pi, DSH), CLI `AUTH_REQUIRED`           | unit + adapter tests             | n/a                                              |
| 052b | `safeStorage` key store, clipboard-only ingestion, provider IPC, Settings → Providers | leak tests, Windows Provider E2E | real keys unverified                             |
| 052c | header-only, non-generating metadata checks for eight providers                       | fake HTTP tests                  | real checks unverified                           |
| 052d | Claude Code / Codex native browser sign-in, status probes                             | fake runtime tests, Provider E2E | real sign-in unverified; Antigravity unsupported |
| 052e | keyless owner-listed local / custom servers                                           | strict URL IPC tests             | real servers unverified                          |

## NEXT EXACT TASK

NXR-055 — Code mode through the WSL2 engineering plane (design first, then bridge, Code lane,
Desktop surface, offline E2E; A1–A6 and one real engineering E2E only on the owner machine).
Then NXR-056 Cowork/OpenWorker, NXR-053 behavior profiles, and the integrated Operating Layer E2E.
NXR-054 and Mobile stay deferred.

## BLOCKERS

- Native browser callback sign-in remains live-unverified. Null stdio supports browser callbacks,
  not interactive/manual codes; use the vendor terminal and Recheck for those flows. Antigravity has
  no verified standalone login/status command, so its login action remains unavailable.

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

- Optional live acceptance: Claude Code/Codex browser sign-in, cancel/deadline and Recheck with the
  installed CLI versions. Native auth is never copied to API providers. Manual terminal flows stay
  vendor-owned. Real provider-key metadata and DeepSeek execution remain optional live checks.

- Owner acceptance in [`windows-validation.md`](../guides/windows-validation.md), plus: a
  conversation survives a relaunch and continues; a Cowork "verify the repository" request asks for
  confirmation and shows the direct fallback; "Implement …" is refused while the Code lane is absent.
- Optional: `claude /login` so the `claude-delegate` relay works.

## LIVE TESTS PENDING

Claude Code/Codex browser sign-in; installed Codex/Antigravity semantic versions; real provider key
checks/DeepSeek execution; installed Windows Desktop Cowork task with Claude Code; WSL A1–A6 and one engineering E2E; synthetic
OpenWorker Cowork E2E. Subscription tests remain opt-in. NXR-054 scheduled work and Mobile stay deferred.
