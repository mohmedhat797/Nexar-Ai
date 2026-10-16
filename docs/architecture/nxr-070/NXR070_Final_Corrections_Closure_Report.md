# NXR-070 — Final Corrections Closure Report (C1–C5, K1–K2)

- **Date:** 2026-10-09.
- **Git state verified before each round:**
  - `origin/main` = `677eefd`;
  - `origin/research/nxr-070-resource-fabric` = `b843d04`;
  - review worktree clean.
- **Scope:**
  - Round 1: five corrections C1–C5 from the owner's technical review.
  - Round 2: two clarifications K1–K2, plus owner directions on OD-13 and OD-14.
  - No new features, no redesign.
- **ADR-029 status:** remains **Proposed**. Implementation has not started.

## 1. Corrections and clarifications

| #      | Item                                            | Resolution                                                                                                                                                                                                                                                                                              |
| ------ | ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| C1     | Review independence vs host authority           | `resource` stays the default; `connection` and `provider` are optional. `host` is attribution only, and the schema rejects it as a dimension. A required unavailable dimension fails with `strategy.diversity.<dimension>.unavailable` and never downgrades. Cross-host review is deferred. B4 is kept. |
| C2     | `context@2` required-information classification | Deterministic classes C1–C5. Only owner actions and Nexar structured records classify. Two overflow rejections. An independent turn needs an explicit owner action. Character limits, token capacity and reserve are separate; unknown capacity is never invented.                                      |
| C3     | Rotation and account identity                   | Four assurance levels; verified-different rejected with no override; in-flight lifecycle actions refused. _The C3 rebinding-with-epoch path is withdrawn by K2._                                                                                                                                        |
| C4     | Id generation and tombstone test ownership      | A′ has a pure generator and collision contract (TST-03) and no store. B′ adds persistent uniqueness and tombstones (REQ-39, TST-43).                                                                                                                                                                    |
| C5     | `context@2` downgrade safety                    | Evidence-based: v0.6 strict schemas, free policy string, listing filter. Decision: keep the manifest in its v0.6 shape and put typed data in a sidecar.                                                                                                                                                 |
| **K1** | Sidecar integrity                               | Full contract in ADR §4.6.5 items 2–9, summarized in §1a below.                                                                                                                                                                                                                                         |
| **K2** | Verified account switching                      | Rule: **a connection never changes account**. Details in §1b below.                                                                                                                                                                                                                                     |
| OD-13  | Owner direction                                 | Conservative policy. All prior owner text and model output is C5, never omitted for capacity. Optional only by documented approved classification; recommended default: owner-marked optional or superseded turns. "Model output outside the window" is no longer optional.                             |
| OD-14  | Owner direction                                 | Conditionally accepted, subject to K1; the conditions are now specified.                                                                                                                                                                                                                                |

### 1a. K1 sidecar integrity contract

1. **Binding.** The sidecar records `sessionId`, `boundRevision` and per-turn SHA-256 digests of a fixed projection.
2. **Staleness.** The sidecar is stale unless the session id, revision and all covered digests match; a valid filename is never trusted. Stale sidecars are reconciled deterministically:
   - promotions are kept and flagged;
   - marks on changed turns are dropped;
   - uncovered turns are C5.
3. **Single writer.** Sidecar writes go only through `FileSessionStore` (B9): the lease, the per-session serialized chain and `expectedRevision`. The session is written first, then the sidecar. A crash in between leaves a stale sidecar, which is reconciled.
4. **Atomic write.** Exclusive temp file, `fsync`, replace, mode 0600. Leftover temp files are cleaned under the lease by exact pattern only.
5. **Bounds.** At most 1 MiB with item limits; strict schema; forbidden-key check; `readBounded` (no symlink, junction or hard link; real-path containment); directory 0700.
6. **Missing sidecar.** If there is no prior `context@2` manifest, this is normal. If there is one, turns are refused with `context.store-missing` until the owner chooses Reconstruct.
7. **Corrupt, unsupported or foreign sidecar.** Turns are refused with `context.store-unreadable`. Reconstruct quarantines the file by renaming it, never deleting it, then rebuilds C2/C3 from canonical records with everything else as C5.
8. **Deletion.** No session deletion exists. Orphan and quarantine files are never deleted automatically. Backup and restore cases are covered by items 2, 6 and 7.

### 1b. K2 account-switching contract

1. **Assurance outcomes.**
   - Verified same: same connection.
   - Owner-asserted same: same connection, with the label.
   - Verified different: rejected, no override.
   - Unknown: an owner assertion or a new connection.
