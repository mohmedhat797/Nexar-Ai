# NXR-070B′/C′ — Final Integration Readiness

Date: 2026-10-24. Engineer: OpenAI Codex.

## Current decision

**Integration remains blocked.** The latest completed aggregate Windows run failed at package timeout. Source E2E, core/runtime regressions and real WSL gates passed. Follow-up callback and CI corrections require final-source acceptance. The historical ACL cause remains unproven.

## Gate matrix

| Gate                   | B′                                                  | C′                                            | Evidence                                         | Status                                                      |
| ---------------------- | --------------------------------------------------- | --------------------------------------------- | ------------------------------------------------ | ----------------------------------------------------------- |
| Contracts              | Existing identity/credential contracts preserved    | Additive review dimensions preserved          | Complete offline and contract corpus             | Verified on first combined source; final regression pending |
| Credential security    | Synthetic A/B transport and host validation passed  | B′ boundary preserved                         | Runtime12; authority21; consent5                 | Final regression pending                                    |
| Connection lifecycle   | Manager19 and Plan-binding corpus passed previously | Historical identity retained                  | Existing lifecycle/Plan tests                    | Callback correction acceptance pending                      |
| Resource Registry      | Canonical resources/stale-result rejection retained | Trusted connection/provider metadata consumed | Registry/host/runtime corpus                     | Final regression pending                                    |
| NRC routing            | Existing filters/pins remain authoritative          | Required dimensions cannot downgrade          | Strategy/routing corpus                          | Final regression pending                                    |
| Review Diversity       | Foundation only                                     | 43 dimension cases and Gateway34 passed       | First clean combined offline report              | Final regression pending                                    |
| Legacy compatibility   | IDs/routing unchanged                               | Original golden corpus unchanged              | No fixture rewrites                              | Final regression pending                                    |
| Windows Full CI        | Historical baseline only                            | Current aggregate failed packaging            | report-2026-10-23T20-07-38-387Z.json             | BLOCKED                                                     |
| Source Desktop E2E     | Management/lifecycle covered in combined source     | 29/29 passed                                  | First stabilization source-stage log             | PASS on2887939                                              |
| Packaged Desktop E2E   | Historical evidence only                            | Skipped after current package failure         | Aggregate raw report                             | OUTSTANDING                                                 |
| WSL isolation          | Preserved                                           | 8 Windows/15 Linux real assertions passed     | First stabilization WSL stage                    | Final-source/full serial regression pending                 |
| Gitleaks               | Historical evidence only                            | Skipped after current package failure         | Aggregate raw report                             | OUTSTANDING                                                 |
| Hosted CI              | Budget-blocked historical head                      | Budget-blocked historical head                | Jobs had0 executed steps; budget annotation      | External blocker; reverify after publication                |
| Independent acceptance | Pending                                             | Pending                                       | Separate source reviewer is not owner acceptance | PENDING                                                     |
| Historical ACL cause   | Shared guard unchanged                              | Diagnostics corrected, cause unproven         | Root-cause report                                | OPEN                                                        |

## Branch ownership and integration order

B′ starts at `18c7cd01412a8c2b138ec99baf98751699ae169e` and targets main. The callback completion-ordering correction belongs on that branch because it changes shared production behavior. C′ starts at published `4c69766e546950bfbbdacb504034d9a010967ea7`, has local stabilization commits through2887939, and remains stacked on B′. Propagation must preserve both histories and every existing worktree.

B′ must receive independent owner acceptance first. C′ can then be reconciled and retargeted non-destructively. No merge, force-push, main push or automatic Ready transition is authorized.

GitHub reported both PRs MERGEABLE with mergeStateStatus UNSTABLE while Draft. Applicable-main-rules returned no rules; branch protection returned404 “Branch not protected.” No enforced required-check rule was established by those reads. Hosted failures are therefore not a proven branch-protection hard block. Draft state, explicit owner restrictions and engineering acceptance gates still prohibit integration. No policy was changed.

## Open items

1. Complete final-source aggregate Windows acceptance, source/packaged E2E, WSL and Gitleaks; preserve every failed attempt.
2. Retain the historical ACL cause as open until evidence establishes a mechanism and correction. Passing repetitions alone are insufficient.
3. Retain the intermittent Plan setup failure as an instrumented observation unless phase evidence establishes attribution. The callback ordering defect has its own deterministic regression proof.
4. Obtain independent owner acceptance separately for B′ and C′ and resolve hosted infrastructure availability.

## Current verdicts

- `NXR070_WINDOWS_FULL_CI_STILL_UNSTABLE`
- `NXR070_WINDOWS_FAILURE_ROOT_CAUSES_PARTIALLY_RESOLVED`
- `NXR070B_SECURITY_REVIEW_REQUIRES_CORRECTIONS` — final correction acceptance is pending, not a new asserted credential breach.
- `NXR070C_REVIEW_DIVERSITY_VERIFIED` on the first tested combined revision; final regression pending.
- `NXR070_BC_COMBINED_INTEGRATION_INCOMPLETE`
- `HOSTED_CI_INFRASTRUCTURE_BLOCKED` at the last inspected published head.
- `NXR070_BC_MERGE_BLOCKED_BY_OUTSTANDING_GATES`
- Overall: `NXR070_BC_STABILIZATION_PARTIALLY_COMPLETE`
- `INDEPENDENT_OWNER_REVIEW_PENDING`

**PENDING_SOURCE_BINDING:** update the final identities, gate results and verdict qualifications after actual final validation/publication.
