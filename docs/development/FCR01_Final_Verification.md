# FCR-01 — Final Verification

**Reviewed implementation:** `723ae706f38d8de65e639b6401ee5fab69705b07`.
**Git tree:** `6a5759f8cb1a1aa2ae8a71d65d82120f476e4951`.
**Date:** 2026-10-11 Africa/Cairo (run timestamps use UTC).
**Overall:** `NEXAR_FCR01_BLOCKED_BY_EXTERNAL_DEPENDENCY`.

## Evidence binding

Windows Full CI ran on the clean implementation commit above; its start/end commit, clean state and sourceStable flag match. The subsequent final commit contains documentation/evidence only. A post-documentation pnpm check and final-history secret scan are recorded before push; no implementation changed after the Full CI/package run. The owner's final PR head is the documentation commit; the installer is explicitly built from the implementation revision.

WSL2's isolated checkout retained intake Git HEAD `5430a5d` with dirty fingerprint `0a2d11b2d05b67ecea4555defbd0b45e5e59f5c804df39630c9e36e37fc92020`. Its written Git tree `6a5759f8cb1a1aa2ae8a71d65d82120f476e4951` exactly matches the corrective commit. It is content-matched WSL2 validation, not a native Ubuntu clean-commit Full CI certificate.

## Toolchain and platforms

| Item             | Windows                                         | WSL2                                                          |
| ---------------- | ----------------------------------------------- | ------------------------------------------------------------- |
| OS               | win32 x64, 10.0.26300                           | Ubuntu 24.04.5, WSL2 kernel 6.18.33.2-microsoft-standard-WSL2 |
| Node             | 22.23.3                                         | 22.23.3, /opt/node/bin/node                                   |
| pnpm             | 10.33.0                                         | 10.33.0                                                       |
| DSH              | @deepseek-ai/dsh@0.2.0-rc.2, exact runtime lock | Same pin and lock                                             |
| Sandbox tools    | Linux stage BLOCKED/optional on Windows         | bubblewrap 0.11.1, socat 1.8.1.1                              |
| Secret scanner   | Gitleaks 8.28.0                                 | No native Linux Gitleaks binary available                     |
| Headless desktop | Source and packaged Electron E2E                | Xvfb/native Ubuntu Full CI unavailable                        |

Node 24.15.0 is the system default but was not used as the CI/developer test runner. The packaged Electron 44.5.1 executable reports embedded Node **24.21.0** in ELECTRON_RUN_AS_NODE mode. That pinned Electron/DSH child path is exercised by source/packaged E2E; it is distinct from running Vitest/CI under a system Node 24 binary. Host acceptance Node 22 is enforced (manifest >=22.19, major 22); unsupported Node cannot use a Full waiver to establish acceptance. Historical 0xC0000409 under Node 24 is a documented unsupported-runtime observation, not a proven Electron root cause. The system Node 24 worker limitation does not certify or reject every embedded Node 24 version; the pinned Electron path has its own bounded E2E evidence. No such native crash occurred in these Node 22 acceptance runs.

## Final results

**Final clean-code Windows Full CI:** `NEXAR_WINDOWS_FULL_PASS`, **1,505.37 seconds**. Start/end commit `723ae706f38d8de65e639b6401ee5fab69705b07`, both clean, sourceStable=true. All required Windows stages passed.

| Final Windows stage                                                | Status          | Seconds |
| ------------------------------------------------------------------ | --------------- | ------: |
| Frozen lockfile dependency verification                            | PASS (required) |    1.79 |
| Pinned DSH runtime install & verification                          | PASS (required) |   67.87 |
| Prettier formatting check                                          | PASS (required) |   26.42 |
| ESLint static analysis                                             | PASS (required) |   49.36 |
| Package boundaries and secret guard                                | PASS (required) |    0.52 |
| TypeScript typecheck (project references)                          | PASS (required) |   16.93 |
| Offline unit & integration test suite (with DSH entry)             | PASS (required) |  220.10 |
| Production build (CLI and Desktop)                                 | PASS (required) |    3.06 |
| CLI smoke: resources listing                                       | PASS (required) |    0.87 |
| CLI smoke: offline general run                                     | PASS (required) |    1.12 |
| Real DSH offline context & compaction acceptance                   | PASS (required) |   19.90 |
| Desktop E2E (source build with NEXAR_DSH_ENTRY)                    | PASS (required) |  232.55 |
| Package Windows desktop installer (with bundled DSH runtime)       | PASS (required) |  672.91 |
| Packaged Desktop E2E (bundled DSH runtime only, no external entry) | PASS (required) |  187.31 |
| Linux bubblewrap Engineering sandbox validation                    | BLOCKED         |    0.00 |
| Gitleaks full-history security scan (pinned 8.28.0, redacted)      | PASS (required) |    1.73 |

