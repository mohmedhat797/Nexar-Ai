# NXR-070B′/C′ — Final Integration Readiness

Date: 2026-10-24. Engineer: OpenAI Codex.

## Current decision

**Integration remains blocked by outstanding acceptance gates.** B′ completed its own immutable Windows Full PASS and WSL full PASS at06e55f36. C′ previously passed at1c584208, but the propagated diagnostic-test source still needs final acceptance. Historical ACL, Plan attribution and the standalone SOW stall remain unresolved; later passes do not establish their causes. Independent owner acceptance remains pending.

## Gate matrix

| Gate                   | B′                                                        | C′                                                       | Evidence                                           | Status                                       |
| ---------------------- | --------------------------------------------------------- | -------------------------------------------------------- | -------------------------------------------------- | -------------------------------------------- |
| Contracts              | Existing identity/credential contracts preserved          | Additive review dimensions preserved                     | C′4535-pass Windows corpus and4678-pass WSL corpus | VERIFIED at1c584208                          |
| Credential security    | Synthetic A/B transport and host validation passed        | B′ boundary preserved                                    | Runtime12; authority21; consent5                   | VERIFIED within tested synthetic scope       |
| Connection lifecycle   | Manager19 and Plan10 passed; callback10 passed            | Historical identity retained                             | Final combined offline report                      | VERIFIED within tested scope                 |
| Resource Registry      | Canonical resources/stale-result rejection retained       | Trusted connection/provider metadata consumed            | Registry/host/runtime corpus                       | VERIFIED                                     |
| NRC routing            | Existing filters/pins remain authoritative                | Required dimensions cannot downgrade                     | Strategy/routing corpus                            | VERIFIED                                     |
| Review Diversity       | Foundation only                                           | 43 dimension cases and Gateway34 passed                  | Final combined offline report                      | VERIFIED                                     |
| Legacy compatibility   | IDs/routing unchanged                                     | Original golden corpus unchanged                         | No fixture rewrites; complete corpus               | VERIFIED                                     |
| Windows Full CI        | PASS at06e55f36;16 required stages                        | Prior PASS at1c584208; current diagnostic source pending | Both source-bound raw reports                      | B′PASS; C′current gate pending               |
| Source Desktop E2E     | 29/29 at06e55f36                                          | Prior29/29 at1c584208                                    | Respective aggregate stage logs                    | B′PASS; final C′pending                      |
| Packaged Desktop E2E   | 29/29 at06e55f36                                          | Prior29/29 at1c584208                                    | Same-build win-unpacked; not NSIS clean install    | B′PASS; final C′pending                      |
| WSL isolation          | Windows8/8, Linux gate and full4623/30skip/0fail/0pending | Prior gate and full4678/30skip                           | Matching Windows/WSL source identities             | B′PASS; final C′pending                      |
| Gitleaks               | PASS in Full06e55f36                                      | PriorPASS; final publication scan pending                | Redacted pinned8.28.0 scan                         | No leaks found in executed scans             |
| Hosted CI              | Budget-blocked ataa803793                                 | Budget-blocked at261e2994                                | Runs40056784525/40056788557; all6 jobs0steps       | INFRASTRUCTURE_BLOCKED; reverify final heads |
| Independent acceptance | Pending                                                   | Pending                                                  | Separate source reviewer is not owner acceptance   | PENDING                                      |
| Historical ACL cause   | Shared guard unchanged                                    | Diagnostics corrected, cause unproven                    | Root-cause report                                  | OPEN                                         |

## Branch ownership and integration order

B′ started at `18c7cd01412a8c2b138ec99baf98751699ae169e` and targets main. Its callback completion-ordering correction is `f1482e692947f72a035c6ff2146f424b5581a41c`; shared infrastructure backport is `aa803793f5b4ec0ff2105b5f19b86f3a0bdb01c3`, tree `87667a254d6a2c42d02a78e07d9322e9b8c6fd97`. C′ received the callback commit through merge `b618fbe`; full acceptance is bound to `1c584208c8580ef3d9ba94e510fb30c58d88796d`, tree `ec47d9ff4db3eed7fdde870c1a2b60773fa5225b`. Both histories and every worktree remain preserved. C′ remains stacked on B′. The final publication receipt distinguishes later documentation/ancestry-only updates from these tested implementation identities.

B′ must receive independent owner acceptance first. C′ can then be reconciled and retargeted non-destructively. No merge, force-push, main push or automatic Ready transition is authorized.

GitHub reported both PRs MERGEABLE with mergeStateStatus UNSTABLE while Draft. Applicable-main-rules returned no rules; branch protection returned404 “Branch not protected.” No enforced required-check rule was established by those reads. Hosted failures are therefore not a proven branch-protection hard block. Draft state, explicit owner restrictions and engineering acceptance gates still prohibit integration. No policy was changed.

## Open items

1. Finish C′'s source-bound acceptance after the normal B′diagnostic merge, then publish factual reports/PR updates. Separate B′Full and WSL full are complete; neither replaces C′acceptance.
2. Retain the historical ACL cause as open until evidence establishes a mechanism and correction. Passing repetitions alone are insufficient.
3. Retain the standalone SOW stall and intermittent Plan setup failure as an instrumented observation unless phase evidence establishes attribution. The callback ordering defect has its own deterministic regression proof.
4. Obtain independent owner acceptance separately for B′ and C′ and resolve hosted infrastructure availability.

## Current verdicts

- `NXR070_WINDOWS_FULL_CI_STILL_UNSTABLE` — B′Full and prior C′Full pass, but final propagated C′acceptance and requested root-cause closure remain incomplete.
- `NXR070_WINDOWS_FAILURE_ROOT_CAUSES_PARTIALLY_RESOLVED`
- `NXR070B_SECURITY_INVARIANTS_VERIFIED` — tested synthetic/host/WSL scope; no claim of universal vulnerability absence.
- `NXR070C_REVIEW_DIVERSITY_VERIFIED` at final tested source1c584208.
- `NXR070_BC_COMBINED_INTEGRATION_INCOMPLETE`
- `HOSTED_CI_INFRASTRUCTURE_BLOCKED` — each latest inspected job was prevented from starting by an Actions budget.
- `NXR070_BC_MERGE_BLOCKED_BY_OUTSTANDING_GATES`
- Overall: `NXR070_BC_STABILIZATION_PARTIALLY_COMPLETE`
- `INDEPENDENT_OWNER_REVIEW_PENDING`

Publication must preserve Draft state, normal non-force history and the stacked dependency. No merge is authorized. Passing local checks cannot substitute for independent owner acceptance or fabricate a hosted check.
