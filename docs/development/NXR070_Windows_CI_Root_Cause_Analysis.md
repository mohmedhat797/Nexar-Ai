# NXR-070B′/C′ — Windows CI Root-Cause Analysis

> Latest disposition: C′80e70a60 Full Windows **FAIL** at packaged private-state startup (28/29). Earlier PASS results below are preserved history; the final-current-source section at the end is authoritative.

Execution: 2026-10-23–24, Africa/Cairo. Engineer: OpenAI Codex.

## Current conclusion

The Desktop scenario had inadequate timing margin, and shared teardown had a confirmed exit-observation gap. Those test-infrastructure defects are corrected. The native ACL test also failed before examining its captured initialization outcome; its diagnostics are corrected without changing the production ACL guard. **The underlying historical ACL failure remains unproven.**

During stabilization, a package deadline failure and a Plan sign-in setup failure were observed and preserved separately. A production callback completion-ordering defect was then established by deterministic RED tests and corrected on B′. Attribution of the observed Plan failure to that defect remains unproven.

## Source and chronology

| Run/evidence                         | Source                                                                                                | Actual result                                                                                                                                                    |
| ------------------------------------ | ----------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| report-2026-10-23T12-23-58-837Z.json | 1d059206f1fdbc7e2fb31a402f0673f9be07bd17, tree a9c6d4be72c7726aa85cd077fb99b2ca570b95c1; clean/stable | Full CI FAIL. Offline 4,524 passed, 169 skipped, 4 pending. Source Desktop 26 passed, 1 timeout at 120 s.                                                        |
| report-2026-10-23T12-52-38-795Z.json | Same clean/stable revision                                                                            | Full CI FAIL. Offline 4,523 passed, 169 skipped, 4 pending, 1 failed native marker assertion.                                                                    |
| bc-connections-diagnostic.log        | Starting published4c69766 plus diagnostic-only changes                                                | Original combined case made continuous progress and completed in 118.806 s, only1.194 s below 120 s. Restart close took327 ms.                                   |
| bc-connections-partitioned.log       | Stabilization working source                                                                          | Four connection cases passed in 176.47 s; split workflows approximately 56.016/62.464/42.193 s.                                                                  |
| report-2026-10-23T20-07-38-387Z.json | 2887939da04a57b705a077377c2093898ba9e242, tree b08e7ed316e04271dccbea7d154293c9aa9ff8ed; clean/stable | Full CI FAIL at package timeout1200.365 s/exit124. Offline 4,531 passed, 169 skipped, 4 pending; source Desktop 29/29 passed. Packaged E2E and Gitleaks skipped. |
| bc-pnpm-check-package-envelope.log   | Follow-up working source, before callback correction                                                  | Offline 4,530 passed, 169 skipped, 4 pending, 1 Plan connect() setup failure. The expired-token assertions were never reached.                                   |

All paths above are relative to the C′ worktree's `.nexar/ci`; Full CI JSON files are under `reports`. Historical failures remain failures.

## Desktop timeout and process lifecycle

The historical source E2E stage began12:37:49.977Z and lasted565.616 s. Its log is `logs/1792759069977-desktop-e2e-source.log`. Startup traces were retained, but no per-operation correlation identified the final blocked operation. Orphaned processes, stale leases or modal contamination are not established by that log.

The original case combined many persistent mutations and two launches under one120-second deadline. The diagnostic execution demonstrated almost no timing margin while making continuous progress. `apps/desktop/e2e/connections.e2e.ts` now uses independent profiles for publication/restart, credential lifecycle and tombstone/restore. Every original assertion and restart check remains; Plan replacement stays separate. Individual case limits remain120 s.

The expanded29-case source suite subsequently passed in 598.86 s; the CI subprocess took601.55 s. That independently demonstrates that the old600-second suite envelope was insufficient. Its replacement is900 s for source/packaged suites, without increasing individual deadlines.

