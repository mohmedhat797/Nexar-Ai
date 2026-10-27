# DSH 0.2.1-rc.3 acceptance

Date: 27 October 2026. **Acceptance in progress. No aggregate Windows, WSL, packaged or rollback PASS is claimed by this preliminary record.**

Candidate branch: `feat/nxr-dsh-021-rc3-upgrade`, based on corrected C′ `f4c73bd6e62b35b4c28ac38531f536e41d6b22a7`. B′ remains on rc.2 `051000fedd7016efc52b0b34ed4b716d92497486`.

## Evidence collected

| Gate                                | Observed result                                                                                         | Raw evidence in candidate `.nexar/ci/`                                                                                          |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| Published root tarball              | SHA512 matches npm; SHA256 `9a8f9493bfab8218215a8ca38ab8821e76dff63dc4fcb65841ef87c0aa277141`           | `dsh-rc3-published-artifact-20261027.json`                                                                                      |
| Frozen workspace dependencies       | Offline install passed; root workspace lock unchanged                                                   | `dsh-rc3-root-dependencies-offline-20261027.log`                                                                                |
| Runtime lock generation             | Exact rc.3, npm lock v3, published SRI; 153,928 ms                                                      | `dsh-rc3-lock-stage-20261027/generation.json`                                                                                   |
| Actual managed install              | PASS, 98,656 ms, real installed version rc.3                                                            | `dsh-rc3-first-install-20261027.json` and `.log`; log SHA256 `86f250243075e730d4e5d2f8b575b3638148273ab9c1a17e93c6688581482f7c` |
| Initial focused run                 | FAIL: new checkout lacked generated workspace exports; one overly specific validation-error expectation | `dsh-rc3-focused-initial-20261027.*`                                                                                            |
| TypeScript build                    | PASS, 17,849 ms                                                                                         | `dsh-rc3-typecheck-initial-20261027.json`                                                                                       |
| Shared agent home RED               | 0 passed, 2 failed before correction                                                                    | `dsh-rc3-agents-home-red-20261027.json`                                                                                         |
| First home correction attempt       | 13 passed, 1 failed; exposed env-sourced credential overwrite not yet refused                           | `dsh-rc3-private-homes-green-20261027.json`                                                                                     |
| Final focused home/input validation | 14 passed, 0 failed, 0 pending                                                                          | `dsh-rc3-private-homes-green-final-20261027.json`                                                                               |

Targeted tests above used Node 22.23.3 on Windows 11. They precede a committed candidate acceptance source and do not constitute clean-source Full CI. Later evidence must identify the exact implementation commit/tree, start/end clean status, toolchain, counts, stage results, report hashes and any changed source.

## Focused runtime integration

The pre-check focused corpus passed: **472 passed, 0 failed, 9 skipped**, 26 passed files and 4 skipped files, 57,017 ms. Evidence: `dsh-rc3-focused-precheck-20261027.*`; log SHA256 `c0b2af28b64ff1a21e3d6169dad2c67c2e2250710e4091b7005495d711cdf42a`. This includes the real rc.3 context corpus and actual two-connection ACP execution.

The new real ACP test uses normal persisted connection creation and inventory publication, not manually supplied owner descriptors. Synthetic transports observed A then B's own credential. An active B request refused rotation, Disable refused new admission while the authorized request drained, and the lease returned to zero. Captured ACP launch environments excluded the ambient provider key and both provider credential values; both runtime homes were private. The actual offered tool catalog excluded the newly disabled capabilities. This is actual managed-runtime integration with a synthetic provider, not live provider or OS sandbox acceptance.

Earlier attempts of that new test failed on fixture task/session ID wiring and were retained as failures. The corrected test uses production task creation and canonical session/turn ID factories. These attempts are not RED/GREEN evidence of a production routing defect.

## Required outstanding gates

Real rc.3 ACP context/compaction, actual connection-bound execution and lifecycle protection, full offline check, source Desktop E2E, packaged runtime identity and E2E, one complete Windows Full CI, isolated WSL2 sandbox regressions, secret scanning, bounded repeatability, disposable rollback, Draft PR publication and independent owner acceptance remain pending until their executed evidence is appended.

No live provider credentials, sign-in or paid inference is authorized. WSL2 is not native Ubuntu acceptance. `win-unpacked` E2E is not a clean-machine NSIS installation. Later successful runs must not relabel historical failures.

## Separate Phase A status

The latest rc.2 B′ Full invocation at `754312a24b38fafd715c5ee093af72172764569f`/tree `e4aa52591dcf18c776e1bcf5c46f1d4d97b88583` failed at packaged Cowork SOW after installation passed in 90,168 ms. Report `report-2026-10-26T20-59-43-641Z.json`, SHA256 `3ec5b896001663902891ae5e1528e525598b6cc81ae3a4ebe8bf3e24cdc40014`, records 14 required passes, one required failure and one required skipped gate. Gitleaks was skipped, not passed. Source remained clean and stable. This candidate is authorized independently while Phase A acceptance remains incomplete.
