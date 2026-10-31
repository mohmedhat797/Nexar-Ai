# NXR-070B′ Final Owner Handover

**Date:** 2026-10-18

**Engineer:** OpenAI Codex

**Target:** Draft [PR #44](https://github.com/mohmedhat797/Nexar-Ai/pull/44)

**Implementation:** `96f8b6a16562e308cc0502d7fc577b563fcb4153`

**Current acceptance:** Windows Full Local CI PASS; hosted execution/owner acceptance outstanding

This report supersedes the original implementation handover's unsupported completeness, production integration and Full CI claims. The independent audit and original history remain unchanged.

## A. Executive summary

All six remediation work packages are implemented locally. Owner connections now reach the real Desktop composition, Registry, NRC and model execution. One connection authority serializes mutations and execution admission; actual Control/direct/delegated/native/refresh activity holds leases. Credential/settings changes use a guarded encrypted redo transaction. Plan identity is retained privately, and sequential replacement permanently retires the old identity. Minimum Desktop management and host-enforced confirmations are implemented.

Windows Full Local CI returned `NEXAR_WINDOWS_FULL_PASS` on clean source `96f8b6a16562e308cc0502d7fc577b563fcb4153`, tree `cbd4d26018133bc6426f9cc7cd979cd5b3feed7c`, with 16/16 required stages passing in 1749.94s. The optional native Linux stage was BLOCKED on Windows and is not counted as passed. Raw report: `.nexar/ci/reports/report-2026-10-18T02-57-15-465Z.json`; SHA-256 `3df3cf845036b3607a61b01717074390d9c5f7076b0c38a3042bbdb9d6451c24`. Start/end source identity was stable and clean.

Windows offline tests: **4,467 passed, 167 skipped, four pending, zero failed** (4,638 total; 245 files). Real DSH context: **3/3**; isolated Cowork Windows/WSL bridge acceptance: **8/8**; source Desktop: **27/27**; packaged Desktop: **27/27**. Skipped/pending cases are not counted as passes. The four pending Windows assertions are actual Linux Bubblewrap cases covered by the WSL run.

The separate WSL checkout at `9dc1909619e41c6b3632179934abe0d696ea665d`, tree `b9c3203e6292b26b4bd06c9216a03157839ad139`, passed **4,609 tests, 29 skipped, zero failed** (4,638 total). Its production and test source is identical to the Windows revision: the only intervening change is `.gitleaks.toml`. Raw WSL report: `/home/nexar/src/nxr070b-remediation-20261018/.nexar/ci/remediation-wsl-control-final-tests.json`, SHA-256 `a924579dc50241a6c5f52c4a667b3435b82ccfd1e6326478de226e7e5e723693`. The real kernel gate also passed 15/15 assertions.

The earlier Windows run at `9dc1909` retained a FAIL result because Gitleaks detected seven synthetic test fixtures. Their literal source values were inspected; exact path-and-value exceptions were added while retaining default rules and full-history scanning. The clean rerun above passed Gitleaks. Historical failed/incomplete runs remain evidence and are not relabelled PASS.

Hosted CI is separate: the pre-publication run at `b6ffde9` failed before steps due to account billing/spending restrictions. Final remote identity and post-push hosted status are recorded in the publication receipt and PR description. No live vendor login, real key or paid inference was used.

The original 13 findings retain their original severities. See [the findings closure matrix](NXR070B_Findings_Closure_Matrix.md) for each root cause, fix, regression and status. No merge is authorized by this report.

## B. Repository state

| Field                            | Value                                              |
| -------------------------------- | -------------------------------------------------- |
| Worktree                         | `D:/Nexar-Ai-main/.nexar/nxr070b`                  |
| Branch                           | `feat/nxr-070b-multi-api-connections`              |
| Main / merge base                | `41b918bf3c32cfd47301f7551a7280368fc3c8ec`         |
| Initial PR HEAD                  | `b6ffde924cd3c6546b9cddbe835c5285f6625c08`         |
| Initial implementation tree      | `7ede253dd585d5d85f539df8b1d366f1fb3b5d90`         |
| Final tested implementation SHA  | `96f8b6a16562e308cc0502d7fc577b563fcb4153`         |
| Final tested implementation tree | `cbd4d26018133bc6426f9cc7cd979cd5b3feed7c`         |
| Published PR HEAD                | See post-push receipt and PR description           |
| PR status                        | Draft; not merged                                  |
| Audit worktree                   | `D:/Nexar-Ai-main/.nexar/nxr070b-audit`, unchanged |

The implementation SHA identifies production code tested by platform acceptance. A later evidence-only commit may change documentation/tree identity without changing production source. The post-push publication receipt records the final remote SHA; a Git document cannot embed the SHA of its own containing commit.

## C. Findings closure

F01–F04 remain P1, F05–F12 remain P2, and F13 remains P3. No severity was reduced. All F01–F13 are CLOSED_WITH_EVIDENCE under the documented test scope. F13 is closed by the corrected source-bound reports, explicit failed-run history and stated platform/operational limits.

The [closure matrix](NXR070B_Findings_Closure_Matrix.md) is authoritative for individual status and links to executable regression sources. Original audit counterexamples are preserved separately; this report does not relabel their defect-observation assertions as compliant tests.

## D. Work packages

| Package | Delivered                                                                                                                                     |
| ------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| WP-1    | Single serialized authority, canonical writer lease, aggregate semantic validation, atomic collision checks and legal lifecycle               |
| WP-2    | Existing KeyStore batch, encrypted reference-only redo journal, state digests, restart reconciliation, backup/rename/acknowledgement failures |
| WP-3    | Real Control decision, direct adapter, delegated unit, native probe/login and inventory refresh leases                                        |
| WP-4    | Explicit API assertion, honest assurance, private retained Plan binding, sequential recoverable replacement and permanent retirement          |
| WP-5    | Actual persisted owner discovery/publication, accepted canonical IDs, normal NRC filtering/selection and connection-bound credentials         |
| WP-6    | Existing Providers UI extended with minimum management, cancellation and host-bound confirmations; documentation corrected                    |

## E. Runtime integration

The actual path is Providers/preload → validated main-process IPC → ConnectionManager/SettingsStore/KeyStore → ConnectionRuntime → canonical catalog materialization → EngineHost/Registry → NRC → execution admission → validated connection scope → Pi model transport → normal accounting/result and cleanup.

`connection-runtime.test.ts` demonstrates two bridge-created same-provider/same-model accounts observing their own synthetic keys at transport, plus restart, Disable, Rotate, Forget, re-entry, Remove, Restore and stable identity. Other cases exercise actual direct Desktop execution and IntelligenceBridge delegation. The normal publication test never hand-injects owner resource descriptors.

See [runtime integration verification](NXR070B_Runtime_Integration_Verification.md).

## F. Credential and identity security

Unknown identity stays unknown. API rotation requires explicit same-account assertion and records non-secret provenance. Plan subject verification/comparison and decoded binding validation remain inside the trusted Plan module. The renderer receives neither subject nor private credential scope.

Forget retains account binding; ordinary Remove is reversible only as the same account. Same-account credential re-entry does not activate a tombstone. Replace rejects active work/sign-in/refresh, deletes old tokens and binding transactionally, permanently retires the old ID and creates one new opaque Plan identity for future explicit sign-in. It provides no concurrent multi-Plan capability.

No real provider credential, login or paid model request was used. Fake IdP signature verification is not a claim of live OpenAI account acceptance.

## G. Persistence and recovery

Complete mutations share one queue with admission. Guarded credential changes and an encrypted metadata-only redo journal commit in the same existing KeyStore file. Settings then commit with required valid-primary backup; journal cleanup precedes normal publication. The journal's base/target digests prevent replay against unexpected authority.

Fault tests cover preparation/encryption, split commit, lost acknowledgement, settings temp/rename, backup, deletion and replay/restart failure. Recovery either proves a coherent state or blocks admission. Corrupt primary bytes are preserved; backup existence does not imply automatic restoration.

Optional assertion/retirement fields preserve valid historical settings under hardened readers. Unrelated appearance writes and restart retain the new fields. Canonical session and Project Memory implementations/schemas were not changed.

Rollback must retain the hardened authority and current credential/settings state. Pre-remediation binaries must not open an upgraded writable profile; arbitrary old-binary downgrade and universal power-loss durability are not claimed.

See [security and persistence acceptance](NXR070B_Security_and_Persistence_Acceptance.md).

## H. Tests

Acceptance exposed outdated Desktop fixtures (global absence of password inputs, unconfirmed removal and the retired raw deletion channel). They now verify clipboard-only legacy cards, a separate masked empty key form, and an exact host-issued confirmation ticket. The corrected orchestration and Providers scenarios were executed. A separate Providers second-turn failure was captured as `INTEGRATION_UNAVAILABLE` after 102 ms and reproduced by deterministic availability tests; live NRC eligibility is now separated from runtime discovery caching. See the runtime report for red/green evidence.

Environment: Windows x64 build `10.0.26300`, Node `22.23.3`, pnpm `10.33.0`, DSH `0.2.0-rc.2`, Gitleaks `8.28.0`.

| Executed validation                                                  | Passed | Failed | Skipped | Pending | Evidence                                                                                                                   |
| -------------------------------------------------------------------- | ------ | ------ | ------- | ------- | -------------------------------------------------------------------------------------------------------------------------- |
| `pnpm check` before scan-config commit                               | 4,456  | 0      | 178     | 4       | `.nexar/ci/remediation-check-scan-config.log`; 179.68s test phase; format/lint/boundaries/typecheck/test/build all exit 0  |
| Full CI offline suite, with real DSH entry                           | 4,467  | 0      | 167     | 4       | `.nexar/ci/test-offline.json`, SHA-256 `c7cef149b028839a36303286e39c77240476f956d6721fab3dcf9c036b14921c`; 202.817s stage  |
| Real DSH offline context/compaction                                  | 3      | 0      | 0       | 0       | Final Full CI stage `dsh-context-real`                                                                                     |
| Real isolated Cowork bridge/transport                                | 8      | 0      | 0       | 0       | Final Full CI stage `cowork-isolation-wsl`                                                                                 |
| Source Desktop E2E                                                   | 27     | 0      | 0       | 0       | 10 files; final Full CI source stage                                                                                       |
| Packaged Desktop E2E                                                 | 27     | 0      | 0       | 0       | 10 files; final Full CI packaged stage                                                                                     |
| WSL complete suite, one worker                                       | 4,609  | 0      | 29      | 0       | Linux `remediation-wsl-control-final-tests.json`; 312.908s                                                                 |
| WSL real kernel subset                                               | 15     | 0      | 0       | 0       | Linux `.nexar/ci/cowork-kernel.json`, SHA-256 `b22349ad965f26bc14a6c83b1e9ad9a85979466b5c6a9b2762d39c0e0932b67d`           |
| Eight principal remediation unit files, included in full offline run | 76     | 0      | 0       | 0       | authority 21; manager 19; runtime 9; Plan binding 9; consent 5; settings recovery 6; inventory guard 3; multi-connection 4 |

Gate counts overlap; they are not a sum of unique assertions.

The accepted Full Local CI invocation was:

```powershell
$env:PATH='D:/Nexar-Ai-nxr070/.nexar/research-toolchain/node-v22.23.3-win-x64;'+$env:PATH
$env:npm_config_prefer_offline='true'
$env:NEXAR_SEC02_WSL_REPO='/home/nexar/src/nxr070b-remediation-20261018'
pnpm ci:local:full --node-bin=D:/Nexar-Ai-nxr070/.nexar/research-toolchain/node-v22.23.3-win-x64/node.exe --gitleaks-bin=D:/Nexar-Ai-main/.nexar/gitleaks-8.28.0/gitleaks.exe --dsh-dir=D:/Nexar-Ai-main/.nexar/nxr070b/.nexar/dsh-runtime --workers=4
```

The WSL checkout used Node 22.23.3/pnpm 10.33.0 and the existing `/opt/dsh` rc.2 runtime. After frozen offline dependency preparation, `pnpm exec tsc -b` preceded:

```sh
pnpm exec vitest run --maxWorkers=1 --reporter=json --outputFile=.nexar/ci/remediation-wsl-control-final-tests.json
```

The final CI JSON records every expanded stage command, duration, exit code and raw log path. Required engineering commands are `pnpm format:check`, `pnpm lint`, `pnpm check:boundaries`, `pnpm typecheck`, `pnpm test`, `pnpm build`, and the composite `pnpm check`; each was executed, not inferred from compilation.

The earlier Full CI at `664c812` ended FAIL at source Desktop E2E (25 passed, two failed), with packaging, packaged E2E and Gitleaks unexecuted. Its raw report is `.nexar/ci/reports/report-2026-10-17T22-11-55-416Z.json`. The outdated password/removal fixtures and the separately captured readiness defect were corrected before the final clean acceptance run. The final evidence-preparation `pnpm check` also passed; its log is `.nexar/ci/remediation-check-publication.log`.

Raw logs and JSON are retained in `.nexar/ci`. Reports distinguish passed, skipped and pending assertions. The first fresh WSL run failed because the checkout had no built `dist` outputs; after `pnpm exec tsc -b`, the suite passed. An earlier Full CI was deliberately stopped after 12 passing gates for the private-binding boundary change; it is not represented as full acceptance.

Meaningful corrected tests replace defect-preserving observations, without deleting the immutable audit evidence or weakening existing assertions to accept defects.

## I. Windows / WSL acceptance

| Gate                                                                         | Result                               | Evidence / limit                                                  |
| ---------------------------------------------------------------------------- | ------------------------------------ | ----------------------------------------------------------------- |
| Frozen lockfile dependency verification                                      | PASS (required)                      | 1.045s; `.nexar/ci/logs/1792292236158-dependencies.log`           |
| Pinned DSH runtime install & verification                                    | PASS (required)                      | 98.658s; `.nexar/ci/logs/1792292237205-dsh-install.log`           |
| Prettier formatting check                                                    | PASS (required)                      | 13.888s; `.nexar/ci/logs/1792292335864-format-check.log`          |
| ESLint static analysis                                                       | PASS (required)                      | 34.272s; `.nexar/ci/logs/1792292349752-lint.log`                  |
| Package boundaries and secret guard                                          | PASS (required)                      | 0.529s; `.nexar/ci/logs/1792292384025-boundaries.log`             |
| TypeScript typecheck (project references)                                    | PASS (required)                      | 16.231s; `.nexar/ci/logs/1792292384555-typecheck.log`             |
| Offline unit & integration test suite (with DSH entry)                       | PASS (required)                      | 202.817s; `.nexar/ci/logs/1792292400786-test-offline.log`         |
| Production build (CLI and Desktop)                                           | PASS (required)                      | 4.247s; `.nexar/ci/logs/1792292603619-build.log`                  |
| CLI smoke: resources listing                                                 | PASS (required)                      | 0.635s; `.nexar/ci/logs/1792292607867-cli-smoke-resources.log`    |
| CLI smoke: offline general run                                               | PASS (required)                      | 0.598s; `.nexar/ci/logs/1792292608503-cli-smoke-run.log`          |
| Real DSH offline context & compaction acceptance                             | PASS (required)                      | 17.091s; `.nexar/ci/logs/1792292609102-dsh-context-real.log`      |
| Real isolated Cowork transport, cancellation, sessions and protected context | PASS (required)                      | 38.811s; `.nexar/ci/logs/1792292626194-cowork-isolation-wsl.log`  |
| Desktop E2E (source build with NEXAR_DSH_ENTRY)                              | PASS (required)                      | 324.424s; `.nexar/ci/logs/1792292665006-desktop-e2e-source.log`   |
| Package Windows desktop installer (with bundled DSH runtime)                 | PASS (required)                      | 670.321s; `.nexar/ci/logs/1792292989435-desktop-package-win.log`  |
| Packaged Desktop E2E (bundled DSH runtime only, no external entry)           | PASS (required)                      | 322.435s; `.nexar/ci/logs/1792293659757-desktop-e2e-packaged.log` |
| Linux bubblewrap Engineering sandbox validation                              | BLOCKED (optional)                   | 0.000s; `.nexar/ci/logs/1792293983888-linux-sandbox.log`          |
| Gitleaks full-history security scan (pinned 8.28.0, redacted)                | PASS (required)                      | 1.519s; `.nexar/ci/logs/1792293983889-gitleaks-scan.log`          |
| WSL complete regressions                                                     | PASS                                 | 4,609 passed / 29 skipped; separate matching production source    |
| Native Ubuntu Full CI                                                        | NOT RUN                              | Windows-first scope; WSL is not native Ubuntu                     |
| Live provider login/inference                                                | NOT RUN                              | Explicit authorization boundary                                   |
| Hosted GitHub CI                                                             | Pre-publication infrastructure block | Billing/spending annotation; final run checked after push         |

Installer: `release/desktop/Nexar-0.1.0-windows-x64-setup.exe`, 322,177,701 bytes, SHA-256 `cfe39e97c5a880fa3d5c837f5f4de19f2104049ed0f3945c1878467e62561fbc`. The CI report verifies the actual checksum, freshness, unpacked executable and bundled DSH rc.2. Authenticode status is **NotSigned**; this is an unsigned local acceptance artifact.

Packaged E2E exercised `release/desktop/win-unpacked/Nexar.exe` produced by that same packaging run. It did not install/uninstall the NSIS executable on the owner's profile or prove fresh-machine WSL provisioning. The existing prepared WSL distro/helper was used.

Additional read-only artifact identity verification:

| Artifact                                 | SHA-256                                                            | Verification                                              |
| ---------------------------------------- | ------------------------------------------------------------------ | --------------------------------------------------------- |
| Packaged `resources/app.asar`            | `5651120a79a941b24466f9e0fa0050550249d5a952f0ea6b2ca479683040514b` | Actual package bytes                                      |
| Bundled DSH `lib/bin.js`                 | `1a03dee18683483ff6a1b27b2a1e650230da6bcca9a0f55f7d81b3308c3f307f` | Runtime manifest: @deepseek-ai/dsh 0.2.0-rc.2             |
| Packaged `dist/main/bridge-relay.cjs`    | `af54ee0430de0557264b47514a8eb863c944fca025e53c31120057be2bbf2e20` | Extracted from ASAR; byte-identical to tested build: true |
| Packaged `dist/main/control-gateway.cjs` | `26b415e24ee9ef3d42e6bd77a019af1a3422c1d600bd76d8fb1e4c86f8370207` | Extracted from ASAR; byte-identical to tested build: true |
| Packaged `dist/main/signin-callback.cjs` | `46a41907dd9a549abee0cfca481ccfe52876355dcaa022b5b0be223a7806305b` | Extracted from ASAR; byte-identical to tested build: true |

Windows acceptance uses disposable Desktop profiles, synthetic keys and fixture services. Packaged acceptance uses the packaged executable and its bundled DSH, with external DSH-entry overrides removed by the supported harness. Installer identity and helper/runtime association are recorded by the package verification stage. Installing/uninstalling on the owner's real profile is not claimed.

WSL runs use a separate checkout pinned to the tested revision, not the historical `/home/nexar/src/Nexar-Ai` checkout. No mount policy, security identity or sandbox permission was changed. Native Ubuntu Full CI is not substituted by WSL testing.

## J. GitHub

The evidence revision was prepared locally for the explicitly authorized fast-forward push to the existing `feat/nxr-070b-multi-api-connections` branch. Publication must be verified independently of this document's containing commit. The post-push local receipt is `.nexar/ci/NXR070B_Published_Owner_Handover.md`; the current [PR #44 description](https://github.com/mohmedhat797/Nexar-Ai/pull/44) records the final remote SHA and report permalinks.

At the last pre-publication check, PR #44 was open, Draft, unmerged and mergeable, with remote HEAD `b6ffde924cd3c6546b9cddbe835c5285f6625c08` and main/base `41b918bf3c32cfd47301f7551a7280368fc3c8ec`. Hosted run [39042775795](https://github.com/mohmedhat797/Nexar-Ai/actions/runs/39042775795) had no executed steps in its Windows, Ubuntu or secret-scan jobs; GitHub's annotation explicitly reported failed account payments or a spending limit. It is not code-test evidence.

The correction commits remain on the existing PR branch. No force-push, main push, merge, ADR-status change or Ready-for-Review transition is authorized or performed. Hosted jobs are evaluated separately from executed local tests; an infrastructure-blocked run is neither a code failure nor a pass.

## K. Remaining risks

- **WSL test timing observation:** a four-worker run at `664c812` had two unchanged five-second test timeouts (consent and existing concurrent KeyStore writes). Both suites passed in isolation, then the full suite passed with one worker. The root cause is not established; no timeout or assertion was relaxed. Preserve the failed and successful reports rather than labelling this observation fixed.

- Live vendor authentication, actual key validity, paid inference, account quota and external revocation remain untested by authorization.
- Pre-remediation binary downgrade on an upgraded writable profile is unsupported; preserve hardened authority and current state.
- Corrupt authority requiring unprovable manual reconciliation remains unavailable, intentionally.
- Historical Gateway child exit and earlier Providers timeout observations are not universally explained. The newly captured stale-readiness failure is corrected separately; diagnostic coverage remains.
- Pinned upstream dependency debt remains tracked; no vulnerability-free claim or dependency upgrade is made.
- Later native-home/account management, review diversity, routing changes and upstream update execution remain outside B′.

The next owner action is independent acceptance of the Draft PR and its raw evidence. This handover does not start C′ or authorize a merge.

## L. Final verdicts

- Remediation: `NXR070B_REMEDIATION_ALL_FINDINGS_CLOSED`
- Runtime integration: `NXR070B_RUNTIME_INTEGRATION_VERIFIED`
- Credential security: `NXR070B_CREDENTIAL_ISOLATION_VERIFIED`
- Persistence: `NXR070B_PERSISTENCE_AND_RECOVERY_VERIFIED`
- Windows platform: `NXR070B_WINDOWS_PLATFORM_ACCEPTANCE_PASSED`
- PR publication: verify the post-push receipt and current PR description; a local evidence commit is not proof of publication.
- Overall at evidence preparation: `NXR070B_REMEDIATION_IMPLEMENTED_WITH_OUTSTANDING_GATES`

These verdicts are bounded by the synthetic/fixture, persistence-fault and real Windows/WSL evidence above. Hosted execution and independent owner acceptance remain outstanding. They do not authorize merging.
