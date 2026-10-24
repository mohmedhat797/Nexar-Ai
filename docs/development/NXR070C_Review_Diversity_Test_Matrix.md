# NXR-070C′ — Review Diversity Test Matrix

> Historical matrix at the revision below. The same corpus was rerun during [combined stabilization](NXR070_Windows_Acceptance_Stabilization.md); [current readiness](NXR070_BC_Final_Integration_Readiness.md) records later acceptance and outstanding gates. No old FAIL or skip is converted into a PASS.

Date: 2026-10-23. Acceptance is bound to the implementation commit and tree below.

Implementation: 1d059206f1fdbc7e2fb31a402f0673f9be07bd17. Tree: a9c6d4be72c7726aa85cd077fb99b2ca570b95c1. Windows x64 10.0.26300 and WSL2 nexar-plane used Node 22.23.3 / pnpm 10.33.0; DSH remained 0.2.0-rc.2.

## Requirement definitions and traceability

Definitions below are from the accepted reconciled blueprint; the identifiers have not been renumbered.

| Requirement/test | Accepted obligation                                                                                                                                             | Implementation and executed evidence                                                                                                                                                                                                 |
| ---------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| REQ-20 / TST-20  | Resource default; optional connection/provider; preferred/required; host rejected; explicit required failure; unknown never distinct; B4 and unset v1 preserved | strategy-dimensions.test.ts: all 43 tests PASS on both platforms, including all 18 corpus combinations below; endpoint/bridge tests preserve grant authority                                                                         |
| REQ-37 / TST-42  | Immutable connection/account identity; same-account re-entry retains key; Replace uses a new identity; comparison uses connectionKey                            | Desktop connection-runtime.test.ts:12 PASS; plan-binding.test.ts:10 PASS on both platforms; actual SettingsStore/ConnectionManager/Registry/NRC/guarded Pi composition with synthetic transport, and real fake-IdP Plan verification |
| TST-06           | v0.6 pins and both NRC policies preserve decisions/reasons                                                                                                      | Existing deterministic/intelligence/controller/model-turn/fallback tests unchanged and PASS; new strategy-legacy corpus validates 12 complete pre-change cases with fixed hashes                                                     |
| TST-27           | Canonical session/turn/sidecar continuity; no provider-native session refs                                                                                      | Existing packages/sessions and Desktop sessions suites PASS in full runs; core ExecutionRecord/session writers unchanged; new identity lives in trusted strategy ledgers, not provider-native history                                |
| TST-30           | Preserve gateway/relay/Cowork/approval/sandbox/session regressions                                                                                              | First Windows offline and serial WSL suites PASS; real DSH 3/3, Windows/WSL 8/8 and Linux sandbox/real DSH 15/15 PASS; supplemental source/packaged E2E each 27/27; aggregate Windows Full CI FAIL (recorded below)                  |
| TST-31           | No generic ACP resource registration/resume/fork/cross-host allocation                                                                                          | No adapter registration or resume/fork changes; host schema rejects host dimension; cross-host review candidate test rejects; existing admission/security suites PASS                                                                |

## TST-20: complete corpus

Source: packages/resource-controller/src/strategy-dimensions.test.ts, suite “TST-20 complete dimension/mode/availability matrix”. Writer uses A; A2 is a different model/resource on A's connection, B is another OpenAI connection, C is an Anthropic connection. Unknown is an agent without account/provider evidence. Resource unknown means the reviewed allocation is absent, since a valid candidate already has a canonical ResourceId.

Each observed result below passed on Windows and WSL. Assertions check selected identity, rejected candidates, dimension explanation, retained comparison identity, no allocation on required failure, and exact unavailable reason. “Fail D” means no selected resource and strategy.diversity.D.unavailable, not a retry without the constraint.

