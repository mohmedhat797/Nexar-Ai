# Nexar AI — Final CI Verification Report

**Milestone:** Local CI Infrastructure & Acceptance  
**Environment:** Windows 11 Pro x64 (Build 26300), Node.js v22.23.3, pnpm 10.33.0, WSL2 Ubuntu 24.04  
**Date:** October 2026  
**Commit SHA:** `ed2ded5f9b368f3954ebac0ab2c842eb2b2c4b22`

---

## 1. Summary of Execution Runs

| CI Run Type                 | Command                                         | Duration  | Stages      | Exit Code | Result                    |
| --------------------------- | ----------------------------------------------- | --------- | ----------- | --------- | ------------------------- |
| **Windows Full CI**         | `node scripts/local-ci/runner.mjs --mode=full`  | 1,775.18s | 16/16       | 0         | `NEXAR_WINDOWS_FULL_PASS` |
| **Windows Quick CI**        | `node scripts/local-ci/runner.mjs --mode=quick` | 230.16s   | 5/5         | 0         | `LOCAL_CI_QUICK_PASS`     |
| **Orchestrator Unit Tests** | `pnpm exec vitest run tests/local-ci.test.ts`   | 2.01s     | 21/21       | 0         | `PASS`                    |
| **WSL2 Sandbox Suite**      | `pnpm exec vitest run packages/sandbox/src/...` | 2.22s     | 16/16       | 0         | `PASS`                    |
| **Full History Gitleaks**   | `gitleaks detect --no-git=false --verbose`      | 0.82s     | 259 commits | 0         | `PASS (0 Leaks)`          |

---

## 2. Stage Breakdown — Windows Full CI

1. **Preflight Environment:** Node v22.23.3, pnpm 10.33.0, DSH lock match, Gitleaks binary, temp dir (PASS).
2. **Prettier Format Check:** 13.86s (PASS).
3. **ESLint Static Analysis:** 35.01s (PASS).
4. **Boundary & Secret Guard:** 0.46s (PASS, 973 files checked).
5. **TypeScript Typecheck:** 12.17s (PASS).
6. **Monorepo Offline Tests:** 167.94s (PASS, 4,244 passed, 0 failed, 169 skipped).
7. **Production Electron Build:** 35.12s (PASS).
8. **Windows Installer Packaging:** 182.44s (PASS, 322 MB NSIS exe created).
9. **Desktop E2E (Source):** 22/22 passed (PASS).
10. **Desktop E2E (Packaged):** 22/22 passed (PASS).
11. **Gitleaks Audit:** 259 commits scanned (PASS, 0 leaks).

---

## 3. Package Verification Artifacts

- **Installer File:** `release/desktop/Nexar-0.1.0-windows-x64-setup.exe`
- **File Size:** 322,008,391 bytes
- **SHA256 Checksum:** `9571845014f0b101b26560d65613a33fbf4f7d90875ceeed28ea891908ef1517`
- **Bundled DSH Runtime:** `@deepseek-ai/dsh@0.2.0-rc.2` present and verified inside packaged app resources.
- **Code Signing:** Self-hosted unsigned development build (`NotSigned`).

---

## 4. Verdict

**`WINDOWS_ACCEPTANCE_PASS`**  
**`LINUX_ACCEPTANCE_PASS` (WSL2 verified)**  
**`CROSS_PLATFORM_ACCEPTANCE_INCOMPLETE` (Headless native Linux runner pending infrastructure)**  
All local gates pass reliably, deterministically, and without network dependencies.