2. **Forget credentials** deletes credentials only. It keeps the account association and the plan binding record, so re-entry must be the same account.
3. **The binding-epoch rebinding introduced in C3 is withdrawn.**
4. **Built-in single plan before E-1.** A different account is offered **Replace plan account** (OD-15, pending). Replace:
   - retires the old connection (tombstone, binding record deleted, pins fail `pin.connection-removed`, history and decisions kept under the old ids);
   - creates `openai.chatgpt-plan.c<suffix>`.

   At most one active plan connection exists. This is not multi-plan support. If OD-15 is declined, verified different plan accounts are refused, with no switch path until E-1.

## 2. Affected sections

| Document                                        | Round 1 (C1–C5)                                                   | Round 2 (K1–K2, OD-13/14)                                                                                                                                                                                                                                                                                                                    |
| ----------------------------------------------- | ----------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ADR029_Reconciled_Proposed.md`                 | §1, §2, §3 (B8), §4.1–4.3, §4.5, §4.6, §4.8, §4.9, §5, §6, §8, §9 | header; §2 (Connection, Account binding); §3 (B9); §4.1 (family id format); §4.3 rewritten (no account change, binding record, Forget, Replace, lifecycle table); §4.4 tier 3 wording; §4.5 (`connection` compares `connectionKey`); §4.6.1 (conservative C4/C5); §4.6.3; §4.6.5 rewritten (items 1–10); §4.8; §4.9; §5 (D2, D9); §6; §8; §9 |
| `NXR070_Implementation_Blueprint_Reconciled.md` | §1–§7                                                             | header id table; §1 rows; REQ-03, 05, 10, 12, 13, 19, 21, 23, 25, 28, 30, 33, 37, 40, 41 amended; REQ-42–47 added; §3 notes; §4 gates and B′/I′ scopes; TST-05, 09, 10, 12, 13, 19, 21, 23, 25, 33, 36, 42, 45, 46, 47 amended; TST-49–58 added; §6; §7                                                                                      |
| `NXR070_Security_Threat_Model_Reconciled.md`    | R-01–R-15                                                         | R-03 rewritten (account redirection); R-04, R-05, R-07, R-08, R-11, R-12, R-14 amended; B9; deferred list                                                                                                                                                                                                                                    |
| `NXR070_Architecture_Decision_Register.md`      | OD-5, 8, 10, 13, 14                                               | legend; OD-8 amended; OD-13 direction confirmed; OD-14 conditionally accepted; OD-15 added; AD-6, AD-7                                                                                                                                                                                                                                       |
| `NXR070_Execution_Plan_Reconciled.md`           | §1–§7                                                             | B′ depends on OD-15; I′ L-sized; CI gate 5 (pinned v0.6 fixture code); L4, L7 rows; rollback rehearsal via TST-49                                                                                                                                                                                                                            |
| `NXR070_Reconciliation_Traceability.md`         | C1–C5 rows                                                        | D2, D9, D13 rows; K1, K2, OD-13 rows; entities                                                                                                                                                                                                                                                                                               |
| `NXR070_Final_Architecture_Approval_Brief.md`   | all                                                               | all                                                                                                                                                                                                                                                                                                                                          |

## 3. Decisions changed

| Decision | Round 1                     | Round 2                                                                |
| -------- | --------------------------- | ---------------------------------------------------------------------- |
| OD-5     | host removed as a dimension | `connection` compares `connectionKey`                                  |
| OD-8     | assurance levels            | binding-epoch rebinding withdrawn; Forget keeps the account            |
| OD-10    | two overflow codes          | —                                                                      |
| OD-13    | new (pending)               | **direction confirmed by owner (conservative)**; category list pending |
| OD-14    | new (pending)               | **conditionally accepted by owner**; conditions specified              |
| OD-15    | —                           | **new**: Replace plan account (pending)                                |

Unchanged:

- **Confirmed:** OD-3, OD-4a, OD-4b, OD-6.
- **Pending:** OD-1, OD-2, OD-7, OD-9.
- **Evidence gates:** OD-4c (E-1), OD-4d (E-2).
- **Deferred:** OD-11.
- **Per action:** OD-12.

## 4. Requirements changed

| Round | Amended                                                        | Added                                                                                                                                                                                                  |
| ----- | -------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1     | REQ-03, 09, 10, 13, 20, 21, 23, 24, 25, 27, 30, 31             | REQ-32–41                                                                                                                                                                                              |
| 2     | REQ-03, 05, 10, 12, 13, 19, 21, 23, 25, 28, 30, 33, 37, 40, 41 | REQ-42 (single writer, crash safety); REQ-43 (bounds, file safety); REQ-44 (missing, corrupt, foreign handling); REQ-45 (no deletion, orphans); REQ-46 (binding record); REQ-47 (Replace plan account) |

No renumbering.

## 5. Tests changed

| Round | Amended                                                        | Added     |
| ----- | -------------------------------------------------------------- | --------- |
| 1     | TST-03, 09, 10, 13, 20, 21, 23, 24, 25, 27                     | TST-32–48 |
| 2     | TST-05, 09, 10, 12, 13, 19, 21, 23, 25, 33, 36, 42, 45, 46, 47 | see below |

Round 2 added tests:

- **TST-49** v0.7 → v0.6 → mutation → v0.7.
- **TST-50** crash between session and sidecar publication.
- **TST-51** stale sidecar with a valid filename.
- **TST-52** missing or corrupt sidecar.
- **TST-53** concurrent updates.
- **TST-54** symlinked, junctioned, hard-linked or oversized sidecar.
- **TST-55** normal v0.6 reader compatibility.
- **TST-56** orphan and quarantine preservation.
- **TST-57** account-switching contract.
- **TST-58** binding-record lifecycle.

TST-28 and TST-29 are deliberately unassigned.

## 6. Security consequences

- **R-03 strengthened.** No path can bind an existing connection to a different account. Its pins, history and decisions are never redirected.
- **R-14 strengthened.** Single writer, binding, staleness reconciliation, crash safety, link refusal, quarantine instead of deletion.
- **R-11 strengthened.** Capacity never omits unclassified context.
- **New invariant B9:** a single session-directory writer.
- No v0.6 control is weakened.

## 7. Remaining uncertainties

- **Owner-asserted identity.** API keys and native logins have no verifiable identity. A wrong owner assertion, or an out-of-band native re-login inside a Nexar home, cannot be detected (labelled residual, R-03).
- **Byte bound.** The UTF-8 byte bound assumes byte-level tokenizers (REQ-34).
- **Sequential plan replacement under one installation host id.** This is the same behavior v0.6 already allows (disconnect, then sign in). Its vendor-side semantics are not further verified. Concurrent plan accounts remain gated by E-1.
- **Long sessions.** They will hit overflow rejections more often under the conservative OD-13 direction.
- **Gates and DSH.** E-1 and E-2 are unresolved, and DSH Code Control remains outside NXR-070.

## 8. Owner decisions still needed

- OD-1, OD-2, OD-5, OD-7, OD-8, OD-9, OD-10.
- The **OD-13 category list**.
- **Final OD-14** (now safe to approve).
- **OD-15** (new).

## 9. Corrected implementation readiness

| Unit           | Ready?                    | Condition                                                                         |
| -------------- | ------------------------- | --------------------------------------------------------------------------------- |
| A′             | Ready after OD-1 and OD-9 | Unchanged by K1–K2 except the family id format (`<built-in family id>.c<suffix>`) |
| B′             | Specified                 | Needs OD-7, OD-8, OD-15                                                           |
| C′             | Specified                 | Needs B′ and OD-5                                                                 |
| D′, F′, G′, H′ | Specified                 | —                                                                                 |
| I′             | Specified; resized L      | Needs OD-10, the OD-13 list, final OD-14                                          |
| E′             | Gated by E-1              | —                                                                                 |

## 10. Final recommendations

1. Approve OD-1 and OD-9 to unblock A′.
2. Approve OD-14 now. Its conditions (ADR §4.6.5, REQ-40–45) are fully specified, and release enforces TST-44–56.
3. Decide OD-15 before B′. Recommendation: approve. It is the only way to keep single-plan switching without redirecting history.
4. Approve the OD-13 default category list ("owner-marked optional or superseded turns" only).
5. Publish the documentation-only NXR-070-0 PR, then implement A′.

Consistency validation results are in the [approval brief](NXR070_Final_Architecture_Approval_Brief.md) §7.

## 11. Round 3 Reconciliation: ADR-030 and Upstream Intelligence (R01–R17)

Following the acceptance of ADR-030 (2026-10-17) and completion of the NXR-070R research into T3 Code v0.1.0 and DeepSeek Harness candidate 0.2.1-alpha.5:

1. **Baseline updated:** `6ea56f99d758bc18698c1fa5770b399a283fe6ad` on `main` is authoritative.
2. **Unified DSH runtime:** OpenWorker retired; DSH `@deepseek-ai/dsh@0.2.0-rc.2` is the sole runtime.
3. **OS-enforced isolation:** Cowork executes inside WSL2/Bubblewrap; Coding inside Linux kernel bubblewrap.
4. **Policy renamed to `context@3`:** preserves accepted `context@2` + Project Memory (`ProjectMemoryStore`).
5. **Nine-field manifest:** conforms to accepted production shape.
6. **Single writer:** `FileSessionStore` retains exclusive write lease for sessions and sidecars.
7. **T3 Code reference:** architectural study only; no runtime import.
8. **Controlled upgrade pipeline:** 19-gate verification for any future DSH candidate.
9. See [NXR070R2_Final_Architecture_Reconciliation.md](NXR070R2_Final_Architecture_Reconciliation.md) for complete details.