The old shared harness killed a child without awaiting confirmed OS exit before reuse/removal. `process-lifecycle.ts` now observes exit, bounds forced termination and refuses cleanup if exit is unconfirmed. Disposal attempts every owned close, aggregates errors before profile deletion and preserves launch plus cleanup errors. Five lifecycle tests cover protocol-close/OS-exit differences, failed termination, already-exited children and a real synthetic child. This establishes the helper contract, not universal cleanup of all naturally detached descendants.

## Native ACL failure

The offline stage began12:56:09.791Z. The private-state file ran approximately 12:56:45.993Z–12:57:17.595Z; the failed fresh-root case lasted18,953.3869 ms. Historical line360 observed the marker absent; it failed before line361 inspected the stored initialization outcome. The production guard executes PowerShell synchronously before its first yield, with a15-second timeout.

Raw JSON `test-offline-1d05920-second-failure.json` and stage log `logs/1792760169791-test-offline.log` contain no underlying error category/phase/exit code, timeout evidence, owner/ACL snapshot, exact assertion timestamp or failure-time host metrics. Duration includes fixture creation and an earlier ACL snapshot. Timeout, antivirus, ownership and contention therefore remain hypotheses.

The corrected test captures marker presence before awaiting, reports only a sanitized `PrivateStateError.diagnostic` on failure, then enforces the captured synchronous assertion. Production ACL policy and15-second guard budget are unchanged. The new stale-marker test is placed after the existing fresh-root case, preserving historical ordering; it verifies that a marker does not authorize permissive ACLs.

Four concurrent independent fresh-root processes passed their selected cases (5.650/5.433/5.416/5.431 s). A four-worker offline diagnostic also passed 4,524 tests, skipped 169 and retained4 pending assertions. The first new Full CI private-state corpus passed 19, skipped 2 POSIX cases. None proves the historical cause corrected.

Native foreign-owner manipulation, every abnormal-termination interleaving and cleanup-during-startup were not demonstrated. Existing synthetic tool tests cover invalid-owner, timeout and unavailable-tool outcomes; native tests retain hard-link/junction and parent-ACL checks. No Windows identities or security settings were changed.

### Requested startup/security scenario coverage

| Scenario                             | Actual evidence and limit                                                                                  |
| ------------------------------------ | ---------------------------------------------------------------------------------------------------------- |
| Fresh initialization                 | Native fresh-root case passes; parent ACL unchanged and inherited private file checked                     |
| Repeated initialization              | Native stale-marker/reused-root case rechecks current ACLs                                                 |
| Concurrent startup                   | Four independent-root processes pass; same-root concurrent startup is NOT VERIFIED                         |
| Clean shutdown/restart               | Desktop connection profile restart passes; not a dedicated native ACL crash/restart campaign               |
| Abnormal termination/restart         | Synthetic child termination is tested; exhaustive private-state crash recovery is NOT VERIFIED             |
| Directory already exists             | Native reused-root and unrelated-nonempty-root refusal cases pass                                          |
| Marker already exists / stale marker | Native stale-marker case passes without trusting marker as current authorization                           |
| Inherited permissive ACL             | Native explicit/inherited broad child grant removal passes, preserving content                             |
| Invalid owner                        | Synthetic tool-boundary fail-closed case passes; native foreign-owner mutation NOT PERFORMED               |
| Symlink/junction attack              | Native root/nested/ancestor junction and hard-link refusal cases pass                                      |
| Temporary directory reuse            | Native reused-root case passes; unrelated owner profile never used                                         |
| Cleanup during startup               | Actual process-exit cleanup contract tested separately; every ACL initialization interleaving NOT VERIFIED |
| Normal non-elevated execution        | Current recorded Windows token is not elevated; complete candidate acceptance ran in this context          |

No timeout, expected permission assertion or production ACL behavior was weakened to obtain these passes.

## Package deadline

