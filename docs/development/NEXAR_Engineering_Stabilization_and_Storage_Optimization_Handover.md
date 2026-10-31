# Nexar engineering stabilization and storage optimization handover

Date: 30 October 2026, hosted CI result updated 31 October. **Overall: NEXAR_ENGINEERING_COMPLETED_WITH_OUTSTANDING_GATES.** The DSH rc.3 stack is ready for your independent review. Nothing was merged.

## 1. Executive summary

Windows Full now passes on exact source, including real packaging and packaged E2E. All six dependency advisories are corrected. The legacy directory is gone and about 23 GiB is recovered. Hosted CI is now green on this PR and the maintenance PR, including hosted Windows packaging and packaged E2E. The remaining gate is your independent acceptance. PRs #44 and #45 show red, but their jobs have never run; see section 10.

## 2. Storage

| Measure           | Before    | After     |
| ----------------- | --------- | --------- |
| D: free           | 16.58 GiB | 39.82 GiB |
| Canonical logical | 42.69 GiB | 18.90 GiB |
| Canonical unique  | 38.07 GiB | 15.30 GiB |
| Files             | 1,471,220 | 508,202   |

The canonical reduction is real deletion, not relocation. Repeated `win-unpacked` copies were the largest cause; Git was 8 MiB of packs. Details, exact paths and items left for your decision are in the private `.nexar/workspace-maintenance/` reports.

## 3. Legacy directory

Removed through Git without force, after preserving 54 hashed files. Windows Full passed afterwards, proving nothing depends on it.

## 4. Toolchain

Node 22.23.3 and Gitleaks 8.28.0 now live in the stable toolchain directory, byte-verified. No version changed and global PATH was not modified.

## 5. Packaging correction

Packaging now consumes the sealed, tested runtime by hashing every byte it copies, and verifies the packaged tree against the seal. Tampered, partial or wrong-identity artifacts are refused. See the [architecture report](NXR070_DSH_Verified_Runtime_Packaging_Architecture.md).

**The historical cause is not proven.** The original lock now installs in about 65 s on the disk where it exceeded 180 s, so file count alone was not the cause. The failed run had about 2.2 GB free, which is a strong correlation, not a demonstrated mechanism.

## 6. Dependency security

196 audit records were six advisories. Exact overrides correct all of them; `npm audit` is clean. It also removes 56% of materialized files. **This is a decision for your review:** the runtime no longer matches upstream's own resolution, and undici and Zod have not met real provider traffic because no paid inference ran. See the [assessment](NXR070_DSH_RC3_Dependency_Security_Assessment.md) and [ADR amendment](../adr/030-dependency-security-amendment-dsh-021-rc3.md).

## 7. Windows acceptance

`NEXAR_WINDOWS_FULL_PASS` on `ab1ddda`: 4,629 tests passed, zero failed; source and packaged Desktop 33/33 each; Gitleaks PASS; installer SHA-256 `cc15c940…`. See the [acceptance report](NXR070_DSH_RC3_Final_Windows_Acceptance.md).

## 8. WSL acceptance

WSL Full on `ab1ddda`: 4,772 passed, 30 skipped, zero failed; real Bubblewrap 12/12. Rollback rc.2→rc.3→rc.2 passed at runtime and state level. WSL2 is not native Ubuntu.

## 9. Git

| Reference      | Branch                              | State                                       |
| -------------- | ----------------------------------- | ------------------------------------------- |
| PR #44         | feat/nxr-070b-multi-api-connections | Draft, unchanged `ae8a46b`                  |
| PR #45         | feat/nxr-070c-review-diversity      | Draft, unchanged `46aa3c2`                  |
| PR #46         | feat/nxr-dsh-021-rc3-upgrade        | Draft, updated                              |
| Maintenance PR | codex/workspace-maintenance         | Draft; cleanup utility and retention policy |

Main is unchanged. There was no merge, force-push or history rewrite.

## 10. Remaining blockers and limits

| Item                       | Owner action or status                                                                                             |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| Independent acceptance     | **Yours.** This is the implementer's own verification                                                              |
| Hosted CI                  | **Green** on PR #46 and the maintenance PR; PRs #44 and #45 have never run. See below                              |
| Package stage margin       | Local: 910–1,692 s against a 1,500 s envelope, 1,324 s in the passing run. Hosted step: 212 s. Envelope not raised |
| Clean-machine NSIS install | Not performed; would risk your real installation on this machine                                                   |
| Historical 180 s cause     | Correlated, not proven                                                                                             |
| Local branch `wip/v06`     | 36 unpushed commits; preserved, please decide                                                                      |

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

**PRs #44 and #45 have no real hosted result.** Their red checks come from runs 40482032663 and 40482043084 on 27 October, at `ae8a46b` and `46aa3c2`. No job started: each has zero steps and the annotation "The job was not started because an Actions budget is preventing further use". Neither branch contains the fixes above, so a re-run would probably hit the Windows and Linux failures on the table. That is a prediction, not a result.

## 11. Recommended next milestone

Get real hosted results for PRs #44 and #45, since they merge first. Then review and accept this stack, and merge B′→C′→upgrade in order. Measure NSIS compression if the local package stage keeps approaching its envelope.

## Verdicts

| Area                | Verdict                                              |
| ------------------- | ---------------------------------------------------- |
| Storage             | NEXAR_STORAGE_OPTIMIZATION_COMPLETED (23.24 GiB net) |
| Legacy directory    | NEXAR_LEGACY_NXR070_SAFELY_REMOVED                   |
| Toolchain           | NEXAR_TOOLCHAIN_MIGRATION_VERIFIED                   |
| Packaging           | NEXAR_DSH_RC3_PACKAGING_VERIFIED                     |
| Dependency security | NEXAR_DSH_RC3_DEPENDENCY_RISKS_DISPOSITIONED         |
| Windows             | NXR070_DSH_RC3_WINDOWS_FULL_CI_PASSED                |
| Integration         | NXR070_DSH_RC3_READY_FOR_INDEPENDENT_ACCEPTANCE      |
| Overall             | NEXAR_ENGINEERING_COMPLETED_WITH_OUTSTANDING_GATES   |
