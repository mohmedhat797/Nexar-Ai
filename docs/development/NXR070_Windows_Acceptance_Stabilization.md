# NXR-070B′/C′ — Windows Acceptance Stabilization

Execution: 2026-10-23–24, Africa/Cairo. Engineer: OpenAI Codex.

## Environment and pinned tools

Windows 11 Pro 10.0.26300 x64; 20 logical CPUs; approximately15.73 GiB RAM. Storage inventory reports NVMe SSD. Node22.23.3, pnpm10.33.0, DSH0.2.0-rc.2, Gitleaks8.28.0, Electron44.5.1 and Electron Builder26.15.3 are preserved.

Node remains at `D:/Nexar-Ai-nxr070/.nexar/research-toolchain/node-v22.23.3-win-x64/node.exe`. This older workspace directory is an active dependency and must not be deleted. No tool relocation or broad cleanup was performed. Gitleaks is under the canonical workspace's `.nexar/gitleaks-8.28.0`; managed DSH is local to the feature worktree.

## Supported invocation

```powershell
$env:PATH='D:/Nexar-Ai-nxr070/.nexar/research-toolchain/node-v22.23.3-win-x64;'+$env:PATH
$env:NEXAR_SEC02_WSL_REPO='/home/nexar/src/nxr070c-20261021'
$env:NEXAR_E2E_PHASE_TRACE='1'
$env:npm_config_prefer_offline='true'
pnpm ci:local:full --node-bin=D:/Nexar-Ai-nxr070/.nexar/research-toolchain/node-v22.23.3-win-x64/node.exe --gitleaks-bin=D:/Nexar-Ai-main/.nexar/gitleaks-8.28.0/gitleaks.exe --dsh-dir=D:/Nexar-Ai-main/.nexar/nxr070c/.nexar/dsh-runtime
```

No worker override: Windows defaults to two. Required stages are awaited sequentially. Supplemental WSL suites do not overlap Windows, Electron or packaging workloads. Source preflight requires a clean identified commit/tree; end identity must match. This is not a machine-wide lock against unrelated owner activity.

## Completed immutable Full CI attempt

Source `2887939da04a57b705a077377c2093898ba9e242`, tree `b08e7ed316e04271dccbea7d154293c9aa9ff8ed`; start/end clean and sourceStable=true.

Raw report `.nexar/ci/reports/report-2026-10-23T20-07-38-387Z.json`, SHA256 `d46a1227013c09831dbfc890fb5516720842234c6316f4673aa5c123c041d748`. Console `bc-windows-full-stabilization.log`. Result **NEXAR_WINDOWS_FULL_FAIL**, duration2494.78 s.

| Gate                                                              | Result                                                                         |
| ----------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| Dependencies, pinned DSH, formatting, lint, boundaries, typecheck | PASS                                                                           |
| Offline                                                           | 4,531 passed,169 skipped,4 pending,0 failed;306.41 s                           |
| Build and both CLI smoke gates                                    | PASS                                                                           |
| Real DSH context/compaction                                       | PASS;23.62 s                                                                   |
| Windows→WSL Cowork/context                                        | 8/8 passed                                                                     |
| Linux ACP/Bubblewrap/kernel                                       | 15/15 passed; no skips                                                         |
| Source Desktop E2E                                                | 29/29 passed;601.55 s subprocess,598.86 s test runner                          |
| Windows packaging                                                 | FAIL;1200.365 s deadline, exit124                                              |
| Packaged Desktop E2E, Gitleaks                                    | SKIPPED due to mandatory package failure                                       |
| Linux-only sandbox stage in Windows profile                       | Not applicable; real Linux kernel coverage above remains required and executed |

The source/packaged suite envelope is now900 s because isolated connection workflows add cold starts; individual120-second case limits remain unchanged. The observed601.55-second source stage independently exceeds the old600-second suite envelope.

The package envelope is now1500 s. The prior1200-second run was killed during block-map creation after NSIS produced a complete-size installer, before the package completed its verification/receipt. Incomplete artifacts are preserved in `.nexar/ci/package-2887939-timeout` and are not accepted.

## Other executed evidence