Raw report SHA256: `d46a1227013c09831dbfc890fb5516720842234c6316f4673aa5c123c041d748`. Package log `logs/1792787352794-desktop-package-win.log` reaches NSIS creation and “building block map.” The322,186,257-byte installer existed, but the package return/receipt had not completed before the20-minute deadline. Compressor progress, normal priority and artifact timestamps were observed; see `bc-package-observation-notes.md`. They do not establish antivirus or disk contention.

Incomplete artifacts were preserved under `package-2887939-timeout` and were not accepted. The package envelope was adjusted to25 minutes, retaining every identity/runtime/helper and packaged-E2E check. At that point, a complete subsequent invocation was required to verify the calibration.

The subsequent immutable C′ invocation at `1c584208c8580ef3d9ba94e510fb30c58d88796d` completed packaging in940.851 s and all16 required stages in2556.04 s: `report-2026-10-24T01-29-48-293Z.json`, SHA256 `4b159a579ec24caf96eaadd0070fe37c47c5c612eddf717b466f171bc48dc9e4`, **NEXAR_WINDOWS_FULL_PASS**. Source E2E passed 29/29 in498.598 s, packaged29/29 in451.143 s. Source connection phases took35.214/27.850/20.076 s;35 graceful owned-process exits were recorded with no forced exit. This verifies the corrected candidate's aggregate acceptance, without claiming package duration variance or the historical timeout's exact blocked operation has been eliminated.

### Retained Windows event evidence

The read-only, filtered metadata query `bc-historical-event-metadata.json` searched the Windows PowerShell and Application Error channels between2026-10-23T12:56:35Z and12:57:25Z. It returned no matching retained records. The oldest retained PowerShell record was2026-10-24T02:07:41.2859454Z, later than the failure. Thus this query cannot reconstruct the historical PowerShell exit/timeout cause; absence of a retained match is not evidence that no fault occurred. No event policy was changed and no unrelated event contents were printed.

### Reproduction limits

The deterministic callback barrier reproduced the pre-fix defect (three failures), and the clean-source acceptance test reproduced the missing preflight check. Process-lifecycle tests establish actual exit-observation and fail-closed cleanup semantics. The original ACL failure did not reproduce; its new tests improve diagnostic fidelity and preserve security rather than proving an unknown cause corrected. The combined E2E diagnostic demonstrated insufficient timing margin, not a proven historical stale lease or orphan. Synthetic cleanup/race tests therefore do not retroactively establish those as historical causes.

## Plan callback ordering

The Plan failure occurred at `service.connect()`, before expiry assertions, with a generic public error and652 ms case duration. Failure-only instrumentation records fixed phases, callback outcomes/exit and sanitized reason codes; it never records subjects, tokens or URLs. A fixed diagnostic batch passed without reproducing the failure, which is not a root-cause closure.

A separate source reviewer identified an actual ordering defect: `callback-server.ts` called `response.end()` and immediately published `onOutcome`; the child exits after forwarding that outcome to stdout. Stdout completion did not establish HTTP completion.

B′ now reserves the first callback synchronously and publishes it on HTTP `finish`. Three barrier tests deterministically failed before the fix; the final31-test focused corpus passed, including abort-before-finish. HTTP finish means handed to the OS, not proof of browser receipt. Host/path/state guards and single-outcome semantics are preserved. See B′'s `NXR070B_Callback_Response_Drain_Correction.md` for hashes and branch ownership.

## Windows/WSL and source integrity

Historical overlapping Windows/WSL runs had three EngineeringRunner timeouts; later serial WSL passed 4,668 with 29 skipped. Overlap is observed, but its precise causal mechanism was not established. This assignment runs acceptance suites serially; it does not install a machine-wide test mutex.

Full-mode preflight now requires a clean identified commit/tree, and completion compares source identity. The new dirty-source regression failed before implementation and passed afterwards. Mandatory stages, failure propagation and security gates remain required.

## Subsequent standalone B′ SOW failure

