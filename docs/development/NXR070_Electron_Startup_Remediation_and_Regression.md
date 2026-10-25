# Electron startup remediation and regression evidence

Audit and execution date: 25 October 2026. Milestones: NXR-070B′ and NXR-070C′.

## Conclusion

The historical packaged restart timeout has **not been causally explained or reproduced**. No production timing workaround has been introduced. The changes below improve safe attribution and correct demonstrated fixture defects; they do not constitute a verified fix for the historical 15-second timeout.

The PowerShell guard remains synchronous before the first promise yield, uses the same executable and invocation policy, and fails closed with the existing 15,000 ms deadline. Owner, ACL, junction, symlink, hard-link and atomic-publication policies remain authoritative. DSH remains pinned to `0.2.0-rc.2`.

## Production observability

`apps/desktop/src/main/private-state-process.ts` uses Node's synchronous native spawn result to retain the numeric child PID. The allowlisted `private-state-process@1` records contain parent/child PID, correlation ID, fixed phase names, timestamps, bounded elapsed durations, readiness capture, exit status and termination classification. Errors do not retain the original native exception, arguments, script, environment, output text or arbitrary exception properties.

The PowerShell script emits and flushes the readiness marker and four fixed phase records: `ready`, `tree-checked`, `acl-verified`, and `complete`. The parser validates their shape and child identity. Main-process trace retention is gated and bounded. Test readback uses the main-process event emitter; no renderer IPC, management listener or permission grant was added.

Synchronous execution imposes an explicit measurement limit: exact live spawn callbacks, first parent output callbacks and OS exit times are unavailable. `nativeReturnedAtUtc` is an observation of native return, not an invented OS exit event. A failed spawn is not labelled as a child exit. Successful native exit retains the previous security authority; absence of a diagnostic marker alone does not introduce a different ACL policy.

## Demonstrated defects and corrections

| Boundary                    | Demonstrated defect                                                                                                   | Correction                                                                                                                                                                     | Evidence and limitation                                                                                                          |
| --------------------------- | --------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------- |
| Electron PID attribution    | Playwright's Windows launcher PID may identify the shell rather than Electron main.                                   | Read the actual main PID, parent PID and application process creation time through trusted main evaluation; validate its relationship to the launcher.                         | Attribution regression: RED one failed, GREEN one passed. This corrects attribution, not the historical timeout.                 |
| Profile teardown            | Launcher exit alone did not establish that the actual main process had exited.                                        | Capture the main identity for each launch and verify its absence before profile release or reuse. A live, ambiguous or inaccessible PID retains the profile and fails cleanup. | Cleanup regression: RED five passed/two failed; final focused cleanup GREEN 18/18. No claim of universal descendant termination. |
| Concurrent fixture startup  | Two launches could enter the same profile before the first asynchronous reservation completed.                        | Reserve the profile synchronously before the first await; release only after verified cleanup.                                                                                 | Deterministic concurrent admission RED one failed. Included in the 18/18 corrected corpus.                                       |
| Trace-enabled unit double   | A new unit double returned process identity even for the trace-event request, causing seven offline failures.         | Distinguish the trace and identity requests; force tracing on in the fixture tests.                                                                                            | RED two passed/seven failed; GREEN nine passed. This was an introduced test defect, acknowledged and corrected.                  |
| Fixture failure cleanup     | Awaited cleanup could prevent restoration of mocks and environment.                                                   | Restore in `finally`, preserving the original cleanup exception.                                                                                                               | Read-only reviewer identified the gap. Final check evidence is recorded in the Windows acceptance report.                        |
| Antigravity failure cleanup | A readiness exception could bypass cancellation and leave the owned fake execution running during directory deletion. | Reuse the structured cancellation helper to abort and await execution on every body outcome; preserve both original and cleanup errors.                                        | Original check retained readiness timeout plus `EBUSY`. Positive-PID abort/fault tests cover owned-process cleanup.              |
| Fake PID publication        | An empty PID file could be interpreted as PID zero during publication.                                                | Require a positive safe integer and publish the fixture PID atomically.                                                                                                        | RED two passed/six failed; focused corrected Antigravity suite 47 passed/one skipped.                                            |
| OAuth timing measurement    | A wall-clock bound included fixture startup and process-tree cleanup, obscuring the response boundary.                | Observe the complete fixed synthetic OAuth line at the existing spawn seam and retain the four-second signal-to-rejection assertion.                                           | Setup and response durations are recorded separately. No production adapter timeout or authentication behavior changed.          |

