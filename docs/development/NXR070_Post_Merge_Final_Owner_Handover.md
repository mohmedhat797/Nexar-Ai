# NXR-070 post-merge final owner handover

**Overall: `NEXAR_POST_MERGE_BASELINE_ACCEPTED_WITH_LIMITATIONS`.** `main` at `c97136b` passes automated acceptance on Windows and WSL, and D′ can start. Nothing here proves the system with real accounts or on a clean machine.

## Verdicts

| Area            | Verdict                                    |
| --------------- | ------------------------------------------ |
| Repository      | `NEXAR_MAIN_BASELINE_VERIFIED`             |
| Toolchain       | `NEXAR_DEVELOPMENT_ENVIRONMENT_VERIFIED`   |
| DSH             | `NEXAR_DSH_RC5_INTEGRATION_VERIFIED`       |
| Resource Fabric | `NXR070_RESOURCE_FABRIC_BC_VERIFIED`       |
| Windows         | `NEXAR_POST_MERGE_WINDOWS_FULL_PASS`       |
| WSL             | `NEXAR_POST_MERGE_WSL_ACCEPTANCE_VERIFIED` |
| Security        | `NEXAR_POST_MERGE_SECURITY_VERIFIED`       |
| NXR-070D′       | `NXR070D_IMPLEMENTATION_READY`             |

## What you should know

- **WSL failed once before it passed.** The first run had 1 failed test out of 4,808. A rerun on the same commit passed with 4,778 passed and 30 skipped. The failure came from the WSL wall clock jumping about 2 s, not from the product. Three test assertions now use a monotonic clock. That change is on this branch, not in `c97136b`.
- **WSL also failed once on this branch.** On `75833a3`, one of three runs timed out in a different test, then two runs passed with 4,778 passed and 30 skipped. The cause is not proven, so WSL Full should be treated as intermittent. See G-14 in the gap register.
- **The Windows bubblewrap stage is blocked by design.** It cannot run on Windows, and WSL covers it instead.
- **Real provider traffic is limited.** Your real DeepSeek check ran through the adapter on an earlier commit in the same stack. Nothing has gone through Desktop routing or the Cowork gateway with a real account.
- **Packaging took 92% of its time limit**: 1,376 s of 1,500 s. It passed, and the limit was not changed.
- **Your installed Plane is out of date.** It still has DSH `0.2.0-rc.2` and an older Nexar build, so Cowork through the default Plane refuses to run until it is updated. WSL acceptance used isolated checkouts, not this install. See G-13 in the gap register.
- **No code defect was found in the product.**

## Your actions

1. **Revoke the DeepSeek key** that was exposed in the transcript and terminal, if you have not already.
2. **Review and merge the Draft PR** for this branch.
3. **The two D′ questions are decided.** You accepted both recommendations for the rollback control and minimum UI, recorded in [section L of the D′ package](NXR070D_Implementation_Readiness_Package.md).
4. **Decide how to update the installed Plane** before L4 and L5. No documented procedure exists yet.
5. **Run the owner scenarios L1–L8** in the [gap register](NXR070_Operational_Acceptance_Gap_Register.md) when you want real-account evidence. All are pending, and most use small amounts of paid inference.

## Not done

- Clean-machine NSIS install, code signing and native Ubuntu Full.
- Any real-account login or paid inference in this work.
- D′ implementation. No Codex homes were created.
- Cleanup. Worktrees, local-only commits and retained evidence were left untouched.

## Acceptance gates

| #     | Gate                                       | Result                                |
| ----- | ------------------------------------------ | ------------------------------------- |
| 1–2   | Main SHA verified, merged features present | Pass                                  |
| 3     | Worktrees healthy                          | Pass                                  |
| 4–5   | Toolchain verified, no legacy dependency   | Pass                                  |
| 6     | Disk sufficient                            | Pass: `D:` 36.2 GiB free              |
| 7–8   | DSH identity, ACP                          | Pass                                  |
| 9–11  | Credential isolation, B′, C′               | Pass with synthetic credentials       |
| 12–14 | Windows Full, source E2E, packaged E2E     | Pass                                  |
| 15    | WSL                                        | Pass on rerun; intermittent, see G-14 |
| 16    | Gitleaks                                   | Pass                                  |
| 17    | Runtime rollback                           | Pass                                  |
| 18–20 | Limitations, documentation, D′ readiness   | Done                                  |
| 21    | Source-bound evidence preserved            | Pass                                  |
| 22    | No unauthorized deployment                 | Pass: nothing deployed or installed   |

Current status lives in the [status page](NEXAR_Current_Development_Status_2026-10-31.md).
