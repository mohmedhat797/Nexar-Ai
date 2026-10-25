# NXR-070B′/C′ — Final integration readiness

Execution period: 25–26 October 2026 (Africa/Cairo). Raw timestamps are UTC.

## Decision

**Integration remains blocked.** C′ passed all 16 required Windows Full CI stages on the final implementation source, and both milestones passed their full WSL regressions. The historical packaged guard delay remains causally unresolved. B′'s latest standalone aggregate failed at runtime installation. Neither an isolated pass nor C′'s aggregate rewrites that B′ failure.

The engineering changes are reviewable: safe native-process attribution, correct owned-main/profile teardown and demonstrated fixture corrections. No production delay workaround, guard retry, production timeout increase, ACL relaxation or routing change was introduced. The synthetic fixture readiness wait changed from five to ten seconds, with the existing twenty-second case budget and four-second signal-to-rejection bound retained; that response bound includes cleanup. The owner-authorized criterion requiring a proven startup failure mechanism has not been met.

## Frozen implementation identities

| Item                          | Identity                                   |
| ----------------------------- | ------------------------------------------ |
| Accepted main at verification | `41b918bf3c32cfd47301f7551a7280368fc3c8ec` |
| B′ tested implementation      | `ca8a603b442fe65750990f1f6f9671f42d7e20bc` |
| B′ tree                       | `204034739826e87c095807831c51844abfb18390` |
| C′ tested implementation      | `315a029e96390422bf0ab2c05080fab2b0bd8656` |
| C′ tree                       | `a3b14a052c446ee79305281ac9b717dd9a66ac11` |

C′ includes B′ by normal merges. Publication adds documentation/evidence only after the tested source. Final remote SHAs, the exact documentation-only delta, Draft/base verification and latest hosted results are recorded in the local `.nexar/ci/NXR070_Electron_Startup_Publication_Receipt_20261026.md`. No merge is authorized by this report.

## Gate matrix

| Gate                   | B′                                                                               | C′                                                                                                   | Evidence                                                           | Verdict                                    |
| ---------------------- | -------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ | ------------------------------------------ |
| Connection identity    | Offline and WSL regressions pass                                                 | Full/offline and WSL regressions pass                                                                | ConnectionManager unchanged; connection-runtime integration corpus | Preserved                                  |
| Credential isolation   | Synthetic execution and scope negatives pass                                     | Same production authority verified in combined source                                                | Host scope validation and execution leases                         | Preserved                                  |
| Lifecycle              | Current offline/WSL corpus passes                                                | Current Full corpus passes                                                                           | Serialized admission/mutation and Plan retirement tests            | Preserved                                  |
| NRC integration        | Persisted connection → Registry → NRC → synthetic transport tested               | Same path plus C′ allocator/revalidation tested                                                      | `connection-runtime.test.ts`; engine and gateway tests             | Verified within offline transport scope    |
| Review Diversity       | Prerequisite connection identity retained                                        | Resource/connection/provider modes, unavailable reasons, retained identity and settlement tests pass | Strategy, core engine and bridge corpus                            | C′ verified                                |
| Windows startup        | Guard policy preserved; bounded diagnostics pass                                 | 40 correlated successful source launches and 40 packaged launches in Full run                        | Safe native traces and focused campaign                            | Historical delay unresolved                |
| Private-state security | Owner/ACL/link/fail-closed assertions preserved                                  | Same guard passed current Full tests and E2E                                                         | `private-state*.test.ts`; startup E2E                              | Preserved; no causal timeout fix claimed   |
| Source E2E             | 33/33 supplemental, clean/stable source                                          | 33/33 in aggregate                                                                                   | Full report and supplemental manifest                              | C′ PASS; B′ separate evidence              |
| Packaged E2E           | Previous B′ baseline 29/29; current standalone aggregate did not reach this gate | 33/33 on current package                                                                             | Source-bound Full reports                                          | B′ current standalone coverage outstanding |
| Windows Full CI        | FAIL at installer 180,829 ms; later gates skipped                                | `NEXAR_WINDOWS_FULL_PASS`, 16/16 required                                                            | Reports listed below                                               | Separate outcomes                          |
| WSL isolation          | Full WSL 4,654/30 skipped; Windows 8/8 + kernel 15/15                            | Full WSL: 4,713 passed/30 skipped; Windows 8/8 + nested kernel 15/15                                 | Raw JSON and clean source manifests                                | WSL2 verified; native Ubuntu not claimed   |
| Gitleaks               | B′ commits included in C′ full-history scan                                      | PASS on tested source; final publication scan in receipt                                             | 317-commit Full scan, redacted                                     | No leaks found in executed scan            |
| Hosted CI              | Published baseline jobs were budget-blocked before steps                         | Same historical infrastructure restriction                                                           | Fresh final-head job/annotation evidence belongs to receipt        | No hosted PASS claimed                     |
| Independent review     | Separate read-only source review completed                                       | Source and Full evidence independently checked                                                       | Focused review findings addressed                                  | Independent owner acceptance pending       |