After the owner enabled the archive-copy command, B′'s existing installer and offline JSON were preserved with matching original hashes. A new Full invocation at clean `aa803793f5b4ec0ff2105b5f19b86f3a0bdb01c3`, tree `87667a254d6a2c42d02a78e07d9322e9b8c6fd97`, failed with28/29 source E2E cases passed. Unlike the original connection-management failure, this was the first Cowork SOW turn: `running` at its60-second completion-poll deadline, within a separate240-second case budget. The77.897-second case duration includes setup; the source stage lasted626.789 seconds.

B′ raw report `.nexar/ci/reports/report-2026-10-24T12-16-11-600Z.json`, SHA256 `303560463f7493e9a18c7ddcce5d35b681c75c500ee7c74fb4e51de952911b3b`; source start/end were clean and identical. Offline4478/167 skipped/4 pending/0 failed, real DSH3/3 and the isolated Cowork stage8/8 passed before source E2E. Packaging, packaged E2E and Gitleaks were not run after the mandatory failure. Its stage log and timestamped host snapshots remain preserved. This is an actual aggregate FAIL and is not replaced by the earlier C′PASS.

A single focused diagnostic invocation then passed the same unforced SOW in11.098 seconds, with5 unrelated cases filtered out. This did not reproduce or explain the failure. Inspection found that failure teardown removed session/delegation state after printing startup output, while a mutable shared output buffer could misattribute late output across launches. Test-infrastructure corrections now retain failed fixtures after still closing their processes, isolate each launch's output and capture bounded, content-free SOW progress. No completion timeout, production behavior, runtime pin or sandbox policy was changed.

The diagnostic corrections have deterministic behavior regressions: old behavior with only dependency-injection test seams gives1 passed/2 failed; corrected behavior gives3 passed. Separate controlled early/completed-turn failures verify actual Electron cleanup, retained evidence and prompt/argument absence from emitted progress; their expected failures are not acceptance passes. Full evidence is in B′'s `docs/development/NXR070B_SOW_Failure_Investigation.md`. The delayed/stalled step behind the actual SOW failure remains unknown; later validation must preserve that distinction.

The later B′ invocation at clean06e55f36/tree20b53990fb585e99ab4ed94001c72f4275b33a38 returned **NEXAR_WINDOWS_FULL_PASS**, all16 required stages, source29/29 and packaged29/29. Raw report `report-2026-10-24T13-20-25-499Z.json`, SHA256 `1cb1fea82daf65dad360cc25ae1ca7aca6b707b25916cb45c544d9524325b16c`. Its serial WSL full suite passed 4623, skipped 30 and had0 failed/pending. The final harness corpus has4 cases: a subsequent launch-rejection edge produced3 passed/1 failed with late failure registration and4 passed with registration before launch. These are diagnostic corrections and repeatability observations, not attribution of the earlier SOW stall.

**Open:** historical ACL cause, attribution of the intermittent Plan setup failure, and the standalone B′ SOW stall mechanism. Passing repetitions cannot manufacture missing failure-time evidence.

## Final current-source failure — packaged restart, 2026-10-24

The later diagnostic-source candidate is `80e70a60f2bd5c109c4a424002ea6af8bcd9b54e`, tree `9aa95dd150bff75aef1d0737520a5b61b6e9ee7d`. Its complete invocation returned **NEXAR_WINDOWS_FULL_FAIL** after3067.65 seconds. Start/end identities were clean and identical. Raw report `.nexar/ci/reports/report-2026-10-24T17-24-16-812Z.json`, SHA256 `0115e7c77e8ac5f71491efcb5fa1c4b9c4f57500cb9e17a3be649dbe0136155b`.

Fourteen required stages passed. Source Desktop passed 29/29; packaging passed 1236.24 seconds. Packaged Desktop passed 28/29 and failed `apps/desktop/e2e/cowork-isolated.e2e.ts:116`: restart after two successful real isolated Cowork turns and awaited close. ElectronPID27372 failed private-state initialization with `{"category":"timeout","phase":"startup","elapsedMs":15025}`. Gitleaks and the additional Linux-only stage were **SKIPPED** after the required failure, not passed.

