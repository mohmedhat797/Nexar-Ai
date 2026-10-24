# NXR-070B′/C′ — Final Owner Handover

Date: 2026-10-24. Engineer: OpenAI Codex. Implementation acceptance and later documentation/publication identities are distinguished below.

## Executive status

The corrected combined C′ revision completed **NEXAR_WINDOWS_FULL_PASS**, all16 required stages in one invocation, and a supplemental serial WSL full suite. It includes B′'s production callback correction, isolated Desktop workflows, actual process-exit observation, improved ACL failure diagnostics and clean commit/tree CI identity checks. The earlier package and platform failures remain preserved as failures.

The historical ACL cause remains unexplained. No source review or isolated pass constitutes owner acceptance.

## Repository

| Field                                | Last verified value                                                                              |
| ------------------------------------ | ------------------------------------------------------------------------------------------------ |
| Canonical workspace                  | D:/Nexar-Ai-main                                                                                 |
| Main                                 | 41b918bf3c32cfd47301f7551a7280368fc3c8ec                                                         |
| Initial PR44                         | 18c7cd01412a8c2b138ec99baf98751699ae169e; OPEN/Draft; base main                                  |
| Initial PR45                         | 4c69766e546950bfbbdacb504034d9a010967ea7; OPEN/Draft; base B′                                    |
| First stabilization local source     | 2887939da04a57b705a077377c2093898ba9e242                                                         |
| Its tree                             | b08e7ed316e04271dccbea7d154293c9aa9ff8ed                                                         |
| B′ callback production correction    | f1482e692947f72a035c6ff2146f424b5581a41c                                                         |
| B′ shared-infrastructure source      | aa803793f5b4ec0ff2105b5f19b86f3a0bdb01c3; tree87667a254d6a2c42d02a78e07d9322e9b8c6fd97           |
| Tested C′ Full CI source             | 1c584208c8580ef3d9ba94e510fb30c58d88796d; treeec47d9ff4db3eed7fdde870c1a2b60773fa5225b           |
| Published heads at last verification | B′f1482e6; C′1c584208; bothOPEN/Draft; later publication receipt records final remote identities |

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

B′'s shared-infrastructure `pnpm check` passed4,478, skipped167, retained4 pending, failed0, then built successfully. A new standalone B′ Full invocation was stopped after the dependency stage, before tests, because the tool allowlist blocked archiving prior artifacts. That interruption is not a PASS or a code-test failure. Separate B′ aggregate acceptance remains outstanding until preservation is possible.

Exact commands, paths, hashes, per-stage timing and repeated-scenario evidence are in [Windows acceptance](NXR070_Windows_Acceptance_Stabilization.md); historical failure mechanisms and uncertainty are in [root-cause analysis](NXR070_Windows_CI_Root_Cause_Analysis.md).

## Security and runtime

B′'s connection→inventory→Registry→NRC→lease→credential→synthetic transport/accounting path and C′'s required-diversity/actual-settlement behavior are rechecked by the existing complete corpus. NRC, DSH0.2.0-rc.2, Permission Broker, monotonic delegation, canonical sessions, Project Memory and Windows/WSL boundaries remain authoritative. No real credentials or paid inference were used.

A separate read-only agent reviewed the authority/settlement paths and corrections. It is not independent owner acceptance.

## Outstanding issues and owner action

The historical ACL initialization failure lacks the underlying diagnostic needed to establish cause. A transient Plan connect failure also lacks attribution; the separately proven callback ordering fix must not be represented as definitive attribution.

Hosted Actions were budget-blocked with zero executed steps at the actual updated heads: B′ run40054239874 and C′40054248363. All six jobs reported that an Actions budget prevented starting. Local CI cannot be substituted for hosted CI. Draft PRs remain unmerged; main protection reads showed no applicable required-check rule, but explicit owner acceptance and engineering gates still apply.

Review the completed evidence package separately for B′ and C′ before authorizing sequential integration. Do not start NXR-070D′ or activate upstream automation.

### Exact remaining execution

1. Enable only lean-ctx's `Copy-Item` command as requested, preserve B′'s current offline JSON and old package under new archive names, then run a new standalone B′ Full invocation at clean `aa803793` with its matching WSL checkout `/home/nexar/src/nxr070b-remediation-20261018`. Use a new console log name; do not overwrite the interrupted attempt. Acceptance requires one actual aggregate PASS, matching clean start/end source/tree and all mandatory stages. No code change is needed merely to resume this gate.
2. Keep the historical ACL failure and intermittent Plan attribution open. Any further reproduction must retain the sanitized initialization outcome and phase/timing data. Close a root-cause claim only after evidence establishes the mechanism and its correction; another isolated PASS is insufficient. Same-root startup and crash/cleanup combinations listed in the root-cause report remain coverage limits.
3. Obtain separate independent owner review for B′ and C′, and resolve the hosted Actions budget or explicitly decide how that external limitation affects acceptance. Only a later owner instruction can authorize sequential integration. This handover does not authorize either merge.

## Current overall verdict

`NXR070_BC_STABILIZATION_PARTIALLY_COMPLETE`; `INDEPENDENT_OWNER_REVIEW_PENDING`.

Separate exact verdicts are in [integration readiness](NXR070_BC_Final_Integration_Readiness.md). The source-bound implementation revision remains distinct from a later documentation-only publication commit; the external `.nexar/ci/NXR070_BC_Publication_Receipt.md` records literal final remote identities without a self-referential commit hash.
