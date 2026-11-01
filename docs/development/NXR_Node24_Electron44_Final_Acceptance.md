# Node 24 / Electron 44 acceptance record

Status: **acceptance in progress; no Full or hosted PASS claimed yet**. This initial record is committed with the candidate source; final evidence will identify its exact tested commit/tree and any documentation-only follow-up separately.

## Completed staged checks

| Check                                 | Observed result                                                        |
| ------------------------------------- | ---------------------------------------------------------------------- |
| Official Windows/Linux Node artifacts | SHA-256 matched before installation                                    |
| Side-by-side Windows/Linux runtimes   | New 24.22.2 and old 22.23.3 both execute                               |
| pnpm                                  | Actual 10.33.0 on selected Windows Node                                |
| Frozen workspace install              | Passed; existing script allowlist retained                             |
| Targeted local-CI tests               | 36 passed                                                              |
| Linux acceptance-input tests          | 13 passed                                                              |
| Typecheck/lint                        | Initial new-test typing/lint errors corrected; subsequent gates passed |
| Production build                      | Passed under Node 24.22.2                                              |
| Windows managed DSH installation      | rc.5 CLI version verified under selected toolchain                     |
| Protected DSH manifest/lock           | No diff                                                                |

## Pending source-bound evidence

Windows Full in one clean invocation; WSL Full with stall observation; source and packaged Desktop identities/E2E; installer and runtime hashes; rollback; full security scan; hosted Windows/Ubuntu/security checks. No partial runs will be combined into a Full PASS. Failures, skips, artifact hashes and source stability will be recorded explicitly.

No live providers, real credentials, installed Desktop replacement or installed Plane deployment is authorized by this acceptance. Clean-machine installation/signing, G-13 and historical G-14 remain separately tracked.
