# NXR-070 — Final Architecture Approval Brief

**Verdict: NXR070_FINAL_ARCHITECTURE_PACKAGE_READY_FOR_APPROVAL.**

The package is internally consistent after corrections C1–C5 and clarifications K1–K2. ADR-029 is **not** approved and remains Proposed. Implementation has not started.

- **Baseline (verified 2026-10-09):**
  - v0.6 implementation `9e71014`, merge `2f856f9`, CI `37955286149` success;
  - main `677eefd`, docs CI `37958959182` attempt 2 success;
  - research `b843d04`, unchanged.
- **Closure:** [corrections closure report](NXR070_Final_Corrections_Closure_Report.md).

## 1. What changed from Codex's original design

| Codex proposed                                                                                                        | Final                                                                                                                                                                      |
| --------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| New entity graph: Driver, Instance, RuntimeDefinition/Environment/Binding/Session, Resource@2, Profile, NRCDecision@2 | Extend `ProviderConnection` and `ProviderRuntimeIdentity`. Only `ConnectionDefinition`, `ConnectionCredentialScope`, `connectionKey` and private account binding are added |
| Instances whose account could be re-bound                                                                             | **A connection never changes account.** A different account is a new connection; nothing is redirected (K2)                                                                |
| Alias manifest and compatibility retirement                                                                           | Built-in ids frozen and never re-pointed                                                                                                                                   |
| One registry across environments; host as a review dimension                                                          | Each host is an independent authority; host is attribution only (C1)                                                                                                       |
| Optional Codex ACP worker                                                                                             | Deferred                                                                                                                                                                   |
| Native session bindings, resume/fork, delivery receipts                                                               | `context@2` with conservative deterministic classification (C2, OD-13), stored in an integrity-checked sidecar written only by the existing session store (C5, K1)         |
| NRC v2 lexicographic ranking with quota/cost preference                                                               | `@2` = v1 scoring + hard filters + provenance; quota rank-neutral; no budget                                                                                               |
| Instance-first accounts                                                                                               | Your order (Decision A), with assurance levels (C3), evidence gates E-1 and E-2, and single-plan Replace (OD-15)                                                           |

## 2. What Opus corrected

| Area                      | Correction                                                                                                             |
| ------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| Governance and invariants | ADR-028/027/024 relationships; v0.6 invariants B1–B9                                                                   |
| Identity                  | Plane/Desktop connection-id collision fixed (F-05); `pi.<provider>.<model>` collision handled (F-11)                   |
| Codex                     | Home attribution fixed (F-06)                                                                                          |
| Code lane                 | Silent context drop replaced by explicit rejection (F-21)                                                              |
| Review                    | Cross-host review requirement removed (C1)                                                                             |
| Accounts                  | No path that redirects an existing connection to another account (C3, K2)                                              |
| Ids                       | Collision checks plus persistent tombstones in the correct unit (C4)                                                   |
| Persistence               | Rollback proven against the actual v0.6 session code; sidecar bound, reconciled, crash-safe and single-writer (C5, K1) |

## 3. Owner decisions

| Status                            | Decisions                                                                                                                                                                                                                                                                              |
| --------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Confirmed by you**              | OD-3 (`context@2`, no native resume/fork/persistence); OD-4a (API keys first); OD-4b (Codex homes second); OD-6 (no budget enforcement); **OD-13 direction** (conservative)                                                                                                            |
| **Conditionally accepted by you** | **OD-14** (sidecar). The conditions are now specified (ADR §4.6.5, REQ-40–45), so it can be approved                                                                                                                                                                                   |
| **Pending**                       | OD-1 (ADR-029); OD-2 (ACP deferral); OD-5 (review dimensions); OD-7 (lifecycle); OD-8 (account binding); OD-9 (host ids); OD-10 (overflow rule); OD-13 category list (recommended: owner-marked optional or superseded turns only); final OD-14; **OD-15** (Replace plan account, new) |
| **Evidence gates**                | OD-4c (concurrent ChatGPT plan, gate E-1); OD-4d (Claude, gate E-2)                                                                                                                                                                                                                    |
| **Deferred**                      | OD-11 (making `@2` the default)                                                                                                                                                                                                                                                        |
| **Per action**                    | OD-12 (live logins and provider tests)                                                                                                                                                                                                                                                 |

