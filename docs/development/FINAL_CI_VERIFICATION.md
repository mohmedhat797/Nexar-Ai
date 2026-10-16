# Nexar AI — Final CI Verification Report

## FCR-01 correction — current verification

The current verified implementation is `723ae706f38d8de65e639b6401ee5fab69705b07`. Exact gates, reconciled counts, artifact hash and platform scope are in [FCR01_Final_Verification.md](FCR01_Final_Verification.md).

The historical 1,775.18-second report actually names dirty source `a3fd0250142a18c3ad2f5478faae4b37e861f216`, fingerprint `27b1c2252e306426`; it records **15 PASS and one BLOCKED** Linux-only stage. The ed2ded5 label below is later documentation provenance, not that run's source identity. Its unit parser stored zeros, so manual totals are not raw assertion evidence. Neither that old report nor installer `9571845014f0b101b26560d65613a33fbf4f7d90875ceeed28ea891908ef1517` certifies later security changes.

WSL2 is separately validated; `NATIVE_UBUNTU_FULL_CI_PASS` is not established and `CROSS_PLATFORM_ACCEPTANCE_INCOMPLETE` remains. Hosted Actions jobs cannot start due to the account's failed-payment/spending-limit annotation. Local inference fixtures are offline; dependency installation/audit may use registries or cached packages, so 'without network dependencies' is not a general Full CI guarantee. Unsigned installers are development artifacts.

Node 22.23.3 is the validated host CI toolchain; standalone Node 24/Vitest remains unsupported. Pinned Electron 44.5.1 embeds Node 24.21.0 and its managed child path is separately exercised by E2E. Historical 0xC0000409 has no established Electron root cause.

## Historical report — superseded for current acceptance

The original report is retained below as historical evidence. Its readiness/security claims do not certify the corrected source; use the FCR-01 verdicts above.

> # Nexar AI — Final CI Verification Report
>
> **Milestone:** Local CI Infrastructure & Acceptance\
> **Environment:** Windows 11 Pro x64 (Build 26300), Node.js v22.23.3, pnpm 10.33.0, WSL2 Ubuntu 24.04\
> **Date:** October 2026\
> **Commit SHA:** `ed2ded5f9b368f3954ebac0ab2c842eb2b2c4b22`
>
> ---
>
> ## 1. Summary of Execution Runs
>
> | CI Run Type                 | Command                                         | Duration  | Stages      | Exit Code | Result                    |
> | --------------------------- | ----------------------------------------------- | --------- | ----------- | --------- | ------------------------- |
> | **Windows Full CI**         | `node scripts/local-ci/runner.mjs --mode=full`  | 1,775.18s | 16/16       | 0         | `NEXAR_WINDOWS_FULL_PASS` |
> | **Windows Quick CI**        | `node scripts/local-ci/runner.mjs --mode=quick` | 230.16s   | 5/5         | 0         | `LOCAL_CI_QUICK_PASS`     |
> | **Orchestrator Unit Tests** | `pnpm exec vitest run tests/local-ci.test.ts`   | 2.01s     | 21/21       | 0         | `PASS`                    |
> | **WSL2 Sandbox Suite**      | `pnpm exec vitest run packages/sandbox/src/...` | 2.22s     | 16/16       | 0         | `PASS`                    |
> | **Full History Gitleaks**   | `gitleaks detect --no-git=false --verbose`      | 0.82s     | 259 commits | 0         | `PASS (0 Leaks)`          |
>
> ---
>
> ## 2. Stage Breakdown — Windows Full CI
>
> 1. **Preflight Environment:** Node v22.23.3, pnpm 10.33.0, DSH lock match, Gitleaks binary, temp dir (PASS).
> 2. **Prettier Format Check:** 13.86s (PASS).
> 3. **ESLint Static Analysis:** 35.01s (PASS).
> 4. **Boundary & Secret Guard:** 0.46s (PASS, 973 files checked).
> 5. **TypeScript Typecheck:** 12.17s (PASS).
> 6. **Monorepo Offline Tests:** 167.94s (PASS, 4,244 passed, 0 failed, 169 skipped).
> 7. **Production Electron Build:** 35.12s (PASS).
> 8. **Windows Installer Packaging:** 182.44s (PASS, 322 MB NSIS exe created).
> 9. **Desktop E2E (Source):** 22/22 passed (PASS).
> 10. **Desktop E2E (Packaged):** 22/22 passed (PASS).
> 11. **Gitleaks Audit:** 259 commits scanned (PASS, 0 leaks).
>
> ---
>
> ## 3. Package Verification Artifacts
>
> - **Installer File:** `release/desktop/Nexar-0.1.0-windows-x64-setup.exe`
> - **File Size:** 322,008,391 bytes
> - **SHA256 Checksum:** `9571845014f0b101b26560d65613a33fbf4f7d90875ceeed28ea891908ef1517`
> - **Bundled DSH Runtime:** `@deepseek-ai/dsh@0.2.0-rc.2` present and verified inside packaged app resources.
> - **Code Signing:** Self-hosted unsigned development build (`NotSigned`).
>
> ---
>
> ## 4. Verdict
>
> **`WINDOWS_ACCEPTANCE_PASS`**\
> **`LINUX_ACCEPTANCE_PASS` (WSL2 verified)**\
> **`CROSS_PLATFORM_ACCEPTANCE_INCOMPLETE` (Headless native Linux runner pending infrastructure)**\
> All local gates pass reliably, deterministically, and without network dependencies.
