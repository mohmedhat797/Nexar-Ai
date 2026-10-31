# DSH 0.2.1-rc.3 acceptance

Date: 27 October 2026. **Upgrade implementation exists; Windows aggregate acceptance FAILED. Keep Draft and do not integrate.** Successful source, WSL and rollback results do not replace the failed mandatory gate.

## Source and environment

Implementation: a3f02b4e4ddce33ae81ec45c96e8d587842b37be; tree 79e0275a8164b1b0c5e9007b2993dee3579c4c58. Base: C′ 46aa3c22460fe278a7f784e9f954f559edda4ccb, normally including B′ ae8a46bc9e80d96d4014ecddc8be9661f73d92cc. Both feature branches retain rc.2 and remain separate Draft PRs. Main remains 41b918bf3c32cfd47301f7551a7280368fc3c8ec.

The final Windows Full, WSL Full and standalone packaging comparison all recorded this exact clean implementation at start and end. Later report/publication commits must be compared against it; documentation-only changes are not claimed as a new Full CI run.

Windows 11 build 26300; Node 22.23.3, npm 10.9.9, pnpm 10.33.0, Electron 44.5.1, electron-builder 26.15.3, Gitleaks 8.28.0. Node is the preserved pinned executable below D:/Nexar-Ai-nxr070/.nexar/research-toolchain/node-v22.23.3-win-x64, not the default Node 24. No toolchain upgrade or global PATH change occurred.

The isolated Windows managed runtime used by the final Full is C:/Nexar-Acceptance-Archive/20261027-rc3-disk-pressure/managed-rc3-full-capacity. Packaging independently installs its bundle below the repository's dist/dsh-runtime. Neither is an owner application profile. The isolated Linux checkout is /home/nexar/src/nxr-dsh-rc3-20261027, distro nexar-plane; global /opt/dsh remains rc.2.

## Current Windows aggregate result

Actual repository invocation: pinned Node scripts/local-ci/runner.mjs --mode=full --profile=windows --workers=2, with explicit --node-bin, --gitleaks-bin and --dsh-dir as recorded in the execution receipt. All repository stage definitions and deadlines were preserved, including the 180-second installer and 15-second private-state guard.

**NEXAR_WINDOWS_FULL_FAIL**, 11:18:47–11:47:26 UTC, 1,718,709 ms. Raw report: .nexar/ci/reports/report-2026-10-27T11-18-47-908Z.json, SHA256 **248a0576d52b642f5917b053b9fca17129ea5685c7a47bb34fe73450597e3f6b**. Recorder: dsh-rc3-windows-full-capacity-a3f02b4-20261027.execution.json. Aggregate log SHA256: c29e11720986c682c6c6256312b7cbee1411dacf3c616b28a0b6453880ae0baf.

| Required stage                            | Result                                               |
| ----------------------------------------- | ---------------------------------------------------- |
| Frozen dependencies                       | PASS                                                 |
| Pinned managed installation               | PASS, 177.44 seconds                                 |
| Formatting, lint, boundaries, typecheck   | PASS, each executed                                  |
| Offline tests                             | 4,608 passed; zero failed; 169 skipped; four pending |
| Production build                          | PASS                                                 |
| Both CLI smoke commands                   | PASS                                                 |
| Actual DSH context/compaction             | 3/3, zero failed/skipped/pending                     |
| Windows-to-WSL Cowork and nested security | 8/8, zero failed/skipped/pending                     |
| Source Desktop E2E                        | 33/33 across 11 files; 471.04 seconds                |
| Windows package                           | FAIL during its nested npm-ci installation           |
| Packaged Desktop E2E                      | SKIPPED after package failure                        |
| Gitleaks in this aggregate                | SKIPPED after package failure                        |

The optional native-Linux host stage was skipped after the preceding failure; it is not a Windows security PASS. The 16 mandatory stages did not all pass. The report's total 4,652 passing assertions includes separately repeated acceptance corpora; it is not a count of unique tests.

The offline JSON was preserved under dsh-rc3-windows-full-capacity-a3f02b4-20261027.offline-tests.json, SHA256 4c4a889a57c33804273e87438b8084e150ed069fd0a588851f17e22240eafe42. The four pending Windows assertions concern real Bubblewrap proxy/socket networking. Their Linux results below are separate executed evidence.

## Packaging timeout and bounded standalone comparison

At 11:44:25.537 UTC the package installer observed owned child PID 16256, parent PID 4788, generation a6525a2c-5034-4804-bf03-71615a646346. npm-ci timed out at elapsed 180,457 ms, exit 124. Entry validation, version probing and publication were not reached. The partial staging tree remains unavailable and retained.