**Final Quick CI:** `LOCAL_CI_QUICK_PASS`, five executed stages PASS, preflight PASS, **211.76 seconds**; start/end clean commit `723ae706f38d8de65e639b6401ee5fab69705b07`, sourceStable=true. Its collected identities overlap Full; Quick has 11 additional runtime-opt-in skips (4,274 passed, 173 skipped, four pending). Full exercises those real-runtime cases. These runs are not added to a unique-test total.

Command: `node scripts/local-ci/runner.mjs --mode=quick --workers=4 --gitleaks-bin=<verified-gitleaks-8.28.0.exe>`.

The Windows manifest has 16 entries: **15 PASS and one BLOCKED Linux-only stage**, with all mandatory Windows stages PASS. BLOCKED is not counted as execution success.

| Suite/run                                   | Collected | Passed | Failed | Skipped | Pending | Todo | Interpretation                                                    |
| ------------------------------------------- | --------: | -----: | -----: | ------: | ------: | ---: | ----------------------------------------------------------------- |
| Final Windows full offline unit/integration |     4,451 |  4,285 |      0 |     162 |       4 |    0 | 229 files; raw assertions reconcile                               |
| Final Windows Quick unit/integration        |     4,451 |  4,274 |      0 |     173 |       4 |    0 | Same collected identities; runtime opt-ins omitted                |
| Final WSL2 full offline unit/integration    |     4,451 |  4,429 |      0 |      22 |       0 |    0 | 229 files; actual sandboxed ACP opt-in enabled                    |
| CI orchestrator focused                     |        32 |     32 |      0 |       0 |       0 |    0 | Also included in full unit suites                                 |
| Real context/compaction focused             |         3 |      3 |      0 |       0 |       0 |    0 | Also included in full unit suites                                 |
| Source Desktop E2E                          |        22 |     22 |      0 |       0 |       0 |    0 | Actual Electron with pinned external entry                        |
| Packaged Desktop E2E                        |        22 |     22 |      0 |       0 |       0 |    0 | Actual fresh unpacked packaged app, bundled DSH only              |
| Real WSL2 DSH handshake focused             |         1 |      1 |      0 |       0 |       0 |    0 | Also included in final Linux unit run                             |
| Additional real sandboxed Coding prompt     |         — |      — |      — |       — |       — |    — | One scripted integration experiment; three fixture model requests |

Collected totals include skipped/pending/todo identities. Actual executed assertions are passed + failed: **4,285 on Windows and 4,429 on WSL2**. These are per-run outcomes; focused suites and platform runs overlap; source/packaged E2E repeat identities. No unique-test sum is claimed. Windows assertion JSON explicitly records these four pending identities (console summary omits them):

1. SandboxLauncher (real bubblewrap) proxy mode tunnels an allowlisted host to the upstream and denies others.
2. SandboxLauncher (real bubblewrap) proxy mode removes the run directory after dispose.
3. SandboxLauncher (real bubblewrap) Nexar services reaches the gateway and bridge sockets in network mode none.
4. SandboxLauncher (real bubblewrap) Nexar services reaches the gateway and bridge sockets in network mode proxy.

Linux executes those cases. Remaining platform/live-inference skips are not PASS.

## Commands

Commands ran from the isolated source checkout, with Node 22 selected in PATH. Full raw reports retain the absolute active executable paths; the portable spellings below identify commands without personal machine paths.

