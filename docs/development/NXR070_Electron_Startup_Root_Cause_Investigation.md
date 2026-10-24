# NXR-070 — Targeted Electron Startup Investigation

Date: 2026-10-25, Africa/Cairo. Status: investigation in progress; no target root-cause closure claimed.

## Authoritative failure and checksum discrepancy

The last failed C′source is80e70a60f2bd5c109c4a424002ea6af8bcd9b54e, tree9aa95dd150bff75aef1d0737520a5b61b6e9ee7d. Its immutable report is `.nexar/ci/reports/report-2026-10-24T17-24-16-812Z.json` in the C′worktree. Actual SHA256 is `0115e7c77e8ac5f71491efcb5fa1c4b9c4f57500cb9e17a3be649dbe0136155b`,64characters, matching the prior publication receipt. The current owner's supplied literal checksum contains75characters and differs; the verified source report/receipt is authoritative.

That aggregate failed packaged E2E28/29 after source29/29, package construction and other preceding mandatory stages passed. At the second launch after two successful isolated Cowork turns and awaited close, Playwright's launch PID27372 (not an established main-process PID) was associated with timeout/startup/15025ms without captured readiness. Historical candidate PowerShellPID20248 was never causally tied to that parent. The retained disposable profile, original logs and reports remain preserved. No earlier ACL, Plan or SOW attribution is promoted to a confirmed cause.

## Preservation and toolchain

Main41b918bf, B′06e55f36 and C′c7eba797 were fetched and verified clean; PR44/45 remain OPEN/Draft and stacked. The C′original package tree was copied to `.nexar/ci/electron-startup-original-package-80e70a6`; installer SHA256036288eb56af7742ad921c9b07b6e4b8e4068eb190c253ffe60e0c8815821a4c verified. B′original installer is preserved at `.nexar/ci/electron-startup-original-06e55f36.exe`, SHA256a492694d549c14cc36c29ce70f53b947990cb9e9fb8ce49bd95f3e1e124090f8. All prior evidence and worktrees remain intact.

Node22.23.3, pnpm10.33.0, Electron44.5.1, Gitleaks8.28.0 and managed DSH0.2.0-rc.2 were reverified. The old research-workspace Node path is still required and was not moved or deleted. No credentials, real user profile, global Windows security settings or dependency pins were changed.

## Exact boundary and instrumentation

`main.ts` awaits private-state validation before `app.whenReady()`. The guard deliberately completes its native call synchronously before the first promise yield, preventing Chromium from creating unrecognized first-run state. That ordering, absolute Windows PowerShell executable, NoProfile/NonInteractive/UTF-16LE command, exact two-variable environment, hidden shell:false invocation,15000ms timeout and16KiB output bound remain unchanged.

The pinned Node implementation was inspected locally: `execFileSync` delegates to `spawnSync`, checks the result and returns stdout. The shared B′instrumentation retains the same synchronous primitive's numeric PID and safe status data. It adds bounded fixed script-phase records after flushing the existing readiness marker, including the child's own OS creation time and Stopwatch offsets. No new ACL, identity, filesystem or routing authority is introduced.

Parent/child IDs, wall-clock times, monotonic total duration, attempt/correlation IDs, exit code, sanitized signal and timeout classification are strictly allowlisted. Raw arguments, encoded script, environment, paths, exception output, prompts, responses, subjects and credentials are not retained on the diagnostic error. Parent creation is explicitly an uptime estimate. Live JS spawn/data callbacks and exact OS exit time are unavailable during synchronous execution and are marked unavailable; child-reported flush/phase times are not mislabeled as parent observations.

The existing Playwright launcher returns after early stderr may have been consumed. With the existing startup trace test flag only, the main process retains at most two safe records in a local closure. Existing trusted main-process inspection can read them using a gated EventEmitter readback; there is no renderer IPC channel, filesystem path parameter or mutation operation. Launch failure still returns the safe trace through `PrivateStateError`, even when Playwright cannot return an application handle. This closes an observability gap, not a proven explanation of the target delay.

## Predetermined reproduction scope

The frozen plan is `docs/development/evidence/nxr070-startup/campaign-plan.json`: two results per each of eight Node/source/packaged/restart/Cowork rows, serial isolated profiles and synthetic transport. Tests do not retry until green. Targeted runtime source/artifact identities and all results will be appended after execution. A passing Node probe, diagnostic regression or Full invocation cannot establish the original failure's cause.

## Current evidence and next execution