| Dimension  | Mode      | Availability  | Expected and observed                                           |
| ---------- | --------- | ------------- | --------------------------------------------------------------- |
| resource   | preferred | satisfiable   | Select A2; resource distinction established                     |
| resource   | preferred | unsatisfiable | Select A; same resource explicitly explained                    |
| resource   | preferred | unknown       | Select A with unknown comparison; no independence claim         |
| resource   | required  | satisfiable   | Select A2; A rejected                                           |
| resource   | required  | unsatisfiable | Fail resource                                                   |
| resource   | required  | unknown       | Fail resource                                                   |
| connection | preferred | satisfiable   | Select B; distinct connectionKey                                |
| connection | preferred | unsatisfiable | Select A2; same connection explicitly explained                 |
| connection | preferred | unknown       | Unknown candidate eligible with penalty; no independence credit |
| connection | required  | satisfiable   | Select B; A rejected                                            |
| connection | required  | unsatisfiable | Fail connection; different model on A is insufficient           |
| connection | required  | unknown       | Fail connection                                                 |
| provider   | preferred | satisfiable   | Select C; canonical provider distinction                        |
| provider   | preferred | unsatisfiable | Select B; same provider explicitly explained                    |
| provider   | preferred | unknown       | Unknown candidate eligible with penalty; no independence credit |
| provider   | required  | satisfiable   | Select C; A rejected                                            |
| provider   | required  | unsatisfiable | Fail provider; different OpenAI account is insufficient         |
| provider   | required  | unknown       | Fail provider                                                   |

## Additional deterministic/security cases

| Scenario                                                                          | Expected and observed                                                          | Source                                                   |
| --------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ | -------------------------------------------------------- |
| Unsupported/empty/undefined/invalid/inherited map and contradictory resource mode | Explicit validation failure; host cannot become a dimension                    | strategy-dimensions; core config tests                   |
| Owner prefers same identity in preferred mode                                     | Owner preference tier retained; explanation admits actual non-diversity        | strategy-dimensions                                      |
| Owner prefers same identity in required mode                                      | Hard rejection wins; distinct eligible alternative selected                    | strategy-dimensions                                      |
| Connection required + provider preferred                                          | Enforce connection first, then rank provider distinction                       | strategy-dimensions                                      |
| Connection + provider required                                                    | Both enforced; exact provider unavailable when only provider fails             | strategy-dimensions                                      |
| Every candidate fails base filters                                                | Actual state/hard-filter failure retained; no fabricated diversity error       | strategy-dimensions                                      |
| Provider spoofed via label; metadata contains synthetic secrets                   | Labels do not establish identity; no secret sentinel in decisions              | strategy-dimensions                                      |
| Catalog ID bound to A with forged B connection metadata                           | Identity becomes unknown; required connection fails                            | strategy-dimensions                                      |
| Malformed explicit metadata / unknown historical account                          | No fallback inference from current Registry; required failure                  | strategy-dimensions                                      |
| Malformed retained ResourceId                                                     | Validation failure, never undefined-versus-defined independence                | strategy-dimensions                                      |
| Plane candidate reviewing Desktop allocation                                      | No allocation; strategy.review.host rejection                                  | strategy-dimensions                                      |
| Map ordering or unrelated labels change                                           | Byte-identical decisions/config identity for equivalent rules                  | strategy-dimensions                                      |
| Reverse graph order, dynamic allocation, then reviewer becomes unavailable        | Static/dynamic agree; revalidation refuses same-account/provider fallback      | strategy-dimensions                                      |
| Reviewed resource disappears after allocation                                     | Frozen historical identity remains authoritative                               | strategy-dimensions                                      |
| Revalidation changes reviewOf                                                     | Context mismatch rejected                                                      | strategy-dimensions                                      |
| Unrelated ordinary work unit                                                      | No review constraint applied                                                   | strategy-dimensions                                      |
| Actual execution falls back before review                                         | Bridge ledger uses actual completed identity, not initial plan identity        | engine-gateway/bridge.test.ts                            |
| Cancel review while awaiting earlier execution                                    | No reviewer execution/allocation; no additional unit allowed                   | engine-gateway/bridge.test.ts                            |
| Relay tries to supply dimensions or standalone reviewOf                           | Rejected by existing wire/admission boundary; host grant remains authoritative | engine-gateway/endpoint.test.ts and existing relay tests |

## TST-42 and production paths

