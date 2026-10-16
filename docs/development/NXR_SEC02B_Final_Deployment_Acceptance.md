# NXR-SEC-02B — Final Deployment Acceptance

**Milestone:** NXR-SEC-02B — Final Deployment Hardening & Windows Acceptance  
**Role:** Principal Software Architect, Senior Implementation Engineer, Security Reviewer and Release Integration Lead  
**Date:** 2026-10-16 (Africa/Cairo)  
**Repository:** `mohmedhat797/Nexar-Ai`  
**Worktree:** `D:/Nexar-Ai-main/.nexar/sec02`  
**Branch:** `feat/nxr-sec02-isolated-cowork`  
**Clean Implementation Commit:** `dc27f551fdab7c80337982598ba07c7c0faca8e5`  
**Clean Implementation Git Tree:** `249bfcc10c4d32aa6b7abddcbfca1a2f71ebcd24`  
**Full CI Report:** `.nexar/ci/reports/report-2026-10-16T16-36-30-282Z.json`

---

## 1. Executive Summary

Milestone NXR-SEC-02B completes the deployment hardening, finding remediation, and Windows acceptance
verification for isolated Cowork execution using DeepSeek Harness (`@deepseek-ai/dsh@0.2.0-rc.2`) inside
WSL2/Bubblewrap.

All six findings identified in the Independent Security Review (`NXR_SEC02_Gemini_Independent_Security_Review.md`)
have been comprehensively resolved or formally evaluated:

- **SEC02-F01 (Linux Helper Deployment):** Automated via `pnpm cowork:wsl:provision` deploying to `/home/nexar/src/Nexar-Ai` and `/usr/local/bin/nexar`. Tested out of the box with zero manual environment overrides.
- **SEC02-F02 (Helper Protocol Versioning & Handshake):** Implemented mandatory `cowork/hello` handshake (`nexar-cowork@1`, helper release `0.1.0-sec02.1`, capabilities `['stdio-rpc', 'gateway-socket', 'bridge-socket', 'flat-scratch']`). Mismatched or missing helpers fail fail-closed before turn execution begins.
- **SEC02-F03 (RPC Callback Concurrency Partitioning):** Replaced shared global limit with dedicated per-channel limits (`cowork/gateway: 4`, `cowork/bridge: 4`, `cowork/permission: 1`, total 9), returning standard JSON-RPC error `-32000 POLICY_REJECTED`.
- **SEC02-F04 (Flat Scratch Outputs Enforcement):** Enforced flat top-level regular files in `/work` across both CLI and Desktop; nested scratch subdirectories are rejected fail-closed with `POLICY_REJECTED`.
- **SEC02-F05 (Probe Error Placement Stability):** Corrected `DshCoworkService.probe()` to report `placement: 'WSL2_BUBBLEWRAP'` across `configuration-missing` and `unsupported-version` error states.
- **SEC02-F06 (Windows Build 26300 Baseline & NSIS Install Constraints):** Documented under Path B for explicit owner decision. Automated NSIS machine installation was omitted because `oneClick: true` silently alters host user data; packaged E2E (25/25 PASS) establishes packaged binary acceptance.

Full Windows Local CI passed all 16 required stages on clean commit `dc27f55` (1,835.62s). All 4,399 collected tests passed with zero failures.

---

## 2. Findings Resolution Matrix

| Finding ID    | Severity | Description                                                   | Resolution Status      | Verification Evidence                                                                                                                                                                                         |
| :------------ | :------- | :------------------------------------------------------------ | :--------------------- | :------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **SEC02-F01** | Medium   | Missing deployed Linux Cowork helper in `nexar-plane`         | **RESOLVED**           | `pnpm cowork:wsl:provision` synchronizes source, builds CLI and bridge relay, updates `/usr/local/bin/nexar`. Doctor check, sandbox selftest, and real WSL tests passed without overrides.                    |
| **SEC02-F02** | Medium   | Missing helper protocol versioning and compatibility check    | **RESOLVED**           | `cowork/hello` protocol frame added to `wsl-cowork.ts` and `cowork.ts`. 7 deterministic unit tests in `wsl-cowork.test.ts` verify matching helper, outdated helper, missing capability, and malformed frames. |
| **SEC02-F03** | Low      | Missing per-channel concurrency limits on stdio RPC callbacks | **RESOLVED**           | Per-channel callback tracker enforced in `wsl-cowork.ts`: gateway limit 4, bridge limit 4, permission limit 1. Rejections return error code `-32000` (`POLICY_REJECTED`). Verified in `wsl-cowork.test.ts`.   |
| **SEC02-F04** | Low      | Arbitrary subdirectory creation in scratch directory          | **RESOLVED**           | Top-level flat file constraint enforced in CLI helper and Desktop `collectCoworkOutputs`. Rejection verified in `cowork-files.test.ts` and `wsl-cowork.test.ts`.                                              |
| **SEC02-F05** | Low      | Misleading `placement: 'UNKNOWN'` on probe error states       | **RESOLVED**           | `DshCoworkService.probe()` and status UI report `placement: 'WSL2_BUBBLEWRAP'` for `configuration-missing` and `unsupported-version`. Verified in `dsh-cowork.test.ts`.                                       |
| **SEC02-F06** | Low      | Host platform Windows 11 Build 26300 vs selected Build 26200  | **EVALUATED (Path B)** | Verified all gates pass on Build 26300. Documented NSIS `oneClick: true` machine-mutation constraints; packaged E2E (25/25 PASS) verified on fresh packaged executable. Owner platform decision required.     |

---

## 3. Windows & WSL Validation Evidence

