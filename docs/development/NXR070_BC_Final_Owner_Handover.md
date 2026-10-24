# NXR-070B′/C′ — Final Owner Handover

Date: 2026-10-24. Engineer: OpenAI Codex. Implementation acceptance and later documentation/publication identities are distinguished below.

## Executive status

The corrected combined C′ revision completed an immutable Windows Full PASS and supplemental WSL full PASS at1c584208. B′ now also has its own complete Windows Full PASS at06e55f36, plus a same-source WSL full PASS. The subsequent diagnostic-only changes are staged in C′ through a normal merge and require final C′ validation before publication. Earlier failures remain preserved; the SOW stall mechanism, historical ACL cause and Plan attribution remain unproven.

The historical ACL cause remains unexplained. No source review or isolated pass constitutes owner acceptance.

## Repository

| Field                                | Last verified value                                                                          |
| ------------------------------------ | -------------------------------------------------------------------------------------------- |
| Canonical workspace                  | D:/Nexar-Ai-main                                                                             |
| Main                                 | 41b918bf3c32cfd47301f7551a7280368fc3c8ec                                                     |
| Initial PR44                         | 18c7cd01412a8c2b138ec99baf98751699ae169e; OPEN/Draft; base main                              |
| Initial PR45                         | 4c69766e546950bfbbdacb504034d9a010967ea7; OPEN/Draft; base B′                                |
| First stabilization local source     | 2887939da04a57b705a077377c2093898ba9e242                                                     |
| Its tree                             | b08e7ed316e04271dccbea7d154293c9aa9ff8ed                                                     |
| B′ callback production correction    | f1482e692947f72a035c6ff2146f424b5581a41c                                                     |
| B′ shared-infrastructure source      | aa803793f5b4ec0ff2105b5f19b86f3a0bdb01c3; tree87667a254d6a2c42d02a78e07d9322e9b8c6fd97       |
| Tested C′ Full CI source             | 1c584208c8580ef3d9ba94e510fb30c58d88796d; treeec47d9ff4db3eed7fdde870c1a2b60773fa5225b       |
| Published heads at last verification | B′aa803793; C′261e2994; OPEN/Draft; new validation candidates remain local until publication |

