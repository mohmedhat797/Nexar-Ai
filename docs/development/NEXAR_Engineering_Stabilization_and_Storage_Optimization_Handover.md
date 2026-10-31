# Nexar engineering stabilization and storage optimization handover

Date: 30 October 2026, updated 31 October for the rc.5 amendment. **Overall: NEXAR_ENGINEERING_COMPLETED_WITH_OUTSTANDING_GATES.** The DSH stack, now pinned to rc.5, is ready for your independent review. Nothing was merged.

**rc.5 replaces rc.3 as the target.** Sections 2 to 8 below record the 30 October rc.3 work as it happened, including its measured numbers. Current results are in the [rc.5 delta report](NXR070_DSH_RC5_Compatibility_and_Upgrade_Delta.md).

## 1. Executive summary

Windows Full, WSL Full and rollback pass on rc.5 at `cb4e2bb`, including real packaging and packaged E2E. rc.5 fixes a real stdout failure that rc.3 has. All eleven dependency advisories are corrected. The legacy directory is gone and about 23 GiB was recovered on 30 October. Hosted CI is green on PRs #44, #45 and the maintenance PR; PR #46's latest full result is for its rc.3-pinned parent, and the rc.5 result is in the PR description. The remaining gate is your independent acceptance.

## 2. Storage

| Measure           | Before    | After     |
| ----------------- | --------- | --------- |
| D: free           | 16.58 GiB | 39.82 GiB |
| Canonical logical | 42.69 GiB | 18.90 GiB |
| Canonical unique  | 38.07 GiB | 15.30 GiB |
| Files             | 1,471,220 | 508,202   |

The canonical reduction is real deletion, not relocation. Repeated `win-unpacked` copies were the largest cause; Git was 8 MiB of packs. Details, exact paths and items left for your decision are in the private `.nexar/workspace-maintenance/` reports.

31 October, rc.5 amendment: 528 MiB reclaimed on `D:`, and 2,002 MiB inside the WSL virtual disk, which does not return space to the host until the disk is compacted. `D:` free is 39.23 GiB. That is down from 42.1 GiB before rc.5 acceptance, because new runtime and package artifacts outweighed the cleanup.

## 3. Legacy directory

Removed through Git without force, after preserving 54 hashed files. Windows Full passed afterwards, proving nothing depends on it.

## 4. Toolchain

Node 22.23.3 and Gitleaks 8.28.0 now live in the stable toolchain directory, byte-verified. No version changed and global PATH was not modified.

## 5. Packaging correction

Packaging now consumes the sealed, tested runtime by hashing every byte it copies, and verifies the packaged tree against the seal. Tampered, partial or wrong-identity artifacts are refused. See the [architecture report](NXR070_DSH_Verified_Runtime_Packaging_Architecture.md).

**The historical cause is not proven.** The original lock now installs in about 65 s on the disk where it exceeded 180 s, so file count alone was not the cause. The failed run had about 2.2 GB free, which is a strong correlation, not a demonstrated mechanism.

## 6. Dependency security

**Correction, 31 October:** the count below is wrong. The data held eleven unique advisories, because five undici ones published on 27 October were missed. The same undici version fixes them. See the [delta report](NXR070_DSH_RC5_Compatibility_and_Upgrade_Delta.md).

196 audit records were six advisories. Exact overrides correct all of them; `npm audit` is clean. It also removes 56% of materialized files. **This is a decision for your review:** the runtime no longer matches upstream's own resolution, and undici and Zod have not met real provider traffic because no paid inference ran. See the [assessment](NXR070_DSH_RC3_Dependency_Security_Assessment.md) and [ADR amendment](../adr/030-dependency-security-amendment-dsh-021-rc3.md).

## 7. Windows acceptance

rc.5: `NEXAR_WINDOWS_FULL_PASS` on `cb4e2bb`: 4,634 tests passed, zero failed; source and packaged Desktop 33/33 each; Gitleaks PASS; installer SHA-256 `075dd074…`; package stage 1,388 s against the 1,500 s envelope.

rc.3, history: `NEXAR_WINDOWS_FULL_PASS` on `ab1ddda`: 4,629 tests passed, zero failed; source and packaged Desktop 33/33 each; Gitleaks PASS; installer SHA-256 `cc15c940…`. See the [acceptance report](NXR070_DSH_RC3_Final_Windows_Acceptance.md).

## 8. WSL acceptance

rc.5: WSL Full on `cb4e2bb`: 4,777 passed, 30 skipped, zero failed; real Bubblewrap 12/12. Rollback rc.2→rc.5→rc.2 passed at runtime and state level.

rc.3, history: WSL Full on `ab1ddda`: 4,772 passed, 30 skipped, zero failed; real Bubblewrap 12/12. Rollback rc.2→rc.3→rc.2 passed at runtime and state level. WSL2 is not native Ubuntu.

## 9. Git

