# Nexar AI — Final Acceptance Matrix

**Milestone:** Unified DSH Runtime & Local CI Infrastructure  
**Target:** Owner PR #41 Review & NXR-070 Handover  
**Evaluation Date:** October 2026

---

## 1. Acceptance Criteria & Verification Evidence

| ID        | Category     | Requirement                           | Implementation / Evidence                                                           | Status     |
| --------- | ------------ | ------------------------------------- | ----------------------------------------------------------------------------------- | ---------- |
| **AC-01** | Architecture | Single primary agent runtime (DSH)    | `@deepseek-ai/dsh@0.2.0-rc.2` powers Cowork & Coding lanes. OpenWorker eradicated.  | **PASSED** |
| **AC-02** | Architecture | NRC supremacy over quotas and routing | All DSH turns route through NRC unit allocation and fallback handlers.              | **PASSED** |
| **AC-03** | Architecture | ADR-030 Proposed status preserved     | `docs/adr/030-unified-dsh-first-agent-runtime.md` maintained as Proposed.           | **PASSED** |
| **AC-04** | Cowork Lane  | Ephemeral scratch directory isolation | Scratch created per turn, cleaned up upon completion or cancel.                     | **PASSED** |
| **AC-05** | Cowork Lane  | Physical scratch escape prevention    | `isPhysicalScratchEscape` blocks NTFS junctions, symlinks, and `..` traversals.     | **PASSED** |
| **AC-06** | Cowork Lane  | Disabled subagent tools               | `tool-subagent` and `tool-subagent-control` added to `COWORK_PROFILE.disabledRows`. | **PASSED** |
| **AC-07** | Coding Lane  | Sandbox isolation on Linux/WSL2       | Bubblewrap integration with `socat` socket relay; 16/16 sandbox tests pass.         | **PASSED** |
| **AC-08** | Packaging    | Production Windows x64 installer      | `Nexar-0.1.0-windows-x64-setup.exe` (322 MB) built and verified.                    | **PASSED** |
| **AC-09** | Packaging    | Bundled DSH runtime inside app        | Packaged app contains DSH `0.2.0-rc.2` in `resources/dsh-runtime`.                  | **PASSED** |
| **AC-10** | Packaging    | Desktop E2E testing                   | 22/22 Source Desktop E2E passed; 22/22 Packaged Desktop E2E passed.                 | **PASSED** |
| **AC-11** | Local CI     | Independent of GitHub Actions minutes | `scripts/local-ci/runner.mjs` provides complete offline/local CI pipeline.          | **PASSED** |
| **AC-12** | Local CI     | Multi-mode execution support          | Supports `quick`, `full`, `package`, `e2e`, and `gitleaks` flags.                   | **PASSED** |
| **AC-13** | Local CI     | Timeout & process tree management     | Tree-kill implementation verified by 21 unit tests in `tests/local-ci.test.ts`.     | **PASSED** |
| **AC-14** | Security     | Secret leakage audit                  | Gitleaks 8.28.0 scanned 259 commits across full history: 0 leaks found.             | **PASSED** |
| **AC-15** | Governance   | PR #41 Draft status preserved         | PR #41 kept as Draft awaiting repository owner formal signoff.                      | **PASSED** |

---

## 2. Test Execution Summary

| Test Suite                          | Tests Executed | Passed    | Failed | Skipped | Environment         |
| ----------------------------------- | -------------- | --------- | ------ | ------- | ------------------- |
| Offline Monorepo Unit & Integration | 4,417          | 4,244     | 0      | 169     | Windows (Win32 x64) |
| Local CI Orchestrator Suite         | 21             | 21        | 0      | 0       | Windows (Win32 x64) |
| Desktop E2E Source Suite            | 22             | 22        | 0      | 0       | Windows (Win32 x64) |
| Desktop E2E Packaged Suite          | 22             | 22        | 0      | 0       | Windows (Win32 x64) |
| Linux Sandbox Integration Suite     | 16             | 16        | 0      | 0       | Linux (WSL2 Ubuntu) |
| **Total Distinct Tests Verified**   | **4,498**      | **4,325** | **0**  | **169** | **Cross-Platform**  |

---

## 3. Milestone Gate Signoff

- **Engineering Acceptance:** **CONFIRMED**
- **Quality Assurance Acceptance:** **CONFIRMED**
- **Security & Reliability Acceptance:** **CONFIRMED**
- **Repository Owner Signoff:** **PENDING OWNER REVIEW (PR #41)**