| Check                        | Command                                                                                                                                                                                                                                                                      | Scope/result                                                                                                                                                                              |
| ---------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Repository check             | `pnpm check`                                                                                                                                                                                                                                                                 | Includes format, ESLint, boundaries, typecheck, full offline tests and production build.                                                                                                  |
| Full Windows CI              | `node scripts/local-ci/runner.mjs --mode=full --workers=4 --gitleaks-bin=<verified-gitleaks-8.28.0.exe>`                                                                                                                                                                     | Run with the Node 22.23.3 bin directory prepended to PATH and normal Windows TEMP/TMP; NEXAR_LIVE_TESTS removed.                                                                          |
| CI focused regressions       | `pnpm exec vitest run tests/local-ci.test.ts tests/local-ci-security.test.ts`                                                                                                                                                                                                | 32 passed; repeated within Full unit tests.                                                                                                                                               |
| Cowork focused regressions   | `pnpm exec vitest run apps/desktop/src/main/dsh-cowork.test.ts apps/desktop/src/main/dsh-cowork-path.test.ts integrations/deepseek-harness/src/cowork-policy.test.ts integrations/deepseek-harness/src/acp/local.test.ts integrations/deepseek-harness/src/profiles.test.ts` | 135 passed on the corrective snapshot; final Full unit run includes them.                                                                                                                 |
| Real host-local DSH          | `pnpm exec vitest run integrations/deepseek-harness/src/acp/local.real.test.ts apps/desktop/src/main/dsh-cowork.real.test.ts`                                                                                                                                                | Actual pinned runtime, deterministic local model; 8 passed on the corrective snapshot, included in final unit run.                                                                        |
| Real context/compaction      | `pnpm exec vitest run apps/desktop/src/main/dsh-cowork.context.real.test.ts`                                                                                                                                                                                                 | Actual model-facing protected system block and real automatic compaction; mandatory Full stage.                                                                                           |
| Session correction           | `pnpm exec vitest run packages/sessions/src/store-concurrent-read.test.ts packages/sessions/src/store.test.ts apps/desktop/src/main/project-memory.test.ts --maxWorkers=3`                                                                                                   | Windows 44 passed, one skipped; WSL2 45 passed. Baseline new get/list regressions both failed.                                                                                            |
| WSL2 final unit/integration  | `pnpm exec vitest run --maxWorkers=1 --reporter=default --reporter=json --outputFile=.nexar/fcr01-linux-lease-retry-final.json`                                                                                                                                              | NEXAR_DSH_ENTRY, NEXAR_DSH_BIN and NEXAR_DSH_TOOLCHAIN point to the installed pinned runtime and /opt/node; NEXAR_LIVE_TESTS unset.                                                       |
| Lease correction             | `pnpm exec vitest run packages/sessions/src --maxWorkers=2`                                                                                                                                                                                                                  | Windows 108 passed / one skipped; WSL2 109 passed. Three new baseline races failed; unreadable lease denial preserves state.                                                              |
| Actual DSH sandbox handshake | `pnpm exec vitest run integrations/deepseek-harness/src/acp/real.test.ts --maxWorkers=1`                                                                                                                                                                                     | One passed with real SandboxLauncher; also enabled in final WSL2 suite.                                                                                                                   |
| Actual DSH Coding prompt     | `node .nexar/fcr01-real-coding.mjs`                                                                                                                                                                                                                                          | Additional synthetic launcher/runtime/model fixture; source reproduced in this verification record.                                                                                       |
| CLI smoke                    | `node apps/cli/dist/main.js resources; node apps/cli/dist/main.js run --kind general "ci smoke"`                                                                                                                                                                             | Selected local-echo; cost 0. No paid inference.                                                                                                                                           |
| Production dependencies      | `pnpm audit --prod --json`                                                                                                                                                                                                                                                   | 0 advisories / 224 dependencies; separate pinned DSH npm audit reports upstream advisory debt.                                                                                            |
| DSH dependencies             | `npm audit --omit=dev --json (cwd dist/dsh-runtime)`                                                                                                                                                                                                                         | 12 affected dependency entries derived from two underlying advisories; not claimed clean.                                                                                                 |
| Packaged source provenance   | `node .nexar/fcr01-inspect-packaged-source.mjs`                                                                                                                                                                                                                              | ASAR main, sessions store and DSH profiles byte-match the compiled outputs; corrective markers and hashes verified. Reproducible source in evidence/fcr01-packaged-provenance-fixture.md. |
| Embedded Node probe          | `$env:ELECTRON_RUN_AS_NODE='1'; release/desktop/win-unpacked/Nexar.exe --version`                                                                                                                                                                                            | v24.21.0; node-only mode, no owner application state opened.                                                                                                                              |
| Secret positive control      | `gitleaks dir . --config=<repository .gitleaks.toml> --redact --report-format=json --report-path=<fixture-report.json>`                                                                                                                                                      | Synthetic GitHub token detected even at tests/local-ci.test.ts; exact synthetic generic-key allowlists do not suppress an unrelated token.                                                |

