# Nexar current project state

**This file is the authoritative current state.** It supersedes the "CURRENT STATE", "NEXT EXACT
TASK" and "BLOCKERS" sections of older handoffs (for example
[`operating-layer-progress.md`](operating-layer-progress.md), which keeps the detailed history).
Update this file at every milestone checkpoint.

## Snapshot (2026-10-07, OpenWorker 0.3.1 compatibility maintenance)

Branch `feat/nexar-resource-orchestration`; draft/open [PR #39](https://github.com/mohmedhat797/Nexar-Ai/pull/39).
Reconciliation found clean local/remote head `c68c7bd7b1366e3bb9a3dc71057a573b19d27aa7` and full
[CI 37621704929 attempt 1](https://github.com/mohmedhat797/Nexar-Ai/actions/runs/37621704929/attempts/1)
green (Ubuntu, Windows, secrets, source/packaged E2E, installer/SHA256 upload), completed
2026-10-07 12:49:51 UTC. The prior `0244d97` implementation CI is also green. Billing outage is
historical. This maintenance commit needs **its own full exact-head CI** before environment
update, acceptance, merge or release; the final handoff records that run without a commit loop.

[Verified upstream v0.3.1](../research/upstream/openworker-0.3.1-compatibility.md), commit
`b9b35036668dfb1653f3aa35bafb9aeea6d47c3c`: existing private-server/session contract compatible,
**no protocol migration**. Supported floor becomes **`>=0.3.1 <0.4.0`**, preferred live target 0.3.1.
Offline fixtures cover canonical version parsing, public health versus protected auth, HTTP-200
MCP/root refusals and new ready/network permission fields. Supervisor/private state, gateway,
bridge, NRC, approvals and WSL2/bubblewrap design remain intact; ADR-027/028 are unchanged.

Previous preparation actually installed an isolated **0.3.0** Windows Python runtime with separate
server/version paths and passed Nexar-supervised private health. Desktop's detached acceptance
checkout and `nexar-plane` were advanced/built at **c68**, doctor and **7/7 sandbox selftests** passed,
validation `main @ 40f02fb` and config/hardening unchanged. The earlier PATH-missing/plane-2dbb
snapshot below describes initial preflight, not the latest preparation. The 0.3.0 runtime is now
below the new floor: preserve it and prepare a separate **0.3.1** environment after new-head CI.
Final handoff records actual runtime/checkout updates and readiness.

**NXR-066b remains owner live acceptance pending.** Agent preparation stops before existing-profile
Desktop startup (automatic ChatGPT inventory refresh), provider login/catalog calls/native metadata
initialization/inference. Use the revised [owner runbook](evidence/nxr-066-live-acceptance-runbook.md).
No new milestone started. [NXR-069 Runtime Discovery](../backlog/069-openworker-runtime-discovery.md)
is a deferred specification only; headless `openworker run` evaluation is deferred to NXR-054 /
v0.8 Automation, and OpenShell 0.1.2 adoption is deferred. Local gates are recorded in the
[compatibility gate evidence](evidence/openworker-031-local-gates.md); later CI/env receipts belong
in the final handoff.

## Historical snapshot (2026-10-07, initial acceptance preflight)

Implementation continues on `feat/nexar-resource-orchestration`, draft
[PR #39](https://github.com/mohmedhat797/Nexar-Ai/pull/39), after architecture checkpoint `3c893a7`.
Full exact-head [CI 37553210679, attempt 2](https://github.com/mohmedhat797/Nexar-Ai/actions/runs/37553210679/attempts/2)
passed for `0244d974704b9350a2ddec873872514db8d5de1a`: Ubuntu, Windows and secret scan, including
source Desktop E2E, Windows packaging, packaged E2E and installer/SHA256 upload. Completed
2026-10-07 at 10:42:24 UTC (13:42:24 Cairo). PR #36 is merged at `76de2e1`; PR #39 remains draft.
This evidence applies to `0244d97`; any later committed head needs its own full CI before merge/release.

NXR-068 architecture checkpoint: ADR-028, upstream comparison, backlog and blocked runbook are
reviewed. Full local `pnpm check` passed on Node 22.23.3 / pnpm 10.33.0 (3,814 passed, 158 skipped,
build passed). An earlier Node 24 run crashed one Vitest worker; the repository specifies Node 22.
Architecture checkpoint `3c893a7` is pushed. Its Ubuntu checks and Windows code/build/packaged E2E
passed; installer upload hit GitHub artifact quota. Owner-approved cleanup removed 50 older archives,
preserving latest main/PR installers. The retry could not start because of GitHub billing/spending
limits. **Historical owner revision (2026-10-07): continue development with strengthened local gates
while CI was unavailable. Billing was subsequently restored and exact-head CI passed for `0244d97`.
Full exact-head CI remains mandatory before merge/release.**
Each coherent unit must pass pinned Node 22 / pnpm 10.33.0 full check, offline Desktop E2E,
Windows packaging and packaged Desktop E2E, plus review. No CI success is inferred from local results.

**NXR-068 implementation checkpoint:** strengthened local gates passed on Node 22.23.3 /
pnpm 10.33.0: full `pnpm check` (3,960 passed, 158 skipped; build passed), source Desktop E2E
(22/22), Windows unsigned installer/SHA256 and packaged Desktop E2E (22/22). Offline CLI smoke
and pinned Gitleaks history/staged scans passed. Full E2E found and fixed an async picker refresh
race; read-only review also verified refresh/write ownership. See the
[local gate evidence](evidence/nxr-068-local-gates.md) for commands, skips and provider boundaries.
Exact-head CI also passed for `0244d97`; no merge, release or owner live acceptance has occurred.

**v0.6 is implemented offline, not owner-accepted. NXR-068's implementation/CI gate is cleared for
`0244d97`; NXR-066b is prepared, pending owner environment setup and live initiation.** The owner's
first Cowork smoke reported two independent findings: OpenWorker unavailable on Windows (environment
acceptance), and account-backed inference rejecting the assumed `gpt-5.2` (provider architecture).
ChatGPT sign-in succeeded; connection success did not establish model availability. No live
authentication or allowance-consuming tests are authorized implicitly by this continuation.

Read-only preparation verified Windows OpenWorker availability separately: upstream v0.3.0 has
Windows x64 installers and Python CLI/server entry points, but this machine's configured default
`openworker` / `openworker-server` commands are absent from PATH and its Python 3.13 installation.
No installed 0.3.x runtime or live Cowork readiness is claimed. `nexar-plane` is clean at `2dbb070`,
with Node 22.23.3 / pnpm 10.33.0, hardened WSL settings and `nxr055-validation` intact. Its source
must be updated and rebuilt to the same CI-verified documentation-checkpoint SHA as Desktop
(implementation generation `0244d97`) before acceptance. This describes the initial preflight;
the final preparation handoff records installation/build results and the new exact-head CI without
an unnecessary follow-up commit just to record CI. Exact owner commands, runtime setup,
UI sequence and the stop boundary are in the [owner runbook](evidence/nxr-066-live-acceptance-runbook.md).
The current request is documentation/preparation only; no new implementation milestone starts.

### Implementation-state audit

- **059:** authenticated turn-scoped local IPC bridge, stdio MCP relay, OpenWorker registration,
  bounded delegated units and lineage; implemented with offline tests.
- **060:** first-run echo migration, `ProviderConnection`, connection/support metadata, `model-turn`
  compatibility, plane resource reporting; implemented. Provider and connection ids are separate,
  but native discovery currently infers one default connection per runtime.
- **061:** pure `strategy@1`, plan allocation, ledger and runtime revalidation; implemented.
- **062:** Control Model Gateway (pinned decisions, tool turns, explicit restart) and Intelligence
  Execution Bridge; implemented. Neither owns provider authentication.
- **063:** supervised loopback translator child and OpenWorker control through Nexar, units through
  the bridge; implemented. OpenWorker is still the Cowork engine; its unavailability is separate.
- **064:** plane-local gateway/relay, DSH ACP control overlay, native fallback with executor facts;
  implemented. Automatic Code lane restart from base after control failure remains follow-up work.
- **065:** provider-family cards, compatible control picker, policy IPC, plane read-only facts;
  implemented. Providers now shows connection-specific inventories, freshness and explicit refresh.
- **066a:** offline orchestration acceptance implemented (`4feddd7`, `122d978`); **066b prepared,
  owner environment/live results pending**.
- **067a:** Nexar-owned ChatGPT PKCE sign-in, supervised callback, encrypted tokens, refresh and
  disconnect implemented (`bf222e6`) and owner-reported sign-in succeeded.
- **067b / 068:** dynamic account Responses model listing replaces the assumed model and static
  catalog dependence. Returned slugs execute through a custom Responses provider; function tools
  round-trip in offline fixtures. Live route compatibility remains owner-unverified.
- **068:** versioned bounded public cache restores stale; generation invalidation, TTL, rejection
  refresh and fresh-only publication/execution are implemented. Metadata-only Claude SDK discovery
  and explicit Google CLI listing publish native-agent variants. Native Codex honestly exposes
  provider default until a browser-safe model/list version is verified. Strict IPC and Providers
  UI use the existing Auto/pinned strategy; raw legacy model hints are preserved, and old Desktop
  model pins resolve to the new stable tuple IDs without rewriting the original settings.

Current resource model is ADR-007 descriptor/state, with connection metadata from ADR-027. API/local
models remain pi-ai catalog/owner-listed endpoint resources. Native Claude Code, Codex and Antigravity
are agent resources; inventory variants use per-invocation model overrides, never vendor global defaults.
Claude authentication uses its vendor CLI; Codex native authentication is distinct from Nexar's
ChatGPT plan connection and cannot prove the account Responses route's models. Antigravity has an
experimental `agy` executor; model listing is explicit owner refresh, no longer a routine probe.
Desktop native Google sign-in/status remains unsupported or unknown; listing is not auth proof.

### Discrepancies and gaps

The older snapshot below and README's "coming next" Desktop section are historical. Backlog 059–065
checkboxes are design acceptance lists, not the current ledger. NXR-068 has offline implementation;
full local and exact-head CI evidence is recorded for `0244d97`. Owner live acceptance remains
outstanding. Native model-rejection invalidation uses only verified structured
signals; no reliable Claude/Google signal was found, so generic CLI error text is not reclassified.
Legacy descriptors without generation metadata cannot invalidate a newer account from a late error.
Inventory refresh never swaps a resource inside an active control loop. Installing/verifying the
Windows OpenWorker runtime and updating the plane remain acceptance prerequisites. Google ACP
migration, plane-side account login and automatic Code replay remain separate follow-ups.

The older snapshot and Operating Layer details below remain historical context.

| Item                           | Value                                                                                                                                                                                                                                       |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Default branch                 | `main`                                                                                                                                                                                                                                      |
| Latest merged PR               | #36 "Nexar Desktop — Windows foundation and Operating Layer integration" (merge commit; `git log --first-parent -1 main`)                                                                                                                   |
| PR #36 head before this report | `2737b7c`, CI run `37153390661` green (Ubuntu, Windows, secret scan); local `pnpm check` green (3,179 passed / 125 skipped, 766 tracked files)                                                                                              |
| Latest milestone               | v0.5 Operating Layer (NXR-051/052/053/055/056/057/058) merged; NXR-054 not started                                                                                                                                                          |
| Open PRs after the merge       | none                                                                                                                                                                                                                                        |
| Remote branches kept           | `feat/nexar-v0.2-personal-work`, `feat/nexar-v0.3-engineering-machine`, `feat/nexar-v0.4-resource-intelligence`, `claude/eager-ptolemy-j5bbnj`, `feat/nexar-operating-layer`: all fully contained in `main` (kept by repository convention) |

## Historical milestone ledger (2026-10-04)

| Milestone                                  | State                              | Notes                                                                                                                                                                                                           |
| ------------------------------------------ | ---------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| v0.1 Foundation                            | DONE                               | Engine, NRC `deterministic@1`, adapters, telemetry. Follow-ups NXR-001..005 listed in the backlog.                                                                                                              |
| v0.2 Personal Work                         | DONE                               | Projects, artifacts, approvals, MCP Work Bridge, workflows (NXR-010..016). NXR-017 export formats planned.                                                                                                      |
| v0.3 Engineering Machine                   | DONE                               | Sandbox, worktrees, lanes, gates, review, owner-approved commits; Codex, DSH ACP, Delegate Skills, experimental Antigravity. WSL A1–A6 passed on the owner machine 2026-10-03. Follow-ups NXR-025..029 planned. |
| v0.4 Resource Intelligence                 | DONE                               | `resource-intelligence@1`, quota, cost, history, discovery (NXR-030..034).                                                                                                                                      |
| v0.5 Desktop foundation (NXR-050)          | DONE                               | Electron shell, host, validated bridge, projects, Cowork chat.                                                                                                                                                  |
| v0.5 Operating Layer                       | MERGED; partly live-validated      | See the table below.                                                                                                                                                                                            |
| NXR-054 Scheduled tasks                    | NOT STARTED                        | Waits for v0.6 live acceptance (NXR-066).                                                                                                                                                                       |
| v0.6 Resource orchestration (NXR-059..066) | ARCHITECTURE ACCEPTED, NOT STARTED | [ADR-027](../adr/027-resource-orchestration-architecture.md), [plan](../architecture/resource-orchestration-plan.md); branch `feat/nexar-resource-orchestration`                                                |
| v0.7 Memory, v0.8 Automation               | NOT STARTED                        | Roadmap.                                                                                                                                                                                                        |
| Nexar Mobile / control plane               | DEFERRED                           | Owner decision 2026-10-02.                                                                                                                                                                                      |

## Acceptance and live validation (v0.5)

| Area                              | Implementation | Offline tests   | CI              | Owner live validation             | Notes                                                                                                                                                                                  |
| --------------------------------- | -------------- | --------------- | --------------- | --------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| NXR-051 Windows foundation        | done           | yes             | Windows + Linux | installer acceptance pending      | [`windows-validation.md`](../guides/windows-validation.md)                                                                                                                             |
| NXR-052 Providers / key store     | done           | yes             | yes             | not run                           | Real keys, native sign-in buttons unverified live                                                                                                                                      |
| NXR-057 Sessions                  | done           | yes             | yes             | exercised in the NXR-055 live run | Issue #37                                                                                                                                                                              |
| NXR-058 Intent and lanes          | done           | yes             | yes             | exercised in the NXR-055 live run | Issue #38; "review this repository" classifier fix `6f3bd1f`                                                                                                                           |
| NXR-055 Code lane / `nexar-plane` | done           | fake plane      | yes             | **PASSED** 2026-10-03             | A1–A5 pass, A6 recorded; real review, change, Desktop approval, local commit, no push, cancel; commit-subject fix re-validated live ([evidence](evidence/nxr-055-owner-validation.md)) |
| NXR-056 Cowork / OpenWorker       | done           | fake OpenWorker | yes             | not run                           | OpenWorker 0.3.x not installed on the owner machine                                                                                                                                    |
| NXR-053 AI behavior (v1 matrix)   | done           | yes             | yes             | not run                           | Code "Plan"/"Auto-edit" and Cowork profiles; needs the live lanes                                                                                                                      |
| Integrated Operating Layer flow   | done           | one-session E2E | yes             | partial                           | Code half live; Cowork half pending NXR-056                                                                                                                                            |

## Owner machine (engineering plane)

`nexar-plane` WSL2 distro (Ubuntu 24.04.5, hardened `wsl.conf`, user `nexar` without sudo), Nexar
built from a git bundle (last at `2dbb070`) with the root-owned launcher `/usr/local/bin/nexar`,
validation project `nxr055-validation` at `/home/nexar/validation/repo`. Claude Code is signed in
inside the plane; Codex is installed but not signed in; DSH is installed without a DeepSeek key. After
source changes that affect the plane, bring a new bundle in and rebuild inside the distro.

## Deferred

NXR-054 scheduled tasks (after the live Operating Layer flow), Nexar Mobile and the control-plane
daemon (owner deferral), Memory (v0.7), Automation (v0.8).

## Known blockers and debt (verified 2026-10-04)

- Live validation still open: OpenWorker Cowork turn (NXR-056), AI behavior on live lanes (NXR-053),
  installer acceptance (NXR-051), real provider keys and native sign-in (NXR-052).
- Codex is not signed in inside `nexar-plane`, so live cross-resource review is unexercised.
- A pending lane confirmation's run options live in memory; after a restart the owner can only
  decline and resend.
- `sessions:list` reads at most 200 sessions before filtering; a reused process id can make a stale
  sessions lease look live (fails closed).
- Windows descendants of an exited process leader need a Job Object for containment; write-capable
  engineering still requires WSL2/bubblewrap (no native fallback).
- External config state-directory overrides need their own ACL audit; Windows artifact storage needs
  hard-link support.
- Windows CI occasionally stalls (timeouts in unrelated tests); a re-run of the job has passed each
  time so far.

## Recent important commits

| SHA       | Purpose                                                                      |
| --------- | ---------------------------------------------------------------------------- |
| `f6f885a` | Integrated Operating Layer E2E in one session                                |
| `2141f55` | Fix: join the pending conversation when sending right after New conversation |
| `6f3bd1f` | Fix: classify "review this repository" as review                             |
| `f9793ca` | NXR-055 owner acceptance recorded                                            |
| `2dbb070` | Fix: engineering commit subject from the owner's request (`run.title`)       |
| `934db0f` | Fix: end a starting OpenWorker before Desktop quits                          |
| `2737b7c` | E2E budget for slow cold starts, bounded cleanup                             |

## Architecture correction (2026-10-04)

The owner's core requirement is that Nexar uses their subscriptions (Claude, ChatGPT/Codex, Google),
API keys and local models across Cowork and Code, configured once. The audit found that Cowork could
not use subscriptions (ADR-026 §4), that DSH was only a lane resource, and that Desktop Auto routed
to the `local-echo` test double even with an authenticated Claude Code. ADR-027 (revision 2) makes
Nexar the unified intelligence gateway: engines consume Nexar through the Engine Gateway (Control
Model Gateway + Intelligence Execution Bridge); control and work resources are separate, both from one
registry, both owner-configurable or NRC Auto, subscriptions included wherever an adapter provides
`model-turn`. The ADR-022 amendment allows owner-enabled experimental client-compatible subscription
auth (Nexar's own isolated login, never harvested; Antigravity excluded by its terms). Compatibility
evidence: [`subscription-control-compatibility.md`](../research/upstream/subscription-control-compatibility.md).
The previous next task (install OpenWorker and give it an API key) is superseded.

## v0.6 implementation history (superseded status: see the 2026-10-06 audit above)

| Unit                                                  | State                                   | Commits                                                                                                                                                                                                                                              |
| ----------------------------------------------------- | --------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| ADR-027 rev. 2, plan, spike, ADR-022 auth amendment   | done                                    | `12c6e00`, `ec33f1a`, `5fcbc86`                                                                                                                                                                                                                      |
| NXR-060 Provider connections + compatibility metadata | done (CI green)                         | `2b5edd4` echo default removed + migration, `1363dc8` connections + `model-turn`, `ebb8c37` E2E seed (echo explicit, real CLIs excluded), `b58484f` plane resources over `nexar-plane/1`                                                             |
| NXR-061 Resource Strategy Planner                     | done                                    | `ae320e2` pure `strategy@1`, `23fa38c` Code lanes planned upfront (records `planned`/`fallback`)                                                                                                                                                     |
| NXR-062 Engine Gateway                                | done (CI green)                         | `42ba31b` Control Model Gateway + pi `ModelTurnPort`, `d33a65b` Intelligence Execution Bridge                                                                                                                                                        |
| NXR-059 OpenWorker → Nexar delegation                 | done (CI green)                         | `7123b61` bridge host (local IPC endpoint) + stdio MCP relay, `872b9b1` transport decision, `7bd4631` Cowork delegation wiring + E2E                                                                                                                 |
| NXR-063 OpenWorker NexarProvider                      | done                                    | `43e9fbe` host `control` op + loopback Chat Completions translator child, `3bdda5c` per-turn gateway provider, control policy setting, restart-on-control-failure, `openworker-control-unavailable` fallback                                         |
| NXR-064 DSH Code orchestration                        | done (CI green, incl. real-bwrap smoke) | `9d69ef5`+`830dd17` spike + ADR-027 §9b, `31d5745` shared endpoint/translator + sandbox services mount, `ccfde2f` lane-private engine sessions + honest `executor` records, `e0f3073` DSH on the gateway (no `DEEPSEEK_API_KEY`, bridge via ACP MCP) |
| NXR-065 Providers and orchestration UX                | done (CI green)                         | `c3333ea` control policy/candidates/lane facts over IPC + plane protocol, `cc7246e` provider cards, Orchestration section, resource details, executor facts in the UI                                                                                |
| NXR-067 ChatGPT plan (official token sharing)         | done (CI green)                         | `dc9e585` decision (Sign in with ChatGPT replaces the experimental Codex-client route), `bf222e6` connection (PKCE, callback child, key store, refresh), `b481b27` `chatgpt-plan:*` model-turn resources + Providers UI                              |
| NXR-066 Acceptance                                    | offline done; owner live pending        | `1658a9a` offline acceptance E2Es, `122d978` `reviewOf` for delegated units (review diversity), `2f1f5c7` live runbook                                                                                                                               |

Desktop note: the next Desktop start migrates the owner's config (backup `nexar.config.json.bak-<timestamp>`),
removing the `local-echo` default so Auto routes to discovered resources (signed-in Claude Code).

## NEXT EXACT TASK

**NXR-068 — Dynamic Provider Model Catalogs.** Research current T3 Code, Goose and official runtime
interfaces; record ADR-028, the bounded implementation plan and the live acceptance blocker. Commit
and push the architecture checkpoint, wait for exact-head CI, then implement contracts,
materialization and the OpenAI account-specific inventory first, followed by Anthropic, Google and
the inventory/selection UI. NXR-066b resumes only after NXR-068 passes CI, with fresh owner initiation.
PR #39 stays draft and must not be merged. Scheduler, Memory, Automation, Mobile and control plane
remain deferred.

Owner notes:

- Expected today on Code: `executor: native` with `control-unavailable` (subscriptions are native
  agents on the plane; ChatGPT plan sign-in on the plane is a follow-up).
- Open live questions: function tools on the ChatGPT token route; pi-ai with the single-chunk SSE and
  DSH `--patch` with `--profile acp`.
- Follow-ups: lane restart on control failure (ADR-027 §8); plane ChatGPT sign-in; local Node 24
  worker crashes (repo pins Node 22).