| Reference      | Branch                              | State                                         |
| -------------- | ----------------------------------- | --------------------------------------------- |
| PR #44         | feat/nxr-070b-multi-api-connections | Draft, `b5848a1`: hosted CI fixes, still rc.2 |
| PR #45         | feat/nxr-070c-review-diversity      | Draft, `f8fde29`: merge of #44, still rc.2    |
| PR #46         | feat/nxr-dsh-021-rc3-upgrade        | Draft, rc.5 (the branch name stays as is)     |
| Maintenance PR | codex/workspace-maintenance         | Draft; cleanup utility and retention policy   |

Main is unchanged. There was no merge, force-push or history rewrite.

## 10. Remaining blockers and limits

| Item                       | Owner action or status                                                                                          |
| -------------------------- | --------------------------------------------------------------------------------------------------------------- |
| Independent acceptance     | **Yours.** This is the implementer's own verification                                                           |
| Hosted CI                  | **Green** on PRs #44, #45, the maintenance PR and PR #46's rc.3-pinned parent. rc.5 result: see the PR          |
| Live provider traffic      | Not run, by policy. ACP tests use a local fake model                                                            |
| Package stage margin       | Local: 910–1,692 s against a 1,500 s envelope, 1,388 s in the rc.5 run. Hosted step: 212 s. Envelope not raised |
| Clean-machine NSIS install | Not performed; would risk your real installation on this machine                                                |
| Historical 180 s cause     | Correlated, not proven                                                                                          |
| Local branch `wip/v06`     | 36 unpushed commits; preserved, please decide                                                                   |

Hosted results after the fixes (run 41144284645 at `c357590` on PR #46; run 41143789384 at `7488502` on the maintenance PR, whose three checks all pass):

| PR #46 job     | Step                 | Tests                     |
| -------------- | -------------------- | ------------------------- |
| windows-latest | Test                 | 4,636 passed, 162 skipped |
| windows-latest | Desktop E2E          | 31 passed, 2 skipped      |
| windows-latest | Packaged desktop E2E | 31 passed, 2 skipped      |
| ubuntu-latest  | Test                 | 4,770 passed, 32 skipped  |
| ubuntu-latest  | Desktop E2E          | 26 passed, 7 skipped      |

Earlier failures (30 October, runs 41073887311 and 41074704254) and what fixed them:

| Job            | Failure                                      | Cause                                                                                                                                                                                                                                 | Fix                                                                                                                                   |
| -------------- | -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| windows-latest | `wsl-cowork.real.test.ts`, 5 tests, both PRs | Requires the real `nexar-plane` WSL distro, which hosted runners lack. Inferred from the failure and consistent with the green run                                                                                                    | Plane-only tests skip when `RUNNER_ENVIRONMENT` is `github-hosted`. Local and self-hosted runs still fail if the plane is missing     |
| ubuntu-latest  | `connections.e2e.ts`, 4 tests, PR #46 only   | Playwright's Electron loader forces `--password-store=basic`, so `safeStorage` stayed unavailable. An earlier diagnosis here, "hosted Linux has no OS keyring", was wrong: bare Electron reached `gnome_libsecret` on the same recipe | CI opts in to a test-only entry that selects `gnome-libsecret` after the loader runs, using a throwaway keyring. The app is unchanged |
| secret scan    | Gitleaks, 7 findings, maintenance PR only    | The all-refs scan sees test fixtures on B′, and `main`'s config lacks B′'s allowlist. Values were inspected only in masked form                                                                                                       | The maintenance branch carries the same allowlist, which may cause a small merge conflict with B′                                     |

**What hosted CI does not cover:** the real plane. Hosted runs skip the plane-only Cowork and WSL tests, so those stay covered only by local Full. The fail-closed test for a missing helper still runs on hosted.

**PRs #44 and #45 now have real hosted results.** The fixes above were added to `b5848a1` and merged forward to `f8fde29` and `f7be98f`. All three jobs pass on each of them. Their earlier red checks, runs 40482032663 and 40482043084 on 27 October, never started a job because of an Actions budget.

## 11. Recommended next milestone

Review and accept this stack, and merge B′→C′→upgrade in order. Watch the first real provider use on rc.5. Measure NSIS compression if the local package stage keeps approaching its envelope.

## Verdicts

| Area                | Verdict                                              |
| ------------------- | ---------------------------------------------------- |
| Storage             | NEXAR_STORAGE_OPTIMIZATION_COMPLETED (23.24 GiB net) |
| Legacy directory    | NEXAR_LEGACY_NXR070_SAFELY_REMOVED                   |
| Toolchain           | NEXAR_TOOLCHAIN_MIGRATION_VERIFIED                   |
| Packaging           | NEXAR_DSH_RC5_PACKAGING_VERIFIED                     |
| Dependency security | NEXAR_DSH_RC5_DEPENDENCY_RISKS_DISPOSITIONED         |
| Windows             | NXR070_DSH_RC5_WINDOWS_FULL_CI_PASSED                |
| Integration         | NXR070_DSH_RC5_READY_FOR_INDEPENDENT_ACCEPTANCE      |
| Overall             | NEXAR_ENGINEERING_COMPLETED_WITH_OUTSTANDING_GATES   |
