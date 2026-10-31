# NXR-070 post-merge integration acceptance

**Result: the merged baseline passes Windows Full and WSL, with one explained first-run WSL failure.** All results below are for `c97136b` unless a row says otherwise. Automated runs use synthetic credentials and local fake model endpoints. No real provider account was used in this acceptance.

## Windows Full

The runner returned `NEXAR_WINDOWS_FULL_PASS` itself. Nothing was aggregated by hand. The source stayed clean at the same commit and tree for the 53.5-minute run.

| Stage                                    | Result  | Seconds |
| ---------------------------------------- | ------- | ------- |
| Frozen lockfile                          | Pass    | 5       |
| Pinned DSH install and verification      | Pass    | 65      |
| Runtime artifact seal                    | Pass    | 16      |
| Prettier                                 | Pass    | 50      |
| ESLint                                   | Pass    | 321     |
| Boundaries and secret guard              | Pass    | 1       |
| Typecheck                                | Pass    | 46      |
| Offline tests: 4,635 passed, 173 not run | Pass    | 347     |
| Production build                         | Pass    | 4       |
| CLI smoke: resources, offline run        | Pass    | 1       |
| Real DSH context and compaction          | Pass    | 23      |
| Real isolated Cowork through WSL         | Pass    | 51      |
| Source Desktop E2E: 33 of 33             | Pass    | 435     |
| Windows packaging                        | Pass    | 1,376   |
| Packaged Desktop E2E: 33 of 33           | Pass    | 452     |
| Linux bubblewrap stage                   | Blocked | 0       |
| Gitleaks: 341 commits                    | Pass    | 2       |

The bubblewrap stage is optional on a Windows host because bubblewrap cannot run there. The WSL run below covers it, so it is not counted as a Windows pass.

## WSL2 and sandbox

| Run                         | Passed | Skipped | Failed | Note                             |
| --------------------------- | ------ | ------- | ------ | -------------------------------- |
| First run                   | 4,777  | 30      | 1      | Wall-clock jump in a timing test |
| Rerun, same commit and tree | 4,778  | 30      | 0      | Sampled the clock during the run |

These runs use an isolated checkout at the tested commit, and Windows Full uses its candidate helper. They do not exercise the Plane installed on this machine, which is out of date. See G-13 in the gap register.

**The failure.** `integrations/claude-code/src/adapter.test.ts` asserted that a timeout took under 2,500 ms using `Date.now`, and measured 2,596 ms. Vitest's monotonic timer recorded 327 ms for the same test, so the adapter met its deadline.

**The cause.** A sampler in the distribution saw the wall clock jump forward by 2,020 to 2,182 ms about every 32 s, plus three brief back-and-forth jumps of about 1.5 s. The failure's 2,269 ms excess is in that range. The failure itself was not reproduced on the rerun, but the mechanism was measured directly.

**The correction.** Three timing assertions a single jump could break now use `performance.now()`: two in that file and one in `apps/cli/src/plane.test.ts`. Product code and limits did not change. This test change is on the baseline branch, not in `c97136b`.

The 30 WSL skips are 25 Windows-only tests, which passed in the Windows run, and 5 opt-in live tests. No Plane-dependent test was skipped:

| Area                                                                              | WSL result |
| --------------------------------------------------------------------------------- | ---------- |
| Bubblewrap launcher: mounts, `.git` read-only, loopback only, proxy, process kill | 12 of 12   |
| Sandboxed harvest and Nexar-owned commit                                          | 2 of 2     |
| Real sandboxed DSH: hidden host files, drives, IPC, interop and network           | 2 of 2     |
| Real ACP handshake and session                                                    | 1 of 1     |
| Lane engine through sandbox and gateway                                           | 2 of 2     |

Comparing the two platforms by test name, only those 5 live tests passed on neither. They were not run and are not counted as passed.

## DSH `0.2.1-rc.5`

All of these ran the real managed runtime against a local fake model:

| Requirement                  | Evidence                                                                   | Result |
| ---------------------------- | -------------------------------------------------------------------------- | ------ |
| Initialization               | `local.real`: reports the pinned version as ready                          | Pass   |
| Session creation             | `acp/real` on WSL: opens and closes a session                              | Pass   |
| Model request                | `local.real`: Cowork turn through the Nexar route                          | Pass   |
| Streaming                    | `stdout-integrity.real`: reasoning excluded, tool events in order          | Pass   |
| Tool execution               | `local.real`: scratch write allowed, out-of-scratch write denied           | Pass   |
| Cancellation and termination | `stdout-integrity.real`: cancel mid-stream, stream parseable, runtime gone | Pass   |
| Error propagation            | `stdout-integrity.real`: rejected request without leaking the credential   | Pass   |
| Diagnostic separation        | `stdout-integrity.real`: JSON-RPC only when asked for resources            | Pass   |
| Credential secrecy           | `stdout-integrity.real`: saved upstream credential cannot replace Nexar's  | Pass   |

Real provider traffic: the owner ran a real DeepSeek check through the adapter on `de270f2`, part of the #46 stack. It passed 3 of 3 with no non-JSON lines. It was not repeated on `c97136b`.

## Startup reliability

The configured limit is 90 s. Times are `initialize` on the real runtime, with no credential and no model call.

| Case                                   | Windows        | WSL        |
| -------------------------------------- | -------------- | ---------- |
| First start in the measurement session | 16,705 ms      | 1,846 ms   |
| New runtime home, later starts         | 1,406–1,473 ms | 658–695 ms |
| Warm starts                            | 1,382–1,687 ms | 606–699 ms |
| Non-JSON stdout lines, all 18 starts   | 0              | 0          |
| Exit after cancel during startup       | 6–27 ms        | 40–199 ms  |
| Process still alive after cancel       | None           | None       |

