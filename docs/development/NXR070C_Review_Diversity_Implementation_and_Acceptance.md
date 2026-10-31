# NXR-070C′ — Review Diversity: Implementation and Acceptance

> Historical milestone record. Later source-bound acceptance and remaining root-cause limitations are in [Windows stabilization](NXR070_Windows_Acceptance_Stabilization.md) and [current readiness](NXR070_BC_Final_Integration_Readiness.md). The results below retain their original revision and are not relabeled as final-source evidence.

Date: 2026-10-23 (Africa/Cairo). Engineer: OpenAI Codex.

Acceptance is source-bound. The completed gate record, raw evidence identities and remaining limitations are recorded below and in the source-controlled acceptance summary.

## Source and scope

Development branch: feat/nxr-070c-review-diversity. Base: B′ PR #44 at 18c7cd01412a8c2b138ec99baf98751699ae169e. Main at preflight: 41b918bf3c32cfd47301f7551a7280368fc3c8ec. Implementation commit: 1d059206f1fdbc7e2fb31a402f0673f9be07bd17; tree: a9c6d4be72c7726aa85cd077fb99b2ca570b95c1.

This implements OD-5 and REQ-20/REQ-37 as an additive extension of strategy@1 under Accepted ADR-029/ADR-030. NRC remains the sole resource selector. DSH remains the primary runtime at 0.2.0-rc.2. B′ is the development dependency, not an owner-accepted milestone: PR #44 remains Draft and unmerged.

## Additive contracts and activation

ReviewDimensions is a partial map from resource, connection and provider to preferred or required. WorkGraph.reviewDimensions enables static planning; StrategyLedger.reviewDimensions enables dynamic allocation. Project engineering settings accept the same map. Trusted host code can set BridgeGrantInput.reviewDimensions; relay/model request schemas reject that field.

Example project engineering settings:

    {
      "reviewDiversity": "preferred",
      "reviewDimensions": {
        "connection": "required",
        "provider": "preferred"
      }
    }

The effective resource mode inherits the legacy reviewDiversity value, or preferred when absent. An explicitly supplied resource mode must agree with an explicitly supplied legacy mode. Project parsing already defaults reviewDiversity to preferred, so a project requesting required resource diversity must set both resource fields to required. Empty maps, undefined modes, unknown dimensions, host, invalid modes, inherited configuration and contradictory resource modes are rejected.

When reviewDimensions is absent, no new context, identity field, configuration hash input, reason family or allocation shape is introduced. Existing reviewDiversity preferred/required behavior remains unchanged, including its existing revalidation semantics. To obtain the C′ execution-time guarantees, opt in through reviewDimensions. No global review requirement or routing policy is changed.

## Selection semantics

| Dimension  | Trusted comparison                          | Preferred                                                               | Required                                    |
| ---------- | ------------------------------------------- | ----------------------------------------------------------------------- | ------------------------------------------- |
| Resource   | Canonical ResourceId                        | Penalize same/unknown comparison using the existing diversity factor    | Both identities must be known and different |
| Connection | connectionKey(host, immutable connectionId) | Prefer established distinction; unknown receives no independence credit | Reject same or unknown identity             |
| Provider   | Canonical structural provider identity      | Prefer established distinction; never infer from labels/models          | Reject same or unknown provider             |

Different resources on one connection satisfy resource diversity only. Different immutable connections under OpenAI may satisfy connection diversity while failing provider diversity. Connection diversity establishes distinct configured connection identities; it does not independently prove different human owners or billing accounts.

Existing policy hard filters, experimental restrictions and legacy budget handling run first. Required constraints narrow the remaining candidates. Preferred constraints reuse the existing diversityPenalty and score-factor conventions. Owner resource preference precedence, quality classes and deterministic ID tie-breaking remain intact. Multiple required dimensions are conjunctive; canonical explanation/hash order is resource, connection, provider.

Selected/rejected candidates explain strategy.diversity.resource, strategy.diversity.connection and strategy.diversity.provider with mode and actual distinct/same/unknown outcome. If diversity eliminates the otherwise eligible choices, no allocation occurs and the decision carries strategy.diversity.&lt;dimension&gt;.unavailable. Jointly unsatisfiable dimensions retain deterministic explanations. If base hard filters eliminate every candidate, their actual failures remain the explanation rather than a fabricated diversity failure.

Host is attribution and connection qualification only. Host is rejected as a selectable dimension. Known cross-host review candidates are rejected with strategy.review.host; no cross-host execution channel is added.

## Identity trust and continuity

reviewIdentityOf reads host-owned structural connection/provider metadata, not display labels, API keys, credential references, account subjects or mutable generations. It rejects malformed/conflicting metadata and validates owner catalog/inventory identity against the existing canonical materializers. Missing host/account evidence remains unknown. A DSH/native/legacy descriptor without sufficient identity cannot satisfy required account/provider independence by inference.