- `bc-pnpm-check-stabilization-final.log`: complete pnpm check PASS;4,531 passed,169 skipped,4 pending; all static/build checks passed.
- `bc-clean-source-red.log`: new clean-source test failed before implementation. `bc-ci-focused-green.log`:37 focused tests passed.
- `bc-connections-diagnostic.log`: original combined workflow118.806 s with continuous progress.
- `bc-connections-partitioned.log`:4/4 passed in176.47 s.
- `bc-offline-diagnostic.json`:4,524 passed,169 skipped,4 pending,0 failed with four workers.
- `bc-acl-parallel-1..4.json`: four selected native fresh-root cases passed; filtered cases are skipped.
- `bc-offline-full-stabilization.json`: SHA256 `527a1388b6af11f9e62dfa31676220787c7ea755f04237c6bf1f84198487805f`; private-state19 passed/2 POSIX skipped; lifecycle5 passed.
- `bc-pnpm-check-package-envelope.log`: subsequent full check FAIL during Plan connect setup;4,530 passed,169 skipped,4 pending,1 failed. Not reclassified as pass.
- B′ callback regression: three new tests RED before correction, then31 focused tests GREEN, including aborted response. See its correction report for command/hash.

Skipped and pending tests are never counted as passes. Historical failed reports and installers remain preserved. The original installer hash `1f3dfa344709cf403780977586c6738a61f0cf9b4a923509ef2e159fa53a805b` identifies the archived historical artifact, not a new accepted build.

## Final-source acceptance

C′ completed a second, independent aggregate invocation: **NEXAR_WINDOWS_FULL_PASS**. Source `1c584208c8580ef3d9ba94e510fb30c58d88796d`, tree `ec47d9ff4db3eed7fdde870c1a2b60773fa5225b`; both start and end were clean, with matching commit/tree and sourceStable=true. Raw report `.nexar/ci/reports/report-2026-10-24T01-29-48-293Z.json`, SHA256 `4b159a579ec24caf96eaadd0070fe37c47c5c612eddf717b466f171bc48dc9e4`; console `bc-windows-full-final-candidate.log`. Total duration2556.04 s. All16 required stages passed in this one invocation.

| Required gate                                                         | Observed result                                                  |
| --------------------------------------------------------------------- | ---------------------------------------------------------------- |
| Frozen dependencies, managed DSH, format, lint, boundaries, typecheck | PASS                                                             |
| Offline Windows tests                                                 | 4,535 passed,169 skipped,4 pending,0 failed;4708 total;310.975 s |
| Build, CLI resources and CLI run                                      | PASS                                                             |
| Real DSH context                                                      | 3/3 passed;25.784 s                                              |
| Windows-to-WSL acceptance                                             | 8/8 passed                                                       |
| WSL ACP/Bubblewrap/kernel acceptance                                  | 15/15 passed, no skips; combined WSL stage58.927 s               |
| Source Desktop E2E                                                    | 29/29 passed;498.598 s                                           |
| Windows packaging                                                     | PASS;940.851 s                                                   |
| Packaged Desktop E2E                                                  | 29/29 passed;451.143 s                                           |
| Gitleaks                                                              | PASS;308 commits, approximately10.78 MB, no leaks;2.111 s        |

The additional Linux-only stage is recorded **BLOCKED, required:false**, rather than passed or skipped. Mandatory WSL kernel coverage passed separately above. The native Windows private-state file passed19 tests, with2 POSIX cases skipped;8 of the19 are actual native ACL cases and11 are tool/boundary cases. Source E2E recorded35 graceful owned-process exits and zero forced exits. These observations do not establish universal descendant-process cleanup or the historical ACL cause.

Offline JSON archive `bc-offline-final-candidate.json`: SHA256 `67af044e5ffa98d4de212e5b73b1a9a2c6bf4c9327bda1a0f24b118b7e4c5dbb`. Windows WSL gate archive `bc-final-cowork-wsl.json`: SHA256 `9cbf28255933e1c5f5e830ecb9ec5da4b0a9fc0823a9db126cb069b400a8c90e`.

### Installer and helper identity

The same-build NSIS artifact `release/desktop/Nexar-0.1.0-windows-x64-setup.exe` is322,186,813 bytes, SHA256 `d69ae5298e92adc24f0c602f64263ce108e4efc7956986d2117a6f758480c945`; its sidecar matches. It is **NotSigned**. Packaged E2E used that build's win-unpacked output, not an installed NSIS copy on a clean computer.

Source-built helpers match packaged `.asar.unpacked/dist/main` byte-for-byte:

| Helper                                        | SHA256                                                             |
| --------------------------------------------- | ------------------------------------------------------------------ |
| bridge-relay                                  | `61559e1d832bfc1698d3e1b044420f743b2252e0e95dfc8c539f8157c43a1312` |
| control-gateway                               | `26b415e24ee9ef3d42e6bd77a019af1a3422c1d600bd76d8fb1e4c86f8370207` |
| signin-callback                               | `517b141153204e7c1cbae41b98c4f8bc0624de6a61d8a9814efbcfaf8b8d5bfa` |
| Managed and bundled DSH lib/bin.js,0.2.0-rc.2 | `1a03dee18683483ff6a1b27b2a1e650230da6bcca9a0f55f7d81b3308c3f307f` |

### Supplemental serial WSL full suite

At the same clean C′ commit/tree, `/home/nexar/src/nxr070c-20261021` completed frozen offline install, TypeScript build and `pnpm exec vitest run --maxWorkers=1 --reporter=json --outputFile=.nexar/ci/bc-wsl-final-full.json`. Node22.23.3, pnpm10.33.0, kernel6.18.33.2-microsoft-standard-WSL2, distro nexar-plane. **4,678 passed,30 skipped,0 failed,0 pending;4708 total.** Raw JSON SHA256 `89a90ff621afd1139d9f5729ebf360f1d69ab3cfbee8910b3f3525500408ce9e`; Windows launcher console `bc-wsl-final-full-console-stdin.log`. All four Windows pending Bubblewrap cases passed here. All five live-provider test files remained skipped. An earlier launcher quoting failure stopped before tests and remains preserved in `bc-wsl-final-full-console.log`; it is not a test pass.

### Separate B′ source

B′ callback correction `f1482e692947f72a035c6ff2146f424b5581a41c` is present in the tested C′ revision. The same11 shared acceptance-infrastructure files were then backported byte-for-byte to B′, without C′ feature code, in `aa803793f5b4ec0ff2105b5f19b86f3a0bdb01c3`, tree `87667a254d6a2c42d02a78e07d9322e9b8c6fd97`. Its `pnpm check` passed4,478 tests,167 skipped,4 pending,0 failed, followed by build. Archive-copy access was subsequently enabled and the prior artifacts were preserved. The first actual standalone Full invocation at that revision failed the SOW completion poll; the later standalone PASS below is a separate run, not a relabeling of combined C′ acceptance or that failure.

B′ check log `bc-b-pnpm-check-shared-infra.log` SHA256 `1c5caf78d967c7ed60134a1817d032581359e18c1b3848db50f185775e248c18`. The interrupted B′ Full launcher log `bc-b-windows-full-final.log`, SHA256 `422f87010a6b687152b0f40d6b77e35aadc903e37b5205a713ec4e11a9a40e8a`, stops after dependency verification. The test stages never ran; no aggregate report or PASS is claimed. Its name does not imply acceptance. Any later invocation must use a new log path to preserve this attempt.

### Publication regression check

After reconciling B′'s shared-infrastructure ancestry into C′ with `--no-commit`, `pnpm check` again passed format, lint, boundaries, typecheck, the complete offline suite and build. `bc-c-pnpm-check-publication.log`, SHA256 `90b1987dee9898dab698014f94fdba3e89d6751b4e2a28eb8043e1a8b8a7cb19`:231 files passed/17 skipped;4,535 tests passed/169 skipped/0 failed,4708 total,212.39 s. The four known Bubblewrap pending cases account for the remaining total; the terse Vitest console does not separately print their count. This check ran with pending documentation/merge changes. Production and test files were byte-identical to clean Full-tested `1c584208`; it is supplemental repeated regression evidence, not another clean-source aggregate Full run. Only documentation was finalized afterwards.

## Final B′ validation and propagation

### Latest standalone B′ aggregate acceptance

After failure-retention/output-attribution corrections and four deterministic harness regressions, B′ completed **NEXAR_WINDOWS_FULL_PASS** at clean commit `06e55f36f66c27b24d524e699d06246094c4617a`, tree `20b53990fb585e99ab4ed94001c72f4275b33a38`. Both source identities were clean and identical; sourceStable=true. Raw B′ report `.nexar/ci/reports/report-2026-10-24T13-20-25-499Z.json`, SHA256 `1cb1fea82daf65dad360cc25ae1ca7aca6b707b25916cb45c544d9524325b16c`; console `bc-b-windows-full-06e55f3.log`. Duration3292.49seconds; all16 required stages passed in this one invocation. The additional Linux-only stage is BLOCKED/required:false.