PRs: [44](https://github.com/mohmedhat797/Nexar-Ai/pull/44), [45](https://github.com/mohmedhat797/Nexar-Ai/pull/45).

## Corrections and evidence

- Three independent connection workflows preserve all original assertions and restart coverage; unchanged individual deadlines.
- Owned-process exit/forced-termination contract and cleanup aggregation; five regression cases, including a real synthetic child.
- Synchronous native marker observation preserved; sanitized initialization diagnostics exposed. New stale-marker case follows the historical fresh-root case.
- Clean commit/tree preflight and end comparison. Source/packaged suite envelope900 seconds; package envelope1500 seconds following observed deadline failures. No security gate removed.
- B′ callback outcome waits for HTTP finish while retaining first-request reservation, validation and fail-closed abort behavior. Three deterministic RED failures preceded the correction;31 focused tests passed afterwards.
- Plan failure-only test diagnostics carry fixed phase/error codes, not tokens, subjects or URLs.

## Acceptance

First complete Windows run: **NEXAR_WINDOWS_FULL_FAIL** at packaging. Raw report `report-2026-10-23T20-07-38-387Z.json`, SHA256 `d46a1227013c09831dbfc890fb5516720842234c6316f4673aa5c123c041d748`.

It passed4,531 tests, skipped169, retained4 pending, and passed29/29 source E2E. Real WSL acceptance passed8 Windows and15 Linux assertions. Packaged E2E and Gitleaks were skipped after the mandatory package failure. Bare installer existence is not acceptance.

Corrected C′ aggregate: **NEXAR_WINDOWS_FULL_PASS** at `1c584208`, tree `ec47d9ff4db3eed7fdde870c1a2b60773fa5225b`. Raw report `.nexar/ci/reports/report-2026-10-24T01-29-48-293Z.json`, SHA256 `4b159a579ec24caf96eaadd0070fe37c47c5c612eddf717b466f171bc48dc9e4`;2556.04 s; start/end clean and stable. Windows offline4,535 passed,169 skipped,4 pending,0 failed. Source Desktop29/29; packaged29/29; real DSH3/3; Windows WSL8/8 plus Linux kernel15/15; Gitleaks PASS. The additional Linux-only stage was BLOCKED/required:false, not passed.

Same-source WSL full suite passed4,678, skipped30, failed0, pending0; SHA256 `89a90ff621afd1139d9f5729ebf360f1d69ab3cfbee8910b3f3525500408ce9e`. The four Windows pending Bubblewrap cases passed there. Node22.23.3, pnpm10.33.0 and DSH0.2.0-rc.2 were preserved.

C′ same-build installer SHA256 `d69ae5298e92adc24f0c602f64263ce108e4efc7956986d2117a6f758480c945`,322,186,813 bytes, unsigned; source/package helpers and DSH identities matched. Packaged E2E launches win-unpacked with disposable profiles. Clean-computer NSIS installation and native Ubuntu were not demonstrated.

B′'s initial archive-copy interruption was resolved by the owner's allowlist change; the old installer and offline JSON were preserved with matching hashes. The following actual Full run ataa803793 failed one SOW poll (28/29 source cases passed). Diagnostic corrections then preserved failed fixtures, isolated per-launch output and added four deterministic regressions, without changing production code or timeouts.

Latest B′ Full: **NEXAR_WINDOWS_FULL_PASS** at `06e55f36f66c27b24d524e699d06246094c4617a`, tree `20b53990fb585e99ab4ed94001c72f4275b33a38`. Report `.nexar/ci/reports/report-2026-10-24T13-20-25-499Z.json` in the B′ worktree, SHA256 `1cb1fea82daf65dad360cc25ae1ca7aca6b707b25916cb45c544d9524325b16c`;3292.49seconds; clean and stable at both ends;16 required stages passed. Offline4482/167skipped/4pending/0failed; source29/29; packaged29/29; DSH3/3; WSL Windows8/8; GitleaksPASS. The extra Linux-only stage remains BLOCKED/nonrequired. Supplemental B′ WSL full:4623 passed/30 skipped/0 failed/0 pending, raw SHA256 `2e35739026911804584b977a0627cea34bdb0b426f8a71f66d4602e6fb403a4d`; the four Windows pending Bubblewrap cases passed there.

Exact commands, paths, hashes, per-stage timing and repeated-scenario evidence are in [Windows acceptance](NXR070_Windows_Acceptance_Stabilization.md); historical failure mechanisms and uncertainty are in [root-cause analysis](NXR070_Windows_CI_Root_Cause_Analysis.md).

## Security and runtime

B′'s connection→inventory→Registry→NRC→lease→credential→synthetic transport/accounting path and C′'s required-diversity/actual-settlement behavior are rechecked by the existing complete corpus. NRC, DSH0.2.0-rc.2, Permission Broker, monotonic delegation, canonical sessions, Project Memory and Windows/WSL boundaries remain authoritative. No real credentials or paid inference were used.

A separate read-only agent reviewed the authority/settlement paths and corrections. It is not independent owner acceptance.

## Outstanding issues and owner action

The historical ACL initialization failure lacks its original underlying diagnostic. The transient Plan setup failure lacks attribution despite the separately proven callback ordering correction. The new standalone B′ SOW failure also lacks a proven delayed/stalled step; a later isolated and aggregate pass do not establish cause. All remain explicitly documented observations.

Hosted Actions at the last published heads aa803793/261e2994 were budget-blocked with zero executed steps (runs40056784525/40056788557). Recheck the eventual publication heads; local CI is not hosted CI. No applicable main required-check rule was established by the earlier read-only protection/rules queries. Draft state, owner restrictions and the remaining engineering gates still prohibit integration.

Review the completed evidence package separately for B′ and C′ before authorizing sequential integration. Do not start NXR-070D′ or activate upstream automation.

### Exact remaining execution

1. Complete final C′ check and source-bound Windows/WSL acceptance after the propagated diagnostic changes, preserve the prior C′installer and all failed reports, then publish normal updates to both Draft PRs. B′'s standalone Full and WSL full gates are now complete; archive-copy permission is resolved.
2. Keep the historical ACL failure and intermittent Plan attribution open. Any further reproduction must retain the sanitized initialization outcome and phase/timing data. Close a root-cause claim only after evidence establishes the mechanism and its correction; another isolated PASS is insufficient. Same-root startup and crash/cleanup combinations listed in the root-cause report remain coverage limits.
3. Obtain separate independent owner review for B′ and C′, and resolve the hosted Actions budget or explicitly decide how that external limitation affects acceptance. Only a later owner instruction can authorize sequential integration. This handover does not authorize either merge.

## Current overall verdict

`NXR070_BC_STABILIZATION_PARTIALLY_COMPLETE`; `INDEPENDENT_OWNER_REVIEW_PENDING`.

Separate exact verdicts are in [integration readiness](NXR070_BC_Final_Integration_Readiness.md). The source-bound implementation revision remains distinct from a later documentation-only publication commit; the external `.nexar/ci/NXR070_BC_Publication_Receipt.md` records literal final remote identities without a self-referential commit hash.