The preserved npm debug record confirms Node 22.23.3/npm 10.9.9, 616 cache-hit records, no recorded HTTP fetches/cache misses or integrity errors, and no completion footer. The retained tree had 62,833 files / 728,863,181 bytes. These facts establish incomplete cache-backed materialization before timeout; they do **not** establish antivirus, disk latency, scheduling or another lower-level cause. No deadline increase, silent retry or acceptance of the partial tree was introduced.

One predetermined standalone comparison then executed the existing package stage, packaged E2E if possible, and the independent secret-scan stage, serially. It also **failed** package installation at 180,563 ms (generation 0fb2431f-bac9-4292-af0f-aec698951796); packaged E2E was skipped. Gitleaks passed in 2,547 ms. This is not an aggregate Full PASS.

Standalone receipt: dsh-rc3-supplemental-package-a3f02b4-20261027.json, SHA256 d18ee264a18fc3afb5228da822fd8cf3c526d055d39bf66cf726625db7e10853. Package log SHA256 45b3044336638f981743927e99ac3221cfd5d24f569a3658a8ab961a3cb4fd3e; secret-scan log SHA256 81c39354a50997e74d09d7fec4004af647a240eab1555df774810606a91de8d3. No further identical retries are classified as remediation.

## WSL2 full regression

Actual command: pnpm exec vitest run --maxWorkers=1 --reporter=default --reporter=json, using the isolated exact rc.3 entry and toolchain; live-provider flag removed. Node 22.23.3/pnpm 10.33.0; Linux 6.18.33.2-microsoft-standard-WSL2.

**4,751 passed, zero failed, 30 skipped, zero pending**, 254 files, 268,660 ms. All 12 real Bubblewrap integration assertions passed, including all four networking assertions pending on Windows. Source remained clean and unchanged.

Evidence prefix: dsh-rc3-wsl-full-a3f02b4-20261027. Execution JSON SHA256 9c659820e4d976192e4666109c7ba7bb9c5c0c275692385f1eb3d7a076795f9e; test JSON SHA256 3633a86e25ee73a2dd4491a56dbd4665ae426ad8b50a8afd66943f4623bf5c5a; log SHA256 13016f13a5a465c4d3e310a5cb2e55e742ae7da3435f7c3b98f38a66d16fc272. This is WSL2, not native Ubuntu or Linux Desktop acceptance.

## Runtime, credential and compatibility regressions

Complete check before implementation commit: pnpm check, 4,595 passed, zero failed, 182 skipped, four pending; 367,997 ms. Log SHA256 e385ede6e7b6aee565b2d8aaefdf2596caeac7f6edd8f9d1ce3f134cf2fc11b6. Focused final corpus: 477 passed, zero failed, nine skipped, 72,394 ms; log SHA256 0a07815a3552d51e031500030f59ecc3510272c23aa73a12d51d072d8b2bc173.

The actual connection test creates persisted A/B connections through the real Desktop bridge, publishes their inventories through Registry/NRC, executes actual managed ACP with the production Gateway and ConnectionManager admission, and observes A/B credentials only at a synthetic provider transport. It checks active rotation refusal, Disable drain/new-admission denial, lease release, private runtime homes and an appropriately restricted tool catalog. Fixture ID-wiring failures were retained; they are not evidence of a production defect.

The actual SDK saved-credential regression produced RED: one failure in 18,261 ms, log SHA256 4aab74322e9aa36629c4fadf7ecdbe89162a21bfd52246f1402a6888b790cdd9. Before correction, a valid foreign native saved key displaced the selected key. GREEN after disabling upstream credentials and authorization: one pass in 4,849 ms, no skips/pending; log SHA256 1e1f7b6f3c316e9c7c0da371f54794e9bf1b902c9469e3dd33e07937dca72012. Both ACP and SDK overlays enforce the correction. The malformed initial native-store fixture and earlier unrelated SDK initialization timeout remain separately classified.

New private agents-home isolation also has actual failing-before/passing-after evidence; final focused home/input validation passed 14/14. Existing routing goldens, required review diversity, ledger settlement, lifecycle/persistence, permissions and session/memory corpora passed in the complete suites. No golden fixture was regenerated to conceal a routing change.

## Disposable rollback

Canonical reader campaign: C′ rc.2 → candidate rc.3 → C′ rc.2. The same connection/resource IDs, credential association, connection digest, completed-session digest and Project Memory digest were preserved. Evidence dsh-rc3-state-rollback-final-20261027/result.json; SHA256 4c73102b70f703a9877c30e9601921304755aeb1811c645c705b96110964aa31.

