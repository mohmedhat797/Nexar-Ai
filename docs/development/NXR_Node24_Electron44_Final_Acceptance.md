# Node 24 / Electron 44 acceptance record

Status: **partial implementation, not accepted for merge/release; Electron 44.10.1 security upgrade BLOCKED; Windows Full failed packaging**. WSL Full passed on the final code candidate. Separate diagnostics never convert the failed Windows invocation into a Full PASS.

Retain accepted Electron 44.5.1 / embedded Node 24.21.0 under the owner's fallback rule, after the [focused compatibility investigation](NXR_DSH_Electron_Runtime_Compatibility_Investigation.md). Standalone Node 24.22.2 completed a real rc.5 ACP turn; Electron 44.10.1's native loader rejected its embedded fingerprint in both RunAsNode and genuine main-process contexts. The [dedicated-runtime proposal](NXR_DSH_Electron_Runtime_Decoupling_Implementation_Proposal.md) is separate unimplemented scope. No intentionally failing Electron dependency is the final deliverable.

## Completed staged checks

| Check                                 | Observed result                                                        |
| ------------------------------------- | ---------------------------------------------------------------------- |
| Official Windows/Linux Node artifacts | SHA-256 matched before installation                                    |
| Side-by-side Windows/Linux runtimes   | New 24.22.2 and old 22.23.3 both execute                               |
| pnpm                                  | Actual 10.33.0 on selected Windows Node                                |
| Frozen workspace install              | Passed; existing script allowlist retained                             |
| Targeted local-CI tests               | 37 passed                                                              |
| Linux acceptance-input tests          | 13 passed                                                              |
| Typecheck/lint                        | Initial new-test typing/lint errors corrected; subsequent gates passed |
| Production build                      | Passed under Node 24.22.2                                              |
| Windows managed DSH installation      | rc.5 CLI version verified under selected toolchain                     |
| Protected DSH manifest/lock           | No diff                                                                |

## Failed and interrupted evidence retained

1. Initial Windows invocation on `3bbec0a7f4e3f1f9c4c145350e57744f9789dc1c` stopped at sealing: `ARTIFACT_UNSAFE_PATH` correctly rejected a state junction alias. Later invocations name the canonical D: runtime directory. The guard is unchanged.
2. Two Windows invocations were deliberately interrupted before final acceptance to fix a linked-executable relaunch loop (`e61e71d`) and stale report label (`c797e54`). They are not combined into a Full PASS.
3. Clean Windows Full on `c797e544fa754626f528579703289fe8fe25dec7`, tree `10597e808b51e622f5d733dbc30af098ff34a5a0`, failed after 1,502.96 seconds. Stages 1–13 passed, including real Windows-to-WSL Cowork. Source Desktop E2E reported at least six DSH-backed failures and exceeded 900 seconds; packaging, packaged E2E and Gitleaks were skipped. The unsupported loader fingerprint was reproduced directly before any model request. Completed-stage totals exclude unfinished E2E and must not be read as zero E2E failures.
4. Initial WSL Full on the same candidate failed after 124.89 seconds with two fixture-mode assertions caused by the wrapper's restrictive umask. See [WSL evidence](NXR_Node24_WSL_Compatibility.md). No timeout, expected mode or production protection was changed.
5. Two clean Windows Full attempts on retained-Electron commit `32e21a1f81eeb90b634a04ef5f9671676b6244d8` failed at the existing 1,500-second packaging deadline (total 2,447.20 and 3,060.40 seconds). All preceding stages passed, including 34 source Desktop E2E tests. Packaged E2E and Gitleaks did not run, so neither invocation is a Full PASS. Runtime promotion alone took approximately 394 and 535 seconds; a same-volume runtime did not solve the deadline. These are packaging performance failures, separate from the rejected Electron fingerprint.

