# NXR-066b historical acceptance and current finalization evidence

## Current targeted acceptance — 2026-10-09, standalone correction PASS

**TARGETED_LIVE_ACCEPTANCE_PASS** at matching Desktop and Plane implementation
`9e71014979db7a7619bb6ac909b8418a0d198573`. The corrected private relay setting
`NEXAR_BRIDGE_STANDALONE_ONLY=1` and actual Control Model MCP schema excluded
`reviewOf`, with additional properties denied. Control output, upstream permission
frame and Bridge input omitted the property; nothing was silently stripped.

- Session `ses_078442699a3e7a43b97dc5231ebd4c3a`; turn
  `turn_28f0f870cf081ad8dc1857ea318beea6`; parent task
  `task_a771a154-b778-4669-9f01-c6de4dcfeada`.
- Cowork / OpenWorker 0.3.1 / GPT-5.6-Luna Control, reason `control.auto`,
  pinned gateway resource
  `inventory:048a60e3b9b7892e466eff536385c50a2168da981a4d3ac61cd0f4c44ba0f2b3`.
- Read-only grant `b5557cda-c057-457a-9579-ca54aa3faa5b`, maximum and shared
  turn ceiling 1. Unit `nxr066-standalone-analysis`; job
  `1b5d9203-ec66-4b63-9598-e042d8ec1820`; NRC decision
  `171f7247-6c13-4a07-8bce-66cab9d79df2`; eligible worker `claude-code`.
- Received/normalized capabilities: `code-review`, `knowledge-work`,
  `text-generation`, unchanged and accepted. Exactly one worker completed
  `succeeded` at 15:52:02.086 UTC; result returned at 15:52:02.899 UTC;
  parent succeeded, zero Control restarts. Monitoring duration 50,450 ms.
- Grant revoked at 15:52:14.011 UTC; no active sessions/jobs, no artifacts;
  original permission restored and passive metadata observer removed.
- Existing validation document's canonical API UTF-8 preview snapshot unchanged;
  source clean. This is not a fresh physical-byte fixture hash. Post-test Plane
  doctor passed, configuration digest unchanged, validation Git tree clean,
  native execution processes absent and isolation preserved.
- Worker receipt: 2 input / 610 output tokens, runtime-reported estimated cost
  USD 0.306552. Control token counters retained locally; Control cost unavailable.
  These are available usage counters, not a complete billing total or hard cap.

Read-only policy continued denying writes, shell, network and foreign MCP while
allowing the two Intelligence Bridge tools. Existing offline capability/alias,
concurrency/restart/remint admission and multi-unit review regressions remain
green. Production default is 16; the restricted invocation does not alter it.