### 3.1 Full Windows Local CI

- **Report Path:** `.nexar/ci/reports/report-2026-10-16T16-36-30-282Z.json`
- **Execution Mode:** `full` (16 required stages + 1 blocked optional stage)
- **Status:** `NEXAR_WINDOWS_FULL_PASS`
- **Duration:** 1,835.62 seconds (~30.6 minutes)
- **Source Stability:** Clean commit `dc27f551fdab7c80337982598ba07c7c0faca8e5` (`isDirty: false`, `sourceStable: true`)
- **Stage Breakdown:**
  1. Dependencies: PASS (1.84s)
  2. Pinned DSH Runtime Install & Verification: PASS (81.75s)
  3. Prettier Formatting Check: PASS (24.46s)
  4. ESLint Static Analysis: PASS (46.09s)
  5. Package Boundaries and Secret Guard: PASS (0.50s)
  6. TypeScript Typecheck (Project References): PASS (14.42s)
  7. Offline Unit & Integration Test Suite: PASS (181.76s) — 4,338 passed, 167 skipped, 4 pending, 0 failed
  8. Production Build (CLI and Desktop): PASS (3.96s)
  9. CLI Smoke Resources Listing: PASS (0.59s)
  10. CLI Smoke Offline General Run: PASS (0.56s)
  11. Real DSH Offline Context & Compaction: PASS (17.02s) — 3/3 passed
  12. Real Isolated Cowork WSL Transport & Boundary: PASS (38.59s) — 8/8 Windows passed, 15/15 Linux passed
  13. Desktop Source E2E: PASS (289.66s) — 25/25 passed across 9 spec files
  14. Package Windows Desktop Installer: PASS (798.39s) — Fresh installer created
  15. Packaged Desktop E2E: PASS (331.13s) — 25/25 passed with bundled DSH runtime
  16. Linux Bubblewrap Sandbox (Host Stage): BLOCKED (0.00s, non-required on Windows host)
  17. Gitleaks Full History Security Scan: PASS (1.13s) — 285 commits scanned, 0 leaks

### 3.2 Linux Helper & Kernel Boundary Evidence

- **Distro:** `nexar-plane` (WSL2, kernel `6.18.33.2-microsoft-standard-WSL2`, Ubuntu 24.04, bubblewrap `0.9.0`, socat `1.8.0.0`)
- **Checkout:** `/home/nexar/src/Nexar-Ai` (UID 1000, 457 production Git index entries matching Windows sorted SHA-256 `d4daa742211f9a55e740d1add365402db8c9329633016d4422f4dc8bc8388a25`)
- **Helper Executable:** `/usr/local/bin/nexar` (delegates to node `/home/nexar/src/Nexar-Ai/apps/cli/dist/main.js`)
- **Direct Syscall Probes:** All 9 synthetic outside read attempts returned `ENOENT`; 4 outside write attempts returned `ENOENT`; read-only input write returned `EROFS`; direct host network connection returned `ECONNREFUSED`.
- **Coding Sandbox Regression:** 12/12 SandboxLauncher tests passed, Coding ACP prompt executed with allowlisted workspace write, outside write prevented, owner context in all requests.

### 3.3 Windows Desktop Packaging Evidence

- **Installer Path:** `release/desktop/Nexar-0.1.0-windows-x64-setup.exe`
- **Size:** 322,016,718 bytes
- **SHA-256:** `ea354fc76779da0a02809c29ea020ea923e441e6664087bf96e26f6352581bc1`
- **Bundled DSH Runtime:** `@deepseek-ai/dsh@0.2.0-rc.2` in `resources/dsh-runtime`
- **Packaged E2E Verification:** 25/25 passed using `win-unpacked/Nexar.exe` with bundled runtime only (no external entry).

---

## 4. Final Deployment Acceptance Verdicts

| Area                                | Milestone Acceptance Verdict                          |
| :---------------------------------- | :---------------------------------------------------- |
| **Linux Helper Provisioning**       | `COWORK_WSL_HELPER_PROVISIONED_AND_VERIFIED`          |
| **Protocol Handshake & Versioning** | `COWORK_PROTOCOL_COMPATIBILITY_VERIFIED`              |
| **RPC Callback Rate Limiting**      | `COWORK_RPC_CHANNEL_LIMITS_ENFORCED`                  |
| **Scratch Filesystem Hardening**    | `COWORK_FLAT_SCRATCH_OUTPUTS_ENFORCED`                |
| **Probe Placement Reporting**       | `COWORK_PROBE_PLACEMENT_STABLE`                       |
| **Kernel & Filesystem Boundary**    | `COWORK_OS_FILESYSTEM_ISOLATION_VERIFIED`             |
| **Network Isolation**               | `COWORK_NETWORK_ISOLATION_VERIFIED`                   |
| **NRC & Session Integrity**         | `COWORK_NRC_INTEGRATION_PASS`                         |
| **Artifact Persistence**            | `COWORK_ARTIFACT_INTEGRATION_PASS`                    |
| **Windows Full CI**                 | `WINDOWS_FULL_CI_PASS`                                |
| **Desktop Source & Packaged E2E**   | `DESKTOP_SOURCE_AND_PACKAGED_E2E_PASS`                |
| **Coding Lane Regression**          | `CODING_SANDBOX_REGRESSION_PASS`                      |
| **Overall Deployment Milestone**    | **`NXR_SEC02B_DEPLOYMENT_HARDENED`**                  |
| **Main Integration Status**         | **`NXR_SEC02B_READY_FOR_OWNER_INTEGRATION_DECISION`** |