The subsequent build-only correction retains the synchronous artifact APIs, reuses one synchronous hash buffer, and adds four-worker bounded copy/hash APIs for Windows packaging. Copied bytes are hashed in the same pipeline, all active pipelines settle before failure returns, and publication remains conditional on the complete sealed tree digest. Post-packaging verification still independently hashes both actual and reference trees. No pin, integrity check, path guard, signing policy or CI timeout is relaxed. Targeted artifact regressions cover multi-chunk binary fidelity, missing/added/changed bytes, live-source mutation, interruption, alias/occupied-target rejection and diagnostic parity; 27 passed in 2.46 seconds after typecheck and targeted lint passed. Full qualification of the final source remains required.

A disposable full-size diagnostic copied 27,802 files / 497,578,774 bytes in 282.973 seconds and independently rehashed both trees in 178.746 seconds with a matching SHA-256 tree digest `250f55b00520b765417cbafd5bbd784f4d5e5360ae6a8e124fed9d67956bf4db`. The first 120-second verification probe expired; a separate bounded 600-second diagnostic completed. This diagnostic bound does not alter the 1,500-second packaging gate and is not a Full PASS.

Rollback proof: old Node 22.23.3 ran baseline CLI help with exit 0. A synthetic canonical session and owner-confirmed memory record created by that baseline were read by Node 24 and again by Node 22 with identical file hashes. No real owner records were accessed for this fixture.

## Final code qualification

Tested code commit: `c510db3d6bececc3e1d4291e75c16e2949a44dee`; tree `26a2c8babca43cc5107bb2521a8e7cc95e955548`; accepted base `6bc038021b66b8d093bad5a4fbd936794f048da3`. Both Full reports record identical clean start/end source identities and `sourceStable: true`. Later documentation-only commits do not inherit an exact-head Full PASS; the tested code identity remains explicit.

| Invocation                                                    | Result                                          | Evidence and limits                                                                                                                                                                                                                     |
| ------------------------------------------------------------- | ----------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Windows 11 Pro, x64, build 26300; Node 24.22.2 / pnpm 10.33.0 | **`NEXAR_WINDOWS_FULL_FAIL`**, 2,916.14 seconds | Stages 1–14 passed; stage 15 packaging exceeded 1,500 seconds. 4,693 passed, 169 skipped, 4 pending, zero reported failed tests across completed stages. Packaged E2E and Gitleaks were skipped. These totals exclude unexecuted gates. |
| Windows source Desktop                                        | **34 passed**, 12 files, 534.738 seconds        | Actual retained Electron main-process identity and DSH-backed workflows passed; this is not packaged acceptance.                                                                                                                        |
| WSL2 `nexar-plane`, x64; Node 24.22.2 / pnpm 10.33.0          | **`NEXAR_LINUX_WSL2_PASS`**, 403.75 seconds     | All 14 required stages passed: 4,836 passed, 39 skipped, zero failed/pending. Includes real context, Xvfb Desktop, native bubblewrap and full-history Gitleaks 8.28.0. Not native Ubuntu or installed-Plane deployment.                 |

The final Windows package phases were cumulative: build 11.201 seconds, clean 84.280, verified runtime 306.459, deploy 344.618. Promotion therefore took approximately 222.179 seconds, lower than earlier observations without solving the builder deadline. These different invocations are not a controlled throughput benchmark. The process reached installer/block-map generation but did not complete the packaging script's independent post-build verification/provenance publication. A setup executable's existence is not a successful package gate. No deadline increase, failed-test suppression, antivirus exclusion or machine-wide tuning was used.

The final independent WSL monitor observed 15,447 samples, maximum timer overrun 558.821 ms and maximum fsync 583.574 ms. No historical G-14 failure recurred, but **G-14 remains open**. **G-13 remains open** because installed Plane source/DSH were not deployed.

The four pending Windows assertions are the existing real-bubblewrap proxy tunnel, dispose cleanup, and gateway/bridge socket cases in `packages/sandbox/src/launcher.integration.test.ts`. Windows cannot run native bubblewrap. Linux Full separately passed the native sandbox stage; this does not make Windows's optional `linux-sandbox` stage pass or establish native Ubuntu parity. Other platform/live tests remain explicitly skipped; no real-account or paid-provider acceptance is claimed.