Initial working-source process tests passed11/11; existing native/private-state suite passed19 with2POSIX cases skipped. Strengthened Windows correlation/phase and error-propagation corpus passed32 with2POSIX skips, raw `.nexar/ci/electron-startup-instrumentation-correlated-20261025.json`, SHA256afd693132be4f0a5068af57ddb7dd3c880e282f7f2ebc9729f3ce533e43040d9. These are preliminary working-source instrumentation checks, not clean-source platform acceptance or target RED/GREEN proof. An initial lint rejection of a non-Error synthetic rejection was corrected; the log is retained. A readback typing error was corrected through the inherited standard EventEmitter API; no security behavior was weakened.

Next: validate the complete B′instrumented candidate, commit normally, propagate to C′, execute the predeclared real Electron/package matrix, correlate any failing native PID with narrow existing Windows event metadata, and implement only a demonstrated mechanism correction. Root cause remains **UNRESOLVED** until such evidence exists.

## Verified launcher identity and embedded runtime

Installed Playwright1.63.0 source enables a shell unconditionally on Windows before launching Electron. Its public application process handle therefore identifies the launcher, not necessarily the Electron main process. The initial controlled probe incorrectly compared these PIDs; it failed a diagnostic assertion after a successful expected native timeout, not because the target startup failure reproduced. Its raw report SHA256 is `42b499cecb561d5654ea9acec77607922fa094e6a410abbc61666ecfe5778535`; its fixture remains retained.

The corrected identity inspection reads actual main PID, parent PID and the OS creation timestamp supplied by Electron's app metrics, then verifies either a direct launch or the main-to-launcher parent relationship. A deterministic wrapper fixture failed against the equality assumption and passed with this correlation: RED1failed/4filtered, SHA256 `f4be6bfacf93a82b0160f93afce62c7d8578e5ddb97a9d2101e4aea22dd1cf6a`; GREEN1passed/4filtered, SHA256 `821c5e076c3de715904f8ac72fa07fe6c995f1c2905215fcf39d9b2eb08eb061`. This is proof of a diagnostic identity defect; it is not proof of the historical startup-delay mechanism.

A bounded corrected probe used the preserved original, uninstrumented C′package. Actual main10784 had parent6020, equal to the launcher6020, with creation1792884807819.425epochmilliseconds. Embedded runtime is Node24.21.0/Electron44.5.1/libuv1.52.1, distinct from the pinned Node22.23.3 acceptance runner. No dependency was changed.

Within that real Electron parent, controlled legacy execFileSync child22440 timed out after15033ms and spawnSync child18780 after15016ms, both using the unchanged15000ms bound. Both retained readiness in Buffer stdout and the alternative output slot, exposed native child PIDs, and left the known child absent after termination (PID/OS-birth query). The fixed child script only flushes a marker/time and sleeps; it does not validate ACLs or perform model work. These observations reject universal timeout-output loss as an explanation, while not excluding a scenario-specific failure.

Raw corrected probe `.nexar/ci/electron-runtime-original-packaged-api-correlated-20261025.json`, SHA256 `9fcaea9a15ca01e58216d9cc2575381710a4f33536f2df0455675d6eca882fe8`:1passed/3filtered. Function source hashes are9fe9bac0ce1a0b34ecd09c502d3462e4795c23500b4cba038b7602605e407029(execFileSync) and16a65ab14c3e6d6df23c115943cd1ffab1f42679939d2c285616e0ea42dfad7a(spawnSync); only hashes and approved fields were emitted, not function arguments or script payloads.

Read-only inspection of the original retained profile found7files/3directories/0links/13286bytes, maximum depth2. This is not evidence of a large persistent-tree delay and does not establish what happened before captured readiness.

The separate read-only review found no security weakening but correctly identified a timestamp naming issue: a failed process creation cannot have an observed child exit. The result now always labels nativeReturnedAtUtc and supplies exitObservedAtUtc only when a created child has an observed exit/signal. Exact OS exit and unavailable live callback times remain explicitly unavailable. No independently accepted root-cause correction is claimed.

A full B′working-source check before the identity correction passed4495/167skipped/4pending/0failed (231files passed/17skipped;175.42s tests), raw log SHA256 `4c0ffa4db2936f95e1edcde16dda7d76be4ca93c47c5e2b3f12f5347ead3dd7b`. Newly staged files passed boundaries at1088files. The later identity/timestamp corrections require a fresh final check before commitment.
