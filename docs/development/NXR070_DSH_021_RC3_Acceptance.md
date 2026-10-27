# DSH 0.2.1-rc.3 acceptance

Date: 27 October 2026. **Acceptance in progress. No aggregate Windows, WSL, packaged or rollback PASS is claimed by this preliminary record.**

Candidate branch: `feat/nxr-dsh-021-rc3-upgrade`, based on corrected C′ `f4c73bd6e62b35b4c28ac38531f536e41d6b22a7`. B′ remains on rc.2 `051000fedd7016efc52b0b34ed4b716d92497486`.

## Evidence collected

Subsequent Phase A standalone B′ acceptance passed on clean `dc4d89b983573131036c28740a904c48c8594e3f` / tree `6b812182583437b760531652c940054aedfb64f1`: all16 mandatory Windows Full stages,4530offline passed/167skipped/four pending, realDSH3/3, WSL8/8, source33/33, packaged33/33, GitleaksPASS. Raw B′ report `report-2026-10-27T02-53-54-830Z.json`, SHA256 `e3ff80ce946bdf71315363885b680c9524d8080e555a73b7cdf0dfcb4d3592ef`. This is rc.2 evidence, not rc.3 acceptance, and does not close the historical delay mechanisms.

The rc.3 Full attempt on clean `fe106fd9872a70aae5a78161f615539f8c684282` / tree `a59d46e08b3b472bb1521771484c52a145d70b73` **failed** at installation after180299ms. Report `report-2026-10-27T02-39-05-898Z.json`, SHA256 `7da65909f95aeb54b1bc04bb7512f739dca7e17aff8ad0436887a513e2895bbd`. Npm and version verification had completed by130384ms; both publication renames completed and recursive old-generation deletion was interrupted. The shared B′ correction retains previous generations outside the readiness path. It requires normal propagation and fresh rc.3 acceptance; later stage skips are not passes. The failed fixture's exact stale ownership file was archived and explicitly reconciled only after parent absence, stage absence, published identity and actual version verification. No product automatic stale-lock recovery was added; the partial old generation remains evidence.

The additional real SDK credential-precedence regression and its actual RED/GREEN results are described in the compatibility assessment. A valid saved foreign key displaced the selected key before the overlays disabled native credential/sign-in services; corrected execution used the selected key. The malformed first fixture is retained separately. This changes production/test code beyond fe106fd and requires final acceptance on the resulting source.

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

## Subsequent source-bound evidence

Implementation `3fa15d4860fe38a52574f6dfa5b8eee8e0507e77`, tree `1177bc61772c0c4281af8d4460cdca4d50239faf`, passed complete `pnpm check` before commit: 4,593 passed, 181 skipped, four pending, zero failed; 285,992 ms. Source stayed at that staged tree. Log SHA256 `2d3322b7abc48e5fe1b87cb6f5a5b6fecbd46ccbc6e989aeb9890c6d4ce49aa0`.

Matching isolated Linux source was promoted non-destructively to that same clean commit/tree, retaining the precommit snapshot in a stash. The actual Windows-to-WSL corpus passed all five tests: model/permission/draft round trip, read-only denial, cancellation, concurrent input isolation and disconnected-helper recovery. Log SHA256 `9cfd44cfe044e0eee8b5a3962b80df6c59fec4cbf2cbc697600e3f50f431f586`. Early helper fixture errors were preserved and corrected; they were not DSH production failures.

The disposable canonical-state rollback reader preserved identical connection, credential, Resource ID, completed session and memory identities through old→new→old code. A separate actual ACP campaign passed 3/3 tests on rc.2, 3/3 on rc.3 and 3/3 after restoring rc.2. Evidence directories: `dsh-rc3-state-rollback-20261027` and `dsh-rc3-runtime-rollback-stable-20261027`. The earlier incomplete runtime campaign stopped before rc.3 execution because a generated build directory was cleaned; it remains incomplete, not PASS.

The first Windows Full invocation at `3fa15d4` was **interrupted by engineering**, exit 130, during ESLint after discovering an SDK overlay compatibility gap. It passed the first three stages, including rc.3 installation in 141.72 seconds. Raw log SHA256 `7d9865c42143504fbb87dccfcbb246b5487d1085940dc2156771d0df11981d8f`. There is no aggregate PASS for that invocation. The SDK correction and its new actual-runtime test require updated acceptance.

## SDK follow-up

The SDK overlay regression failed before blocking the new shared-base rows and passed after correction. The real SDK fixture first failed to answer initialization within its 60-second test deadline (`dsh-rc3-real-sdk-first-20261027`, log SHA256 `4eb1fe6229fcb0bce6782d3dac8666b932a70e1abd85172a07cfe9a0844a7a60`). A diagnostic attempt then passed in 12,341 ms with no stderr and 24 offered tools. Temporary instrumentation was removed. Two predefined additional attempts passed in 5,921 ms and 4,839 ms, with log SHA256 values `bdf0b4e170e17000c877bbe9995fd70f20d1e4b67314898b157e77578a01b9bb` and `fe190f5fe4a7c7ca3aea737c6e74b753c61d451fd53e05f0b709fb29db439355`.

The wire protocol, explicit synthetic credential route and disabled new tool were exercised successfully. The original timing failure remains causally unresolved; these later passes are not a reliability correction. No production deadline, automatic retry or security policy was changed.

## Required outstanding gates

Real rc.3 ACP context/compaction, actual connection-bound execution and lifecycle protection, full offline check, source Desktop E2E, packaged runtime identity and E2E, one complete Windows Full CI, isolated WSL2 sandbox regressions, secret scanning, bounded repeatability, disposable rollback, Draft PR publication and independent owner acceptance remain pending until their executed evidence is appended.

No live provider credentials, sign-in or paid inference is authorized. WSL2 is not native Ubuntu acceptance. `win-unpacked` E2E is not a clean-machine NSIS installation. Later successful runs must not relabel historical failures.

## Separate Phase A status

The latest rc.2 B′ Full invocation at `754312a24b38fafd715c5ee093af72172764569f`/tree `e4aa52591dcf18c776e1bcf5c46f1d4d97b88583` failed at packaged Cowork SOW after installation passed in 90,168 ms. Report `report-2026-10-26T20-59-43-641Z.json`, SHA256 `3ec5b896001663902891ae5e1528e525598b6cc81ae3a4ebe8bf3e24cdc40014`, records 14 required passes, one required failure and one required skipped gate. Gitleaks was skipped, not passed. Source remained clean and stable. This candidate is authorized independently while Phase A acceptance remains incomplete.
