# NXR-070 — Electron startup root-cause investigation

Execution date: 25 October 2026. Repository: `mohmedhat797/Nexar-Ai`.

**Verdict: `NXR070_ELECTRON_STARTUP_ROOT_CAUSE_UNRESOLVED`.** The bounded actual Electron campaign did not reproduce the historical timeout. Safe process correlation and demonstrated fixture corrections were implemented, but no production delay mechanism was established. The original failed acceptance remains a failure.

## Authoritative failed source and preservation

The target failure belongs to C′ commit `80e70a60f2bd5c109c4a424002ea6af8bcd9b54e`, tree `9aa95dd150bff75aef1d0737520a5b61b6e9ee7d`. Raw report:

`.nexar/ci/reports/report-2026-10-24T17-24-16-812Z.json`

Its actual SHA256 is `0115e7c77e8ac5f71491efcb5fa1c4b9c4f57500cb9e17a3be649dbe0136155b` (64 characters), matching the repository publication receipt. The owner's supplied literal contains 75 characters and a duplicated segment. The verified report and receipt take precedence.

That invocation passed source Desktop E2E 29/29, packaging and preceding mandatory gates, then failed packaged Desktop E2E 28/29. After two successful isolated Cowork turns, restart failed with `{"category":"timeout","phase":"startup","elapsedMs":15025}` and no captured readiness. Gitleaks was skipped because the aggregate had already failed; it was not a pass in that invocation.

Historical PID `27372` identifies the Playwright launch handle, not an established Electron main process. Candidate PowerShell PID `20248` was never linked causally to the failing main process. Other historical event observations do not repair that missing relationship.

Original reports, logs, the retained disposable profile and package evidence remain intact. The original C′ package tree was copied to `.nexar/ci/electron-startup-original-package-80e70a6`. Its installer SHA256 is `036288eb56af7742ad921c9b07b6e4b8e4068eb190c253ffe60e0c8815821a4c`; original `app.asar` SHA256 is `ebdd2495313b4a7a2ab5df74c987bdc8b9b604da153b4381f20a7ba342611964`. B′'s original installer was preserved separately, SHA256 `a492694d549c14cc36c29ce70f53b947990cb9e9fb8ce49bd95f3e1e124090f8`. No retained failure profile, worktree or audit history was deleted.

## Actual startup boundary

The production path remains packaged Electron main → synchronous private-state initialization → absolute Windows PowerShell executable → readiness emission → tree/identity/ACL validation → successful private-state completion. The guard completes before the first promise yield. The invocation retains NoProfile, NonInteractive, UTF-16LE encoded command, explicit minimal environment, `shell:false`, a 16 KiB output bound and the 15,000 ms security deadline.

The former synchronous API did not expose the child PID to the caller. The implementation now uses the same synchronous native spawning facility through `spawnSync` so the caller can retain the numeric native child PID. This is an observability change, not evidence that the old API caused the historical timeout.

Allowlisted diagnostics record actual parent/child identity, monotonic elapsed time, separate wall-clock correlation and fixed script phases. The script includes its own process birth time and flushed readiness observation. Raw arguments, encoded script, environment, private paths, credentials, account subjects, prompts, responses, sessions and memory contents are excluded. No machine-wide auditing or unrestricted process tracing was enabled.

Because the call is synchronous, live spawn/data callbacks and exact OS exit time cannot be observed by the parent. The record names and `unavailableTimings` preserve those limits; native return is not misrepresented as an exact OS event.

## Bounded reproduction and timeline

The predetermined plan is `docs/development/evidence/nxr070-startup/campaign-plan.json`: two attempts per planned row, with every result retained.

| Sequence                                       | Observation                                                                                | Outcome                                                                     |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------- |
| Historical C′ target                           | Packaged restart after two isolated turns; no correlated native child identity             | Aggregate FAIL, 28/29 packaged                                              |
| Node fresh/reused state                        | Two real native-guard attempts; fresh/reused durations 884/484 ms and 842/452 ms           | Both passed; supplemental Node evidence only                                |
| Source Electron fresh/restart                  | Actual native guard and owned-main teardown                                                | Four focused cases passed                                                   |
| Packaged fresh/restart                         | Actual package, disposable profiles, native child correlation                              | Four focused cases passed                                                   |
| Packaged restart without Cowork                | Two predetermined restart attempts                                                         | Both passed                                                                 |
| Packaged restart after Cowork                  | Project setup, two actual isolated synthetic turns, close, verified main exit and restart  | Both passed; target failure not reproduced                                  |
| Original unmodified package cancellation probe | Both synchronous APIs launch an owned child emitting readiness then exceeding the deadline | Both timed out safely and retained readiness output; child absence verified |

