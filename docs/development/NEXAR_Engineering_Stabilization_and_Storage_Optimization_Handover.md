# Nexar engineering stabilization and storage optimization handover

Date: 30 October 2026. **Overall: NEXAR_ENGINEERING_COMPLETED_WITH_OUTSTANDING_GATES.** The DSH rc.3 stack is ready for your independent review. Nothing was merged.

## 1. Executive summary

Windows Full now passes on exact source, including real packaging and packaged E2E. All six dependency advisories are corrected. The legacy directory is gone and about 23 GiB is recovered. Two gates remain, neither one code: your independent acceptance, and hosted CI, which the GitHub Actions budget has been blocking.

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

| Item                       | Owner action or status                                                                                                    |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| Independent acceptance     | **Yours.** This is the implementer's own verification                                                                     |
| Hosted CI                  | Actions budget; not claimed as passing                                                                                    |
| Package stage margin       | 910–1,692 s observed against a 1,500 s envelope; 1,324 s in the passing run. Can fail intermittently; envelope not raised |
| Clean-machine NSIS install | Not performed; would risk your real installation on this machine                                                          |
| Historical 180 s cause     | Correlated, not proven                                                                                                    |
| Local branch `wip/v06`     | 36 unpushed commits; preserved, please decide                                                                             |

## 11. Recommended next milestone

Review and accept this stack, then address the package-stage margin by measuring NSIS compression. Only after that, merge B′→C′→upgrade in order.

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