Opted-in allocations retain a frozen ReviewIdentity containing only resourceId and, when established, connectionId/provider/host. ReviewContext retains the reviewed unit and its identity in the existing UnitStrategy. Historical identity is copied from that allocation, never reconstructed from an unrelated current Registry entry. Malformed retained resource IDs reject. Disappearance, Disable, Forget, rotation or replacement cannot rewrite the historical comparison.

## Production execution path

The existing controller shares decideUnit across planStrategy, allocateNext and revalidate. ResourceController.revalidate gathers current Registry/availability/quota/history inputs and retains the same fallback policy and hard filters.

EngineeringExecution forwards project dimensions during planning, maintains a dynamic ledger with round-qualified lane IDs, allocates each actual lane, and compares reviews with the last successfully executed writer. Nexar.run enforces project/workspace boundaries before NRC revalidation. A required failure prevents adapter execution; the old resource-only retry cannot downgrade an opted-in review.

IntelligenceBridge accepts dimensions from the host grant only. An opted-in review waits for the earlier admitted job to complete successfully. Actual executor identity replaces provisional planning identity, including after fallback. Cancellation remains bounded by the existing timeout/signal and monotonic unit limit. The host executor forwards retained strategy to Nexar.run; the Desktop bounded Cowork wrapper preserves it while applying its existing exclusions.

The guarded adapter then uses B′ connection admission/lease and connection-bound credential resolution. C′ adds no credential writer or alternate execution authority. Core returns the selected descriptor's public identity separately from the existing persisted ExecutionRecord; bridge/lane ledgers retain it. FileSessionStore and ProjectMemoryStore are unchanged.

## Modified modules and source anchors

| Source                                                        | Change                                                                            |
| ------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| packages/contracts/src/strategy.ts:24                         | Validated additive dimensions, public identity/context, trusted StrategyExecution |
| packages/contracts/src/routing.ts                             | Optional revalidation port and explicit unavailable decision reasons              |
| packages/contracts/src/gateway.ts                             | Host-grant constraint and bounded result reason codes                             |
| packages/resource-controller/src/review-diversity.ts:31       | Structural identity extraction, retained evidence and connectionKey comparisons   |
| packages/resource-controller/src/strategy.ts:255              | Shared filters/factors, conditional hashes, immutable allocation evidence         |
| packages/resource-controller/src/strategy.ts:573              | Required constraints retained at revalidation                                     |
| packages/resource-controller/src/controller.ts:174            | Real Registry-backed revalidation and fallback                                    |
| packages/core/src/config.ts; packages/projects/src/project.ts | Opt-in project setting and strict parsing                                         |
| packages/core/src/engine.ts:208                               | Execution-time NRC check; actual public allocation identity returned at line 450  |
| packages/engineering/src/execution.ts:529                     | Planner/dynamic lane ledger; runLane at line 635                                  |
| packages/engine-gateway/src/bridge.ts:395                     | Completion-aware review allocation and actual identity settlement                 |
| packages/engine-gateway/src/endpoint.ts                       | Trusted mint input preserved; wire request remains restricted                     |
| packages/host/src/bridge-ports.ts:13                          | Existing host executor carries trusted strategy                                   |
| packages/resource-registry/src/materialize.ts                 | Input type narrowed to required public identity fields; ID algorithm unchanged    |

Tests changed in Desktop connection-runtime/plan-binding, core config, engineering strategy, bridge and endpoint suites. New strategy-dimensions and strategy-legacy suites plus a pre-change fixture manifest cover the new behavior and legacy byte identity.

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

## Limits and rollback

All provider transports/sign-ins used synthetic fixtures or credential-free DSH, with disposable profiles. No live provider/account acceptance is claimed. Packaged acceptance is a regression of the supported packaged harness, not a new review UI or a personal-profile installer test.

No persistence migration is introduced. Rollback must keep B′ connection/settings/credential/session/memory data intact and remove newly opted-in configuration fields before an older strict parser reads them. Never rebind identities or rewrite pins. Historical C′ identity fields are additive public evidence.

No D′/F′/G′/H′/I′ capability, new harness, upstream manager, DSH upgrade, new financial policy or architecture decision is included. Independent owner acceptance of B′ and C′ remains required.

## Final concurrency correction

Commit `1d059206f1fdbc7e2fb31a402f0673f9be07bd17` closes a race found during final call-graph review after the initial C′ commit. While an allocator awaited Registry inputs, an earlier execution could settle its actual fallback identity and cost. Publishing the allocator's older ledger could overwrite that settlement.

The C′ path now reconciles completed allocation objects and the settled cost delta synchronously before publication, within the existing serialized allocation tail. It does not add a queue, counter or resource authority. The unset-field legacy path is unchanged. The deterministic regression holds an unrelated allocation, settles writer A on actual resource B with cost 0.25, releases the allocation, and verifies the reviewer compares B and selects A while accounting retains 0.25.

Raw RED: `.nexar/ci/c-settlement-red.log`; GREEN: `.nexar/ci/c-settlement-green.log`. The RED run reproduced the defect against the initial C′ implementation. All 34 bridge tests pass after correction, including cancellation and authority regressions. Initial `2726cc8` Full CI evidence is historical and does not establish acceptance of this correction.

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
