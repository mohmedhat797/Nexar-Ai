# NXR-070 — Independent Architecture Audit (Executive)

Reviewer: Claude Opus 5.5 (independent of the original author, Codex). Date: 2026-10-09.

**Inputs:**

- Accepted v0.6 at `9e71014` (merge `2f856f9`, docs `677eefd`). Verified on GitHub on 2026-10-09:
  - PR #39 is MERGED as `2f856f9`.
  - Post-merge CI `37955286149` succeeded.
  - Documentation CI `37958959182` attempt 2 on `677eefd` succeeded.
  - `origin/main` is still `677eefd`.
  - The research branch is still `b843d04`.
- Authority order: the v0.6 implementation is the architecture baseline, main documentation is the project state, and the research snapshot is historical.
- NXR-070 research at `b843d04` (base `4c69d1c`).
- T3 Code pin `3143335` and HEAD `31b04e2`.
- Goose pin `9560429` and HEAD `903743e`.
- ACP spec v1 and v2 pages.
- Official Codex documentation.

**Workspace:** an isolated worktree, `D:/Nexar-Ai-nxr070-opus-review` (branch `review/nxr070-opus-architecture-audit`, no commits, nothing pushed). The deliverables are in `D:/Nexar-NXR070-Opus-Audit/`. No production code, credentials, logins or paid calls were touched. Codex's and Gemini's worktrees were not modified.

## Executive verdict

**ARCHITECTURE_READY_WITH_REQUIRED_AMENDMENTS.**

The direction is sound:

- Nexar keeps ownership of resources and policy.
- Changes are additive and backward-compatible.
- Credentials are never harvested.
- Model-turn and agent-run stay separate.
- Control is pinned.
- Unknowns are honest.
- Hard filters run before scoring.

The proposal is not implementable as written, for three reasons:

1. **It conflicts with Accepted ADR-028.** ADR-028 already defines provider → multiple connections → routes → inventory → resources, and forbids a driver mega-interface. ADR-029 never cites ADR-027 or ADR-028 (F-01).
2. **It was not reconciled with the accepted v0.6 security fixes** made after its research base (F-02).
3. **It builds a new entity graph over contracts that already exist.** Instance, binding, environment and driver duplicate `ProviderConnection`, `ProviderRuntimeIdentity`, `machine` and the adapter ports, and the new `RuntimeBinding` name collides with an existing type (F-03).

All three are amendment-level fixes, not a redesign.

## Strengths (VERIFIED against code)

- Accurate inventory of v0.6 foundations. The cited file seams all exist (70 paths checked; only the explicitly proposed ones are missing).
- Correct rejections: T3 keychain token reads, Goose Auto → bypass/full-access, secret-hashed identities, HTTP MCP passthrough.
- Correct emphasis on fail-closed unknowns, generation guards, Control pinning, and keeping NRC selection separate from authorization.
- A good discipline of labelling claims VERIFIED, INFERRED or UNVERIFIED in the study.

## Critical weaknesses

| Area          | Issue                                                                                             | Finding |
| ------------- | ------------------------------------------------------------------------------------------------- | ------- |
| Governance    | ADR-028 overlap and silent reversal of its deferrals                                              | F-01    |
| Baseline      | Delta invariants missing; NXR-066b status now incorrect                                           | F-02    |
| Model         | 12 entities where 3 additions suffice; name collision                                             | F-03    |
| Environments  | Assumes one cross-host registry/NRC; v0.6 has two independent hosts                               | F-04    |
| Identity      | Plane and Desktop share connection ids for different accounts                                     | F-05    |
| Multi-account | Missing the concrete official mechanism (`CODEX_HOME`); latent `codexHome` attribution bug        | F-06    |
| Sessions      | Native resume reintroduces cross-account risk that v0.6 avoids by design                          | F-07    |
| ACP           | No requirement; duplicates the existing ACP client and adapter; third-party adapter; ACP v2 drift | F-08    |
| NRC v2        | Bias toward vendors that report quota; starvation; cash-budget scope creep                        | F-09    |

## Confirmed risks if implemented unchanged

- Duplicate abstractions and conflicting ADRs.
- Regression of the 3cbd6a6 and 9e71014 security fixes.
- Account conflation between plane and Desktop.
- Wrong-account attribution for Codex resources with a custom home.
- A new native-resume attack surface.
- Large, unrequired ACP scope.
- Ranking bias.

## Recommendations

1. Amend ADR-029 (`ADR029_Proposed_Amendments.md` §A–E).
2. Grow along connections. Built-in connections keep their v0.6 ids, which needs zero aliases (O-1). The first real second account is an API key (O-2).
3. Keep each host an independent authority.
4. Replace native session binding with typed `context@2`.
5. Defer ACP, native resume/fork, cross-host allocation, budgets and learned quality.
6. Make `resource-intelligence@2` equal to v1 scoring plus new hard filters and explanations.

## Implementation readiness

| Item                                | Status                                                                                                 |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------ |
| ADR-029 approvable as written       | **No** (2 blockers)                                                                                    |
| ADR-029 approvable with Amendments  | Yes, pending owner decisions OD-1…OD-6                                                                 |
| NXR-070A ready as written           | **No**: it proves properties that already hold and misses the `pi.<provider>.<model>` collision (F-11) |
| NXR-070A′ (identity contract) ready | Ready after P0 approval: small, offline, reversible, no login, no inference                            |
| Upstream research                   | Valid at its pins; T3 has moved 4 of the 18 cited files since (F-18); ACP v2 not yet considered        |

## Deliverable index

| #   | File                                          | Purpose                                      |
| --- | --------------------------------------------- | -------------------------------------------- |
| 1   | `NXR070_Independent_Architecture_Audit.md`    | This summary                                 |
| 2   | `NXR070_Critical_Findings_Register.md`        | All findings: evidence, impact, corrections  |
| 3   | `NXR070_Upstream_Research_Verification.md`    | T3, Goose and ACP verification and matrix    |
| 4   | `NXR070_v0.6_Architecture_Reconciliation.md`  | As-is model, diagram, concept mapping        |
| 5   | `ADR029_Proposed_Amendments.md`               | D1–D18 verdicts and replacement wording      |
| 6   | `NXR070_Implementation_Blueprint_Reviewed.md` | Corrected contracts, units, DAG, tests, DoD  |
| 7   | `NXR070_Security_Threat_Model.md`             | Threats, boundaries, multi-account scenarios |
| 8   | `NXR070_Execution_Readiness_Plan.md`          | Phases, gates, risks, owner decisions        |
| 9   | `NXR070_Owner_Decision_Brief.md`              | Owner answers                                |