Separate actual ACP campaign: rc.2 before, rc.3, rc.2 after, each 3/3 passed, zero failed/skipped/pending; 84,408 / 97,822 / 24,414 ms. Evidence dsh-rc3-runtime-rollback-final-20261027/result.json; SHA256 308c1e824b5754ac8792cf5fd2f0f3e754d37aa62060d8ae53c3a3cadc90f86a.

These use disposable state and private native runtime homes. They demonstrate canonical-state reader and runtime restoration compatibility, not universal downgrade of an arbitrary shared rc.3 native database. No real connection, credential, session or memory was migrated.

## Historical failures remain failures

| Source / run                                   | Actual outcome                                                                                                        |
| ---------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| 3fa15d4 first Full                             | Deliberately interrupted after discovery of SDK overlay gap; no aggregate verdict                                     |
| fe106fd / report-2026-10-27T02-39-05-898Z.json | Installer timeout after publication while recursively deleting previous generation; subsequently corrected separately |
| a3f02b4 / report-2026-10-27T09-54-14-935Z.json | FAIL: 7za reported insufficient disk space during NSIS packaging; later E2E/scan skipped                              |
| a3f02b4 / report-2026-10-27T11-18-47-908Z.json | FAIL: nested npm-ci timed out; later packaged E2E/scan skipped                                                        |
| a3f02b4 standalone comparison                  | FAIL: nested npm-ci timed out again; independent Gitleaks PASS                                                        |

The ENOSPC report SHA256 is 64224652e3cc4fbd732c7b44541ca3d2e622979c01b7642f2e2348c63f82b417. Its source Desktop suite passed 33/33; generated unpacked CLI/lock/helper identity was verified supplementally, not accepted as an installer or packaged E2E result. Ten unique failed-build code/identity files were byte-verified and preserved on C before normal package cleanup. Earlier runtime/package reports and their hashes remain retained.

Only explicitly identified inactive acceptance artifacts were relocated, after byte verification, to C:/Nexar-Acceptance-Archive/20261027-rc3-disk-pressure. The two runtime archives have per-file verification receipts; old B′/C′ installer paths are forwarded by receipts. Real profiles, worktrees, raw reports and the legacy pinned toolchain were preserved. No broad workspace cleanup occurred.

## Separate Phase A and release blockers

B′ standalone rc.2 Full passed on dc4d89b983573131036c28740a904c48c8594e3f/tree 6b812182583437b760531652c940054aedfb64f1: all 16 mandatory stages, offline 4,530 passed / 167 skipped / four pending, real DSH 3/3, WSL 8/8, source and packaged Desktop 33/33, Gitleaks PASS. Raw report SHA256 e3ff80ce946bdf71315363885b680c9524d8080e555a73b7cdf0dfcb4d3592ef. Final B′ ae8a46b adds documentation only. C′ 46aa3c2 passed its complete check; no new standalone rc.2 Full PASS is claimed for that merge.

This does not close historical npm materialization, PowerShell startup, packaged SOW or initial unrelated SDK delay causes. The demonstrated destructive reinstall and post-publication deletion defects have separate corrections and regression evidence.

The rc.3 installed dependency audit remains non-clean: 189 high/seven moderate package/metavulnerability records, not independent CVE counts. Nested Zod and other advisory reachability/risk disposition remains outstanding; exact-version authorization is not a security exception. See [compatibility](NXR070_DSH_021_RC3_Compatibility_Assessment.md).

Current rc.3 package/installer identity, packaged restart/E2E and a complete passing Windows Full remain unverified. No current NSIS artifact hash or clean-machine installation PASS is claimed. No live provider credentials, account sign-in or paid inference was used. Hosted CI and independent owner acceptance are separate gates, recorded in the [handover](NXR070_DSH_Upgrade_Final_Owner_Handover.md).

## Publication and report-tree verification

The upgrade is published as [Draft PR #46](https://github.com/mohmedhat797/Nexar-Ai/pull/46), base C′. Initial report commit cb78be90f0f0fab1e2173123b9dd51f68854f36e is documentation/evidence only after the tested implementation. Complete pnpm check on its staged tree 31763cf9b80ed3667063c98605ed74e48d7b2ba0 passed in493815ms; log SHA256 d58cd370ba0babeb0f37f17f9c53f6ecbcbba117accac44e7f82abe6b3fdf4c6. Neither this check nor publication changes the failed Windows acceptance result.

Actual initial upgrade hosted run40537560834 atcb78be90 was infrastructure-blocked by the Actions budget: three failed jobs, zero executed steps, explicit failure annotations. Receipt dsh-rc3-initial-publication-hosted-20261027.json SHA256324a4da2fb3edc0dc28acbee4f94913a46202919279e9cbcc8e6347be4c5b966. The final publication receipt records the later exact remote SHA, final checks and latest inspected hosted run. All PRs remain Draft/unmerged and independent owner acceptance is pending.