### Confirmed observation and limits

The guard's synchronous Windows PowerShell child exceeded its15000 ms deadline without a captured `nexar-state-guard:ready` marker. That marker is emitted/flushed before state path resolution, identity checks, tree enumeration and ACL mutation (`apps/desktop/src/main/private-state.ts:39`, `:243`, `:377`). Missing captured readiness is not proof that script execution never began. This is not evidence of an ACL-policy rejection, credential leak, DSH failure or Bubblewrap bypass. No timeout or ACL expectation was changed.

The corrected harness retained `C:/Users/Mohamed Medhat/AppData/Local/Temp/nexar-e2e-code-XTwXjj/isolated-draft`. Its state marker was created18:10:05.189Z, before the failing restart. At later read-only inspection the root's access rules remained protected; that does not reconstruct the complete ACL at failure time.

Existing Windows PowerShell Operational metadata showsPID20248 event40961 at epoch1792865443860 and53504 at1792865451428, with no40962 or engine400 in the inspected18:09:30Z–18:11:10Z window. **Its parent relationship toElectron27372 was not established**, so these events remain circumstantial. Selected metadata is preserved in `.nexar/ci/bc-c-packaged-startup-observation-80e70a6.json`; full original event logging was not enabled or modified. An attempted metadata export was blocked by lean-ctx's Set-Content allowlist; the selected observation was written through the existing patch tool instead, without changing permissions.

A separate read-only reviewer found no concrete malformed invocation: absolute executable, NoProfile/NonInteractive, UTF-16LE encoded command, shell:false, explicit environment and bounded output. It recommended numeric childPID correlation rather than a timeout increase or retry. This review is not independent owner acceptance.

### Exact unresolved next step

Capture only numeric subprocessPID and correlate it with parentElectronPID, process creation time and existing PowerShell startup events; do not capture command arguments, environment, encoded script, private paths or credentials. Establish what prevents readiness, reproduce that mechanism deterministically, then make the smallest verified correction on B′ if shared production behavior changes and propagate it normally to C′. No such production correction is claimed here. The historical ACL-marker cause, historical Plan attribution and first B′ SOW stall mechanism also remain unproven. Later passing repetitions do not close them.

The same-source supplemental WSL full suite subsequently passed 4682/30 skipped/0 failed/0 pending; this does not convert the failed Windows aggregate into a PASS.

## Supplemental startup measurement and final check

After the Windows failure and all other heavy suites completed, a bounded diagnostic invoked the unchanged native guard on four fresh and four repeated synthetic directories using pinned Node 22.23.3: `node --experimental-transform-types .nexar/ci/native-startup-probe-80e70a6.mjs`. All eight calls exited0 with readiness captured,475–1,427 ms; none exceeded the production 15,000 ms deadline. Only the diagnostic observation bound was 60,000 ms. Numeric child and parent PIDs and start/end times were retained; no arguments, environment, script payload, credentials or private subjects were logged. Fixture roots remain preserved.

This is a **Node-parent measurement, not Electron or packaged acceptance**. It did not reproduce the delay and supplies no evidence for raising the production deadline. Production source, native guard deadline and ACL policy remain unchanged. Raw log SHA256 `07b1b02da7c2eb0cf123ce71df1dc254dc680d71e7fa4b5bd8f20e086f677124`; diagnostic script SHA256 `a00eca36e712e632482fbf5be3499389e860286985ab6411b93aba8dc5c19705`.

The final repository `pnpm check` completed successfully:4539 passed,169 skipped,4 pending,0 failed;232 files passed/17 skipped,226.00s test duration; format/lint/boundaries/typecheck/build passed. Log `.nexar/ci/bc-c-pnpm-check-final-publication-80e70a6.log`, SHA256 `50635445e67959ff5b432a16cb5e4a305f51ba6e619039cbffc8ad875ccca282`. Subsequent publication edits are documentation only and receive formatting/diff checks. This check and diagnostic do not replace the failed aggregate Windows gate.
