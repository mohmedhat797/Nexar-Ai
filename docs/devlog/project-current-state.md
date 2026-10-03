# Nexar current project state

**This file is the authoritative current state.** It supersedes the "CURRENT STATE", "NEXT EXACT
TASK" and "BLOCKERS" sections of older handoffs (for example
[`operating-layer-progress.md`](operating-layer-progress.md), which keeps the detailed history).
Update this file at every milestone checkpoint.

## Snapshot (2026-10-04, repository reconciliation)

| Item                           | Value                                                                                                                                                                                                                                       |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Default branch                 | `main`                                                                                                                                                                                                                                      |
| Latest merged PR               | #36 "Nexar Desktop — Windows foundation and Operating Layer integration" (merge commit; `git log --first-parent -1 main`)                                                                                                                   |
| PR #36 head before this report | `2737b7c`, CI run `37153390661` green (Ubuntu, Windows, secret scan); local `pnpm check` green (3,179 passed / 125 skipped, 766 tracked files)                                                                                              |
| Latest milestone               | v0.5 Operating Layer (NXR-051/052/053/055/056/057/058) merged; NXR-054 not started                                                                                                                                                          |
| Open PRs after the merge       | none                                                                                                                                                                                                                                        |
| Remote branches kept           | `feat/nexar-v0.2-personal-work`, `feat/nexar-v0.3-engineering-machine`, `feat/nexar-v0.4-resource-intelligence`, `claude/eager-ptolemy-j5bbnj`, `feat/nexar-operating-layer`: all fully contained in `main` (kept by repository convention) |

## Milestones

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
API keys and local models across Cowork and Code. The audit found that Cowork could not use
subscriptions (ADR-026 §4), that DSH was only a lane resource, and that Desktop Auto routed to the
`local-echo` test double even with an authenticated Claude Code. ADR-027 corrects the architecture;
the previous next task (install OpenWorker and give it an API key) is **superseded** because it would
validate the old coupling. OpenWorker's `openai-codex` provider was verified to emulate the Codex
CLI's OAuth client and is not an accepted route.

## NEXT EXACT TASK

**NXR-060 — Provider connections and resource normalization** on `feat/nexar-resource-orchestration`
([backlog](../backlog/060-provider-connections-and-resources.md)): `ProviderConnection` contract,
`metadata.connection` on every resource source, probe-backed native subscription resources,
`agent-loop-control:<engine>` capability, and the first-run Desktop config without the `local-echo`
default (with a one-time migration). Then NXR-061 → 062 → 059 → 063 → 064 → 065 → 066.