| Gate                        | B′ actual result                                                    |
| --------------------------- | ------------------------------------------------------------------- |
| Offline Windows             | 4482 passed,167 skipped,4 pending,0 failed;4653 total               |
| Build/static/CLI gates      | PASS                                                                |
| Real DSH context            | 3/3 passed;24.71seconds                                             |
| Isolated Cowork Windows→WSL | 8/8 passed;58.00seconds                                             |
| Source Desktop              | 29/29 passed;575.15seconds;35 graceful owned-process exits,0 forced |
| Packaging                   | PASS;1339.50seconds within the unchanged25-minute envelope          |
| Packaged Desktop            | 29/29 passed;649.91seconds                                          |
| Gitleaks                    | PASS;1.98seconds                                                    |

Installer `release/desktop/Nexar-0.1.0-windows-x64-setup.exe`:322178248bytes, SHA256 `a492694d549c14cc36c29ce70f53b947990cb9e9fb8ce49bd95f3e1e124090f8`; unsigned; checksum matches, unpacked output exists and bundled DSH0.2.0-rc.2 matches. Packaged acceptance uses that build's win-unpacked output. Windows offline archive `bc-b-offline-06e55f3.json`, SHA256 `f40847d7a4985fe6db0db85e427729d664fb8f752355d9e92a937eb1f96cddd9`. The prior failed B′ archive `bc-b-offline-aa80379.json` remains separate.

The final pre-commit `pnpm check` also passed4482/167skipped/4pending/0failed,189.60seconds, followed by build. Log `bc-b-pnpm-check-sow-final-v2.log`, SHA256 `f7de970c0beec65a343a6e1f674b93f9039b05bb495fbb100c2342ce90b67dfe`. Earlier stopped/lint-failed check attempts remain documented in B′'s SOW investigation report.

Actual B′ suites differ from C′: runtime9 versus12; Plan9 versus10; Gateway31 versus34. Authority21, manager19, consent5, callback10, inventory guard3 and private-state19passed/2POSIXskipped match across those sources. B′ adds harness4; it does not contain C′'s43-dimension corpus or dedicated legacy-golden case. A separate reviewer independently parsed these distinctions. The new PASS does not establish the earlier SOW stall's delayed step, or the historical ACL/Plan causes.

The B′ diagnostic changes have been propagated into C′ with a normal uncommitted merge. Their final C′ source-bound validation remains to be recorded; the older C′PASS remains attached to its actual1c584208 source.

### Same-source B′ serial WSL full suite

At clean06e55f36/tree20b53990fb585e99ab4ed94001c72f4275b33a38, `/home/nexar/src/nxr070b-remediation-20261018` completed frozen offline install, TypeScript build and `pnpm exec vitest run --maxWorkers=1 --reporter=json --outputFile=.nexar/ci/bc-b-wsl-full-06e55f3.json`. **4623 passed,30 skipped,0 failed,0 pending;4653 total.** Raw SHA256 `2e35739026911804584b977a0627cea34bdb0b426f8a71f66d4602e6fb403a4d`; Windows console `bc-b-wsl-full-06e55f3-console.log`. Start/end source and clean-state assertions passed. Node22.23.3, pnpm10.33.0, Linux6.18.33.2-microsoft-standard-WSL2. All four Windows-pending Bubblewrap network/cleanup cases passed; all five live-provider files remained skipped.

B′ source-built and packaged helper SHA256 values match: bridge-relay `af54ee0430de0557264b47514a8eb863c944fca025e53c31120057be2bbf2e20`; control-gateway `26b415e24ee9ef3d42e6bd77a019af1a3422c1d600bd76d8fb1e4c86f8370207`; signin-callback `f81bdc330f077375867b70faf99777eb4cd727b643aeeeb45d895945e5f7f4ec`. Managed/packaged DSH lib/bin.js both hash `1a03dee18683483ff6a1b27b2a1e650230da6bcca9a0f55f7d81b3308c3f307f`. Each helper comparison uses its own branch's build output.

## Coverage limits

Packaged E2E launches win-unpacked with bundled DSH and disposable profiles. It does not demonstrate clean-computer NSIS installation. No owner profile, live credentials, real sign-in or paid inference is used.

WSL2 results are not native Ubuntu acceptance. Native Windows foreign-owner manipulation and every startup/crash/cleanup interleaving were not demonstrated. The ACL policy/guard timeout and sandbox permissions remain unchanged.

Even repeated passing runs do not identify the underlying historical ACL failure. The separate read-only source review is not owner acceptance.