Raw local evidence is retained under this worktree's ignored `.nexar/`: `node24-windows-io-full.json/.md/.log`, `node24-linux-io-full.json/.md/.log`, `node24-linux-io-stalls.jsonl`, and the per-stage paths named by each JSON report. Evidence hashes and separate unpacked diagnostics are recorded below after verification.

## Remaining acceptance requirements

One complete Windows Full PASS remains required. Hosted Windows, Ubuntu and secret-scan outcomes must be checked against the exact published PR head; their run IDs and terminal results belong in the Draft PR acceptance block, avoiding a self-referencing tracked commit SHA. No partial runs will be combined into a Full PASS. Clean-machine installation, signing and owner acceptance remain separate release gates.

No live providers, real credentials, installed Desktop replacement or installed Plane deployment is authorized by this acceptance. Clean-machine installation/signing, G-13 and historical G-14 remain separately tracked.

## Independent unpacked-artifact diagnostic

After the failed Full process settled, a separate Node 24.22.2 diagnostic independently hashed every file in both the unpacked runtime and the canonical sealed reference. It completed in 325.629 seconds with `matches: true`, zero missing/extra/changed files, 27,802 files / 497,578,774 bytes and tree SHA-256 `250f55b00520b765417cbafd5bbd784f4d5e5360ae6a8e124fed9d67956bf4db`. Its own 600-second diagnostic bound does not alter a CI gate. An initial diagnostic script import resolved relative to the ignored state junction and failed before verification; the corrected diagnostic imports the source module by absolute worktree URL. No product guard changed.

The produced unpacked `Nexar.exe` is 245,726,208 bytes, SHA-256 `7b3c5a7a1b5b0ce04a074fda3c8ed098c9aba321d9f7de82e5afcdbcc28c5cbf`. The unqualified setup executable is 322,816,113 bytes, SHA-256 `f2671a6c58a002a3ef5a3107b13d3d3cf08dab90c94b1169a753253cbdf76814`. Both are **unsigned** (`Get-AuthenticodeSignature: NotSigned`); Builder log wording about signtool is not evidence of signing. The setup was not installed and is not an accepted release artifact. The script's final provenance publication/block-map gate did not complete inside Full.

Only after that independent integrity check, a separate bundled-only `pnpm desktop:e2e` invocation passed **34 tests in 12 files**, 728.63 seconds, with `NEXAR_DSH_ENTRY` and `NEXAR_DESKTOP_TEST_DSH_ENTRY` absent. The harness supplied only its packaged-runtime opt-in. This observes all existing Desktop scenarios against the produced unpacked app; it is not a fresh successful package stage, installed-app acceptance, or a Windows Full PASS.

Dedicated identity tests observed source PID 16024 / launcher 32376 at `D:\Nexar-Ai-main\.nexar\node24-migration\virtual-store\electron@44.5.1\node_modules\electron\dist\electron.exe`, and packaged PID 18104 / launcher 10476 at `C:\Users\Mohamed Medhat\.codex\worktrees\nxr-node24-electron44\Nexar-Ai-main\release\desktop\win-unpacked\Nexar.exe`. Both report Electron **44.5.1**, embedded Node **24.21.0**, Chromium **152.0.7977.130**, V8 **15.2.124.28-electron.0**, libuv **1.52.1**. The launching toolchain is separately verified Node **24.22.2**. These identities come from actual trusted-main observations, not package metadata.

