# NXR-070R2: Final Architecture Reconciliation

**Date:** 2026-10-17  
**Status:** Reconciled Architecture Proposal (ADR-029 remains Proposed; ADR-030 Accepted)  
**Governing Production Baseline:** `6ea56f99d758bc18698c1fa5770b399a283fe6ad` (main)  
**Primary Agent Runtime:** DeepSeek Harness (`@deepseek-ai/dsh@0.2.0-rc.2`)  
**Operating Environment:** Windows Desktop (Validated Engineering Baseline: Windows 11 Build 26300)

---

## 1. Executive Summary

This document establishes the final architectural reconciliation for **NXR-070 (Resource Fabric v2)** in light of:

1. The acceptance and integration of **ADR-030 (Unified DSH-First Agent Runtime)** via PR #41 (`6ea56f99d758bc18698c1fa5770b399a283fe6ad`).
2. The independent security verification and deployment hardening of Cowork execution inside WSL2/Bubblewrap (**NXR-SEC-02 / NXR-SEC-02B**).
3. The upstream intelligence evaluation of **T3 Code Orchestrator V2 (`v0.1.0`)** and **DeepSeek Harness candidate `0.2.1-alpha.5`** (**NXR-070R**).

Nexar operates under a clear, unified architecture:

- **ONE NEXAR.**
- **ONE PRIMARY AGENT RUNTIME:** Unified DeepSeek Harness (`@deepseek-ai/dsh@0.2.0-rc.2`).
- **MULTIPLE SPECIALIZED OPERATING MODES:** Cowork supervised inside WSL2/Bubblewrap; Coding sandboxed inside Linux kernel bubblewrap.
- **MULTIPLE MODELS AND PROVIDERS:** Orchestrated authoritatively by the Nexar Resource Controller (NRC).
- **ONE RESOURCE INTELLIGENCE SYSTEM:** Local-first, connection-scoped, and audit-verifiable.

ADR-029 (Resource Fabric v2) is harmonized with ADR-030 and remains **Proposed**.

---

## 2. The 17 Reconciliation Directives (R01–R17)

### R01: Governing Production Baseline

The definitive base commit for all Nexar architecture and implementation is `6ea56f99d758bc18698c1fa5770b399a283fe6ad` on `main`, which includes accepted ADR-030, full Windows Local CI (`NEXAR_WINDOWS_FULL_PASS`), and resolutions for `SEC02-F01` through `SEC02-F05`. All v0.6 baseline assumptions in earlier PR #40 drafts are superseded by this baseline.

### R02: Unified Agent Runtime

DeepSeek Harness (`dsh`) is the sole agent runtime across both Cowork and Coding lanes. OpenWorker is completely retired. Dual-harness assumptions (OpenWorker for Cowork, DSH for Coding) in earlier drafts are formally rejected and removed.

### R03: Cowork Isolation Architecture

Cowork executes under DeepSeek Harness inside WSL2/Bubblewrap (`apps/desktop/src/main/wsl-cowork.ts`, `scripts/provision-wsl-cowork-helper.mjs`). Verification requires the exact hello tuple, protocol version, and capability handshake. No unrestricted host-local Cowork execution is permitted.

### R04: Coding Isolation Architecture

Coding executes under DeepSeek Harness inside Linux kernel bubblewrap (`packages/engineering/src/runner.ts`). Environment allowlists strictly exclude provider credentials and host secrets.

### R05: Context Policy Renaming (`context@3`)

ADR-030 already designed, implemented, and accepted `context@2`, featuring `ProjectMemoryStore` integration and a 9-field `ContextManifest`. To prevent semantic collisions and preserve backward compatibility, the conservative C1–C5 classification and sidecar policy proposed by ADR-029 is designated **`context@3`** (`context@3`, `context@3/code-goal`, `context@3/independent`). Historical `context@1` and `context@2` policies remain valid.

### R06: Nine-Field Context Manifest

`ContextManifest` in production contains 9 fields: `schemaVersion`, `policy`, `hash`, `truncated`, `turnCount`, `byteCount`, `tokenCount`, `requiredIds`, and `requiredHash`. Proposed `context@3` manifests conform strictly to this 9-field shape without adding extra fields to session records.

### R07: Project Memory Authority

`ProjectMemoryStore` (`packages/project-memory`) is the sole authoritative owner of confirmed project facts and decisions. Rendered project memory blocks (`### Project Memory\n...`) are generated authoritatively before/after compaction and auxiliary model requests. Project Memory is NOT stored in turn sidecars.

### R08: Canonical Session Continuity & Single Writer

`FileSessionStore` (`packages/sessions/src/store.ts`) remains the exclusive writer of the session directory. It owns the `.lease`, revision locking, atomic replacement (`writeFileAtomic`), and mode 0600 file protections. Future `context@3` sidecars (`ses_<id>.context.json`) are written exclusively through store methods under the same lease.

