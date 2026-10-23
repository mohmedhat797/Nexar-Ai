# NXR-070C′ — Backward Compatibility and Security

Date: 2026-10-23. Implementation 1d059206f1fdbc7e2fb31a402f0673f9be07bd17; tree a9c6d4be72c7726aa85cd077fb99b2ca570b95c1. The acceptance appendix and evidence summary distinguish local platform results from hosted CI.

## Legacy strategy@1 evidence

Before editing production strategy code, strategy-legacy.test.ts captured 12 complete deterministic cases at B′ commit 18c7cd01412a8c2b138ec99baf98751699ae169e: both existing routing policies × default/preferred/required legacy reviewDiversity × pinned/unpinned preferences.

The capture includes plan decisions, selected resources, ranked alternatives, hard-filter rejections, factors/reasons, policy/config stamps, review relationships, ledger allocations and revalidation/fallback results. The committed fixture manifest records source identity, per-case hashes and human-readable allocation/stamp summaries. The test recomputes the full serialized result and compares fixed hashes; it does not regenerate expected values from modified code.

Whole-corpus SHA-256: 763d312b67b4a330493ad7e6a17964261d6bd449ae50459cfba5f177c720e24d.

Manifest: packages/resource-controller/src/fixtures/strategy-v1-pre-c.json. Capture: .nexar/ci/legacy-capture.log. Test: packages/resource-controller/src/strategy-legacy.test.ts. It PASSed in the final Windows and WSL suites.

The new fields are conditional. Without reviewDimensions, allocation/ledger/decision shapes and policy hashes remain unchanged. Existing strategy tests and deterministic/intelligence/controller/model-turn/fallback routing tests remain unchanged. No default routing policy or financial constraint was added.

## Contract and data compatibility

| Contract                              | Preservation evidence                                                                                                                                                 |
| ------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Built-in resource IDs and pins        | catalogResourceId implementation unchanged; only its parameter type narrowed to the three public fields already read. Existing materialization/routing/pin tests PASS |
| Owner resource IDs                    | Same accepted connectionKey/provider/model SHA materializer; rotation/re-entry retains IDs in actual Desktop runtime tests                                            |
| Connection identities/generations     | ConnectionManager, SettingsStore, DesktopKeyStore and Plan service production files unchanged; existing lifecycle/transaction/admission tests PASS                    |
| Account assurance and Plan retirement | No redefinition of B′ assurance; fake-IdP retained-binding/replacement regressions PASS; historical ReviewIdentity remains frozen                                     |
| Canonical sessions                    | FileSessionStore and session schemas/writers unchanged; public strategy identity returned separately from ExecutionRecord                                             |
| Project Memory                        | Store/compaction/persistence authority unchanged; existing requiredContext flow to adapters preserved                                                                 |
| Older work graphs/ledgers             | Optional fields absent retain legacy behavior; old allocation lacking account evidence cannot satisfy new required connection/provider diversity                      |
| Configuration identity                | New explicit dimensions alone add a canonical ordered hash input; labels/credentials never enter it                                                                   |
| DSH and sandbox                       | No integration-deepseek-harness runtime source, pin/lockfile, WSL permission, sandbox or ACP registration changes                                                     |

Rollback retains B′ as the dependency baseline. Remove the opted-in project configuration field before loading an older strict parser. Do not delete connection records, restore retired IDs, rewrite pins, replace credential generations or migrate canonical sessions/memory. This milestone introduces no persistent account database or migration.

## Security boundaries

Required diversity is a constraint on already eligible candidates, never a permission or delegation grant. NRC base hard filters still run first. Unknown identity cannot satisfy required constraints, and preferred mode gives it no independence credit. Provider labels/model names, credential names/values, account subjects, generation counters and display labels are not comparison identities.

Structural identity extraction rejects malformed explicit metadata, conflicting provider/host claims and canonical catalog/inventory ID mismatches. Production Registry descriptors remain governed by B′ host authority and credential validation. A stored public identity snapshot is not a new credential authorization token.

