# DSH runtime upgrade — final owner handover

Date: 27 October 2026. **The exact rc.3 upgrade is implemented, but Windows acceptance is blocked. Do not merge or deploy it.**

## Outcome

Phase A corrected two demonstrated safety/reliability defects: failed reinstall no longer destroys the working runtime, and readiness no longer waits for recursive deletion of the previous dependency tree. B′ passed its standalone rc.2 Windows Full. The original low-level npm installation delay remains unresolved.

Phase B pins exactly @deepseek-ai/dsh@0.2.1-rc.3 on its own branch. Source execution, actual ACP/SDK, connection-specific credentials, WSL isolation and disposable rollback were exercised successfully. However, the final Full and a bounded standalone comparison both timed out during packaging's nested npm-ci. Packaged E2E could not execute. The dependency advisory assessment also remains open. Neither a later stage pass nor B′'s acceptance substitutes for these gates.

## Repository and publication

| Reference                                                            | Verified source                                               |
| -------------------------------------------------------------------- | ------------------------------------------------------------- |
| Main                                                                 | 41b918bf3c32cfd47301f7551a7280368fc3c8ec                      |
| B′, Draft [PR #44](https://github.com/mohmedhat797/Nexar-Ai/pull/44) | ae8a46bc9e80d96d4014ecddc8be9661f73d92cc                      |
| B′ Windows-tested implementation                                     | dc4d89b983573131036c28740a904c48c8594e3f                      |
| C′, Draft [PR #45](https://github.com/mohmedhat797/Nexar-Ai/pull/45) | 46aa3c22460fe278a7f784e9f954f559edda4ccb                      |
| Upgrade implementation                                               | a3f02b4e4ddce33ae81ec45c96e8d587842b37be                      |
| Upgrade implementation tree                                          | 79e0275a8164b1b0c5e9007b2993dee3579c4c58                      |
| Upgrade branch/base                                                  | feat/nxr-dsh-021-rc3-upgrade → feat/nxr-070c-review-diversity |

Normal merges preserve B′→C′→upgrade ancestry. No main change, merge, force-push, Ready transition or audit-history rewrite occurred. Upgrade [Draft PR #46](https://github.com/mohmedhat797/Nexar-Ai/pull/46) was created with base C′ and initial report HEAD cb78be90f0f0fab1e2173123b9dd51f68854f36e. That commit changes documentation/evidence only from the tested implementation. Final publication HEAD, remote/ancestry verification, final secret scan and current hosted evidence are recorded in the canonical workspace's .nexar/ci/NXR070_DSH_RC3_Final_Publication_Receipt_20261027.md. This avoids pretending a document can contain its own Git commit hash.

## Installation reliability

The installer uses exclusive admission, fresh same-parent staging, npm lock integrity, contained entrypoint and actual CLI-version checks, and two-rename publication with in-process compensation. Failed/partial stages cannot become ready. Previous generations are retained for explicit maintenance; there is no automatic stale-lock stealing, universal atomic-swap/power-loss claim or new garbage collector.

The post-publication deletion regression produced RED 16 passed/one failed and GREEN 17 passed/zero failed, preserving the 180-second policy. B′'s source-bound Full then passed all 16 mandatory stages. The original historical npm unpack delay is separate and unresolved.

In the current rc.3 Full, managed installation on C passed in 177.44 seconds; packaging's independent installation on D timed out in npm-ci. Its npm record shows cache hits without a completed materialization. The standalone package comparison reproduced the timeout. This does not prove a particular disk, scheduling, antivirus or network cause, and no speculative fix or timeout increase was applied.

## Upgrade and compatibility changes

- Exact root package, managed lock and active verification/packaging assertions target rc.3; workspace pnpm lock remains unchanged. Official root tarball SRI and SHA256 were verified separately from the upstream Git tag.
- Both ACP and SDK overlays disable upstream saved-credential/sign-in services. Actual RED showed a saved foreign key overriding the selected key; GREEN delivered the selected key. Host ConnectionManager and Permission Broker remain authoritative.
- The new shared instruction/agent home is explicitly private. Newly introduced working-directory and DeepSeek web capabilities remain disabled.
- The official native model default is deepseek-flash; canonical built-in resource/connection/provider identity is unchanged. Explicit owner model settings are not silently migrated.
- No native session resume, optional plugin installation, DSH worktree mechanism, T3 runtime, second harness, automatic upstream monitoring or later NXR milestone was enabled.

The implementation report lists the exact changed files. Ten core authority files are byte-identical to C′: connection/settings/credential stores, private-state guard, FileSessionStore, Project Memory, NRC controller/strategy, Control Gateway and Permission Broker. This is a focused implementation-agent review, not independent acceptance.

## Acceptance and rollback

| Gate                                             | Actual result                                                                        |
| ------------------------------------------------ | ------------------------------------------------------------------------------------ |
| B′ rc.2 standalone Windows Full                  | PASS, all 16 required stages, source/packaged Desktop 33/33 each                     |
| rc.3 complete check before implementation commit | 4,595 passed, 182 skipped, four pending; zero failed                                 |
| rc.3 final Windows offline                       | 4,608 passed, 169 skipped, four pending; zero failed                                 |
| Actual DSH context / Windows-to-WSL              | 3/3 and 8/8                                                                          |
| rc.3 source Desktop                              | 33/33                                                                                |
| rc.3 final aggregate Windows Full                | FAIL at nested package installation                                                  |
| rc.3 standalone package comparison               | FAIL at nested package installation                                                  |
| rc.3 packaged Desktop E2E                        | Not executed after failed packaging                                                  |
| rc.3 independent Gitleaks                        | PASS; aggregate scan was skipped                                                     |
| Exact-source WSL Full                            | 4,751 passed, 30 skipped; zero failed/pending                                        |
| Real Bubblewrap                                  | 12/12, including all four Windows-pending networking assertions                      |
| Disposable canonical rollback                    | Same connection/resource/credential/session/memory identities through rc.2→rc.3→rc.2 |
| Actual runtime rollback                          | 3/3 ACP tests on each of rc.2→rc.3→rc.2                                              |

The final Windows report is report-2026-10-27T11-18-47-908Z.json, SHA256 248a0576d52b642f5917b053b9fca17129ea5685c7a47bb34fe73450597e3f6b. The [acceptance report](NXR070_DSH_021_RC3_Acceptance.md) records all attempt identities, hashes, commands, timing, skips and rollback receipts; [machine evidence](evidence/nxr070-dsh-rc3/acceptance-summary.json) provides a compact index.

WSL2 is not native Ubuntu acceptance. Earlier win-unpacked identity inspection is not a successful current package or a clean-machine NSIS installation. Native runtime rollback uses private homes; no universal native-database downgrade is certified. Real user profiles, credentials, canonical sessions and Project Memory were not modified.

## Security and external blockers

Nexar's tested credential, identity, review, permission and sandbox boundaries remain preserved. That does not certify the bundled dependency closure as clean: rc.3 npm audit returned 189 high/seven moderate package/metavulnerability records. These are not independent vulnerabilities; nested Zod availability exposure and other bundled advisories need explicit reachability/risk disposition. No override, audit-fix or security exception was introduced.

PR #44/#45 hosted runs 40482032663/40482043084 were infrastructure-blocked: three failed jobs each, zero executed steps, actual annotations citing the Actions budget. The upgrade's initial [run 40537560834](https://github.com/mohmedhat797/Nexar-Ai/actions/runs/40537560834) at cb78be90 also has three failed jobs, zero executed steps and actual budget-prevented-start annotations: HOSTED_CI_INFRASTRUCTURE_BLOCKED. Authenticated receipt dsh-rc3-initial-publication-hosted-20261027.json has SHA256 324a4da2fb3edc0dc28acbee4f94913a46202919279e9cbcc8e6347be4c5b966. Later publication metadata is separately verified in the final receipt; no hosted PASS or protection bypass is claimed.

Independent owner review remains pending. Self-review and test results do not grant acceptance. Existing historical PowerShell startup, npm materialization, packaged SOW and unrelated initial SDK timing observations retain unresolved causal status.

## Required next work and owner decision

First, resolve the now-reproduced packaging installer materialization timeout on this exact pin and host path, preserving the 180-second policy. Prove the mechanism with bounded diagnostics and a meaningful regression, then obtain one complete clean-source NEXAR_WINDOWS_FULL_PASS including actual packaged restart/E2E and Gitleaks. Do not repeatedly rerun the same failing command or substitute an unverified runtime/cache.

Separately disposition the bundled dependency advisory exposure and obtain independent review of the final stack. Keep all three PRs Draft and integrate none without subsequent owner authorization. The owner may authorize a narrowly scoped installer/dependency correction; this handover does not request an unrelated roadmap or NXR-070D′.

## Verdicts

| Area                                                       | Verdict                                         |
| ---------------------------------------------------------- | ----------------------------------------------- |
| Installation reliability                                   | NXR070_DSH_INSTALLATION_ROOT_CAUSE_UNRESOLVED   |
| Upgrade implementation                                     | NXR070_DSH_RC3_UPGRADE_IMPLEMENTED              |
| Runtime compatibility, including missing packaged coverage | NXR070_DSH_RC3_RUNTIME_COMPATIBILITY_INCOMPLETE |
| Tested Nexar security boundaries                           | NXR070_DSH_RC3_SECURITY_INVARIANTS_PRESERVED    |
| Windows                                                    | NXR070_DSH_RC3_WINDOWS_ACCEPTANCE_FAILED        |
| WSL                                                        | NXR070_DSH_RC3_WSL_ACCEPTANCE_VERIFIED          |
| Disposable rollback                                        | NXR070_DSH_RC3_ROLLBACK_VERIFIED                |
| GitHub                                                     | NXR070_DSH_RC3_DRAFT_PR_PUBLISHED               |
| Independent acceptance                                     | INDEPENDENT_OWNER_REVIEW_PENDING                |

**NXR070_DSH_RC3_UPGRADE_IMPLEMENTED_WITH_OUTSTANDING_GATES**

## Report-tree validation

Before report commit cb78be90, complete pnpm check passed on unchanged staged tree 31763cf9b80ed3667063c98605ed74e48d7b2ba0: 4,595 passed, zero failed, 182 skipped and four pending; 493,815 ms. Log SHA256 d58cd370ba0babeb0f37f17f9c53f6ecbcbba117accac44e7f82abe6b3fdf4c6. This validates the report revision and unchanged code, not a new Windows Full. The publication-link update receives its own complete check before commit; its exact result is in the final publication receipt.