The first Windows start took longer than the old 15 s limit. A new home was not the cause, because later new homes took about 1.4 s. This fits first-load cost on 27,826 files, but what adds that cost was not isolated. These are ordinary first starts, not a flushed file cache.

Timeouts classify as `EXECUTION_TIMEOUT` and kill the child in the fake-runtime tests. A real runtime that hangs during startup was not tested.

## Credential isolation

`connection-runtime.test.ts` runs the real managed DSH through persisted connections on both platforms. It sets a synthetic ambient `OPENAI_API_KEY` and a foreign `DSH_HOME`, and records the key that reaches the local provider.

| Requirement                         | Evidence                                                                 | Result |
| ----------------------------------- | ------------------------------------------------------------------------ | ------ |
| A uses Key A, B uses Key B          | Fake endpoint sees only the selected key                                 | Pass   |
| No key crosses connections          | A→B, built-in and forged scopes rejected at the guarded adapter          | Pass   |
| Native DSH cannot override          | Saved upstream credential test on the real runtime; foreign native store | Pass   |
| Ambient environment cannot override | Ambient key present; selected key still used                             | Pass   |
| Renderer cannot read secrets        | Preload and bridge schemas; `connections.e2e` synthetic A, B and C       | Pass   |
| Leases preserve identity            | Lease retained during a real turn, drained on Disable                    | Pass   |

## NXR-070B′

Test files: `connection-authority` 21, `connection-manager` 19, `connection-runtime` 13, `plan-binding` 10, `connection-consent` 5, contracts `connection` 33. All passed on both platforms.

Each of these is covered: creation, definitions, immutable identity, encrypted storage, replacement, rotation with active-execution guards, disable and enable, deletion, tombstones, recoverable persistence, leases, registry publication, NRC integration, account binding, safe fallback to built-ins, and sequential plan replacement.

**One divergence.** ADR-029 §6 and the execution plan describe rollback as "feature flag off". No such flag exists in the Desktop code. See the [gap register](NXR070_Operational_Acceptance_Gap_Register.md).

## NXR-070C′

`strategy-dimensions.test.ts` passed 43 of 43 on both platforms. `strategy.test.ts` passed 81 of 81.

| Requirement                       | Evidence                                                                                                 | Result |
| --------------------------------- | -------------------------------------------------------------------------------------------------------- | ------ |
| Three dimensions, two modes       | Full corpus: resource, connection, provider × preferred, required × satisfiable, unsatisfiable, unknown  | Pass   |
| Unknown never proves independence | Unknown connection or provider earns no credit; malformed identity rejected                              | Pass   |
| Unavailable fails explicitly      | Required and unsatisfiable yields no eligible resource, no downgrade                                     | Pass   |
| Dynamic revalidation              | Required dimension kept at execution and across disappearing resources                                   | Pass   |
| Ledger settlement                 | `engine-gateway/bridge.test`: identity kept across an in-flight allocation; ledger balanced across units | Pass   |
| Actual lane path                  | Lane planner to execution revalidation: passes on WSL only, needs the Plane                              | Pass   |

## Complete execution path

| Path segment                            | Evidence                                                                                 | Result |
| --------------------------------------- | ---------------------------------------------------------------------------------------- | ------ |
| Desktop to registry to NRC to admission | `connection-runtime`, `providers.e2e`, `orchestration.e2e`                               | Pass   |
| Connection credential to real DSH       | Real A/B test above                                                                      | Pass   |
| Tool execution and Permission Broker    | `local.real`, `dsh-cowork.real`, `gateway.test`                                          | Pass   |
| Settlement                              | `engine-gateway/bridge.test`, IntelligenceBridge tests                                   | Pass   |
| Canonical session and restart           | `sessions`, `cowork.e2e`, `acceptance.e2e`                                               | Pass   |
| Cancellation and timeout                | Real cancel test; adapter and ACP timeout tests                                          | Pass   |
| No alternate routing                    | Boundary check; execution tests reach adapters through NRC selection. Not a formal proof | Pass   |

**Not proven by this run:** a real provider account through Desktop routing or the Cowork gateway. That is scenario L2 in the gap register.

## Packaging

| Phase                             | Seconds |
| --------------------------------- | ------- |
| Build                             | 6       |
| Verified runtime artifact staging | 468     |
| Deploy                            | 15      |
| Electron Builder, including NSIS  | 851     |
| Packaged verification             | 33      |
| Total                             | 1,376   |

Separate from packaging, the DSH install stage took 65 s and sealing took 16 s. Electron Builder does not report NSIS on its own. Free space on `D:` went from 38.7 GiB to 36.2 GiB across the Full and later runs, and peak use was not measured.

Packaging used 92% of its 1,500 s limit, with no limit change. See risk G-07 in the gap register.

Packaged E2E ran `win-unpacked` with the bundled runtime and disposable profiles. **It does not prove a clean-machine NSIS install**, which remains an outstanding release gate.

## Rollback

| Check                                  | Result                                                          |
| -------------------------------------- | --------------------------------------------------------------- |
| Runtime: rc.2, rc.5, rc.2              | Real tests 3 of 3 at each step                                  |
| State: rc.2 seed, rc.5 read, rc.2 read | Connection, session and memory digests match; credential intact |

## Hosted CI

Run `41225379130` on `c97136b` succeeded: Windows, Ubuntu and secret scan. The runs on `8325ff0` and `f98da1d` were cancelled when later merges superseded them.

Hosted CI does not exercise the real sandbox on the local Plane, packaged E2E, real Cowork through WSL, or rollback. Hosted Ubuntu and local WSL2 are not interchangeable. Neither one is a native Ubuntu Full run.