| Local raw evidence under `.nexar/`    | SHA-256                                                            |
| ------------------------------------- | ------------------------------------------------------------------ |
| `node24-windows-io-full.json`         | `c71fbe805f7e208c2782545e484be6e581376ac996141a28df718fe8e5e6d59a` |
| `node24-windows-io-full.md`           | `60e0009491881c7e713aa4773270f828346b4b8193b22d8da74dff49e85982eb` |
| `node24-windows-io-full.log`          | `6e8f0791f788bfb132013f841b17635a7a2ede7cbbbe844d979c0225d9fc4574` |
| `node24-linux-io-full.json`           | `917f621d4ccd55ac6cb1591d3cacd1ef0e4aa73e3bcff482db3cf20034147ed4` |
| `node24-linux-io-full.md`             | `d21f390f4c4f3191f2a5a1e7b5e7709876a1932947ca8aa41b502508aef88e0d` |
| `node24-linux-io-full.log`            | `4e7bb988a3ac0a85082ef246a32679f2786b09d9f649bbb55530c726bbb7bc05` |
| `node24-linux-io-stalls.jsonl`        | `55a46e28d9120868927ad4638b6e0bd1661d32e57a0ac7747d68ca75c703e4f3` |
| `node24-unpacked-integrity-final.log` | `9afedd0a2d0c3e55a5ba9875083b3d99b34702a5e3c5c6ceeb96004f2cc28ff8` |
| `node24-unpacked-e2e.log`             | `6b6313aab68b6258eb687cf021051089618a7dd883215227e495bb1b40f0bf43` |
| `node24-standalone-acp-probe.log`     | `02e74fa5dfdce9a53116af7c7380977a68fecb298452a7859b1a9a8b44c13034` |
| `node24-electron-acp-probe.log`       | `e8d7c3a61ef2852c37e49f8c25cc04307576b7d707ffe86e6468ab76fcdc1ed2` |
| `node24-electron-main-probe.log`      | `b8981f1c763df52e3e2c17d9d05a0d33620f00e19393fa168faed7f20af75c15` |
| `node24-rollback-data.log`            | `c24f4dabda169775bf6acf9ece571990fb30796d3d2ef177d85b9f4e373e13b1` |

Windows packaging follow-up must first capture native builder/compressor/block-map process timing and CPU/I/O under a bounded isolated reproduction, with a controlled accepted-baseline comparison before assigning a Node regression. Preserve integrity checks and deadlines. Any justified correction needs a fresh single-invocation Full, fresh packaged E2E, provenance publication and security scan; diagnostics in this document cannot substitute for those gates.

## Publication and verdicts

[Draft PR 50](https://github.com/mohmedhat797/Nexar-Ai/pull/50), branch `feat/nxr-node24-electron44-security`, remains unmerged. Its acceptance block records the exact documentation/publication head, hosted Windows/Ubuntu/secret-scan run IDs and terminal results. Hosted checks are a separate authority and cannot erase the failed local Windows Full. PR 49 and the active D′ worktree are unchanged by this work.

| Area               | Verdict                                                    | Limit                                                                                                                     |
| ------------------ | ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| Node migration     | `NEXAR_NODE24_TOOLCHAIN_MIGRATION_INCOMPLETE`              | Implementation and execution paths evidenced; required Windows Full is not green.                                         |
| Electron security  | `NEXAR_ELECTRON44_SECURITY_UPGRADE_INCOMPLETE`             | **BLOCKED** by the unchanged rc.5 loader fingerprint; retained 44.5.1 exposure unresolved.                                |
| Windows Full       | `NEXAR_NODE24_WINDOWS_ACCEPTANCE_INCOMPLETE`               | Packaging deadline failed; separate unpacked E2E is not aggregation.                                                      |
| WSL                | `NEXAR_NODE24_WSL_COMPATIBILITY_VERIFIED`                  | Current isolated code/runtime only; not native Ubuntu or installed Plane.                                                 |
| Current DSH        | `NEXAR_DSH_RC5_NODE24_COMPATIBILITY_VERIFIED`              | Real synthetic standalone ACP/SDK, source/packaged Desktop and WSL paths; not Electron 44.10.1 or real-account inference. |
| Future DSH         | `NEXAR_DSH_ALPHA2_NODE_PREREQUISITE_READY`                 | Numerical engine prerequisite only; no alpha installed or qualified.                                                      |
| GitHub publication | `NEXAR_NODE24_ELECTRON44_DRAFT_PR_PUBLISHED`               | Draft publication only; hosted acceptance separately recorded on the exact head.                                          |
| Overall            | `NEXAR_NODE24_ELECTRON44_MODERNIZATION_PARTIALLY_COMPLETE` | No merge, release, deployment or full dual-upgrade acceptance.                                                            |