## 4. Remaining risks

- **Owner-asserted identity.** API keys and native logins cannot be verified as the same account, and an out-of-band native re-login cannot be detected. Labelled "owner-asserted" (R-03).
- **Long sessions.** They will be rejected for overflow more often by design, under the conservative OD-13 direction.
- **Byte-bound assumption** for token capacity (REQ-34).
- **Cross-provider disclosure** is inherent when you switch providers; the locality policy still applies (R-10).
- **Gates E-1 and E-2** may never pass.
- **DSH Code Control** remains unconfigured and outside NXR-070.

## 5. Is NXR-070A′ ready after approval?

**Yes, after OD-1 and OD-9.** A′ is:

- the pure identity contract and id generator, using the `<built-in family id>.c<suffix>` format, with a collision check;
- no persistent store;
- no settings, IPC, credential, UI, login or inference changes.

Its offline tests are TST-01–07 plus TST-06/27/30/31. Rollback is a revert.

## 6. Exact next action: documentation-only NXR-070-0 PR

This needs your explicit go-ahead to push.

1. Create a worktree from `origin/main` (`677eefd`) on branch `docs/nxr-070-0-architecture`.
2. Add:
   - `docs/adr/029-connection-scoped-resources-and-canonical-continuity.md` (this ADR, status **Proposed**);
   - `docs/architecture/nxr-070/`: blueprint, security, register, execution plan, traceability, closure report and this brief;
   - `docs/architecture/nxr-070/audit/`: the nine audit documents.
3. Rewrite the relative links accordingly.
4. Do not edit ADR-024, ADR-027, ADR-028 or the research branch.
5. Run:
   - `pnpm check` (includes `format:check`);
   - gitleaks;
   - a BOM, control-character and CRLF scan.
6. Commit with `docs: propose reconciled ADR-029 and NXR-070 architecture package`.
7. Push, and open a **draft** PR to `main`.
8. Wait for exact-head CI. Merge only on your decision.

## 7. Consistency validation (offline)

Performed on this package after K1–K2:

| Check               | Result                                                                                                                      |
| ------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| Internal links      | All resolve                                                                                                                 |
| Identifiers         | Every REQ, TST, R and OD reference resolves to a definition; TST-28 and TST-29 are deliberately unassigned (evidence gates) |
| Cited source paths  | All exist at `677eefd`                                                                                                      |
| Formatting          | Prettier (repo config) passes                                                                                               |
| Encoding            | No BOM, control characters or CRLF                                                                                          |
| ADR status          | Proposed everywhere                                                                                                         |
| Binding epochs      | No remaining binding-epoch or rebinding-to-another-account semantics                                                        |
| Host routing        | No cross-host routing claims                                                                                                |
| Required context    | No silent loss: capacity never omits C1–C3 or C5                                                                            |
| Sidecar writes      | Only via `FileSessionStore`                                                                                                 |
| Tombstone tests     | Only in B′                                                                                                                  |
| Deferrals and gates | Labelled consistently                                                                                                       |

## Package index

| Document                                                                                               | Content                                                         |
| ------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------- |
| [ADR029_Reconciled_Proposed.md](../../adr/029-connection-scoped-resources-and-canonical-continuity.md) | The proposed ADR                                                |
| [NXR070_Implementation_Blueprint_Reconciled.md](NXR070_Implementation_Blueprint_Reconciled.md)         | REQ-01–47, TST-01–58, units and gates                           |
| [NXR070_Security_Threat_Model_Reconciled.md](NXR070_Security_Threat_Model_Reconciled.md)               | R-01–R-15                                                       |
| [NXR070_Architecture_Decision_Register.md](NXR070_Architecture_Decision_Register.md)                   | OD/AD status, evidence gates                                    |
| [NXR070_Execution_Plan_Reconciled.md](NXR070_Execution_Plan_Reconciled.md)                             | Sequence, rollback, release gates                               |
| [NXR070_Reconciliation_Traceability.md](NXR070_Reconciliation_Traceability.md)                         | Proposal → finding → correction → requirement → test → decision |
| [NXR070_Final_Corrections_Closure_Report.md](NXR070_Final_Corrections_Closure_Report.md)               | C1–C5 and K1–K2 closure                                         |
