# NXR-066b owner acceptance — smoke passed, SOW write compatibility blocked

Prepared 2026-10-07 for implementation generation `0244d974704b9350a2ddec873872514db8d5de1a`.
The preparation handoff records the OpenWorker 0.3.1 maintenance SHA, its CI run and both build
identities; require that exact-head CI before owner live acceptance.
Owner initially started live acceptance on 2026-10-07 at the maintenance head
`feb36dc59572c40ef13afd79a4d0ded519dfd9e7`, then resumed at the catalog-correction head
`12d7ea183deea08cbcc19a38384b6649c7186ab1`. This is **not a completed acceptance record**. Follow the
[owner runbook](nxr-066-live-acceptance-runbook.md), including its STOP boundary.

## Gates and environment

- [x] Full exact-head CI for deployed `12d7ea1`: [37657555559 attempt 1](https://github.com/mohmedhat797/Nexar-Ai/actions/runs/37657555559/attempts/1), Ubuntu/Windows/secrets, source/packaged E2E, installer/SHA256 upload passed.
      Earlier runs [37553210679 attempt 2](https://github.com/mohmedhat797/Nexar-Ai/actions/runs/37553210679/attempts/2)
      and [37631118802 attempt 1](https://github.com/mohmedhat797/Nexar-Ai/actions/runs/37631118802/attempts/1)
      cover their historical preparation heads only.
- [x] Windows OpenWorker **0.3.1** (`>=0.3.1 <0.4.0`) and private-server startup verified; separate 0.3.0 retained.
- [x] Desktop built at `12d7ea1`; owner authorized existing-profile launch in this live session.
- [x] Plane built at `12d7ea1`; doctor and 7/7 sandbox selftests passed.
      Live Desktop `refreshCode` confirmed project `nxr-055-validation` mapped to `nxr055-validation`,
      state `ready`, both Claude/Codex authenticated, checked 2026-10-07 18:23:20.722 UTC.
- [x] Owner explicitly initiated the live stages after the runbook STOP boundary.

## Owner results

| Stage                   | Record only                                                                                                 | Result                                               |
| ----------------------- | ----------------------------------------------------------------------------------------------------------- | ---------------------------------------------------- |
| Connections/inventories | Connection id, route, returned model/resource ids, freshness, reason codes                                  | PASS; fresh authenticated account catalog at 12d7ea1 |
| Read-only smoke         | Task id, lane, resource/model, selection reason, timing, outcome; zero modifications                        | PASS; gateway, source unchanged                      |
| Cowork SOW              | Task/unit ids, control resource, subscription unit resource, lane, outcomes, draft artifact id              | Incomplete; succeeded but no delegation/draft        |
| Code                    | Task id, lane resources, executor/fallback reason, sandbox/gate/review status, approval id, local commit id | Preflight ready; model turn/approval/commit not run  |
| Integrated flow         | Conversation/turn/task ids, lane decisions, resources, outcomes                                             | Not run                                              |

### Resumed live observations (2026-10-07, 12d7ea1)

- **Full exact-head CI:** [37657555559 attempt 1](https://github.com/mohmedhat797/Nexar-Ai/actions/runs/37657555559/attempts/1),
  SHA `12d7ea183deea08cbcc19a38384b6649c7186ab1`, all three jobs successful; Ubuntu finished
  17:22:04 UTC, Windows including packaged E2E / installer/SHA256 upload finished 17:33:11 UTC.
- Matching clean detached Desktop and plane builds passed. Plane doctor and 7/7 sandbox selftests;
  validation `main @ 40f02fb`, config hash and hardening preserved. OpenWorker ready `0.3.1`.
- Owner connection retained: `connected`, sharing enabled. Account source `official-api`,
  auth `authenticated`, status `fresh`. Startup observed 17:37:39.801 UTC; explicit refresh after
  pin/Auto validation observed 17:40:21.979 UTC. Four returned slugs: `gpt-6-astra`, `gpt-5.6-sol`,
  `gpt-5.6-terra`, `gpt-5.6-luna`. Native Claude metadata refreshed 17:39:22.758 UTC, 12 entries.
- Temporary pin of a fresh compatible resource, return to Auto, and fresh inventory verified.
  Actual Auto control resource: `inventory:048a60e3b9b7892e466eff536385c50a2168da981a4d3ac61cd0f4c44ba0f2b3`
  / `gpt-5.6-luna`, connection `openai.chatgpt-plan`, runtime `pi`, route `openai.responses.account`.
- **Read-only smoke:** session `ses_70ffdaab22ac7ad08366d4208375e736`,
  turn `turn_9b8794b087cbbe1d98cb5ccde05a8dd1`, task `task_a4aa2ba7-b756-4e91-8000-660e1a7af1a6`;
  17:41:50.040–17:42:45.668 UTC, `succeeded`, lane `cowork` without fallback,
  policy `control@1:auto`, control path `gateway` on the resource above, zero restarts / artifacts.
  UI submitted the exact runbook smoke once. Source file set/hash unchanged; original drafts-only
  permission restored after temporary read-only. No generated content is included here.
- **SOW:** session `ses_03d6ea01051f20bb30ac55435243187a`,
  turn `turn_2e71e456a5dd128c207f1c4075ce4e93`, task `task_72766780-70d4-484b-a9d5-c1feb9fff64a`;
  17:45:09.733–17:48:39.134 UTC, `succeeded`, intent `documentation`, lane `cowork`,
  no fallback, same Auto gateway resource, zero restarts. **No delegated units and no draft artifact
  were recorded. This is not SOW acceptance.** Owner review confirms two workspace writes were
  declined. Source unchanged. No further SOW or dependent live call submitted.
- **SOW policy receipts:** `apr_1854a62497f3f8aee7f915a355ce2b3e` (17:47:23.556 UTC) and
  `apr_45cf324e848eed640e4a46b5a93d6708` (17:48:14.677 UTC) both deny `write_file` with
  `cowork.target-missing.deny`. The owner did not decline an approval. The two earlier submit-tool
  permissions, `apr_befd3520998465ba17a39235ecd33c10` (17:45:46.327 UTC) and
  `apr_41da9b686e4e7f073cd6a98a6ba4fdbb` (17:45:54.715 UTC), were allowed by `cowork.delegation`.
  Allowed tool submissions do not establish successful delegated execution; no completed unit was
  recorded and that failure remains unresolved.
- **Write protocol finding:** pinned upstream 0.3.1 emits `permission_required.data.arguments`,
  with single-file writes using `arguments.path`; Nexar at 12d7ea1 only reads top-level `target`.
  See the [corrected compatibility note](../../research/upstream/openworker-0.3.1-compatibility.md).
  A bounded local correction reduces only `write_file` / `replace_in_file` paths into the existing
  policy, rejects conflicting/malformed destinations and retains legacy target-only support.
  Default offline frames now match upstream without the invented top-level write target.
  Targeted session/policy/Desktop Cowork tests pass **117/117**. Full local `pnpm check` passes:
  **3,981 passed / 158 expected skips**, 195 passed / 16 skipped files; formatting, lint, boundaries,
  typechecking and build passed. Full source Desktop E2E passes **22/22**; Windows unsigned installer
  packaging passes, SHA256 manifest independently matches, Authenticode `NotSigned`. Packaged
  Desktop E2E passes **22/22**. An initial E2E suite failed owner-state preservation while the live
  app remained open; all turns were verified inactive and the app closed before isolated reruns.
  A subsequent integrated-flow lane-confirmation timeout did not reproduce in the isolated scenario
  or the complete final suite. Original assertions and test-file hash preserved; no gate weakened.
  After explicit scanner-only owner authorization, only the existing Gitleaks executable was added
  to lean-ctx's allowlist, keeping its defaults and restricted mode. Gitleaks 8.28.0 scanned the current
  unstaged diff with `stdin --redact --no-banner`: **PASS, no leaks found** (2026-10-07).
  Owner authorized correction/evidence review, commit and push, then full exact-head CI, matching
  Desktop/plane builds and SOW revalidation. At this checkpoint the correction is undeployed;
  exact-head CI above covers 12d7ea1 only. No further provider/model call before the corrected build
  is deployed and its full exact-head CI is green. Record those receipts in the local handoff.
- **Code:** live preflight ready at 17:41:05.248 UTC; project `nxr-055-validation` maps to
  `nxr055-validation`. Initially native Claude authenticated and native Codex unauthenticated. Owner device-auth
  attempted by the owner, but failed before issuance of a device code. Read-only probes found DNS
  resolved while HTTPS to OpenAI and GitHub timed out in the plane; Windows reached OpenAI.
  After the owner closed their VPN, plane probes returned GitHub HTTP 200 and OpenAI generic-root
  HEAD HTTP 403 with TLS verification successful. Connectivity recovered; a root HEAD response is
  not authentication proof. The owner then completed device-auth; Desktop `refreshCode` at
  **18:23:20.722 UTC** verified both `claude-code` and `codex` available/authenticated, project/plane
  `ready`. Both remain native-agent resources, not model-turn controls. No login initiated by the agent.
  No Code turn, engineering write, approval or local commit.
  Integrated flow remains pending; PR stays draft, no merge/release/acceptance push.
- The live app was closed with every project session inactive before isolated gates. Sign-ins were
  not disconnected; drafts-only and Auto retained. Resume only after the next authorized publication,
  exact-head CI and matching-build checkpoint.
- Delegation counts come from Nexar's bounded session receipt because the public DTO omits them.
  Only ids, fixed states, routes, timings and counts were extracted; no credentials or content exported.

### Historical live observations (2026-10-07, feb36dc)

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

**Owner approved publishing the catalog correction and evidence to draft PR #39.** This completed at
`12d7ea1`, with full exact-head CI, matching Desktop/plane builds, fresh inventory and resumed smoke/SOW,
as recorded above. The owner separately authorized publishing the write-permission correction and
acceptance evidence after diff review. Its local gates pass, but the CI and deployed builds above cover
12d7ea1 only; require the correction's own full exact-head CI and matching builds before another live SOW.
No new implementation milestone started. This authorization covers source maintenance; the runbook's
no-push boundary still applies to acceptance-generated engineering commits.

Keep prompts, generated content, tokens, credential contents, account identifiers and raw vendor
output out of this file. A recorded failure/fallback remains a failure/fallback; it is not acceptance.
No acceptance-generated push. No merge/release. PR #39 stays draft until the owner accepts the recorded v0.6 results.
