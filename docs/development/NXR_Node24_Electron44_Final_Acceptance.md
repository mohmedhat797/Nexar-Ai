# Node 24 / Electron 44 acceptance record

Status: **Node 24 fallback under qualification; Electron 44.10.1 security upgrade BLOCKED**. No Full or hosted PASS is claimed yet. This source-bound record will identify the exact tested fallback commit/tree and any documentation-only follow-up separately.

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

Rollback proof: old Node 22.23.3 ran baseline CLI help with exit 0. A synthetic canonical session and owner-confirmed memory record created by that baseline were read by Node 24 and again by Node 22 with identical file hashes. No real owner records were accessed for this fixture.

## Pending source-bound evidence

Windows Full in one clean invocation; WSL Full with stall observation; source and packaged Desktop identities/E2E; installer and runtime hashes; rollback; full security scan; hosted Windows/Ubuntu/security checks. No partial runs will be combined into a Full PASS. Failures, skips, artifact hashes and source stability will be recorded explicitly.

No live providers, real credentials, installed Desktop replacement or installed Plane deployment is authorized by this acceptance. Clean-machine installation/signing, G-13 and historical G-14 remain separately tracked.