The final WSL2 quality sequence was pnpm format:check, lint, check:boundaries, typecheck, full Vitest with JSON reporter, pnpm build, then compiled CLI resources and offline general run. The first CLI attempt used nonexistent pnpm cli and exited 254; invoking apps/cli/dist/main.js correctly passed and selected local-echo with cost 0. This command error is not hidden or classified as a production defect.

The real Coding script uses production prepareAcpLaunch, SandboxLauncher and actual pinned DSH. It authenticates a local deterministic model fixture, writes a synthetic workspace file, then Bash invokes Node fs against a generated outside host path: ENOENT inside the sandbox, host file unchanged. Required context is present in all three model-facing requests; no token is in prepared argv. Normal Coding standing workspace writes require no extra ACP request in that sandbox. Its early fixture assertion incorrectly expected a permission request, then the Bash negative fixture omitted a required description argument; these fixture mistakes were corrected before the successful OS test. They are not claimed production defects. The complete script is preserved in [the reproducible fixture](evidence/fcr01-real-coding-fixture.md).

## Installer provenance

- Local artifact: `release/desktop/Nexar-0.1.0-windows-x64-setup.exe`.
- Built from clean source `723ae706f38d8de65e639b6401ee5fab69705b07` during the final packaging stage.
- Size: **322,009,732 bytes**.
- SHA-256: `c161d853d886ecbf9e63a15de86c02a91ace68484d05ac9faa2c606bec2b35fc` (computed byte match verified).
- Fresh installer/unpacked executable: verified; bundled DSH `0.2.0-rc.2` verified.
- Authenticode: **NotSigned**.
- ASAR desktop main and compiled session/profile dependencies byte-match the built outputs, including the new writer-lease guards. Per-file hashes and the complete probe are preserved in [the evidence record](evidence/fcr01-final-evidence.json) and [reproducible provenance probe](evidence/fcr01-packaged-provenance-fixture.md).

The historical installer hash `9571845014f0b101b26560d65613a33fbf4f7d90875ceeed28ea891908ef1517` is not used for current acceptance. The new installer/unpacked executable freshness and computed SHA are checked, bundled DSH version is verified and packaged E2E uses only that bundle. Authenticode NotSigned means this is an unsigned development artifact; no publisher authenticity or public-release certification is asserted.

## Failed and historical evidence retained

The first clean Windows Full CI at `c4df4c8ef7aa964b05720e21ece2e5cecc5f20a4` failed one Project Memory test after six gates passed; remaining gates were skipped. Session read/mutation serialization was then corrected, both baseline regressions failed as expected, focused tests passed and complete pnpm check passed before commit `479501e` and a successful clean Full Windows run (4,448 assertions; 15 PASS, one BLOCKED). The later lease audit reproduced both empty-lease and stale-takeover dual-writer races; all three new regressions failed before correction. Commit `723ae706` adds the exclusive acquisition claim and unreadable-lease denial. The final Full run below certifies that newer implementation. No failed/interrupted run was reported as acceptance.

The first final-source WSL2 unit run (two workers while Windows validation was active) had one five-second timeout in Project Memory concurrent adds: 4,428 passed, one failed, 22 skipped. The unchanged focused memory/lease suites then passed 29 tests. The complete unit suite was rerun with one worker and the same five-second Linux timeout; final outcomes are recorded below. Host resource contention is a probable explanation, not a proven root cause. No assertion, production code or timeout was weakened.