Execution-time revalidation cannot substitute the implementation connection/provider after a required reviewer becomes unavailable. The real Desktop tests prove no subsequent transport request occurs. Revalidation also binds context to the same work unit/reviewOf relationship. Base failures remain base failures; unavailable diversity is explicit when it caused rejection.

The standalone wire schemas still reject reviewOf where B4 forbids it and reject model-supplied dimensions. Only trusted host grants/orchestration settings select the rules. Review waits use existing admitted jobs and abort/timeout controls, not a new queue or replacement work unit. Existing monotonic DelegationUnitLimit, scopes and access checks remain authoritative. C′ ledger reconciliation preserves settled cost without introducing a financial policy.

Host qualifies connectionKey and appears in explanations. It is not a selectable diversity mode. Known cross-host reviewers are rejected; no federation, remote channel or credential sharing was added.

## Secret and identity minimization

ReviewIdentity contains only public resourceId, connectionId, canonical provider and host. No credential scope/path, key, token, account subject, native home or provider session reference is copied. Invalid dimension errors do not echo supplied values. Diversity error/result reason codes are bounded.

Tests assert that synthetic secret/subject sentinels are absent from decisions and retained ledgers. B′ credential-scope forgery, credential-generation, lifecycle and guarded execution tests remain intact. Real execution uses the existing host lease and credential resolver. No renderer persistence or credential UI path is added.

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

## Final diff review

The review traced project/host configuration → NRC allocation → retained UnitStrategy → workspace enforcement → NRC revalidation → guarded adapter/connection lease → transport → actual identity settlement. The Desktop bounded executor preserves strategy while retaining existing native-resource exclusions. It also checked unknown/malformed identity, preference precedence, required fallback, Plan retirement, secret propagation and grant limits.

No production Desktop credential/lifecycle/settings/Plan file, DSH runtime integration, sandbox package, session writer, Project Memory store, default routing policy, credential pin or upstream manager was changed. Tests exercise the production connection publisher instead of injecting owner resource descriptors for a fabricated normal-publication pass.

## Remaining qualifications

Distinct connection IDs are distinct configured identities, not independent proof of different real billing accounts. Legacy/native/runtime descriptors without trustworthy metadata can be unavailable under required diversity; the feature must not invent evidence to improve availability.

No live provider or personal-account acceptance was run or authorized. Existing B′ dependency/reliability qualifications remain inherited; passing C′ tests does not establish their root causes or retroactively accept B′. PR #44 and C′ require independent owner acceptance. No new security finding is being hidden by a successful suite.

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

## Unresolved acceptance observations

Both aggregate Windows Full CI attempts failed, respectively at the existing connection-management E2E timeout and private-state ACL startup-marker assertion. An earlier WSL run had three EngineeringRunner timeouts; the serial WSL full rerun passed. Later isolated passes do not close these observations or establish a root cause. The [owner handover](NXR070C_Final_Owner_Handover.md) preserves the complete failed-run identities and counts. Production security settings and existing timeouts/assertions were not changed.

## Supplemental TST-42 pin assertion

After platform validation, the existing Plan lifecycle test was strengthened with the production subscription credential scope and generation. The actual ConnectionRuntime pin authority rejects the replaced ID with retained descriptors and when only the new resource is present; the new pin remains valid. This adds assertions to the existing case, with no production source change and no test-count increase. Windows focused result: ten passed, zero failed/skipped/pending. Raw: `.nexar/ci/c-plan-pin-retirement.json`, SHA-256 `673f208c66e9f2c7997fc91c02bbb6a177e852792951e0ab95a2bc55c70dbdcb`. Final repository checks and post-publication WSL verification of these assertions are recorded in the local publication receipt. Full-suite and package evidence remains bound to production revision `1d05920`; later test/report changes do not establish a new aggregate Full CI pass.