The new parameterized Desktop test creates actual persisted owner connections through the real IPC bridge. Connection mode uses two OpenAI connections; provider mode uses OpenAI and Anthropic. Actual Registry descriptors originate from ConnectionRuntime, not manually injected owner resources. NRC allocates A, guarded execution receives synthetic Key A, and the actual public identity is retained. Forget and explicitly asserted same-account re-entry retain A's canonical resource/connection identity. NRC allocates B and guarded execution receives Key B. Disabling B before revalidation refuses fallback to A; the transport call list remains exactly [Key A, Key B].

The production bounded IntelligenceBridge test holds A's actual model execution, submits its reviewer, disables B, then completes A. The reviewer fails with strategy.diversity.connection.unavailable and no model call. The writer lease drains to zero.

The Plan test uses the actual Plan service with fake signed identity-provider responses. Same-subject Forget/re-entry preserves connection identity and cannot create connection diversity. Approved simulated Replace permanently retires the old ID, creates a new opaque ID and canonical inventory resource, allows a new verified subject, and leaves the historical comparison unchanged. Restore of the replaced identity fails. Existing B′ pin/credential/lifecycle negatives remain in the full regression corpus. No live Plan login or concurrent Plan account is used.

The two complete EngineeringRunner tests require the existing POSIX harvest script and are explicitly skipped on native Windows, matching existing runner/lane-engine conventions. Both PASS in WSL: actual planner → dynamic controller → Nexar execution/revalidation → recorded review; and unavailable reviewer with another model on the writer account → exact failure/no review execution/no downgrade.

## Executed evidence

All results below refer to source `1d059206f1fdbc7e2fb31a402f0673f9be07bd17`, tree `a9c6d4be72c7726aa85cd077fb99b2ca570b95c1`, unless expressly described as historical. Windows x64 build 26300 and WSL2 nexar-plane used Node 22.23.3 / pnpm 10.33.0; DSH remained 0.2.0-rc.2.

- Pre-commit `pnpm check`: PASS (format, lint, boundaries, typecheck, tests and build). Tests: 4,513 passed, 180 skipped, four pending, zero failed. Log: `.nexar/ci/c-pnpm-check-settlement.log`.
- First corrected Windows Full CI: FAIL at source Desktop E2E, 26 passed / one 120-second timeout. Its offline gate passed: 4,524 passed, 169 skipped, four pending, zero failed. Report: `.nexar/ci/reports/report-2026-10-23T12-23-58-837Z.json`.
- Serial Windows Full CI: FAIL at the existing private-state ACL startup-marker assertion. Offline tests: 4,523 passed, 169 skipped, four pending, one failed. Report: `.nexar/ci/reports/report-2026-10-23T12-52-38-795Z.json`. Subsequent stages were skipped by fail-fast.
- Isolated unchanged private-state suite: PASS, 18 passed / two skipped. Raw: `.nexar/ci/c-private-state-isolated.json`. This does not close the full-run failure.
- Serial WSL full suite: PASS, 4,668 passed / 29 skipped / zero failed or pending. Raw: `/home/nexar/src/nxr070c-20261021/.nexar/ci/c-wsl-full-serial.json`; SHA-256 `66fa2f8fa25d95acff8d52214e87a53d7ede632cb796cf832354dd0afa01387a`; duration 226.337 seconds.
- Real DSH context: 3/3 PASS; Windows-to-WSL isolated Cowork: 8/8 PASS, including nested Linux kernel/real DSH 15/15, in the first corrected Windows run.

All 43 dimension tests, the fixed legacy corpus, 34 bridge tests, twelve connection-runtime tests and ten Plan-binding tests passed. Both complete POSIX engineering-lane tests passed in WSL and remain explicitly skipped on native Windows. Counts from standalone gates are not added to the unique 4,697-test offline corpus. The four Windows pending assertions are the existing real-bubblewrap proxy/socket tests; their counterparts pass in WSL.

Independent installer, Desktop and secret-scan results are recorded in the supplemental acceptance appendix and [evidence summary](evidence/nxr070c/acceptance-summary.json). They do not convert a failed aggregate Full CI invocation into a pass. No live provider, paid inference or owner-profile testing is claimed.

