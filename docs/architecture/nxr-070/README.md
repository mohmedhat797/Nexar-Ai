# NXR-070 — Resource Fabric v2 architecture package

**Status:** Accepted architecture (formally ratified by owner on 2026-10-17).

- [ADR-029](../../adr/029-connection-scoped-resources-and-canonical-continuity.md) is **Accepted — 2026-10-17**.
- Initial implementation tracks completed: NXR-070A′ (PR #42) and UI-01 (PR #43).
- Next implementation authorized: NXR-070B′ (Multi-API-Key Connections & Credential Lifecycle).
- Upstream Intelligence Manager (UI-02..04) deferred: `UPSTREAM_INTELLIGENCE_FOUNDATION_ACCEPTED_FURTHER_DEVELOPMENT_DEFERRED`.

## What each source is, and which one wins

| Layer                        | Where                                                                                                                                | Authority                                                                                                                                            |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| Accepted v0.6 implementation | `9e71014` (merge `2f856f9`); [official baseline](../../devlog/evidence/Nexar_v0.6_Official_Baseline.md)                              | **Authoritative for existing behavior.** Nothing here changes it                                                                                     |
| Historical Codex research    | branch `research/nxr-070-resource-fabric` at `b843d04` (not merged)                                                                  | Historical input only. Superseded wherever it disagrees with the reconciled proposal                                                                 |
| Independent Opus audit       | [`audit/`](audit/NXR070_Independent_Architecture_Audit.md) (nine documents, preserved as reviewed; only their links were relocated)  | Historical review evidence: findings F-01–F-21, O-1–O-3. Its own recommendations were refined later, so read it as evidence, not as the final design |
| **Accepted architecture**    | [ADR-029](../../adr/029-connection-scoped-resources-and-canonical-continuity.md) and the documents in this directory                 | **Accepted architecture.** Extends accepted ADR-030 baseline.                                                                                        |
| Owner decisions              | [Owner Decisions 2026-10-17](NXR070_Owner_Decisions_2026-10-17.md) and [Decision register](NXR070_Architecture_Decision_Register.md) | Authoritative record of ratified owner decisions OD-1 through OD-15 and R-DEC-01 through R-DEC-06                                                    |

## Reconciled documents

| Document                                                                         | Content                                                                      |
| -------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| [ADR-029](../../adr/029-connection-scoped-resources-and-canonical-continuity.md) | The accepted decision; amends ADR-028; refines ADR-027 §10 and ADR-024 §10   |
| [Owner decisions 2026-10-17](NXR070_Owner_Decisions_2026-10-17.md)               | Ratified owner decisions OD-1..15 and R-DEC-01..06                           |
| [Implementation blueprint](NXR070_Implementation_Blueprint_Reconciled.md)        | REQ-01–47, TST-01–58, units A′–J′, gates, rollback                           |
| [Security threat model](NXR070_Security_Threat_Model_Reconciled.md)              | R-01–R-15, trust boundaries, per-unit security gates                         |
| [Decision register](NXR070_Architecture_Decision_Register.md)                    | OD-1–OD-15, R-DEC-01–06, AD-1–AD-7, evidence gates E-1/E-2                   |
| [Execution plan](NXR070_Execution_Plan_Reconciled.md)                            | Sequence, CI and release gates, owner live matrix                            |
| [Traceability](NXR070_Reconciliation_Traceability.md)                            | Research → finding → correction → requirement → test → decision              |
| [Closure report](NXR070_Final_Corrections_Closure_Report.md)                     | Final corrections C1–C5 and clarifications K1–K2                             |
| [Approval brief](NXR070_Final_Architecture_Approval_Brief.md)                    | What changed, decisions and readiness                                        |
| [Architecture Reconciliation](NXR070R2_Final_Architecture_Reconciliation.md)     | Final R01–R17 reconciliation against ADR-030 and upstream intelligence       |
| [T3 Code V2 Reconciliation](NXR070_T3Code_V2_Architecture_Reconciliation.md)     | Detailed upstream comparative evaluation of T3 Code v0.1.0 and DSH candidate |
| [Execution Brief](NXR070_Architecture_Approval_and_Execution_Brief.md)           | Approval and execution brief for NXR-070A′ and upstream foundation           |

## Status at publication (from the decision register)

| Status                 | Items                                                                                                                                                                                                                                                                                                              |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Approved by owner      | OD-1 (ADR-029); OD-4a (API-key connections first); OD-4b (Codex homes second); OD-5 (review diversity); OD-7 (lifecycle); OD-8 (account binding); OD-9 (host identity); OD-10 (`context@3` overflow); OD-13 (conservative optional); OD-14 (`session-context@1` sidecar); OD-15 (single-plan replace); R-DEC-01–06 |
| Confirmed by owner     | OD-3 (`context@3`, no native resume/fork/persistence); OD-6 (no budget enforcement); OD-12 (live logins owner-initiated per action)                                                                                                                                                                                |
| Deferred               | OD-2 (generic ACP worker); OD-11 (resource-intelligence@2 default); Upstream Manager UI-02..04; concurrent multi-plan; cross-host allocation and review; remote hosts; learned quality; budgets; HTTP MCP                                                                                                          |
| Evidence-gated         | E-1 (concurrent ChatGPT plan accounts, OD-4c); E-2 (Claude multi-account isolation, OD-4d)                                                                                                                                                                                                                         |
| Live owner action only | OD-12 (logins and provider tests)                                                                                                                                                                                                                                                                                  |