## Packaged verification

The predetermined two-attempt campaign exercised Node fresh/reused state, source fresh/restart, packaged fresh/restart, packaged restart without Cowork, and packaged restart after two isolated synthetic Cowork turns. All planned rows completed successfully. The exact Cowork scenario included project setup, two actual isolated turns and a final restart.

The final packaged restart observations were Electron main PID `18780` → PowerShell PID `2580` in 4,199 ms, and main PID `4460` → PowerShell PID `34488` in 4,241 ms. Both captured all four phases, readiness and exit zero. These observations establish parent-child attribution for successful runs. They do not retroactively identify the uncorrelated historical processes or prove the cause of their delay.

The original unmodified package was also tested with a controlled, owned native child that emitted readiness and exceeded the deadline. Both `execFileSync` and `spawnSync` retained readiness output and terminated the owned child. That rejects a universal claim that the former API always loses timeout output; it does not rule out a particular historical output or scheduling failure.

The package used for this supplemental campaign was built from C′ `acf29da784ee2778235e80e19a1f2bbf58929b91`. Installer SHA256: `ee0be8e801b168caf792b1bb132f90923b21fdc892710b34e2677987f01a1022`. The corresponding `app.asar` SHA256 is `cacfd704e100a2a0a37c2372ee34bb15c02861912e26b18a0958aa023ef1013e`. Later acceptance results must retain their own source identity.

## Regression evidence

Raw evidence is retained under the relevant worktree's `.nexar/ci/`; hashes below identify immutable observations, not an aggregate acceptance result.

| Observation                                      | SHA256                                                             |
| ------------------------------------------------ | ------------------------------------------------------------------ |
| Main-process attribution RED                     | `f4be6bfacf93a82b0160f93afce62c7d8578e5ddb97a9d2101e4aea22dd1cf6a` |
| Main-process attribution GREEN                   | `821c5e076c3de715904f8ac72fa07fe6c995f1c2905215fcf39d9b2eb08eb061` |
| Owned-main cleanup RED                           | `daa694924b4cf4d80b6ea4eb98bf9a4fc180eac47ae2f5e8b64587bbf607e4ab` |
| Concurrent-profile admission RED                 | `ca04a6cc95dd35506782cfcfb763e2b0c6a2f2a397e415831ba487b1201cc2f2` |
| Focused cleanup GREEN, 18/18                     | `403db8f6acd4c60026a3841cb341896c86bc4e225c3bf75826b9c8d433684f93` |
| Trace double RED                                 | `4320d13e3755fc0b7a86939c82325ea4eb137fcd386c874e402525db3fd12a9c` |
| Trace double GREEN, 9/9                          | `46b0e611b7b154597343b0cd0815de05f759d219df6f79a2478d3518cd780caf` |
| Antigravity PID readiness RED                    | `3e43ecea4e40f6ee8a7d69019a27fa1f6abf04d81178b744d73d7e8759994887` |
| Antigravity focused GREEN, 47 passed/one skipped | `54128a1385e89260f641345552f1cf0fc7ed98ee16207ea51c0c5e4409a871f4` |
| Original-package controlled cancellation         | `9fcaea9a15ca01e58216d9cc2575381710a4f33536f2df0455675d6eca882fe8` |

## Acceptance limits

See `NXR070_BC_Final_Windows_Acceptance.md` for the final source-bound stage outcomes. An isolated E2E pass, a successful package or a Node-parent probe does not repair a failed aggregate report. A `win-unpacked` E2E run is not a clean-machine NSIS installation test. No live provider, personal profile, paid inference, OS policy modification, runtime upgrade or owner acceptance is implied.

The next root-cause assignment should consume the bounded evidence already collected. It should require a correlated failing Electron/PowerShell observation or a deterministic mechanism tied to the historical failure before proposing a production timing correction. Repeated successful reruns alone cannot close this finding.