The optional native-Linux stage was blocked on Windows and was not counted as passed. Mandatory Linux kernel coverage executed through the required WSL gate. Native Ubuntu is deferred under the Windows-first scope.

## Source-bound acceptance records

| Observation          | Raw report                                                       | SHA256                                                             |
| -------------------- | ---------------------------------------------------------------- | ------------------------------------------------------------------ |
| B′ latest Full FAIL  | B′ `.nexar/ci/reports/report-2026-10-25T19-32-29-858Z.json`      | `5b119937c082b1a38ec774c50b84913c7efcfe5416d797a10d2a50a6e5e4e977` |
| C′ current Full PASS | C′ `.nexar/ci/reports/report-2026-10-25T19-36-40-909Z.json`      | `a053d3fa7fb6dde15a6480ffb3079b32518c17de00d2ffe6dec4d3f88d97f196` |
| B′ full WSL PASS     | B′ `.nexar/ci/electron-startup-b-wsl-full-ca8a603-20261026.json` | `0f3700873f3becd7d2099aea2bc90f490ddc322c468a8d37c883f3377b567f89` |
| C′ full WSL PASS     | C′ `.nexar/ci/electron-startup-c-wsl-full-315a029-20261026.json` | `3197c4c9974ef3bbcfa30f47920197fc32ac169e1dae2cfb0305dfeea538609e` |

Current C′ Windows totals: offline 4,570 passed/169 skipped/four pending, DSH context 3/3, Windows-to-WSL 8/8, source 33/33 and packaged 33/33. The nested Linux corpus passed 15/15 separately from the Windows parser's rolled-up total. Pending/skipped tests are not passes.

The current unsigned installer SHA256 is `35c2d64dec469f262df059ba7668eee2b1907875cd911de5b34fa0f203b5ba9a` (322,190,637 bytes). Packaged E2E launched `win-unpacked` with disposable profiles; clean-machine NSIS installation was not executed.

## Remaining blockers and owner action

| Issue                                                               | Classification                                                       | Impact                                                            | Required next evidence                                                                                       |
| ------------------------------------------------------------------- | -------------------------------------------------------------------- | ----------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| Historical private-state startup delay                              | P2 reliability, acceptance-blocking under the explicit task criteria | Fail-closed startup may prevent use; no evidence of an ACL bypass | Correlated failing process observation or deterministic mechanism, justified correction and regression proof |
| Pinned runtime installation intermittently exceeds the Full gate    | P2 local acceptance/reliability observation; cause unproven          | B′ current aggregate cannot complete                              | Controlled causal investigation and a complete successful B′ invocation without changing required gates      |
| Hosted jobs stopped by budget restrictions on prior published heads | External infrastructure blocker                                      | No hosted code validation from those jobs                         | Final-head job/annotation check and owner restoration of Actions capacity if still blocked                   |
| Independent owner acceptance                                        | Governance gate                                                      | Draft milestones cannot be integrated                             | Separate owner-requested acceptance of B′ followed by C′                                                     |

The branches retain their intended ancestry for eventual sequential integration, but they are **not recommended for merge now**. Do not merge #44 or #45, mark them Ready automatically, start NXR-070D′, change accepted ADRs, or activate upstream monitoring. GitHub's main-branch metadata reports protection disabled and no required status checks; the repository rulesets endpoint returned an empty list. Thus hosted failures are an unmet validation requirement under the owner's instructions, rather than an enforced status-check rule reported by this configuration. Draft status and the explicit owner acceptance criteria still prohibit integration. No repository policy was changed.

## Exact verdicts

- `NXR070_ELECTRON_STARTUP_ROOT_CAUSE_UNRESOLVED`
- `NXR070_ELECTRON_STARTUP_REMEDIATION_INCOMPLETE`
- `NXR070_WINDOWS_FULL_CI_STILL_UNSTABLE`
- `NXR070B_SECURITY_INVARIANTS_PRESERVED`
- `NXR070C_REVIEW_DIVERSITY_VERIFIED`
- `NXR070_BC_COMBINED_INTEGRATION_VERIFIED` — synthetic connection-bound execution plus real DSH/isolation scope; no live-provider acceptance implied.
- `INDEPENDENT_OWNER_REVIEW_PENDING`
- `NXR070_BC_MERGE_BLOCKED_BY_OUTSTANDING_GATES`

The Windows stability verdict reflects the unresolved historical mechanism and latest B′ aggregate failure; it does not negate C′'s actual Full PASS. The final hosted-CI verdict is source- and time-specific and is recorded after publication in the receipt.

**Overall: `NXR070_BC_STABILIZATION_PARTIALLY_COMPLETE`.**
