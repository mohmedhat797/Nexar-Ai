# NXR-070 — Execution Plan (Reconciled, PROPOSED)

Estimates are qualified assumptions for the ADR-009 workflow: Opus architects and reviews, Sonnet implements, one "dispatch" per brief. They are not guarantees. Nothing here is authorized until OD-1 is approved. Corrections C1–C5 and clarifications K1–K2 are reflected throughout ([closure report](NXR070_Final_Corrections_Closure_Report.md)).

## 1. Sequence and dependencies

| Step | Unit                                                 | Depends on                                       | Boundary (in / out)                                                                                                                                           | Dispatches    |
| ---- | ---------------------------------------------------- | ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------- |
| 0    | 070-0 documentation-only PR with this package        | owner go-ahead                                   | docs only / no code                                                                                                                                           | 1             |
| 1    | A′ identity contract                                 | OD-1, OD-9                                       | contracts, registry, host identity sources, Desktop plane DTO / **no persistent store**, settings, IPC, credentials                                           | 1             |
| 2    | B′ API-key connections + lifecycle + account binding | A′, OD-7, OD-8, OD-15                            | settings (definitions, tombstones, binding), key store, pi catalog, plan binding record and Replace, IPC, minimal UI / no native, no concurrent plan accounts | 3             |
| 3    | C′ review dimensions                                 | B′, OD-5                                         | strategy / no defaults changed; host attribution only                                                                                                         | 1             |
| 4    | F′ provenance                                        | A′                                               | telemetry records / no budget                                                                                                                                 | 1–2           |
| 5    | G′ `resource-intelligence@2`                         | C′, F′                                           | new policy module / v1 untouched                                                                                                                              | 2             |
| 6    | D′ Codex homes                                       | B′                                               | codex integration, homes, lifecycle guards / no Claude, no plan                                                                                               | 2             |
| 7    | H′ Providers UI v2                                   | B′, D′                                           | renderer and IPC / no new authority                                                                                                                           | 2             |
| 8    | I′ `context@2` + sidecar                             | OD-1, OD-10, OD-13, OD-14 (parallel from step 1) | operating classifier and assembler; sidecar methods inside `FileSessionStore`; owner actions / no session schema change, no second writer, no native state    | 3             |
| 9    | J′ owner acceptance                                  | all above                                        | evidence / no release                                                                                                                                         | owner session |
| —    | E′ concurrent plan accounts                          | gate E-1                                         | —                                                                                                                                                             | not scheduled |
| —    | Claude accounts                                      | gate E-2                                         | —                                                                                                                                                             | not scheduled |

Parallel tracks: {A′ → B′ → C′/D′ → H′}, {F′ after A′, then G′ after C′ and F′}, {I′ after P0}. Each track uses its own worktree; commits are cherry-picked in DAG order onto one integration branch.

## 2. Acceptance tests per step

Entry and exit gates per unit are in the [blueprint](NXR070_Implementation_Blueprint_Reconciled.md) §4. Every unit also passes its security gates in the [threat model](NXR070_Security_Threat_Model_Reconciled.md). TST-06, TST-27, TST-30 and TST-31 run at every step.

Test ownership:

- **A′:** TST-03 covers only the pure generator and collision contract.
- **B′:** persistent tombstones (TST-43) and the account-switching contract (TST-57, TST-58).
- **I′:** the sidecar integrity suite, TST-44–56.

## 3. Rollback

| Unit           | Rollback                                      | Data effect                                                                                                                                                              |
| -------------- | --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| A′, C′, F′, G′ | revert commit                                 | none                                                                                                                                                                     |
| B′, D′, H′     | feature flag off                              | owner connections hidden; credentials, homes, binding records and tombstones retained; pins fail explicitly; a replaced plan connection stays retired                    |
| I′             | revert to `context@1`                         | sessions stay readable by v0.6 (TST-45, TST-55, evidence ADR §4.6.5); sidecars and quarantine files untouched; re-enabling reconciles (TST-49); no migration or deletion |
| Any            | never force-push, never hard-reset owner data | —                                                                                                                                                                        |

