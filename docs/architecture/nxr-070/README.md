# NXR-070 — Resource Fabric v2 architecture package

**Status:** proposed architecture for owner review.

- [ADR-029](../../adr/029-connection-scoped-resources-and-canonical-continuity.md) is **Proposed**, not accepted.
- NXR-070 implementation has **not started**.
- Publishing this package authorizes no implementation, login, live provider test, deployment or release.

## What each source is, and which one wins

| Layer                                | Where                                                                                                                               | Authority                                                                                                                                            |
| ------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| Accepted v0.6 implementation         | `9e71014` (merge `2f856f9`); [official baseline](../../devlog/evidence/Nexar_v0.6_Official_Baseline.md)                             | **Authoritative for existing behavior.** Nothing here changes it                                                                                     |
| Historical Codex research            | branch `research/nxr-070-resource-fabric` at `b843d04` (not merged)                                                                 | Historical input only. Superseded wherever it disagrees with the reconciled proposal                                                                 |
| Independent Opus audit               | [`audit/`](audit/NXR070_Independent_Architecture_Audit.md) (nine documents, preserved as reviewed; only their links were relocated) | Historical review evidence: findings F-01–F-21, O-1–O-3. Its own recommendations were refined later, so read it as evidence, not as the final design |
| **Reconciled architecture proposal** | [ADR-029](../../adr/029-connection-scoped-resources-and-canonical-continuity.md) and the documents in this directory                | **The current proposal.** It takes precedence over the research and the audit-stage drafts                                                           |
| Owner decisions                      | [Decision register](NXR070_Architecture_Decision_Register.md)                                                                       | The only record of what is confirmed, conditionally accepted, pending, deferred or evidence-gated                                                    |

## Reconciled documents

| Document                                                                         | Content                                                                      |
| -------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| [ADR-029](../../adr/029-connection-scoped-resources-and-canonical-continuity.md) | The proposed decision; amends ADR-028; refines ADR-027 §10 and ADR-024 §10   |
| [Implementation blueprint](NXR070_Implementation_Blueprint_Reconciled.md)        | REQ-01–47, TST-01–58, units A′–J′, gates, rollback                           |
| [Security threat model](NXR070_Security_Threat_Model_Reconciled.md)              | R-01–R-15, trust boundaries, per-unit security gates                         |
| [Decision register](NXR070_Architecture_Decision_Register.md)                    | OD-1–OD-15, AD-1–AD-7, evidence gates E-1/E-2                                |
| [Execution plan](NXR070_Execution_Plan_Reconciled.md)                            | Sequence, CI and release gates, owner live matrix                            |
| [Traceability](NXR070_Reconciliation_Traceability.md)                            | Research → finding → correction → requirement → test → decision              |
| [Closure report](NXR070_Final_Corrections_Closure_Report.md)                     | Final corrections C1–C5 and clarifications K1–K2                             |
| [Approval brief](NXR070_Final_Architecture_Approval_Brief.md)                    | What changed, decisions and readiness                                        |
| [Architecture Reconciliation](NXR070R2_Final_Architecture_Reconciliation.md)     | Final R01–R17 reconciliation against ADR-030 and upstream intelligence       |
| [T3 Code V2 Reconciliation](NXR070_T3Code_V2_Architecture_Reconciliation.md)     | Detailed upstream comparative evaluation of T3 Code v0.1.0 and DSH candidate |
| [Execution Brief](NXR070_Architecture_Approval_and_Execution_Brief.md)           | Approval and execution brief for NXR-070A′ and upstream foundation           |

## Status at publication (from the decision register)

| Status                 | Items                                                                                                                                                                              |
| ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Confirmed by owner     | OD-3 (`context@3`, no native resume/fork/persistence); OD-4a (API-key connections first); OD-4b (Codex homes second); OD-6 (no budget enforcement); OD-13 direction (conservative) |
| Conditionally accepted | OD-14 (sidecar persistence, conditions in ADR §4.6.5)                                                                                                                              |
| Pending                | OD-1, OD-2, OD-5, OD-7, OD-8, OD-9, OD-10, OD-13 category list, final OD-14, OD-15                                                                                                 |
| Deferred               | OD-11; ACP runtimes; native resume/fork; cross-host allocation and review; remote hosts; learned quality; budgets; HTTP MCP; session deletion                                      |
| Evidence-gated         | E-1 (concurrent ChatGPT plan accounts, OD-4c); E-2 (Claude multi-account isolation, OD-4d)                                                                                         |
| Live owner action only | OD-12 (logins and provider tests)                                                                                                                                                  |
