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

**PENDING_SOURCE_BINDING:** B′ correction commit, C′ propagation, complete final-source Windows Full CI, packaged E2E, Gitleaks and supplemental serial WSL suite have not yet been recorded here. This section must be updated with actual report identities before publication.

## Coverage limits

Packaged E2E launches win-unpacked with bundled DSH and disposable profiles. It does not demonstrate clean-computer NSIS installation. No owner profile, live credentials, real sign-in or paid inference is used.

WSL2 results are not native Ubuntu acceptance. Native Windows foreign-owner manipulation and every startup/crash/cleanup interleaving were not demonstrated. The ACL policy/guard timeout and sandbox permissions remain unchanged.

Even repeated passing runs do not identify the underlying historical ACL failure. The separate read-only source review is not owner acceptance.
