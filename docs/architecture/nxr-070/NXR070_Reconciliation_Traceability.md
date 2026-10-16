# NXR-070 — Reconciliation Traceability Matrix

Chain: original proposal (Codex research `b843d04`) → finding ([register](audit/NXR070_Critical_Findings_Register.md)) → amendment ([audit amendments](audit/ADR029_Proposed_Amendments.md) A–E, corrections C1–C5 and clarifications K1–K2 ([closure report](NXR070_Final_Corrections_Closure_Report.md)), [reconciled ADR](../../adr/029-connection-scoped-resources-and-canonical-continuity.md) §) → reconciled requirement ([blueprint](NXR070_Implementation_Blueprint_Reconciled.md) REQ) → test (TST) → owner decision ([register](NXR070_Architecture_Decision_Register.md) OD).

## Decisions D1–D18

| Original                    | Finding               | Amendment / correction           | Reconciled requirement     | Test                    | Owner decision                                                                                 |
| --------------------------- | --------------------- | -------------------------------- | -------------------------- | ----------------------- | ---------------------------------------------------------------------------------------------- |
| D1 Nexar ownership          | — (confirmed correct) | ADR §4                           | REQ-30                     | TST-30                  | OD-1 (pending)                                                                                 |
| D2 Instance identity        | F-01, F-03, O-1       | A, C, C4, **K2**; ADR §4.1, §4.3 | REQ-01, 03, 05, 37, 39, 47 | TST-01, 03, 05, 43, 57  | OD-1, OD-8, OD-15 (pending)                                                                    |
| D3 Driver composition       | F-03                  | C; ADR §4.7                      | REQ-31                     | TST-31                  | OD-1 (pending)                                                                                 |
| D4 Environment binding      | F-04, F-05            | D, C1; ADR §4.2                  | REQ-02, 07, 20             | TST-02, 07, 20          | OD-9, OD-5 (pending)                                                                           |
| D5 Id aliases               | F-11, O-1             | D; ADR §4.1                      | REQ-01, 04, 06             | TST-01, 04, 06          | OD-1 (pending)                                                                                 |
| D6 Inventory authority      | —                     | ADR-028 retained                 | REQ-11                     | TST-11                  | OD-1 (pending)                                                                                 |
| D7 ACP worker               | F-08, F-19            | D; ADR §4.9                      | REQ-31                     | TST-31                  | OD-2 (pending)                                                                                 |
| D8 Permissions              | F-02                  | B; invariant B3                  | REQ-30                     | TST-30                  | OD-1 (pending)                                                                                 |
| D9 Sessions/handoff         | F-07, F-21            | D, C2, C5, **K1**; ADR §4.6      | REQ-24–27, 32–35, 40–45    | TST-24–27, 32–40, 44–56 | OD-3 (confirmed); OD-13 (direction confirmed); OD-14 (conditionally accepted); OD-10 (pending) |
| D10 Control pinning         | —                     | ADR §4.7; C3 in-flight rule      | REQ-30, 38                 | TST-30, 09, 42          | OD-8 (pending)                                                                                 |
| D11 Telemetry authority     | F-09, F-14            | D; ADR §4.8                      | REQ-21                     | TST-21                  | OD-6 (confirmed)                                                                               |
| D12 NRC ranking             | F-09                  | D; ADR §4.5                      | REQ-22                     | TST-22                  | OD-1 (pending), OD-11 (deferred)                                                               |
| D13 Review diversity        | F-12, O-3, F-02       | D, C1, **K2**; ADR §4.5, B4      | REQ-20, 37                 | TST-20, 42              | OD-5 (pending)                                                                                 |
| D14 MCP transport           | —                     | ADR §4.9                         | REQ-31                     | TST-31                  | AD-5 (existing)                                                                                |
| D15 No third gateway        | F-08                  | ADR §4.7                         | REQ-31                     | TST-31                  | OD-1 (pending)                                                                                 |
| D16 No secret/history reuse | F-18 (shadow home)    | ADR §4.4                         | REQ-08, 17                 | TST-08, 17              | AD-6 (rejected patterns)                                                                       |
| D17 Patterns not source     | F-18                  | —                                | —                          | — (review gate)         | OD-1 (pending)                                                                                 |
| D18 First slice             | F-11                  | D, C4; Blueprint §4 A′           | REQ-01–07                  | TST-01–07               | OD-1 (pending)                                                                                 |

## Units A–L

