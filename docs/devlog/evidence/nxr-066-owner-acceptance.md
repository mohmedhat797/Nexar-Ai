# NXR-066b owner acceptance — started, catalog size blocker

Prepared 2026-10-07 for implementation generation `0244d974704b9350a2ddec873872514db8d5de1a`.
The preparation handoff records the OpenWorker 0.3.1 maintenance SHA, its CI run and both build
identities; require that exact-head CI before owner live acceptance.
Owner explicitly started live acceptance on 2026-10-07 at the maintenance head
`feb36dc59572c40ef13afd79a4d0ded519dfd9e7`. This is **not a completed acceptance record**. Follow the
[owner runbook](nxr-066-live-acceptance-runbook.md), including its STOP boundary.

## Gates and environment

- [x] Full exact-head CI: [37553210679 attempt 2](https://github.com/mohmedhat797/Nexar-Ai/actions/runs/37553210679/attempts/2), Ubuntu/Windows/secret scan passed.
- [x] Full exact-head maintenance CI: [37631118802 attempt 1](https://github.com/mohmedhat797/Nexar-Ai/actions/runs/37631118802/attempts/1), Ubuntu/Windows/secrets, source/packaged E2E, installer/SHA256 upload passed.
- [x] Windows OpenWorker **0.3.1** (`>=0.3.1 <0.4.0`) and private-server startup verified; separate 0.3.0 retained.
- [x] Desktop built at the maintenance SHA; owner authorized existing-profile launch in this live session.
- [x] Plane built at the same SHA; preparation doctor and 7/7 sandbox selftests passed.
      Live Desktop `refreshCode` confirmed project `nxr-055-validation` mapped to `nxr055-validation`, state `ready`, checked 2026-10-07 16:19:50 UTC.
- [x] Owner explicitly initiated the live stages after the runbook STOP boundary.

## Owner results

| Stage                   | Record only                                                                                                 | Result                                              |
| ----------------------- | ----------------------------------------------------------------------------------------------------------- | --------------------------------------------------- |
| Connections/inventories | Connection id, route, returned model/resource ids, freshness, reason codes                                  | Connected; catalog exceeds current byte ceiling     |
| Read-only smoke         | Task id, lane, resource/model, selection reason, timing, outcome; zero modifications                        | Not run; inventory prerequisite failed              |
| Cowork SOW              | Task/unit ids, control resource, subscription unit resource, lane, outcomes, draft artifact id              | Not run                                             |
| Code                    | Task id, lane resources, executor/fallback reason, sandbox/gate/review status, approval id, local commit id | Preflight ready; model turn/approval/commit not run |
| Integrated flow         | Conversation/turn/task ids, lane decisions, resources, outcomes                                             | Not run                                             |

### Live observations (2026-10-07)

- Initially ChatGPT plan status was `connected`, sharing enabled. Account identity is
  `openai.chatgpt-plan` / `pi` / `openai.responses.account` on Desktop.
  Automatic startup listing and one explicit refresh failed. Explicit attempt at
  **16:13:42.814 UTC** returned `unavailable`, `refresh-failed`, zero entries/resources and unknown auth.
- Native Claude inventory at **16:12:51.633 UTC** was `fresh`, generation 2, source `live-runtime`:
  12 native-agent entries, including provider-returned `default`, `opus`, `sonnet` and `haiku`.
  Listing's auth is `unknown`; this alone is not subscription execution/authentication acceptance.
  Native Codex and Google inventories were `runtime-unavailable`; optional listing/login was not initiated.
- OpenWorker reports version **0.3.1**, with `configuration-missing` / no compatible control resource.
  Cowork and Code policies are both Auto / fallback Auto; there are zero control candidates.
- Live plane preflight: `ready`; native `claude-code` available/authenticated,
  native `codex` available/unauthenticated; neither is a model-turn control resource.
- After a diagnostic relaunch, ChatGPT status was `signed-out`. A metadata refresh at
  **16:20:46.910 UTC** returned `not-connected`, auth `unauthenticated`, zero entries.
  The public status does not establish why the connection disappeared. No disconnect or sign-in
  command was invoked by the acceptance driver. The owner subsequently completed browser reconnection;
  public status returned `connected`, sharing enabled, including after the next relaunch.
- Successful account catalog HTTP responses still failed inventory refresh. Structural diagnostics at
  **16:29:30.825 UTC** and **16:29:56.451 UTC** observed 81,590 / 81,920 bytes before stopping at the
  diagnostic ceiling. These are lower bounds, not complete response sizes. Both responses were HTTP 200,
  without declared content length. The current-head client rejects bodies above **65,536 bytes**.
  This establishes a catalog-size blocker, rather than a sign-in failure.
- A complete bounded structural probe at **16:34:22.543 UTC** measured **362,153 bytes**, 7 model
  objects / 4 visible entries, no invalid visible fields or duplicates. It matches the account
  `models` shape, not an API-key `data` array. No response values were retained. The initial
  proposed 262,144-byte budget was therefore discarded before completing validation.
- A bounded local correction gives the catalog its own **1,048,576-byte** ceiling; OAuth responses retain
  their existing 65,536-byte bound. Ordered visible model parsing, entry limits, deadlines and
  fail-closed validation remain. The correction is not committed, CI-tested or deployed to acceptance.
- The owner independently completed a test-project turn: session `ses_44ea98becfe9046e0fb779ef20750d4c`,
  turn `turn_b7242e02ef10f6dcac7072877c39c9bc`, task `task_19e3b265-f3d1-4d95-8d17-9f51907a4b1d`,
  **16:25:52.116–16:26:18.802 UTC**, `succeeded`, resource `claude-code`.
  Requested Cowork fell back to `direct` with `openworker-control-unavailable`; one draft artifact.
  The driver did not submit this turn. Its prompt/output and zero-modification property were not checked;
  it is not the controlled smoke, SOW or orchestrated Cowork acceptance.
- No model prompt, SOW, engineering write, approval, local commit or push was initiated by the driver.
  No model slug was invented and no API-key/native catalog substituted for account inventory.
  Endpoint/shape match the [official account route](https://developers.openai.com/siwc/token-sharing-open-source/models-and-inference);
  local diagnostic instrumentation retains route enums, HTTP status/allowlisted transport code,
  timing and fixed structural counts, never response values, headers or tokens.

### Local catalog correction gates

Node **22.23.3** / pnpm **10.33.0**, final local patch, 2026-10-07:

- Full `pnpm check` **PASS**: **3,979 passed / 158 skipped**, 195 passed / 16 skipped files;
  format, lint, boundaries, typecheck and build passed. Windows sandbox/live-test skips remain expected.
- Catalog regression accepts the exact **1 MiB** ceiling with and without declared length, discards
  unrelated metadata, and rejects larger declared/streamed responses. Existing OAuth tests passed.
- Source Desktop E2E **22/22 PASS**; unsigned Windows installer/SHA256 **PASS**;
  packaged Desktop E2E **22/22 PASS**, all isolated fixture profiles.
- The runner's initial silent-lint timeout and a temporary helper's undeclared browser global were
  resolved before the successful full check. No gate configuration was weakened.
- Diagnostic Desktop closed with all sessions inactive. The helper's next launch uses the original
  built main; no active diagnostic wrapper remains. Owner sign-in was not disconnected.

**Owner approved publishing this correction and evidence to draft PR #39**, requiring full exact-head
CI, matching Desktop/plane builds and resumed acceptance. The prior deployed acceptance generation
is `feb36dc`; its CI does not cover this correction. Require the corrected head's full CI and matching
Desktop/plane builds, then a fresh account catalog, before resuming controlled live smoke/SOW/Code.
No new implementation milestone started. This authorization covers source maintenance; the runbook's
no-push boundary still applies to acceptance-generated engineering commits.

Keep prompts, generated content, tokens, credential contents, account identifiers and raw vendor
output out of this file. A recorded failure/fallback remains a failure/fallback; it is not acceptance.
No acceptance-generated push. No merge/release. PR #39 stays draft until the owner accepts the recorded v0.6 results.
