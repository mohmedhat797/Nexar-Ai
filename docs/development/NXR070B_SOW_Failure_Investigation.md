# NXR-070B′ — SOW Failure Investigation and Diagnostic Corrections

Date:2026-10-24. Engineer:OpenAI Codex. This is evidence and test-infrastructure work, not a claim that the intermittent SOW failure is fixed.

## Preserved aggregate failure

Standalone Windows Full CI at clean commit `aa803793f5b4ec0ff2105b5f19b86f3a0bdb01c3`, tree `87667a254d6a2c42d02a78e07d9322e9b8c6fd97`, returned **NEXAR_WINDOWS_FULL_FAIL**. Start/end source identities matched and sourceStable=true. Raw `.nexar/ci/reports/report-2026-10-24T12-16-11-600Z.json`, SHA256 `303560463f7493e9a18c7ddcce5d35b681c75c500ee7c74fb4e51de952911b3b`.

Offline4478 passed/167 skipped/4 pending/0 failed; DSH context3/3; isolated Cowork Windows8/8 passed. Source Desktop28 passed/1 failed,626.789s. The failing case was the first Cowork SOW in `apps/desktop/e2e/acceptance.e2e.ts`, not connection management. Its assertion observed `running` instead of `succeeded` after the shared60-second completion poll; the case itself had a separate240-second budget and lasted77.897s including setup. Packaging, packaged E2E and Gitleaks were not executed after this mandatory failure. Stage log `logs/1792844920442-desktop-e2e-source.log` is preserved.

The underlying delayed/stalled step is unknown. The recorded state is not a terminal execution error. This failure cannot be attributed to stale leases, ACLs, orphaned processes, model/ACP failure or host contention from the available evidence. Timestamped memory/CPU observations for this attempt are retained in `bc-b-full-host-samples.log`; they are snapshots, not a causal trace.

## Confirmed diagnostic defects and corrections

The shared fixture printed only application output, then removed its temporary state after successful process cleanup even when a test had failed. That lost the session/delegation evidence needed to diagnose the SOW. Also, callbacks for older applications captured a mutable output variable that was reassigned on a subsequent launch, allowing late output to be attributed to the wrong application.

The corrected harness retains a failed fixture after still closing every owned application, removes successful fixtures as before and gives each launch its own output buffer. Test-only registration/launch dependencies allow deterministic verification without a real Electron process. Defaults retain the same actual Vitest and Electron functions.

The separate reviewer found a further edge: registration after the launcher returned still lost evidence when launch itself rejected. Registration now precedes seeding/launch, and an injected-launch rejection regression verifies retention without an owned process handle. This does not claim universal cleanup of processes that an external launcher never returned.

The SOW failure hook records only timestamps, turn state, fixed task/delegation fields, request counts and bounded recent model progress. Model progress retains roles, timestamps and whitelisted status codes; no prompts, delegated text, credential values, private subjects or token-bearing URLs are added. Actual fixture model responses and routing behavior are unchanged. The60-second poll,240-second case budget, production ACL guard, DSH pin and sandbox settings are unchanged. No live sign-in, real credential or paid inference was used.

## Executed diagnostic evidence

- One focused unforced SOW invocation passed in11.098s, with5 unrelated cases filtered out. `bc-b-sow-diagnostic.json`, SHA256 `094a7c3b1268b7399f6eefd710016b8704014c65c4c912f309e15ae18c7e885b`. This did not reproduce or close the aggregate failure.
- Two explicitly injected fixture failures verified early and completed-turn capture. Both deliberately returned one failed case and5 filtered skips. The injection lines were temporary and removed before normal validation. Captured fixtures remain in their own generated temporary directories; their owned processes exited gracefully.
- Completed-turn capture included all four successful delegation outcomes and11 model requests, with neither the SOW prompt nor delegated argument text in the console. Its log SHA256 is `9113b1d881b103f3b41da4b1e18b7864b3b6e6f9edf1719594a4ca7d5b9471b6`; exact temporary working-source patch SHA256 `c3c2c633479481c86a4c03d66b45ebf9b4b2314f36c22b10252fe546006cbe3a`, file `bc-b-sow-completed-capture-probe.patch`. These controlled failures are not acceptance passes.
- New `tests/desktop-e2e-harness.test.ts` checks successful cleanup, failed-state retention with process cleanup, and late output attribution across two launches. With the pre-fix behavior and only the test registration/launcher seams,1 passed/2 failed: `bc-b-harness-red.json`, SHA256 `b71615ea893240fede36f7a058b54c36574dd6013a582e3a2b374955a11f5eb1`. Corrected behavior:3 passed/0 failed, `bc-b-harness-green.json`, SHA256 `b72ec916beef1122f5d26d9077b6218f77d030d2c06e399ba97019a338a915cb`.
- The initial unit-test mock did not intercept the workspace-local Electron import and its three assertions failed. That test-development attempt is retained in `bc-b-harness-green-initial.*`; it is not the RED proof above. The corrected tests use explicit injected launch dependencies and no Electron process. The initial attempt used only disposable seeded fixtures and cleaned up its actual applications.

All `.nexar/ci` paths above are relative to the B′ worktree. These working-source diagnostics are supplemental evidence and are not relabeled as a clean-source Full CI pass. A subsequent aggregate invocation must identify its own clean commit/tree and preserve any failure. A passing repetition cannot establish the original SOW failure's cause. Final results belong in the combined stabilization reports and publication receipt on PR45.

The final harness corpus has4 cases, including the launcher-rejection edge. Before moving registration ahead of launch,3 passed/1 failed; after correction,4 passed/0 failed. Raw `bc-b-harness-launch-red.json` and `bc-b-harness-green-final.json` preserve those results. A preliminary `pnpm check` was intentionally stopped during lint so the expanded final version could be checked in a fresh invocation; its log remains `bc-b-pnpm-check-sow-diagnostics.log`. No failing assertion was suppressed or timeout extended.

Launch-edge RED SHA256 `2600ca5a6f49cf28fd49507a6b9ef8f18a3a70805ac0851ef3c6c12ef6b5d80e`; final4-case GREEN SHA256 `6c56334a997d7d7cce7c5f547f7805236f8c48dda25c59b0a4a5500b4b1e1044`. The first complete check of the expanded tests stopped at five require-await lint errors in synthetic test doubles (`bc-b-pnpm-check-sow-final.log`); those functions were corrected to return resolved/rejected promises. Focused lint and full typecheck then passed (`bc-b-diagnostics-lint-fixed.log`, `bc-b-diagnostics-typecheck.log`). The next full check has a new log, `bc-b-pnpm-check-sow-final-v2.log`; none of the earlier attempts is overwritten or relabeled as a pass.

A further read-only call-graph review found no actionable proof that project reload or renderer session notification caused the stall. Project addition awaits persistence/reload; composition replacement does not dispose the previous in-flight runtime; terminal publication is awaited; and active selected sessions also poll authoritative state. Those paths remain unchanged. This review is not independent owner acceptance.
