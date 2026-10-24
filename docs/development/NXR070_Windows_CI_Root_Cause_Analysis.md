# NXR-070B′/C′ — Windows CI Root-Cause Analysis

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

The subsequent immutable C′ invocation at `1c584208c8580ef3d9ba94e510fb30c58d88796d` completed packaging in940.851 s and all16 required stages in2556.04 s: `report-2026-10-24T01-29-48-293Z.json`, SHA256 `4b159a579ec24caf96eaadd0070fe37c47c5c612eddf717b466f171bc48dc9e4`, **NEXAR_WINDOWS_FULL_PASS**. Source E2E passed29/29 in498.598 s, packaged29/29 in451.143 s. Source connection phases took35.214/27.850/20.076 s;35 graceful owned-process exits were recorded with no forced exit. This verifies the corrected candidate's aggregate acceptance, without claiming package duration variance or the historical timeout's exact blocked operation has been eliminated.

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

**Open:** historical ACL cause and attribution of the intermittent Plan setup failure. Passing repetitions cannot manufacture missing historical evidence.
