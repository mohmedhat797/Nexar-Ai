# NXR-070B′/C′ — Final owner handover

Execution period: 25–26 October 2026 (Africa/Cairo); evidence timestamps are UTC.

## Executive summary

C′'s final implementation passed the complete Windows Full Local CI: all 16 required stages, source Desktop 33/33, packaged Desktop 33/33, real DSH context 3/3, Windows-to-WSL 8/8 with nested Linux kernel 15/15, and Gitleaks. Both frozen milestones also passed full WSL regressions: B′ 4,654 passed/30 skipped and C′ 4,713 passed/30 skipped, with zero failures or pending assertions.

The original packaged guard timeout remains **unresolved**. The bounded actual Electron campaign did not reproduce it, so no causal production timing correction is claimed. We implemented safe process attribution and corrected demonstrated teardown, profile-admission and fixture defects. The guard still completes synchronously before its first await, retains the 15-second deadline and fails closed.

B′'s latest standalone Windows aggregate failed at pinned DSH installation after 180.829 seconds. C′'s installer passed in 104.232 seconds. That contrast does not establish a cause. C′'s pass is not substituted for B′'s failed aggregate.

The result is a reviewable partial stabilization package, not completed root-cause remediation or owner acceptance.

## Repository and publication identity

| Field                          | Verified implementation value                                                                                                |
| ------------------------------ | ---------------------------------------------------------------------------------------------------------------------------- |
| Accepted main                  | `41b918bf3c32cfd47301f7551a7280368fc3c8ec`                                                                                   |
| Initial published PR #44       | `06e55f36f66c27b24d524e699d06246094c4617a`                                                                                   |
| Initial published PR #45       | `c7eba797f1a523102a03a8945b5df41e1f6b5d14`                                                                                   |
| B′ final implementation        | `ca8a603b442fe65750990f1f6f9671f42d7e20bc`                                                                                   |
| B′ implementation tree         | `204034739826e87c095807831c51844abfb18390`                                                                                   |
| C′ final tested implementation | `315a029e96390422bf0ab2c05080fab2b0bd8656`                                                                                   |
| C′ implementation tree         | `a3b14a052c446ee79305281ac9b717dd9a66ac11`                                                                                   |
| B′ branch                      | `feat/nxr-070b-multi-api-connections`                                                                                        |
| C′ branch                      | `feat/nxr-070c-review-diversity`                                                                                             |
| Dependency                     | B′ is an ancestor of C′ through normal merges                                                                                |
| PRs                            | [#44](https://github.com/mohmedhat797/Nexar-Ai/pull/44), [#45](https://github.com/mohmedhat797/Nexar-Ai/pull/45), kept Draft |

The final C′ publication may add documentation/evidence after `315a029e`; production and tests must remain identical. Actual final remote SHAs, tree, documentation-only comparison, PR base/Draft state, final secret scan and fresh hosted checks are recorded in the local `.nexar/ci/NXR070_Electron_Startup_Publication_Receipt_20261026.md`. This separates the tested implementation identity from the later publication identity without a self-referential commit claim.

Main, the frozen audit worktree, existing owner profiles and credential stores were preserved. No merge, force-push, reset, worktree deletion or branch-history rewrite was performed.

## Implemented changes

1. **Native process attribution.** The guard records actual Electron and PowerShell identity, separate UTC and monotonic observations, fixed phase timing, readiness and termination outcome. The previous wrapper did not retain/correlate the PID; failure objects from the old API could expose one. The new synchronous native spawn result makes child identity available on successful and failed attempts. It is not presented as the cause or cure of the historical delay.
2. **Owned-process teardown.** Playwright's Windows launcher may be a shell. Tests now identify Electron main and verify its absence before profile release/reuse. Ambiguous or live identities fail cleanup and retain evidence. No unrelated process is terminated.
3. **Profile admission.** Concurrent starts reserve a profile before the first await. A deterministic barrier regression exposed and verifies the correction.
4. **Failure-safe fixtures.** Trace-event doubles now model the actual event; tests force trace mode. Mocks/environment restore in `finally`. Fake PID publication is atomic and rejects empty/zero values. Hanging synthetic Antigravity execution is cancelled and awaited even when readiness/assertions fail, preserving cleanup and original errors.
5. **Honest timing assertions.** The synthetic OAuth four-second bound runs from receipt of the complete signal through rejection, including process-tree cleanup and disposal. Startup is recorded separately. The synthetic readiness wait changed from five to ten seconds while the existing whole-case budget remains twenty seconds. Production authentication behavior and deadlines were not changed.

Shared changes were committed on B′ and propagated normally into C′. B′ commits include `36bb0041`, `f66e17a6`, `1c3f3a89`, `428eb770`, `756fa8f2`, and `ca8a603b`. Later fixture changes are test-only. Production changes are confined to `main.ts`, `private-state.ts` and the new `private-state-process.ts`; accepted connection, credential, memory, session and routing authorities remain unchanged.

## Root-cause evidence and limits

The historical failed source is `80e70a60`, tree `9aa95dd1`; report `report-2026-10-24T17-24-16-812Z.json` SHA256 is `0115e7c77e8ac5f71491efcb5fa1c4b9c4f57500cb9e17a3be649dbe0136155b`. The supplied prompt checksum had 75 characters and a duplicated segment; the actual report/receipt has the valid 64-character value.

Historical launch PID 27372 was not established as Electron main. Candidate PowerShell PID 20248 was not linked to it. We did not fabricate that relationship. Original reports, event metadata, the retained failure profile and original package/installer copies remain preserved.

The predetermined two-attempt matrix exercised Node fresh/reused, source and packaged fresh/restart, restart without Cowork and restart after two real isolated synthetic Cowork turns. Both exact post-Cowork restarts passed, with main/child pairs 18780→2580 and 4460→34488 in 4,199 and 4,241 ms. The original-package controlled deadline probe showed that both synchronous APIs can retain readiness on timeout, rejecting a universal output-loss claim.

The final Full Desktop suites each recorded 40 distinct successful parent/child pairs. Source durations were 2,852–5,902 ms; packaged durations were 3,647–6,747 ms. These successes establish measurement and successful lifecycle behavior, **not the missing delay mechanism**. Earlier ACL, Plan setup and SOW attribution remains unresolved; no common cause is asserted.

## Executed acceptance

| Scope                                    | Result                                                                                                              | Evidence                                                                                                                              |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| B′ final `pnpm check`                    | PASS; 4,513 passed/167 skipped/four pending; build passed                                                           | `electron-startup-b-cleanup-serial-check-v2-20261025.log`, SHA256 `8758f07269733abc7157cd03015d8c79f2309c31ef6bef852f1bb9e2c3167a45`  |
| C′ implementation `pnpm check`           | PASS; 4,570 passed/169 skipped/four pending; build passed                                                           | `electron-startup-c-cleanup-two-worker-check-20261025.log`, SHA256 `9e12a48224c91036be9a3936be340d8354b71ca5c9f2fd660aa014b9b79298f2` |
| B′ latest Full                           | FAIL at runtime installer; later mandatory gates skipped                                                            | B′ `report-2026-10-25T19-32-29-858Z.json`, SHA256 `5b119937c082b1a38ec774c50b84913c7efcfe5416d797a10d2a50a6e5e4e977`                  |
| C′ latest Full                           | `NEXAR_WINDOWS_FULL_PASS`, 16/16 required; 3,237.37 s; clean/stable start and end                                   | C′ `report-2026-10-25T19-36-40-909Z.json`, SHA256 `a053d3fa7fb6dde15a6480ffb3079b32518c17de00d2ffe6dec4d3f88d97f196`                  |
| C′ current Windows detail                | Offline 4,570 passed/169 skipped/four pending; DSH 3/3; Windows WSL 8/8; kernel 15/15; source 33/33; packaged 33/33 | Full stage logs and raw JSON                                                                                                          |
| B′ WSL Full                              | 4,654 passed/30 skipped; zero failed/pending; source stable                                                         | Raw SHA256 `0f3700873f3becd7d2099aea2bc90f490ddc322c468a8d37c883f3377b567f89`                                                         |
| C′ WSL Full                              | 4,713 passed/30 skipped; zero failed/pending; source stable                                                         | Raw SHA256 `3197c4c9974ef3bbcfa30f47920197fc32ac169e1dae2cfb0305dfeea538609e`                                                         |
| B′ supplemental source/context/isolation | Source 33/33; DSH context 3/3; Windows-to-WSL 8/8 plus kernel 15/15, all clean/stable                               | Execution manifests listed in the Windows report; not an aggregate PASS                                                               |
| Final publication check/scan             | Recorded after documentation-only publication preparation                                                           | Receipt identifies exact source and raw logs                                                                                          |

All prior failures remain failures, including four earlier installer-blocked attempts, the B′ offline trace-double failure and C′'s later connection/fixture timing failures. RED/GREEN observations are separately identified. An initial WSL launcher syntax error occurred before test execution and was preserved. No skipped stage is counted as a pass.

Windows runner Node is 22.23.3, pnpm 10.33.0, Gitleaks 8.28.0, DSH rc.2 and Electron 44.5.1. Electron embeds Node 24.21.0, distinct from the runner. The legacy pinned Node directory remains required and was not moved/deleted. WSL2 is `nexar-plane`; native Ubuntu acceptance is not claimed. Heavy suites ran serially. Production guard/installer deadlines, existing whole-case budgets and global Vitest budgets remain unchanged; the fixture readiness and response windows are distinguished above.

## Package identity

Current C′ installer: `release/desktop/Nexar-0.1.0-windows-x64-setup.exe`, 322,190,637 bytes, SHA256 `35c2d64dec469f262df059ba7668eee2b1907875cd911de5b34fa0f203b5ba9a`. The independent hash, report and sidecar agree. The bundled manifest pins DSH rc.2.

Packaged E2E ran `win-unpacked` with disposable profiles. It is not evidence of a clean-machine NSIS installation. No owner profile, live account sign-in, real credential or paid model request was used.

## Security and integration

The production path remains persisted connection → inventory → Registry → NRC selection → serialized admission/lease → authoritative credential scope → synthetic model transport/real DSH execution → accounting/cleanup. The actual connection-runtime corpus verifies distinct synthetic keys and lifecycle invalidation; required Review Diversity remains enforced through planning, dynamic allocation, revalidation and actual settled identity.

A separate read-only reviewer verified protected production blobs, source anchors, guard policy, review settlement, final Full evidence and installer identity. This is separate source review, not owner acceptance. Diagnostic records are strictly allowlisted; no arguments, encoded PowerShell, environment, private paths, account subjects, prompts, responses, credentials, sessions or Project Memory contents are logged by the new traces.

## Remaining blockers and precise next work

- Establish the historical packaged startup delay mechanism. The bounded campaign did not reproduce it; the report must remain unresolved even though C′'s complete rerun passed.
- Establish why pinned runtime installation intermittently exceeds the unchanged gate, and obtain B′ standalone aggregate acceptance without hiding failed attempts.
- Verify fresh hosted checks after publication. Previously published jobs were stopped by an Actions budget restriction before steps; no hosted PASS or code-failure attribution is fabricated.
- Obtain separate independent owner acceptance for B′, then C′. Both PRs remain Draft. Do not merge, start D′, change ADR status, upgrade DSH or activate upstream monitoring.

First technical assignment: consume these retained process records and the exact current package, then obtain a correlated failing guard observation or deterministic reproduction before proposing another production correction. Completion requires causal evidence, a minimal justified fix, regression proof and source-bound required acceptance. Passing reruns alone do not satisfy that exit criterion.

## Final verdicts

- Root cause: `NXR070_ELECTRON_STARTUP_ROOT_CAUSE_UNRESOLVED`.
- Remediation: `NXR070_ELECTRON_STARTUP_REMEDIATION_INCOMPLETE`.
- Windows stability: `NXR070_WINDOWS_FULL_CI_STILL_UNSTABLE` — C′ Full passed; B′ latest Full failed and the historical cause is unresolved.
- B′ security: `NXR070B_SECURITY_INVARIANTS_PRESERVED`.
- C′ functionality: `NXR070C_REVIEW_DIVERSITY_VERIFIED`.
- Combined integration: `NXR070_BC_COMBINED_INTEGRATION_VERIFIED` within synthetic provider execution and real DSH/WSL coverage; no live-provider acceptance implied.
- Independent acceptance: `INDEPENDENT_OWNER_REVIEW_PENDING`.
- Hosted CI: final-head classification is recorded in the post-publication receipt; prior published jobs were infrastructure-blocked.
- Merge recommendation: `NXR070_BC_MERGE_BLOCKED_BY_OUTSTANDING_GATES`.

**Overall: `NXR070_BC_STABILIZATION_PARTIALLY_COMPLETE`.**

GitHub merge-policy inspection found main protection disabled, no required status checks and no listed repository rulesets. Hosted failures remain an unmet owner validation gate; they are not reported as a technically enforced status-check rule in this configuration. Both PRs remain Draft and the explicit acceptance criteria prohibit merging. No branch policy was modified.
