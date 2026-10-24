# NXR-070B′/C′ — Final Integration Readiness

Date: 2026-10-24. Engineer: OpenAI Codex.

## Decision

**Integration remains blocked.** B′ has a standalone clean-source Windows Full PASS. The later C′80e70a60 aggregate **FAILED** packaged Desktop restart28/29 after a15025 ms private-state PowerShell startup timeout. Earlier C′1c584208Full PASS is historical. Current C′WSL full passed; it does not replace Windows acceptance. Startup-delay root cause, historical ACL attribution, Plan attribution and first B′SOW stall mechanism remain unresolved.

## Gate matrix

| Gate                   | B′                                                                   | C′                                                               | Evidence                                                         | Status                                    |
| ---------------------- | -------------------------------------------------------------------- | ---------------------------------------------------------------- | ---------------------------------------------------------------- | ----------------------------------------- |
| Contracts              | Immutable identity/credential contracts retained                     | Additive dimensions retained                                     | Complete offline corpus                                          | Verified within executed corpus           |
| Credential security    | Authority21; consent5; runtime9; Plan9 passed                        | Runtime12; Plan10; authoritative host resolution passed          | B06 and C80 offline JSON                                         | Verified within synthetic execution scope |
| Connection lifecycle   | Manager19; recoverable persistence and retirement regressions passed | B′ guarantees preserved; historical comparison identity retained | Manager/authority/lifecycle/Plan corpus                          | Verified within executed corpus           |
| Resource Registry      | Canonical IDs and stale refresh guards retained                      | Production connection/provider metadata consumed                 | Inventory guard3; runtime corpus                                 | Verified                                  |
| NRC routing            | Existing filters, pins, leases and credential selection retained     | Required diversity remains a hard constraint                     | Routing/selection/gateway corpus                                 | Verified within executed corpus           |
| Review Diversity       | Foundation only                                                      | Dimensions43; legacy1; bridge34 pass                             | C80 offline JSON                                                 | Verified                                  |
| Legacy compatibility   | Historical built-in identities retained                              | Legacy policy/strategy/goldens pass                              | Existing golden corpus                                           | Verified within executed corpus           |
| Windows Full CI        | PASS at06e55f36                                                      | **FAIL at80e70a60**                                              | Reports13:20:25.499Z and17:24:16.812Z                            | **Blocking**                              |
| Desktop Source E2E     | 29/29                                                                | 29/29                                                            | Own branch Full reports                                          | Passed                                    |
| Packaged Desktop E2E   | 29/29                                                                | **28/29, restart startup timeout**                               | C packaged log1792865203584                                      | **Blocking**                              |
| WSL isolation          | Windows8 and Linux gate; supplemental4623/30/0/0                     | Windows8 and Linux gate; supplemental4682/30/0/0                 | Same-source Windows and WSL reports                              | Passed; WSL2, not native Ubuntu           |
| Gitleaks               | Full invocation passed                                               | Final aggregate skipped after required failure                   | Supplemental publication scan recorded in receipt                | No fabricated aggregatePASS               |
| Hosted CI              | Last published head budget-blocked                                   | Last published head budget-blocked                               | Actual annotations; rechecked after final publication in receipt | External infrastructure limitation        |
| Independent acceptance | Pending                                                              | Pending                                                          | Separate source review is not owner acceptance                   | **Blocking**                              |

Numbers written passed/skipped/failed/pending use that exact order for WSL full rows. Four Windowspending Bubblewrap cases passed under WSL; all five live-provider files remained skipped. Source and packaged acceptance use disposable profiles and synthetic model transports with real pinnedDSH/WSL boundaries; no paid provider inference or personal sign-in.

## Evidence identities

- B′tested source: `06e55f36f66c27b24d524e699d06246094c4617a`, tree `20b53990fb585e99ab4ed94001c72f4275b33a38`. Full PASS3292.49s, report `.nexar/ci/reports/report-2026-10-24T13-20-25-499Z.json` in B′ worktree, SHA256 `1cb1fea82daf65dad360cc25ae1ca7aca6b707b25916cb45c544d9524325b16c`. Offline4482 passed/167 skipped/4 pending/0 failed; WSL full4623/30/0/0.
- C′latest test source: `80e70a60f2bd5c109c4a424002ea6af8bcd9b54e`, tree `9aa95dd150bff75aef1d0737520a5b61b6e9ee7d`. Full FAIL3067.65s, report `.nexar/ci/reports/report-2026-10-24T17-24-16-812Z.json`, SHA256 `0115e7c77e8ac5f71491efcb5fa1c4b9c4f57500cb9e17a3be649dbe0136155b`. Fourteen required PASS, packaged FAIL, required Gitleaks SKIPPED, extra nonrequired Linux SKIPPED. Start/end clean and identical.
- C′same-source WSL full: `/home/nexar/src/nxr070c-20261021/.nexar/ci/bc-c-wsl-full-80e70a6.json`, SHA256 `217b5a151c5124eaf79472a2a6b164092d6069a07fb45c481e9fdcd7be09482e`.
- C′earlier source1c584208Full PASS2556.04s and WSL4678/30/0/0 remain preserved historical evidence. No later result is relabeled with that source.
- Publication may add documentation only. Literal final remote SHAs, hosted annotations, final scan and docs-only comparison are recorded in `.nexar/ci/NXR070_BC_Publication_Receipt.md`, avoiding self-referential commit identity.

## Ownership and integration recommendation

PR44 targetsmain; PR45 remains stacked on `feat/nxr-070b-multi-api-connections`. B06 is an ancestor of C80 via a normal merge. Preserve sequential B′thenC′ integration only after required acceptance; do not merge either now. Neither passing C′tests nor this review retrospectively accepts B′.

The shared private-state startup observation must be investigated with numeric child/parent process correlation and a demonstrated mechanism before correction. If shared production code changes, apply it to B′ and propagate it normally to C′, then rerun source-bound acceptance. Do not raise the native guard deadline, relax ACL assertions, retry automatically or run Full repeatedly merely to get green.

No applicable main required-check rule was established by inspected rules/protection queries; budget-blocked Actions are not a proven branch-protection configuration. They remain external non-passing checks. The owner controls the Actions budget and independent acceptance; engineering/root-cause and Draft restrictions already block integration.

## Exact verdicts

- `NXR070_WINDOWS_FULL_CI_STILL_UNSTABLE` — latest C′Full failed; B′Full and earlier C′Full passed.
- `NXR070_WINDOWS_FAILURE_ROOT_CAUSES_PARTIALLY_RESOLVED` — confirmed fixture/callback/runner fixes exist; current startup delay and historical attribution gaps remain.
- `NXR070B_SECURITY_INVARIANTS_VERIFIED` — within the executed synthetic/offline and isolated-runtime corpus; not universal security certification.
- `NXR070C_REVIEW_DIVERSITY_VERIFIED` — executed strategy, controller, bridge and identity regressions passed.
- `NXR070_BC_COMBINED_INTEGRATION_INCOMPLETE` — final packaged Cowork restart gate failed.
- `HOSTED_CI_INFRASTRUCTURE_BLOCKED` — actual latest verified annotations; literal post-publication runs are in the receipt.
- `NXR070_BC_MERGE_BLOCKED_BY_OUTSTANDING_GATES`.
- **`NXR070_BC_STABILIZATION_PARTIALLY_COMPLETE`**.

`INDEPENDENT_OWNER_REVIEW_PENDING`. No merge or Ready transition is authorized by this report.