## Concurrency regression

The deterministic bridge regression preserves actual fallback identity and settled cost across an unrelated in-flight allocation. Its RED/GREEN raw logs and hashes are recorded in the acceptance summary; the unset-field legacy path is unchanged.

## Supplemental platform gates and publication

These independently executed gates use corrected source `1d059206f1fdbc7e2fb31a402f0673f9be07bd17` / tree `a9c6d4be72c7726aa85cd077fb99b2ca570b95c1`, Node 22.23.3 / pnpm 10.33.0 on Windows x64 build 26300. The checkout remained clean through execution. These results do not change either aggregate Windows Full CI failure.

| Gate / command                                                                                                      | Observed result                                             | Raw evidence                               |
| ------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------- | ------------------------------------------ |
| `pnpm desktop:package:win`                                                                                          | PASS; new installer, checksum and bundled runtime inspected | `.nexar/ci/c-package-independent.log`      |
| `pnpm desktop:e2e`, source with `NEXAR_DSH_ENTRY` pointing to the pinned managed entry                              | 27 passed / zero failed, skipped or pending; 498.08 seconds | `.nexar/ci/c-source-e2e-independent.log`   |
| `pnpm desktop:e2e`, `NEXAR_DESKTOP_EXECUTABLE=release/desktop/win-unpacked/Nexar.exe`, external DSH entries removed | 27 passed / zero failed, skipped or pending; 440.07 seconds | `.nexar/ci/c-packaged-e2e-independent.log` |
| `gitleaks.exe git --redact --verbose --exit-code 1 .`, version 8.28.0                                               | PASS, exit 0                                                | `.nexar/ci/c-gitleaks-independent.log`     |

Installer: `release/desktop/Nexar-0.1.0-windows-x64-setup.exe`, 322186257 bytes, SHA-256 `1f3dfa344709cf403780977586c6738a61f0cf9b4a923509ef2e159fa53a805b`; its checksum sidecar matches actual bytes and freshness inspection passed. Authenticode reports `NotSigned`, consistent with existing local packaging configuration. Packaged `app.asar`: `655e22cf2b9faa8472f79ea3c2e12cbff7b498aaa7f7f3869078634e4deffc4e`. Relay, control-gateway, sign-in helper and bundled DSH entry match the tested build bytes; all identities are in the [acceptance summary](evidence/nxr070c/acceptance-summary.json).

The packaged harness launches the generated unpacked executable and bundled DSH in disposable profiles. The NSIS installer was built and inspected; it was not installed over the owner's application/profile. Source Providers diagnostics observed zero non-loopback egress; packaged egress/IPC were not observed without a fixture launcher, so no packaged zero-egress claim is made. No native Ubuntu Full CI pass is claimed. Native Linux was skipped by fail-fast in current Windows aggregate attempts; mandatory WSL validation passed separately.