## 4. CI gates (per commit and unit)

1. `pnpm check` locally. On this machine (Node 24 vs pinned 22), rerun the unit-test step with `--maxWorkers=2` if a worker crashes, and report both runs.
2. Gitleaks, plus a BOM, control-character and CRLF scan of the diff.
3. Exact-head CI green on Ubuntu and Windows, including source Desktop E2E, Windows packaging and packaged E2E, before the next unit stacks.
4. No paid or live calls in CI.
5. **For I′:** TST-45, TST-49 and TST-55 run the v0.6 store and reader code pinned at `9e71014` as a test fixture dependency, not a reimplementation.

## 5. Release gates (J′)

1. All units in scope are merged to a draft PR branch, with exact-head CI green on its final head.
2. Desktop and plane are built from the same SHA where both changed.
3. The owner live matrix passes. Each row needs an explicit owner action:

   | Row | Scenario                                                                                  | PASS                                                                                                           |
   | --- | ----------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
   | L1  | Two OpenAI API-key connections                                                            | Both route independently; removing one leaves the other's pins and history intact                              |
   | L2  | Two Codex connections (owner logs in to the second home)                                  | Executions observe distinct homes; attribution correct                                                         |
   | L3  | Rotation of one API key while idle, then attempted while a turn runs                      | Idle: same resource ids, next execution uses the new key, assurance "owner-asserted"; active: refused          |
   | L4  | Disable, Remove, Restore, Forget and same-account re-entry on an owner connection         | Each behaves per ADR §4.3; the account never changes                                                           |
   | L5  | Review with `connection` preferred, then required with no eligible candidate              | Preferred: different connection when eligible; required and unavailable: explicit failure, no downgrade        |
   | L6  | Cross-provider turn sequence with an early unpromoted constraint and one promoted to C1   | Both carried with attribution; overflow rejected with explanation; independent turn only by explicit action    |
   | L7  | Plan re-sign-in with the same account; then (optional, owner choice) Replace plan account | Same → connection continues; Replace → old connection retired, old pins fail explicitly, new connection active |
   | L8  | v0.6 regression (Cowork SOW, read-only standalone unit, native Code lane)                 | Unchanged results                                                                                              |

   Control-loop rows are Cowork only. DSH Code Control stays unconfigured and outside NXR-070.

4. Rollback rehearsal for I′, on the release candidate: a session written under `context@2` opens and mutates in the v0.6 build, then reopens and reconciles in the new build (the TST-49 procedure).
5. The evidence document records SHAs, consent, counts and reason codes, with no secrets or subjects.
6. The PR stays draft until the owner accepts. No release or tag without a separate decision.

## 6. Risks

| Risk                                                                   | Mitigation                                                                 |
| ---------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| Settings migration defects                                             | Additive section, backup, fail-closed reads (TST-16)                       |
| IPC widening                                                           | Main-generated ids; fuzz tests (TST-15)                                    |
| More context-overflow rejections in long sessions (conservative OD-13) | Owner actions: mark optional, promote, independent turn                    |
| Sidecar complexity in I′                                               | Single writer reused (B9); dedicated integrity suite TST-44–56; I′ sized L |
| Local Windows test flakiness                                           | Exact-head CI is authoritative                                             |
| Gate E-1 or E-2 never passes                                           | Tiers 3 and 4 stay roadmap items; no claim of support                      |

## 7. Owner decision points

Each decision is listed in the [register](NXR070_Architecture_Decision_Register.md).

| Before                  | Decisions needed                            |
| ----------------------- | ------------------------------------------- |
| Step 0 (docs PR)        | your go-ahead to push the docs branch       |
| Step 1 (A′)             | OD-1, OD-9                                  |
| B′ and D′               | OD-7, OD-8, OD-15                           |
| C′                      | OD-5                                        |
| I′                      | OD-10, the OD-13 category list, final OD-14 |
| Removing the ACP worker | OD-2                                        |

OD-3, OD-4a, OD-4b and OD-6 are confirmed. The OD-13 direction is confirmed and OD-14 is conditionally accepted.