### R09: Downgrade & Rollback Safety

Historical `context@2` turns legitimately have no sidecar. If `context@3` is deployed and subsequently rolled back, existing readers process session records normally (TST-45, TST-55) and ignore sidecar and quarantine files. Rollback returns the runtime safely to accepted ADR-030 (`context@2` + Project Memory), not `context@1`.

### R10: Platform Governance & Engineering Baseline

Windows Desktop is the primary platform. Windows 11 Build 26300 is the validated engineering baseline. Windows 11 Build 26200 remains unverified. Acceptance requires green Windows Local Full CI (`pnpm ci:local:full`), passing WSL2 Cowork checks, Linux kernel Coding sandbox tests, and Source and Packaged Desktop E2E tests.

### R11: Managed ACP Stdio Transport

DeepSeek Harness is driven exclusively through managed ACP over stdio. The earlier proposal for a generic or optional ACP worker is deferred (AD-7 / OD-2).

### R12: T3 Code Orchestrator V2 Disposition

T3 Code Orchestrator V2 (`v0.1.0` @ `81493ef`) is an **architectural reference only**. Direct source reuse, npm package imports, and adoption of T3's thread store or multi-agent execution are rejected. An optional read-only T3 MCP connector is deferred pending independent protocol and security evaluation.

### R13: DeepSeek Harness Version Pinning

The production runtime remains strictly pinned to `@deepseek-ai/dsh@0.2.0-rc.2`. Candidate `0.2.1-alpha.5` is source-evaluated only; its runtime compatibility is unknown. Any future upgrade requires passing all 19 gates of the controlled upgrade pipeline.

### R14: Upstream Intelligence & Update Management

Upstream dependencies are partitioned into `architecture-reference` (T3 Code) and `runtime-dependency` (DeepSeek Harness). Update management is implemented through four distinct, non-breaking slices: UI-01 (Manifest and evaluation contracts), UI-02 (Discovery and report CLI), UI-03 (Proposal assembly), and UI-04 (Controlled runtime evaluation).

### R15: Reconciled Decision Register

Owner Decisions OD-1 through OD-15 and Architecture Decisions AD-1 through AD-7 are reconciled with ADR-030. OD-3 affirms `context@3`; OD-10 affirms overflow rejection without silent fallback; OD-14 affirms sidecar persistence under `FileSessionStore`; OD-15 affirms single-plan account switching via Replace.

### R16: Audit Traceability

Architecture decisions maintain full bidirectional traceability through findings registers, audit reports, and test matrices from FCR-01, FCR-02, NXR-SEC-02, and NXR-SEC-02B.

### R17: Repository & PR Governance

Draft PR #40 (`docs/nxr-070-0-architecture`) remains open as a draft. ADR-029 remains Proposed. Implementation work proceeds in separate, dedicated branches (`feat/nxr-070a-connection-identity` and `feat/nexar-upstream-intelligence-ui01`).

---

## 3. Component Architecture Matrix

| Component               | Accepted ADR-030 Baseline       | Reconciled ADR-029 Target                        | Implementation Slice |
| :---------------------- | :------------------------------ | :----------------------------------------------- | :------------------- |
| **Agent Runtime**       | DSH `0.2.0-rc.2` over ACP stdio | DSH `0.2.0-rc.2` over ACP stdio                  | Baseline Preserved   |
| **Cowork Sandbox**      | WSL2 / Bubblewrap helper        | WSL2 / Bubblewrap helper                         | Baseline Preserved   |
| **Coding Sandbox**      | Linux kernel bubblewrap         | Linux kernel bubblewrap                          | Baseline Preserved   |
| **Connection Identity** | Static provider routes          | Additive `ConnectionDefinition`, `connectionKey` | **070A′**            |
| **Account Binding**     | Single slot per provider        | 4 Assurance levels; Replace plan account         | **070B′**            |
| **Review Diversity**    | Resource-only                   | Optional `connection`, `provider`                | **070C′**            |
| **Codex Isolation**     | Single shared home              | Isolated `CODEX_HOME` per connection             | **070D′**            |
| **Context Continuity**  | `context@2` + Project Memory    | `context@3` + C1–C5 sidecar                      | **070I′**            |
| **Upstream Updates**    | Ad-hoc evaluation               | Source-controlled manifest + pure state          | **UI-01**            |

---

## 4. Next Implementation Actions

1. **Track 1:** Non-destructively update Draft PR #40 (`docs/nxr-070-0-architecture`) with this reconciled documentation package.
2. **Track 2:** Implement `070A′` (Connection Identity Compatibility Slice) on branch `feat/nxr-070a-connection-identity` from `main`.
3. **Track 3:** Implement `UI-01` (Upstream Intelligence Foundation) on branch `feat/nexar-upstream-intelligence-ui01` from `main`.