An earlier Linux full run failed one obsolete lifecycle assertion, corrected in `ebf33c7`. Normal Windows TEMP is required for ACL/non-repository fixtures; using an in-repository temporary base produced fixture failures and was abandoned without changing security assertions.

The historical Windows report at report-2026-10-10T16-16-54-591Z.json records a3fd0250142a18c3ad2f5478faae4b37e861f216 with dirty fingerprint 27b1c2252e306426, duration 1,775.18s, 15 PASS stages and one BLOCKED Linux-only stage. The later documentation's ed2ded5 source label and 16/16-executed claim do not match that raw report. Its old unit-statistics parser returned zero counts, so manually reported 4,417 collected / 4,244 passed / 169 skipped remains unreconciled by four historical outcomes; no archived raw assertion report for that exact run was found in the inspected CI report directory. Current raw Vitest assertions demonstrate four nested pending bubblewrap cases omitted by the console summary. Those current identities are not retroactively asserted to be the original four.

Focused orchestrator tests and real-context tests also run within the full unit suite. Source and packaged E2E repeat the same identities under different application builds, and platform runs repeat common tests. Per-suite counts are execution attempts, not a computed unique-test population. The old 4,498 'distinct tests' total is withdrawn. Historical installer SHA256 9571845014f0b101b26560d65613a33fbf4f7d90875ceeed28ea891908ef1517 and unsigned status are retained as historical packaging evidence, not proof of this corrected implementation. No old PASS can certify changes made after it.

## Native Ubuntu and hosted CI blocker

`LINUX_WSL2_VALIDATION_PASS` covers the available Linux checks above. `NATIVE_UBUNTU_FULL_CI_PASS` is **not established**: WSL2 is not native Ubuntu, and no authorized isolated native Ubuntu executor with Xvfb and Linux secret scanning was available. The self-hosted workflow is configured but was not executed; no persistent personal runner was registered.

GitHub run [38090301669](https://github.com/mohmedhat797/Nexar-Ai/actions/runs/38090301669) did not start Ubuntu, Windows or secret-scan jobs. The exact annotation was: “The job was not started because recent account payments have failed or your spending limit needs to be increased.” The owner directed: “Finish and report the CI blocker.” No billing changes, purchases or repeated hosted retries were made. Local Windows PASS does not remove the native Ubuntu/exact-source cross-platform requirement.

## Independent verdicts

| Area           | Verdict                                      | Basis                                                                                                                     |
| -------------- | -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| Security       | `SECURITY_REVIEW_BLOCKED`                    | Cowork OS read isolation/release policy needs owner authority; no P0 identified.                                          |
| Runtime        | `DSH_RUNTIME_VERIFIED`                       | Pinned runtime verified with deterministic offline fixtures; provider certification is excluded.                          |
| Windows        | `WINDOWS_FINAL_ACCEPTANCE_PASS`              | Clean code commit 723ae706: 15 Windows stages PASS, Linux-only BLOCKED; fresh source/packaged E2E and installer verified. |
| Linux          | `LINUX_ACCEPTANCE_PARTIAL`                   | WSL2 available gates pass; native Ubuntu Full CI not executed.                                                            |
| Cross-platform | `CROSS_PLATFORM_ACCEPTANCE_INCOMPLETE`       | Native Ubuntu exact-source acceptance is missing.                                                                         |
| Architecture   | `ADR030_BLOCKED`                             | Architecture invariants retained; owner security policy and mandatory platform evidence unresolved.                       |
| Overall        | `NEXAR_FCR01_BLOCKED_BY_EXTERNAL_DEPENDENCY` | OS release-policy decision and native Ubuntu environment/CI availability.                                                 |
| Next milestone | `NXR070_PREREQUISITES_NOT_YET_SATISFIED`     | Do not start NXR-070.                                                                                                     |

Cowork OS read policy also requires an owner decision; it remains documented in [FCR01_Security_Findings.md](../architecture/unified-dsh-runtime/FCR01_Security_Findings.md). ADR-030 remains Proposed, PR #41 Draft, and no merge, deployment, release or NXR-070 work occurred.