[Draft PR #45](https://github.com/mohmedhat797/Nexar-Ai/pull/45) remains OPEN / Draft, targeting `feat/nxr-070b-multi-api-connections`, explicitly STACKED ON NXR-070B′ / PR #44. Corrected source was pushed normally as `1d05920`. PR #44 remains unchanged, OPEN / Draft and unmerged at `18c7cd01412a8c2b138ec99baf98751699ae169e`. Main remains `41b918bf3c32cfd47301f7551a7280368fc3c8ec`. Final test/report-commit/publication identity is recorded in the local `.nexar/ci/NXR070C_Publication_Receipt.md`; the final follow-up changes are limited to reports and the identified Plan pin test.

Hosted classification: `HOSTED_CI_INFRASTRUCTURE_BLOCKED`. Corrected-source [run 39965401076](https://github.com/mohmedhat797/Nexar-Ai/actions/runs/39965401076) completed with three failed jobs and zero executed steps. Each job's failure annotation states: “The job was not started because an Actions budget is preventing further use.” Hosted checks have not passed. No CI configuration, security check or branch protection was bypassed.

Raw files remain local/ignored; the committed acceptance summary preserves source identity, commands, environment, counts and report/log/artifact hashes. Independent owner acceptance, resolution of Windows Full CI failures and hosted CI availability remain outstanding.

## Acceptance reruns and unresolved timing observations

The first 2026-10-23 WSL run at the corrected source overlapped Windows validation and failed three unchanged EngineeringRunner tests at their existing 5,000 ms limits (4,665 passed, 29 skipped, three failed). The raw file is `/home/nexar/src/nxr070c-20261021/.nexar/ci/c-wsl-full-settlement.json`, SHA-256 `2254866b8d53a694313b9ad168e23fa3f248ab713b3b8c485bb6d9c036661c89`. All 43 dimension tests, 34 bridge tests, ten engineering strategy tests, twelve connection-runtime tests and ten Plan-binding tests passed in that run.

The first corrected Windows Full CI failed source Desktop E2E: 26/27 passed; the existing `connections.e2e.ts` multi-account management test exceeded 120,000 ms. Packaging, packaged E2E, native Linux and Gitleaks were then skipped by fail-fast. Immutable report: `.nexar/ci/reports/report-2026-10-23T12-23-58-837Z.json`, SHA-256 `f7d668d310d51541a7e17c716927389c7c21de46f38781a520dedc1122841751`. The passing offline raw JSON from that attempt is preserved as `.nexar/ci/test-offline-1d05920-first.json` (SHA-256 `56b057f0e42371329474ed565fb92a9ec72401556a01936c49efbeb4f27cd641`).

These are real failed attempts. The three EngineeringRunner tests and Desktop E2E test are unchanged from B′; that fact does not establish the timeout root cause. No timeout, assertion, sandbox setting or production source was changed to obtain a retry. Serial rerun results are recorded separately below. Passing a later run establishes that run's outcome, not that these intermittent timing failures are fixed.

The serial Windows rerun failed earlier, at `native Windows state ACLs → creates a private root and inherited private files without changing its parent ACL`: the synchronous readiness marker was absent. Raw report: `.nexar/ci/reports/report-2026-10-23T12-52-38-795Z.json` (SHA-256 `bef001a2f509ada46e443ca5805691089c7fe1e89b48e3e51fe9bb8996ca736d`). Raw offline JSON: `.nexar/ci/test-offline.json` (SHA-256 `88dcd27edf31df8e7a30c07128cf2f4f92c825a7ba5e2c69cd5a82c454f5d815`): 4,523 passed, 169 skipped, four pending, one failed.

That assertion passed in the first full run (8.815 seconds) and in the unchanged isolated suite (5.306 seconds); the failed attempt took 18.953 seconds. The native tool has an existing 15-second timeout, but its diagnostic category was not captured by the failing marker assertion, so the root cause remains unproven. The existing production helper throws on tool failure. The isolated suite passed 18 tests / two skipped; raw `.nexar/ci/c-private-state-isolated.json`, SHA-256 `1ca59cf983b7f894c956df4592af9c968ae66288ba9849c06fb0b4b65c11ae3d`.

The independent source Desktop rerun passed all 27 tests in 498.08 seconds at unchanged source and timeouts. This is supplemental evidence; both aggregate Full CI invocations remain FAIL. No current `NEXAR_WINDOWS_FULL_PASS` claim is made.

## Supplemental TST-42 pin assertion

After platform validation, the existing Plan lifecycle test was strengthened with the production subscription credential scope and generation. The actual ConnectionRuntime pin authority rejects the replaced ID with retained descriptors and when only the new resource is present; the new pin remains valid. This adds assertions to the existing case, with no production source change and no test-count increase. Windows focused result: ten passed, zero failed/skipped/pending. Raw: `.nexar/ci/c-plan-pin-retirement.json`, SHA-256 `673f208c66e9f2c7997fc91c02bbb6a177e852792951e0ab95a2bc55c70dbdcb`. Final repository checks and post-publication WSL verification of these assertions are recorded in the local publication receipt. Full-suite and package evidence remains bound to production revision `1d05920`; later test/report changes do not establish a new aggregate Full CI pass.
