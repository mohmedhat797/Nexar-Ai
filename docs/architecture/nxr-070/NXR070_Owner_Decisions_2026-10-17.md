# NEXAR AI — RESOURCE FABRIC V2

## FORMAL OWNER DECISION RECORD (2026-10-17)

**Document ID:** NXR070-OD-2026-10-17  
**Date:** 2026-10-17  
**Authority:** Repository Owner  
**Assigned AI:** Gemini Argon  
**Project:** Nexar AI (`mohmedhat797/Nexar-Ai`)  
**Baseline Commit:** `6ea56f99d758bc18698c1fa5770b399a283fe6ad`  
**Accepted Production Architecture:** ADR-030 (Accepted)  
**Target Resource Architecture:** ADR-029 (Accepted — 2026-10-17)  
**Status:** **RATIFIED AND ACCEPTED**

---

## 1. Executive Summary

On 2026-10-17, the repository owner reviewed the reconciled Resource Fabric v2 architecture ([ADR-029](../../adr/029-connection-scoped-resources-and-canonical-continuity.md)), the accompanying decision register, blueprint, threat model, and the completed engineering slices (NXR-070A′ in PR #42 and UI-01 in PR #43).

The owner explicitly:

1. **Accepted ADR-029** as the authoritative Resource Fabric v2 architecture, harmonized with Accepted ADR-030.
2. **Approved Decisions OD-1 through OD-15** and **R-DEC-01 through R-DEC-06**.
3. **Authorized sequential integration** of PR #40 (Architecture), PR #42 (NXR-070A′ Identity), and PR #43 (UI-01 Upstream Intelligence Foundation) into `main` subject to mandatory verification gates.
4. **Authorized immediate engineering implementation** of **NXR-070B′ (Multi-API-Key Connections & Secure Credential Lifecycle)** on a dedicated feature branch.
5. **Formally deferred further Upstream Intelligence development** (UI-02..04), retaining UI-01 as an offline, passive foundation:
   `UPSTREAM_INTELLIGENCE_FOUNDATION_ACCEPTED_FURTHER_DEVELOPMENT_DEFERRED`.

---

## 2. Ratified Owner Decisions

### OD-1 — Accept ADR-029 Architecture

- **Verdict: APPROVED.**
- ADR-029 status transitioned from `Proposed` to `Accepted — 2026-10-17`.
- Extends existing Nexar contracts (`ProviderConnection`, `ResourceConnection`, `ProviderRuntimeIdentity`, `ConnectionDefinition`, `ConnectionCredentialScope`, `connectionKey`).
- Prohibits duplicate domain abstractions (`ProviderDriver`, `ProviderInstance`, `RuntimeEnvironment`, `RuntimeSession`).
- DeepSeek Harness remains the sole primary managed runtime (`@deepseek-ai/dsh@0.2.0-rc.2`).
- Cowork WSL2/Bubblewrap isolation and Linux kernel Coding sandbox preserved.

### OD-2 — Generic ACP Worker Scope

- **Verdict: DEFERRED.**
- Managed DSH ACP stdio transport is accepted and preserved under ADR-030.
- Introduction of an unmanaged or generic ACP work resource is deferred to a future milestone.

### OD-3 — Context Continuity Policy

- **Verdict: CONFIRMED.**
- Accepted `context@2` retained for current execution with Project Memory.
- Enhanced `context@3` approved as the future context policy (NXR-070I′).
- Native session persistence, resume, and fork remain deferred.
- Canonical sessions and Project Memory retain authoritative continuity ownership.

### OD-4 — Multi-Account Priority & Phasing

- **Tier 1 (Multiple API-key connections): APPROVED FOR NXR-070B′ IMPLEMENTATION.**
- **Tier 2 (Multiple Codex accounts via `CODEX_HOME`): APPROVED FOR NXR-070D′.**
- **Tier 3 (Concurrent ChatGPT plan accounts): REQUIRES EVIDENCE (Gate E-1).** Sequential Replace (OD-15) approved; concurrent connections prohibited without vendor evidence.
- **Tier 4 (Multiple Claude subscription accounts): REQUIRES EVIDENCE (Gate E-2).** Unsupported account switching prohibited; remains gated roadmap research.

### OD-5 — Review Resource Diversity

- **Verdict: APPROVED.**
- Dimensions: `resource` (default), `connection` (optional), `provider` (optional).
- Constraints: Required unavailable dimension fails explicitly (no silent downgrade).
- Host attribution metadata only; cross-host review routing deferred.

### OD-6 — Cost and Budget Scope

- **Verdict: CONFIRMED.**
- No monetary budget enforcement, spending caps, or billing-based rejection in NXR-070.
- Cost metadata remains informational; quota observations remain evidence-based.

### OD-7 — Connection Lifecycle Semantics

- **Verdict: APPROVED.**
- Lifecycle operations approved: `Disable`, `Rotate`, `Remove`, `Forget`, `Replace`, `Delete-home`.
- Retired connection IDs are tombstoned and permanently protected against reuse.
- In-flight execution is protected; lifecycle actions fail closed when active work is bound.
- Canonical sessions, Project Memory, and historical audit associations are preserved by default.

### OD-8 — Immutable Account Binding

- **Verdict: APPROVED.**
- Rule: **One connection = one account identity.** A connection never changes account.
- Four identity assurance levels:
  1. `VERIFIED_SAME_ACCOUNT`: Proven continuity; permits rotation.
  2. `OWNER_ASSERTED_SAME_ACCOUNT`: Explicit owner confirmation recorded; never labeled provider-verified.
  3. `VERIFIED_DIFFERENT_ACCOUNT`: Rejects credential replacement for existing connection; no override.
  4. `IDENTITY_UNKNOWN`: Requires explicit owner action before credentials are accepted.

### OD-9 — Host Identity & Boundaries

- **Verdict: APPROVED.**
- Host literals frozen to `desktop` and `plane`.
- Host serves as attribution and explanation metadata only.
- Prohibits host federation, cross-host allocation, and cross-host credential sharing.

### OD-10 — Context Overflow Policy

- **Verdict: APPROVED.**
- Future `context@3` fails closed on overflow (`required-overflow`, `unclassified-overflow`).
- Prohibits automatic independent turns and request-only fallbacks that lose history.

### OD-11 — Default Resource Intelligence

- **Verdict: DEFERRED.**
- Retain current accepted routing; evaluate `resource-intelligence@2` default after measured benchmark evidence.

### OD-12 — Live Provider Authentication Policy

- **Verdict: OWNER-INITIATED PER ACTION.**
- No blanket authorization for real provider authentication, OAuth flows, or paid inference.
- Implementation and testing must use deterministic offline mocks and fake credentials.

### OD-13 — Optional Context Classification

- **Verdict: APPROVED.**
- Conservative classification: Default sole optional category is owner-marked optional or explicitly superseded turns.
- Instructions, decisions, constraints, and unclassified conversation must never be dropped due to capacity pressure.

### OD-14 — Session Sidecar Architecture

- **Verdict: APPROVED AT ARCHITECTURE LEVEL.**
- Future `context@3` sidecar `session-context@1` approved.
- Written strictly by `FileSessionStore`; release requires TST-44–56 verification in NXR-070I′.

### OD-15 — Plan Account Replacement

- **Verdict: APPROVED.**
- Explicit sequential plan account replacement: Previous connection tombstoned; new connection ID generated; history preserved.
- Concurrent multi-plan support remains gated by E-1.

---

## 3. Additional Owner Decisions (R-DEC-01 through R-DEC-06)

- **R-DEC-01:** Approved `context@3` as the future enhanced context policy identifier.
- **R-DEC-02:** Approved store ownership boundaries: `ProjectMemoryStore` owns confirmed facts; `FileSessionStore` owns canonical session persistence and sidecars.
- **R-DEC-03:** Approved rollback to accepted ADR-030 baseline without rolling back Project Memory.
- **R-DEC-04:** Approved Upstream Intelligence scope freeze: UI-01 offline foundation retained; UI-02..04 deferred (`UPSTREAM_INTELLIGENCE_FOUNDATION_ACCEPTED_FURTHER_DEVELOPMENT_DEFERRED`).
- **R-DEC-05:** Approved retaining exact DSH pin `@deepseek-ai/dsh@0.2.0-rc.2`; no unverified upgrades.
- **R-DEC-06:** Approved T3 Code reference role: T3 Code Orchestrator V2 remains an architecture reference only; not installed, imported, or integrated via MCP.

---

## 4. Engineering Authorizations & Boundaries

### Authorized Actions

1. Formally update ADR-029 and companion documents to **Accepted**.
2. Perform final review and verify PR #40, PR #42, and PR #43.
3. Sequentially merge PR #40, PR #42, and PR #43 into `main` after mandatory checks pass.
4. Create feature branch `feat/nxr-070b-multi-api-connections` from updated `main`.
5. Implement NXR-070B′: Multi-API-Key Connections, secure credential isolation, connection lifecycle management.
6. Publish NXR-070B′ as a Draft PR for independent owner acceptance review.

### Prohibited Actions

- Force-pushing or bypassing branch protections.
- Live provider logins or paid inference calls.
- Inspecting or handling production credentials.
- Upgrading DeepSeek Harness.
- Installing T3 Code.
- Developing deferred Upstream Manager features (UI-02..04).
- Merging NXR-070B′ into `main` without separate owner authorization.
