# NXR-070B′/C′ — Final Owner Handover

Date: 2026-10-24. Engineer: OpenAI Codex.

## Executive summary

B′ has its own clean-source Windows Full PASS and WSL fullPASS. The later C′ final diagnostic-source Windows Full invocation **FAILED** at packaged Desktop restart:28/29 passed, one private-state PowerShell startup timeout after15025 ms. Source Desktop29/29, package creation, offline regressions and real DSH/WSL gates passed. Supplemental same-source C′WSL full then passed 4682/30 skipped/0 failed/0 pending.

The task is **partially complete**, not acceptance-complete. The guard failed closed; no credential leak or isolation bypass was observed. The startup delay's underlying cause remains unknown. Historical ACL attribution, historical Plan attribution and first B′SOW stall mechanism also remain unproven. Later PASS results do not close them.

## Repository and publication identity

| Field                           | Verified source identity                                                                                                                            |
| ------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| Canonical workspace             | D:/Nexar-Ai-main                                                                                                                                    |
| Main                            | `41b918bf3c32cfd47301f7551a7280368fc3c8ec`                                                                                                          |
| Initial B′PR head               | `18c7cd01412a8c2b138ec99baf98751699ae169e`                                                                                                          |
| Initial C′PR head               | `4c69766e546950bfbbdacb504034d9a010967ea7`                                                                                                          |
| B′tested source                 | `06e55f36f66c27b24d524e699d06246094c4617a`                                                                                                          |
| B′tested tree                   | `20b53990fb585e99ab4ed94001c72f4275b33a38`                                                                                                          |
| C′latest tested source          | `80e70a60f2bd5c109c4a424002ea6af8bcd9b54e`                                                                                                          |
| C′latest tested tree            | `9aa95dd150bff75aef1d0737520a5b61b6e9ee7d`                                                                                                          |
| Earlier C′passing source        | `1c584208c8580ef3d9ba94e510fb30c58d88796d`                                                                                                          |
| B′branch/PR                     | feat/nxr-070b-multi-api-connections; [PR44](https://github.com/mohmedhat797/Nexar-Ai/pull/44)                                                       |
| C′branch/PR                     | feat/nxr-070c-review-diversity; [PR45](https://github.com/mohmedhat797/Nexar-Ai/pull/45), stacked on B′                                             |
| Final published head identities | Literal values and normal-push verification in `.nexar/ci/NXR070_BC_Publication_Receipt.md`; documentation publication is distinct from test source |

B06 is an ancestor of C80 through a normal merge. No existing branch was reset, rebased, force-pushed, merged into main or changed Ready. Historical audit/worktrees, credentials, real profiles and prior evidence were preserved. Both PRs must remain Draft.

## Implemented corrections

- Split the near120-second connection scenario into independent publication/restart, credential and tombstone workflows, retaining assertions and restart coverage with unchanged case deadlines.
- Owned-process teardown waits for real exit with bounded grace/force cleanup; failed cleanup retains disposable fixtures and all close attempts run.
- Capture native startup-marker observation synchronously before yielding; retain sanitized category/phase/elapsed diagnostics. The native ACL policy and15000 ms guard deadline remain unchanged.
- Clean commit/tree preflight and source-end stability checks; regression-proofed dirty-source rejection.
- Source/packaged suite envelope900 seconds and package envelope1500 seconds follow measured legitimate completions; security and functional stages remain mandatory.
- B′callback fix `f1482e692947f72a035c6ff2146f424b5581a41c` reserves the first valid response and publishes only after HTTPfinish, with abort/validation unchanged. Three deterministic RED regressions preceded31 focused passes. This separately proven defect does not establish attribution for the original intermittent Plan failure.
- B06/C80 diagnostic fixtures register failure retention before seed/launch, isolate each launch's output and record bounded allowlisted model progress. Four deterministic harness tests pass, including launch rejection. No production or timeout change was made in this diagnostic delta.

The original B′Full attempt ataa803793 failed the first SOW's60-second state poll (not its240-second case deadline);28/29 source cases passed. Its original session/progress state had already been removed by the old fixture. Diagnostic RED/GREEN and deliberate probe evidence are preserved in `NXR070B_SOW_Failure_Investigation.md`; all temporary probe injections were removed. The cause of that stall is still unknown.

## Source-bound acceptance

| Gate                                | B′06e55f36                                | C′80e70a60                                                    |
| ----------------------------------- | ----------------------------------------- | ------------------------------------------------------------- |
| pnpmcheck before test-source commit | PASS4482/167 skipped/4 pending/0 failed   | PASS4539/169 skipped/4 pending/0 failed                       |
| Windows Full                        | **PASS3292.49s**                          | **FAIL3067.65s**                                              |
| Windows offline withinFull          | 4482/167 skipped/4 pending/0 failed       | 4539/169 skipped/4 pending/0 failed                           |
| Real DSH context                    | 3/3                                       | 3/3                                                           |
| Windows WSL and real Linux gate     | Passed                                    | Passed                                                        |
| Source Desktop                      | 29/29                                     | 29/29;443.77s                                                 |
| Package                             | PASS1339.50s                              | PASS1236.24s                                                  |
| Packaged Desktop                    | 29/29                                     | **28/29; restart failed**                                     |
| Aggregate Gitleaks                  | PASS                                      | SKIPPED after mandatory failure; supplemental scan in receipt |
| SupplementalWSL full                | 4623 passed/30 skipped/0 failed/0 pending | 4682 passed/30 skipped/0 failed/0 pending                     |

B′raw Full `.nexar/ci/reports/report-2026-10-24T13-20-25-499Z.json`, SHA256 `1cb1fea82daf65dad360cc25ae1ca7aca6b707b25916cb45c544d9524325b16c`, in B′worktree. C′raw Full `.nexar/ci/reports/report-2026-10-24T17-24-16-812Z.json`, SHA256 `0115e7c77e8ac5f71491efcb5fa1c4b9c4f57500cb9e17a3be649dbe0136155b`. Both start/end source identities were clean and stable.

C′offline archive `.nexar/ci/bc-c-offline-80e70a6.json`, SHA256 `40105fb1837445f87ce8f5d5f82c6acacf1593ea1f73661cb4d6d6f7b4b6fe03`. C′WSLraw `/home/nexar/src/nxr070c-20261021/.nexar/ci/bc-c-wsl-full-80e70a6.json`, SHA256 `217b5a151c5124eaf79472a2a6b164092d6069a07fb45c481e9fdcd7be09482e`. Four Windowspending Bubblewrap cases passed there; all five live-provider files stayed skipped. WSL2 is not native Ubuntu acceptance.

The latest C′installer is322186813bytes, SHA256 `036288eb56af7742ad921c9b07b6e4b8e4068eb190c253ffe60e0c8815821a4c`, unsigned. Hash/freshness/bundledDSH verification passed; the overall packaged application acceptance failed. No clean-computer NSIS installation is claimed. Prior installers and failed reports remain preserved.

## Exact current failure and remaining investigation

The failing packaged case restarted after two successful isolated Cowork turns and awaited application close (`apps/desktop/e2e/cowork-isolated.e2e.ts:116`). Electron27372 reported private-state startup timeout15025 ms without captured readiness. The corrected harness retained the synthetic profile under `C:/Users/Mohamed Medhat/AppData/Local/Temp/nexar-e2e-code-XTwXjj`.

The readiness marker precedes path, identity, traversal and ACL operations; absence of captured output does not prove execution never began. Later root ACL protection was observed. PowerShellPID20248 has startup events in the interval but lacks an established parent correlation; these are circumstantial, not a proven cause. No blanket deadline increase, retry or security-policy change was made. Capture only numeric childPID, correlate parent/creation timing and existing events, then reproduce and correct the established mechanism.

## Security and integration

The executed corpus preserves connection→inventory→Registry→NRC→lease→authoritative credential→synthetic transport/accounting. Connection authority21, manager19, consent5, C′runtime12, Plan10, inventory guard3, bridge34, review dimensions43 and legacy1 passed. Required resource/connection/provider diversity, unknown-identity rejection, actual ledger settlement and revalidation remain covered. No new routing policy, harness, session writer, memory authority or delegation grant was introduced.

NRC, PermissionBroker, FileSessionStore, ProjectMemoryStore, DSH0.2.0-rc.2 and WSL/Bubblewrap remain authoritative. No live personal credentials, provider sign-in or paid inference were used. The separate read-only agent found no actionable issue in the diagnostic delta and no concrete malformed native invocation. That review is not independent owner acceptance.

## Hosted checks and owner action

Latest inspected hosted jobs were budget-blocked before executing any steps. Current post-publication run IDs and exact annotations belong in the receipt. Do not equate local tests with hosted PASS or change branch protection. Earlier rules/protection inspection did not establish an applicable main required-check rule; owner/Draft and engineering gates already prohibit integration.

First work: establish the private-state child process startup-delay mechanism using retained diagnostics and numeric process correlation. Apply any confirmed shared production fix to B′ and propagate it normally to C′; add deterministic RED/GREEN evidence and rerun complete final-source Windows acceptance. Keep historical ACL, Plan and SOW attribution open until supported. Resolve hosted budget separately, then request independent owner acceptance of B′followed by C′. Do not merge or beginD′.

## Final verdict

**`NXR070_BC_STABILIZATION_PARTIALLY_COMPLETE`**; **`INDEPENDENT_OWNER_REVIEW_PENDING`**. Separate exact verdicts and the gate matrix are in [final integration readiness](NXR070_BC_Final_Integration_Readiness.md). A documentation-only publication commit does not change the latest C′Full FAIL into a PASS.

## Supplemental startup measurement and final check

After the Windows failure and all other heavy suites completed, a bounded diagnostic invoked the unchanged native guard on four fresh and four repeated synthetic directories using pinned Node 22.23.3: `node --experimental-transform-types .nexar/ci/native-startup-probe-80e70a6.mjs`. All eight calls exited0 with readiness captured,475–1,427 ms; none exceeded the production 15,000 ms deadline. Only the diagnostic observation bound was 60,000 ms. Numeric child and parent PIDs and start/end times were retained; no arguments, environment, script payload, credentials or private subjects were logged. Fixture roots remain preserved.

This is a **Node-parent measurement, not Electron or packaged acceptance**. It did not reproduce the delay and supplies no evidence for raising the production deadline. Production source, native guard deadline and ACL policy remain unchanged. Raw log SHA256 `07b1b02da7c2eb0cf123ce71df1dc254dc680d71e7fa4b5bd8f20e086f677124`; diagnostic script SHA256 `a00eca36e712e632482fbf5be3499389e860286985ab6411b93aba8dc5c19705`.

The final repository `pnpm check` completed successfully:4539 passed,169 skipped,4 pending,0 failed;232 files passed/17 skipped,226.00s test duration; format/lint/boundaries/typecheck/build passed. Log `.nexar/ci/bc-c-pnpm-check-final-publication-80e70a6.log`, SHA256 `50635445e67959ff5b432a16cb5e4a305f51ba6e619039cbffc8ad875ccca282`. Subsequent publication edits are documentation only and receive formatting/diff checks. This check and diagnostic do not replace the failed aggregate Windows gate.