Node/source and later packaged rows were separated by a user-resume gap of approximately 15 hours. They are not a contemporaneous controlled performance comparison.

The two exact post-Cowork restart observations were:

| Attempt | Electron main PID | PowerShell PID | Total    | Creation delay | Child birth → readiness | Readiness → completion |
| ------- | ----------------- | -------------- | -------- | -------------- | ----------------------- | ---------------------- |
| 1       | 18780             | 2580           | 4,199 ms | 14 ms          | 3,702 ms                | 431 ms                 |
| 2       | 4460              | 34488          | 4,241 ms | 2 ms           | 3,728 ms                | 466 ms                 |

Both captured readiness, all four fixed phases and exit zero. These timings locate successful startup work. They cannot identify the missing phase in the historical failed process.

The campaign package came from C′ `acf29da784ee2778235e80e19a1f2bbf58929b91`. Installer SHA256: `ee0be8e801b168caf792b1bb132f90923b21fdc892710b34e2677987f01a1022`. The actual packaged Electron runtime is Electron 44.5.1 with embedded Node 24.21.0/libuv 1.52.1; the acceptance runner separately uses pinned Node 22.23.3.

## Hypothesis assessment

| Hypothesis                                                                    | Evidence                                                                        | Conclusion                                                                         |
| ----------------------------------------------------------------------------- | ------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| Historical candidate PowerShell event belonged to failing Electron            | No numeric parent-child relationship was retained                               | Unproven                                                                           |
| The old synchronous API always loses readiness on timeout                     | Both APIs retained readiness in the original-package controlled probe           | Universal claim rejected; individual historical failure still unexplained          |
| A launcher process exit proves Electron main exit                             | Actual Windows shell/main identities differ                                     | False assumption demonstrated; harness corrected                                   |
| Profile reuse can begin before startup reservation                            | Deterministic concurrent fixture test exposed admission before reservation      | Fixture race confirmed and corrected; no causal link to target timeout established |
| Native install stalls are solely caused by deleting a prior runtime directory | Fresh-directory attempt still exceeded the unchanged 180-second installer limit | Sole-cause hypothesis rejected                                                     |
| Antivirus, Windows scheduling or general contention caused the target delay   | No causal measurement from the failed process                                   | Not established; no security settings changed                                      |
| Earlier ACL, Plan setup and SOW observations share this cause                 | No demonstrated linkage                                                         | Remain unresolved historical observations                                          |

No new global event-auditing policy was enabled. The historical event metadata lacks the necessary relationship; new successful native records supply correlation for their own processes only.

## Confirmed corrections outside target attribution

The actual Electron main identity is now captured and checked before a profile can be reused. Concurrent profile startup is reserved synchronously. Cleanup failures retain evidence and do not authorize another launch. These changes have deterministic RED/GREEN tests.

Subsequent validation also exposed an introduced trace-enabled unit double mismatch, fake PID publication ambiguity, and Antigravity cancellation bypass when fixture readiness failed. They were corrected without weakening security assertions, production deadlines or adapter behavior. The final fixture restoration uses `finally` so cleanup exceptions cannot leave mocks/environment installed.

C′'s later trace-enabled repository check also timed out in the complete connection-lifecycle scenario and in an Antigravity readiness wait. The connection test's mechanism was not established. The readiness failure demonstrated the separate cleanup bypass; it does not prove the cause of the readiness delay. Supported serialized worker execution is an acceptance configuration, not a claimed root-cause cure.

Detailed corrections, regression hashes and limits are in `NXR070_Electron_Startup_Remediation_and_Regression.md`. Current complete-run outcomes are in `NXR070_BC_Final_Windows_Acceptance.md`; individual passing stages are never combined into a synthetic aggregate PASS.

## Remaining decision and exit criterion

The historical delay cannot honestly be assigned to “before spawn,” “child initialization,” “readiness delivery,” or “after readiness” using the evidence that exists. The required classification is inconclusive.

Close the target finding only when a correlated failing observation or deterministic reproduction establishes the mechanism, a minimal correction addresses it, security-preserving regression evidence exists, and the corrected final source passes the full required acceptance. A successful rerun alone does not meet that criterion. Independent owner review and merge authorization remain separate gates.