PR [#39](https://github.com/mohmedhat797/Nexar-Ai/pull/39) merged on
2026-10-09 at 15:55:10 UTC as `2f856f935a1ca51fc0f2c179386baa31bd82c3bd`.
[CI 37955286149 attempt 1](https://github.com/mohmedhat797/Nexar-Ai/actions/runs/37955286149/attempts/1) passed all three jobs at that actual merge SHA, including
source/package E2E, packaging and Gitleaks; checkouts independently verified.
The merged tree exactly equals the live-tested implementation tree. See the
[official baseline](Nexar_v0.6_Official_Baseline.md).

Historical SOW/native Code/integrated results below remain attributed to
`2f26b36`; prior failures remain failures. DSH Control is still unconfigured.
No second current acceptance attempt, new authentication, release/tag or
NXR-070 implementation occurred. Detailed sanitized operational receipts remain
in the owner's ignored remediation directory.


## Historical targeted acceptance (2026-10-09, pre-mode correction)

**TARGETED_LIVE_ACCEPTANCE_FAIL** at matching Desktop/Plane
`3cbd6a66426407be6a588506a32fc47046f888ae`. The parent Cowork turn completed,
but no delegated unit was submitted or completed. Session
`ses_c8f833a2e22846963053272b0be3ceb4`, turn
`turn_67a040c3382820cf98ff6495596b3e10`; read-only grant maximum 1, revoked on
cleanup. No artifact, active execution or fixture API change remained.

See [read-only delegation correction](nxr-066-read-only-delegation-correction.md)
for the upstream mode incompatibility, regression evidence and remaining gate.
No repeat paid attempt or merge is authorized by the failed attempt's receipt.
The owner's finalization instruction withdraws the former artificial cost/time
ceilings and permits normal runtime recovery, but a second paid acceptance still
requires renewed authorization. PR #39 remains unmerged.

## Historical NXR-066b acceptance at 2f26b36 — all stages PASSED

Prepared 2026-10-07, updated 2026-10-08 for deployment generation `2f26b36f35d874702e29e4c9ef3f63d6aea1a216`.
Exact-head CI [37776301563 attempt 2](https://github.com/mohmedhat797/Nexar-Ai/actions/runs/37776301563/attempts/2)
passed all 3 jobs (secrets, Ubuntu, Windows). Matching Desktop and WSL2 `nexar-plane` builds deployed.
Follow the [owner runbook](nxr-066-live-acceptance-runbook.md).

## Gates and environment

- [x] Full exact-head CI for deployed `2f26b36`: [37776301563 attempt 2](https://github.com/mohmedhat797/Nexar-Ai/actions/runs/37776301563/attempts/2), Ubuntu/Windows/secrets, source/packaged E2E, installer/SHA256 upload passed.
- [x] Windows OpenWorker **0.3.1** (`>=0.3.1 <0.4.0`) and private-server startup verified; separate 0.3.0 retained.
- [x] Desktop built at `2f26b36`; owner authorized existing-profile launch in this live session.
- [x] Plane built at `2f26b36`; doctor and 7/7 sandbox selftests passed.
      Live Desktop `refreshCode` confirmed project `nxr-055-validation` mapped to `nxr055-validation`,
      state `ready`, both Claude/Codex authenticated.
- [x] Owner explicitly initiated the live stages after the runbook STOP boundary.

## Owner results

| Stage                   | Record only                                                                                                 | Result                                                                               |
| ----------------------- | ----------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| Connections/inventories | Connection id, route, returned model/resource ids, freshness, reason codes                                  | PASS; fresh authenticated account catalog at 2f26b36                                 |
| Read-only smoke         | Task id, lane, resource/model, selection reason, timing, outcome; zero modifications                        | PASS; gateway, source unchanged                                                      |
| Cowork SOW              | Task/unit ids, control resource, subscription unit resource, lane, outcomes, draft artifact id              | PASS; OpenWorker 0.3.1 on Luna, 1 unit on Claude Code, draft artifact, source clean  |
| Code                    | Task id, lane resources, executor/fallback reason, sandbox/gate/review status, approval id, local commit id | PASS; Claude Code feature, Codex review, gate/verdict approve, local commit, no push |
| Integrated flow         | Conversation/turn/task ids, lane decisions, resources, outcomes                                             | PASS; 1 session, SOW Cowork -> Repo Review Code -> Impl Code commit, all turns green |

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
- **SOW live retry observations (944b602):** session `ses_bc471dc526ea480b28b551b6c26a1f2d`,
  turn `turn_9647b6fdef341c284b992681fd9f525f`, task `task_dba3a362-b73e-40df-8872-f6feb830023e`.
  OpenWorker reached Cowork on fresh NRC resource `gpt-5.6-luna`, but failed acceptance due to two
  verified protocol defects:
  1. Bridge rejection of delegation sentinel: OpenWorker 0.3.1 sent `reviewOf: "none"`, which Nexar treated
     as a real unit ID and rejected with `unknown-reviewed-unit` (`review-target-missing`).
  2. Zero draft artifacts imported: OpenWorker 0.3.1 wrote `statement-of-work-nxr-055-live-validation.md`
     into its conversation workspace directory (`~/OpenWorker/<sessionId>`) rather than Desktop's private
     scratch parent directory, leaving zero drafts recognized by Nexar. Source project files remained unmodified.
- **Protocol adaptation fix & local gates:**
  1. Delegation normalization: Added `normalizeReviewOf` in `@nexar/contracts`, `@nexar/engine-gateway`,
     and `@nexar/integration-mcp` to normalize `"none"`, `"null"`, `""`, whitespace, and `null` to `undefined`,
     while strictly preserving real review unit IDs and rejecting malformed/non-existent targets.
  2. Workspace draft import: Added `openWorkerWorkspaceDir` resolution and updated `collectDrafts` and
     Desktop `importDrafts` to inspect both scratch and workspace directories with canonical `realpath`
     containment checks, ignoring `tool-output/`, `workers/`, and hidden files without weakening source write policy.
  3. Offline regression tests (Criteria A–J) added and passing in contracts, engine-gateway, mcp,
     openworker, and desktop cowork suites.
  4. Local quality gates:
     - `pnpm check`: PASS (3,988 passed / 158 skipped, 195 test files; format, lint, boundaries, typecheck, test, build).
     - Source Desktop E2E: PASS (8/8 files, 22/22 tests).
     - Windows packaging: PASS (`release/desktop/win-unpacked/Nexar.exe` and NSIS installer).
     - Packaged Desktop E2E: PASS (8/8 files, 22/22 tests).
     - Gitleaks (8.28.0 scanner-only): PASS (no leaks found).
- **SOW live acceptance attempt (4c69d1c):** session `ses_f0188bb478fb26313534ae3f5b92a92d`,
  turn `turn_20366d2eac8c9a67e56a43a1c0cc2cbc`, task `task_853a91b1-b569-43e1-9702-e4791ed554de`.
  - Lane: `cowork` (`requestedLane: cowork`, `effectiveLane: cowork`), fallback: `none` (`fallbackReason: undefined`).
  - Engine: OpenWorker `0.3.1` (path `gateway`), zero restarts.
  - Control resource: `inventory:048a60e3b9b7892e466eff536385c50a2168da981a4d3ac61cd0f4c44ba0f2b3` (`gpt-5.6-luna`).
  - Normalization & Draft Import verified in live turn:
    - Sentinel `reviewOf: "none"` normalized to `undefined`; `mcp__nexar__nexar_intelligence_submit` accepted,
      minting `jobId: 57ff8103-c2f4-450f-a0e5-243098ad9ec8` (`apr_9af12f1749a57397ee23f9e131e5a06e` allowed).
    - Workspace write `SOW_NXR-055_Live_Validation.md` (19,729 bytes) allowed by `cowork.scratch-write.allow`
      (`apr_b8f5deb47994a3b43d494f4b00d653d6`) and imported as a draft artifact into Nexar.
    - Zero unauthorized source modification: `README.md` SHA256 unchanged.
  - Delegated unit execution failure:
    - Delegation requests: 1 (`unitId: sow-draft-1`). Completed units: **0** (outcome `failed`).
    - Root cause: OpenWorker requested capabilities `["requirements-analysis", "technical-writing", "project-planning"]`.
      Nexar's resource registry hard-filter rejects candidates lacking any requested capability (`capability.missing`),
      and no inventory resource declares these bespoke strings, returning `NO_ELIGIBLE_RESOURCE`.
  - Verdict: **FAIL** (criterion: completed delegated units $\ge 1$ not met). **STOPPED before Code acceptance.**
- **Delegation capability normalization fix & local gates:**
  1. Root cause: OpenWorker requested task-description / skill-hint strings `["requirements-analysis", "technical-writing", "project-planning"]`
     in `mcp__nexar__nexar_intelligence_submit`. NRC hard filters strictly enforce required capabilities against candidate descriptors;
     neither `gpt-5.6-luna` (`['text-generation', 'knowledge-work', 'model-turn']`) nor `claude-code` (`['text-generation', 'reasoning', 'knowledge-work', 'coding', ...]`)
     advertises these bespoke strings, failing with `NO_ELIGIBLE_RESOURCE` (`capability.missing`).
  2. Bounded delegation boundary compatibility fix:
     - `integrations/mcp/src/bridge-relay.ts`: Updated `SubmitInput.capabilities` schema description to explicitly advertise
       canonical Nexar capabilities (`text-generation`, `reasoning`, `knowledge-work`, `coding`, `repo-editing`, `code-review`, `tool-use`, `shell-execution`, `long-context`, `web-research`, `vision`, `model-turn`).
     - `@nexar/contracts` (`packages/contracts/src/capabilities.ts`): Added deterministic allowlisted mapping `VERIFIED_CAPABILITY_ALIASES`:
       `requirements-analysis` $\rightarrow$ `knowledge-work`, `technical-writing` $\rightarrow$ `text-generation`, `project-planning` $\rightarrow$ `knowledge-work`.
       Added `normalizeCapability`, `normalizeCapabilities`, and `normalizeCapabilitiesInput`.
     - Preserved hard capability filtering: canonical capabilities and unknown capabilities are preserved as-is so unrecognized
       requirements fail closed with `capability.missing` (`NO_ELIGIBLE_RESOURCE`).
     - Wired normalization at delegation boundaries: `bridge-relay` MCP tool preprocessor, `endpoint` bridge input parser, and `bridge.submit`.
  3. Regression tests:
     - `packages/contracts/src/capabilities.test.ts`: Canonical capability preservation, verified legacy aliases, whitespace/case handling, unknown capability preservation (fail-closed), deduplication, input helper.
     - `integrations/mcp/src/bridge-relay.test.ts`: Canonical capability advertising in tool description, relay boundary normalization, preservation of unknown capabilities in wire frame.
     - `packages/engine-gateway/src/bridge.test.ts`: Normalization of legacy aliases matching eligible resources (`luna`), fail-closed `NO_ELIGIBLE_RESOURCE` on unknown capabilities.
     - `packages/engine-gateway/src/endpoint.test.ts`: Socket/pipe submission normalization of legacy aliases.
  4. Local quality gates:
     - `pnpm format:check ; pnpm check:boundaries ; pnpm lint`: PASS (914 tracked files).
     - Full `pnpm check`: PASS (4,006 passed / 158 skipped, 196 test files; format, lint, boundaries, typecheck, test, build).
     - Source Desktop E2E: PASS (8/8 files, 22/22 tests).
     - Windows packaging: PASS (`release/desktop/win-unpacked/Nexar.exe` and NSIS installer).
     - Packaged Desktop E2E: PASS (8/8 files, 22/22 tests).
     - Gitleaks (8.28.0): PASS (229 commits scanned, no leaks found).
- **SOW live retry observations (1feb97f):** session `ses_e528a47ffdc84157a9f5383501a18da0`,
  turn `turn_e105545b99478ab65f1a65cb7f745532`.
  - Lane: `cowork` via OpenWorker 0.3.1 gateway, control resource: `gpt-5.6-luna`.
  - Capability normalization verified: OpenWorker submitted delegation request `sow-draft-1` with normalized capabilities;
    Nexar minted `jobId: bba779ae-6616-4745-822e-0c3b7ca11a49`, matched capabilities, allocated `claude-code`, and started execution `task_b5f5a53a-71d5-40aa-bca0-638b418c9e1e`.
  - Premature turn completion / yield failure: OpenWorker polled `nexar.intelligence_status` twice (0ms return), observed `{"state": "running"}`,
    and called internal tool `sleep_for {"seconds": 5}`. In OpenWorker, `sleep_for` yields the turn (`turn_done`). Nexar Desktop treated `turn_done` as
    turn completion, ran session cleanup in `cowork.ts`, removed the loopback `openai` provider, and revoked the grant. When OpenWorker resumed 5s later,
    it had no credentials and aborted the in-flight delegated unit.
  - Verdict: **FAIL** on turn continuity. **STOPPED before Code acceptance.**
- **In-turn status polling adaptation & local gates:**
  1. Instruction: Updated `DELEGATION_INSTRUCTION` in `apps/desktop/src/main/cowork.ts` instructing OpenWorker not to call timer tools (`sleep_for`),
     and to wait by polling `nexar.intelligence_status` directly in the turn until complete.
  2. Bounded polling in bridge relay: Updated `integrations/mcp/src/bridge-relay.ts` so `nexar.intelligence_status` waits up to 15s (1s poll interval)
     while state is `running`, returning immediately once `state: 'done'`.
  3. Regression tests: Added test suite in `integrations/mcp/src/bridge-relay.test.ts` (polling while running until done, timeout after deadline,
     immediate return on errors). All 15/15 tests passing.
  4. Local quality gates:
     - `pnpm format:check ; pnpm check:boundaries ; pnpm lint`: PASS (915 tracked files).
     - Full `pnpm check`: PASS (4,009 passed / 158 skipped, 196 test files; format, lint, boundaries, typecheck, test, build).
     - Source Desktop E2E: PASS (8/8 files, 22/22 tests).
     - Windows packaging: PASS (`release/desktop/win-unpacked/Nexar.exe` and NSIS installer).
     - Packaged Desktop E2E: PASS (8/8 files, 22/22 tests).
     - Gitleaks (8.28.0): PASS (230 commits scanned, pre-commit diff scanned, 0 leaks found).
- **Full exact-head CI & deployment (2f26b36):**
  - Commit `2f26b36f35d874702e29e4c9ef3f63d6aea1a216` pushed to `feat/nexar-resource-orchestration`.
  - CI Run: [37776301563 attempt 2](https://github.com/mohmedhat797/Nexar-Ai/actions/runs/37776301563/attempts/2), all 3 jobs green (`secret scan`, `ubuntu-latest`, `windows-latest`).
  - Deployed matching builds to `D:/Nexar-Ai-acceptance-nxr066` and WSL2 `nexar-plane`.
  - Doctor & 7/7 sandbox selftests passed. Hardening, non-root user, and clean repo maintained.
- **SOW live acceptance (2f26b36) — PASS (§14.2):**
  - Session: `ses_92b2d52f7b895d1f2ca58c37d86bc468`, turn: `turn_eb06ed623a104ea5c34e718d3755f09e`, task: `task_f7c2dbe2-8e80-47f3-93fb-42b3f0a947df`.
  - Lane: `cowork` (`requestedLane: cowork`, `effectiveLane: cowork`), fallback: `none`.
  - Engine: OpenWorker `0.3.1` (path `gateway`), 0 restarts.
  - Control resource: `inventory:048a60e3b9b7892e466eff536385c50a2168da981a4d3ac61cd0f4c44ba0f2b3` (`gpt-5.6-luna`).
  - Delegation: 1 delegation request (`sow-review`), 1 completed unit (`succeeded`). Executed on `claude-code` (`subscription:anthropic:claude-code`, tokens: 4,056 out, cost: $1.017).
  - Artifact import: `SOW_NXR-055_Live_Validation.md` (23,426 bytes, SHA256: `9fd68541b82e22f268b6f93d643f0fcff3f5eaddbab03b8e3e1c5d0e7444c476`) imported as draft artifact.
  - Source integrity: Fixture `README.md` SHA256 unchanged (`0734D41F7E5A9FA94C2C19B4AB24285575F73E8B12A993C7185FAF2F63F5A9C0`).
  - Verdict: **PASS**.
- **Code change live acceptance (2f26b36) — PASS (§14.3):**
  - Session: `ses_c5543812dc2c8d06b470bb6b48505cf0`, turn: `turn_55a017d4f23020cbcca2d2d36c4cf1fb`, plane task: `eng-2b34ab77d5fc`.
  - Prompt: `"Add a one-line comment at the top of src/slugify.js describing the module."` with kind `coding`.
  - Lane: `code`, executor: native on plane. Lane diversity: `feature=claude-code`, `review=codex`.
  - Gate / review: 1 gate passed, review verdict: `approve`.
  - UI approval: `apr_3ae302dc1a39f547e7594c1d1d803ba8` approved via Desktop UI (`data-testid="approve-commit"`).
  - Local commit: `df045a6b879db447fbe197ffa719881f96d6e0c1` minted on branch `nexar/eng-2b34ab77d5fc`.
  - Clean working tree: validation `main` branch clean at `40f02fb`, zero remote push.
  - Verdict: **PASS**.
- **Integrated flow live acceptance (2f26b36) — PASS (§14.4):**
  - Session: `ses_efca9e3bac68ec7bee56f1e1904c3a7b` on project `nxr-055-validation`. Single continuous conversation, no manual resource selection.
  - **Turn 0 (Proposal — Cowork):**
    - Turn: `turn_f064c3cc9bd2fea74bf849d92967716d`, prompt: `"Create a professional SOW using this project."`.
    - Lane: `cowork` (`requestedLane: cowork`, `effectiveLane: cowork`), fallback: `none`.
    - Control: OpenWorker 0.3.1 gateway on `gpt-5.6-luna` (`task_9fa05b4f-d676-489b-b1c4-2c1a731e73d2`, 0 restarts).
    - Draft artifact: `SOW_NXR-055_Live_Validation.md` (22,455 bytes, draft: true) saved.
    - State: `succeeded`.
  - **Turn 1 (Repository Review — Code report-only):**
    - Turn: `turn_c7d7b7ef0e47616ce01a627d5d96aae8`, prompt: `"Review this repository."`.
    - Lane: `code` (`mismatch: { from: 'cowork', to: 'code' }`, user confirmed).
    - Plane task: `eng-ff9cde4ca569`, status: `reported`. Role: `report` on `claude-code`.
    - State: `succeeded`.
  - **Turn 2 (Implementation — Code write, approval, local commit):**
    - Turn: `turn_f7eda718bf1599a0579b9dc0f5c54e1a`, prompt: `"Add a one-line comment at the top of src/slugify.js describing the module."` (`kind: coding`).
    - Lane: `code` (`mismatch: { from: 'cowork', to: 'code' }`, user confirmed).
    - Plane task: `eng-11b9cb225211`. Lane diversity: `feature=claude-code`, `review=codex`.
    - Gate / review: 1 gate passed, review verdict: `approve`.
    - Approval: `apr_86d4820b58e68ccfb48c602fef771021` confirmed via UI.
    - Commit: `cab1156e35539414ef9f7591b47428c8f93f1102` on branch `nexar/eng-11b9cb225211`.
    - Working tree on `main` untouched (`40f02fb`), zero remote push.
    - State: `succeeded`.
  - Verdict: **PASS**.
- **Code preflight:** live preflight ready at 17:41:05.248 UTC; project `nxr-055-validation` maps to
  `nxr055-validation`. Both `claude-code` and `codex` available/authenticated, project/plane `ready`.
- The live app was closed with every project session inactive after acceptance. Sign-ins were
  not disconnected; drafts-only and Auto retained.
- Keep prompts, generated content, tokens, credential contents, account identifiers and raw vendor
  output out of this file. All acceptance stages passed; PR #39 stays draft awaiting owner authorization.
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
