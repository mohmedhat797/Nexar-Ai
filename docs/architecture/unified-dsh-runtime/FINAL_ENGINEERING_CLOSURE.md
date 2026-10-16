# Nexar AI — Final Engineering Closure Report

## FCR-01 correction — current recommendation

The earlier complete-closure and NXR-070-ready declarations are superseded. Independent review reproduced fail-open scratch checks, standing Cowork write bypasses, incomplete subagent rows, sandbox credentials in argv, a compatibility launcher downgrade gap, acceptance-evidence defects and a concurrent session read race. Corrective code is committed and verified at `723ae706f38d8de65e639b6401ee5fab69705b07`.

The primary managed runtime remains DSH; NRC native specialist compatibility paths are not described as nonexistent. Cowork checks are application policy and do not confine OS reads or eliminate the final-grant race. Native Windows writable Coding refuses unsandboxed execution in the reviewed supported path.

Current Windows/local and WSL2 evidence is in [FCR01_Final_Verification.md](../../development/FCR01_Final_Verification.md); security decisions are in [FCR01_Security_Findings.md](FCR01_Security_Findings.md). Overall: `NEXAR_FCR01_BLOCKED_BY_EXTERNAL_DEPENDENCY`; `NXR070_PREREQUISITES_NOT_YET_SATISFIED`. Owner OS release-policy decision and native Ubuntu Full CI remain missing. No production readiness or owner acceptance is certified here.

Dual-writer lease acquisition was also reproduced and corrected in `723ae706`: exclusive acquisition claims serialize creation/stale takeover and unreadable leases deny. Abandoned claims require operator verification/repair; no automatic stealing.

## Historical report — superseded for current acceptance

The original report is retained below as historical evidence. Its readiness/security claims do not certify the corrected source; use the FCR-01 verdicts above.

> # Nexar AI — Final Engineering Closure Report
>
> **Milestone:** Unified DeepSeek Harness Runtime & Local CI Infrastructure\
> **Baseline SHA:** `f248873c6c213996dc4ae7ac71f7d0f97521c44a`\
> **Closure HEAD:** `ed2ded5f9b368f3954ebac0ab2c842eb2b2c4b22`\
> **Branch:** `feat/nexar-unified-dsh-runtime`\
> **Pull Request:** [#41 (Draft)](https://github.com/mohmedhat797/Nexar-Ai/pull/41)\
> **Governance State:** ADR-030 Proposed | PR #41 Draft (Awaiting Owner Review)
>
> ---
>
> ## 1. Executive Summary
>
> This document certifies the complete engineering closure of the Unified DeepSeek Harness (DSH) Runtime and Local CI Infrastructure milestones for Nexar AI. All objectives, architectural boundaries, security containment rules, and local verification gates have been implemented, tested, and validated.
>
> No further engineering changes are required for this milestone. The codebase is frozen and prepared for final repository owner signoff prior to the commencement of **NXR-070 — Resource Fabric v2**.
>
> ---
>
> ## 2. Core Architecture Invariants Preserved
>
> The single-runtime architecture defined in ADR-030 has been upheld across all packages:
>
> 1. **ONE NEXAR, ONE PRIMARY RUNTIME:** DeepSeek Harness (`@deepseek-ai/dsh@0.2.0-rc.2`) is the sole execution engine for both Cowork and Coding lanes.
> 2. **NO OPENWORKER:** Legacy OpenWorker remains fully eliminated. No competing agent loop exists.
> 3. **NRC SUPREMACY:** The Nexar Resource Controller retains exclusive authority over quota allocation, model provider routing, budget enforcement, and accounting.
> 4. **MEMORY INTEGRITY:** Canonical project memory resides strictly within Nexar; DSH accesses it via governed bridge protocols.
> 5. **CONTAINMENT BOUNDARIES:**
>    - Cowork lane executes host-local in ephemeral scratch space with strict lexical and physical symlink/junction escape prevention.
>    - Coding lane executes in Bubblewrap sandboxes where available (Linux/WSL2) with isolated temporary worktrees.
>
> ---
>
> ## 3. Engineering Work Completed in Closure
>
> | Item       | Component                                       | Description                                                                                                                                                    | Verdict      |
> | ---------- | ----------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------ |
> | **SEC-01** | `apps/desktop/src/main/dsh-cowork.ts`           | Added `isPhysicalScratchEscape` to resolve canonical paths and deny any writes targeting NTFS junctions, symlinks, or parent traversals escaping turn scratch. | **VERIFIED** |
> | **SEC-02** | `integrations/deepseek-harness/src/profiles.ts` | Added `tool-subagent` and `tool-subagent-control` to `COWORK_PROFILE.disabledRows` to eliminate subagent escalation in host-local turns.                       | **VERIFIED** |
> | **LCI-01** | `scripts/local-ci/`                             | Multi-mode Local CI orchestrator (`quick`, `full`, `package`, `e2e`, `gitleaks`) with preflight checks and structured JSON/Markdown reporting.                 | **VERIFIED** |
> | **LCI-02** | `tests/local-ci.test.ts`                        | 21 end-to-end orchestrator test cases covering process lifecycle, timeout enforcement, signal cancellation, and preflight validation.                          | **VERIFIED** |
> | **WSL-01** | `packages/sandbox/`                             | Resolved missing relay dependency (`socat`); 16/16 sandbox integration and availability tests pass in Linux/WSL2.                                              | **VERIFIED** |
> | **PKG-01** | `release/desktop/`                              | Packaged Windows x64 NSIS installer (322 MB) with verified DSH runtime bundle and clean E2E passes.                                                            | **VERIFIED** |
>
> ---
>
> ## 4. Final Acceptance Verdicts
>
> | Dimension             | Formal Verdict                                    | Status / Note                                                                        |
> | --------------------- | ------------------------------------------------- | ------------------------------------------------------------------------------------ |
> | **Architecture**      | `ARCHITECTURE_ACCEPTED_FOR_OWNER_REVIEW`          | ADR-030 Proposed; boundaries strictly maintained.                                    |
> | **Security**          | `SECURITY_ACCEPTANCE_PASS`                        | Zero leaks (259 commits), physical scratch containment verified.                     |
> | **Windows Platform**  | `WINDOWS_ACCEPTANCE_PASS`                         | Full local CI pass (1,775s), Quick CI pass (230s), 4,265 tests passing.              |
> | **Linux / Sandbox**   | `LINUX_ACCEPTANCE_PASS`                           | WSL2 verified with bwrap/socat; 16/16 sandbox tests pass.                            |
> | **Cross-Platform CI** | `CROSS_PLATFORM_ACCEPTANCE_INCOMPLETE`            | Native Linux headless CI pending GitHub runner availability; local scripts verified. |
> | **DSH Runtime**       | `DSH_RUNTIME_ACCEPTANCE_PASS`                     | DSH 0.2.0-rc.2 integrated, packaged, and verified offline.                           |
> | **Documentation**     | `FINAL_DOCUMENTATION_COMPLETE`                    | All closure reports, threat models, and handover guides compiled.                    |
> | **Milestone Verdict** | `NEXAR_CURRENT_MILESTONE_READY_FOR_OWNER_SIGNOFF` | Ready for owner review on PR #41.                                                    |
> | **Next Milestone**    | `NXR070_PREREQUISITES_SATISFIED`                  | Foundation solid for Resource Fabric v2.                                             |