| Original unit                         | Finding          | Reconciled unit                                | Requirements                         | Owner decision                         |
| ------------------------------------- | ---------------- | ---------------------------------------------- | ------------------------------------ | -------------------------------------- |
| 070A compatibility slice              | F-11             | A′                                             | REQ-01–07                            | OD-1, OD-9                             |
| 070B instances                        | F-03, F-15       | B′                                             | REQ-03, 08–13, 15, 16, 36–39, 46, 47 | OD-4a (confirmed), OD-7/8/15 (pending) |
| 070C runtime and environment bindings | F-04, F-05, F-06 | A′ (host keys), D′ (homes)                     | REQ-02, 07, 14, 17–19, 38            | OD-4b (confirmed), OD-9 (pending)      |
| 070D inventory and capabilities       | F-06             | B′, D′ (per-connection inventory)              | REQ-08, 17                           | OD-4a/b                                |
| 070E ACP worker                       | F-08             | deferred                                       | REQ-31                               | OD-2                                   |
| 070F observations                     | F-14             | F′                                             | REQ-21                               | OD-6                                   |
| 070G profiles                         | F-03, F-14       | merged into F′ and G′ (no new entity)          | REQ-21, 22                           | OD-1                                   |
| 070H NRC v2                           | F-09, F-13       | C′ + G′                                        | REQ-20, 22, 37                       | OD-5, OD-11                            |
| 070I settings UX                      | F-13, F-15       | H′ (minimal UI in B′)                          | REQ-15, 23                           | OD-7                                   |
| 070J session handoff                  | F-07, F-21       | I′ (`context@3` + sidecar)                     | REQ-24–27, 32–35, 40–45              | OD-3, OD-10, OD-13, OD-14              |
| 070K compatibility migration          | O-1, F-13        | removed (built-ins frozen; sessions unchanged) | REQ-06, 16, 40                       | OD-1, OD-14                            |
| 070L acceptance                       | F-10, F-16       | J′                                             | Execution plan §5                    | OD-12                                  |

## Entities

| Original entity                        | Finding                | Reconciled outcome                                                                                                   |
| -------------------------------------- | ---------------------- | -------------------------------------------------------------------------------------------------------------------- |
| ProviderDriver                         | F-03                   | Removed; existing ports                                                                                              |
| ProviderInstance                       | F-01, F-03             | `ConnectionDefinition` (extends `ProviderConnection`); one account per connection                                    |
| AccountIdentity                        | F-12, C3, K2           | Private account binding with assurance levels; plan binding record kept inside the plan service (REQ-10, 36, 37, 46) |
| CredentialRef                          | F-06                   | `ConnectionCredentialScope`                                                                                          |
| RuntimeDefinition / RuntimeEnvironment | F-03, F-04             | `runtimeId` / host `machine` (attribution only)                                                                      |
| RuntimeBinding (new)                   | F-03                   | Removed (name collision); `ProviderRuntimeIdentity`                                                                  |
| RuntimeSession                         | F-07, C5               | Removed; a future separate store is outside session records (REQ-27)                                                 |
| Inventory@2 / Resource@2               | F-14                   | Additive fields only                                                                                                 |
| Observation / Profile                  | F-14                   | F′ provenance on existing records                                                                                    |
| NRCDecision@2                          | F-14                   | Explanation fields in `@2` policy                                                                                    |
| ContextHandoff@1                       | F-07, F-21, C2, C5, K1 | `context@3` + integrity-checked sidecar `session-context@1`                                                          |

## Owner requirements, corrections and clarifications

| Item                                      | Reconciled in                 | Requirements             | Tests                    |
| ----------------------------------------- | ----------------------------- | ------------------------ | ------------------------ |
| Req. A Stable identity and rotation       | ADR §4.1, §4.3                | REQ-05, 09, 10, 36–38    | TST-05, 09, 10, 41, 42   |
| Req. B Safe connection lifecycle          | ADR §4.3                      | REQ-11–14, 38, 47        | TST-11–14, 57            |
| Req. C Context handoff integrity          | ADR §4.6                      | REQ-24–26, 32–35         | TST-24–26, 32–40         |
| Req. D Host extensibility                 | ADR §4.2                      | REQ-02, 07               | TST-02, 07               |
| C1 Review independence and host authority | ADR §4.2, §4.5                | REQ-20                   | TST-20                   |
| C2 Required-context classification        | ADR §4.6.1–4.6.4              | REQ-24, 25, 32–35        | TST-24, 25, 32–40        |
| C3 Rotation and account identity          | ADR §4.3                      | REQ-09, 10, 36–38        | TST-09, 10, 41, 42       |
| C4 Id generation and tombstone ownership  | ADR §4.1; Blueprint §4        | REQ-03 (A′), REQ-39 (B′) | TST-03 (A′), TST-43 (B′) |
| C5 `context@3` downgrade safety           | ADR §4.6.5; Blueprint §6      | REQ-40, 41               | TST-44–48                |
| **K1** Sidecar integrity                  | ADR §3 (B9), §4.6.5 items 2–9 | REQ-41–45                | TST-46, 47, 49–56        |
| **K2** Verified account switching         | ADR §4.3                      | REQ-13, 37, 46, 47       | TST-13, 42, 57, 58       |
| OD-13 conservative direction              | ADR §4.6.1, §4.6.3            | REQ-33                   | TST-33, 35, 36           |
