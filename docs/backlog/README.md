# Nexar backlog

Specifications for planned work, one file per item, grouped by milestone from the
[roadmap](../roadmap/ROADMAP.md). Each file is written to be understood without chat history and can be
pasted verbatim as a GitHub issue body ([ADR-010](../adr/010-github-source-of-truth.md)).

Every item uses the same sections: Summary, Problem, Objective, Scope, Out of scope, Technical notes,
Acceptance criteria, Testing expectations, Security considerations. Ids are stable: `NXR-00x` is v0.1
follow-ups, `01x` v0.2 (`017` is an unscheduled follow-up), `02x` v0.3 (`025`–`029` are v0.3.x and later follow-ups), `03x` v0.4, `04x` mobile (deferred), `05x` v0.5 (desktop).

## v0.1 — Foundation (follow-ups)

| Id                                                            | Title                                              | Milestone | Labels                                 |
| ------------------------------------------------------------- | -------------------------------------------------- | --------- | -------------------------------------- |
| [NXR-001](001-deepseek-harness-live-smoke-test.md)            | DeepSeek Harness live smoke test                   | v0.1      | integration, deepseek-harness, testing |
| [NXR-002](002-pi-ai-live-smoke-test.md)                       | pi-ai live smoke test                              | v0.1      | integration, pi, testing               |
| [NXR-003](003-migrate-to-typescript-7.md)                     | Migrate to TypeScript 7                            | v0.1      | tooling, tech-debt                     |
| [NXR-004](004-streaming-text-output.md)                       | Streaming text output for adapters and CLI         | v0.1      | core, integration                      |
| [NXR-005](005-claude-code-json-fixtures-and-version-probe.md) | Claude Code CLI JSON fixtures and version tracking | v0.1      | integration, claude-code, testing      |

## v0.2 — Personal Work

NXR-010 to NXR-016 were delivered in v0.2. NXR-017 is a follow-up and is not scheduled.

| Id                                                         | Title                                                               | Milestone   | Labels                    | Status      |
| ---------------------------------------------------------- | ------------------------------------------------------------------- | ----------- | ------------------------- | ----------- |
| [NXR-010](010-nexar-mcp-server.md)                         | Nexar MCP server (stdio) for OpenWorker                             | v0.2        | openworker, mcp           | Done (v0.2) |
| [NXR-011](011-work-bridge-authentication-and-audit-log.md) | Work Bridge authentication and request audit log                    | v0.2        | openworker, security      | Done (v0.2) |
| [NXR-012](012-documentation-workflows.md)                  | Documentation workflows (technical docs, SOW, proposals)            | v0.2        | personal-work             | Done (v0.2) |
| [NXR-013](013-meeting-brief-and-communication-drafts.md)   | Meeting brief generation and calendar/email preparation             | v0.2        | personal-work, openworker | Done (v0.2) |
| [NXR-014](014-human-approval-framework.md)                 | Human approval framework for outward-facing and destructive actions | v0.2        | security, core            | Done (v0.2) |
| [NXR-015](015-project-context.md)                          | Project context (settings, document sets, directory allowlists)     | v0.2        | core                      | Done (v0.2) |
| [NXR-016](016-artifact-storage.md)                         | Artifact storage (`ArtifactRef` → project files)                    | v0.2        | core                      | Done (v0.2) |
| [NXR-017](017-document-export-formats.md)                  | Document export formats (DOCX, PDF, PPTX)                           | unscheduled | personal-work, core       | Planned     |

## v0.3 — Engineering Machine

NXR-020 to NXR-024 were delivered in v0.3. NXR-025 to NXR-029 are follow-ups (milestone v0.3.x unless noted).

| Id                                                    | Title                                         | Milestone | Labels                        | Status                    |
| ----------------------------------------------------- | --------------------------------------------- | --------- | ----------------------------- | ------------------------- |
| [NXR-020](020-deepseek-harness-acp-adapter.md)        | DeepSeek Harness ACP adapter                  | v0.3      | integration, deepseek-harness | Done (v0.3)               |
| [NXR-021](021-codex-native-agent-adapter.md)          | Codex native agent adapter                    | v0.3      | integration, codex            | Done (v0.3)               |
| [NXR-022](022-antigravity-agy-adapter.md)             | Google Antigravity (`agy`) adapter            | v0.3      | integration, antigravity      | Done (v0.3), experimental |
| [NXR-023](023-delegate-skills-adapter.md)             | Product-time Delegate Skills adapter          | v0.3      | integration, delegate-skills  | Done (v0.3)               |
| [NXR-024](024-os-level-sandbox-for-agent-runtimes.md) | OS-level sandbox for agent runtimes           | v0.3      | security                      | Done (v0.3)               |
| [NXR-025](025-seccomp-filter-for-sandbox.md)          | Seccomp filter for the sandbox                | v0.3.x    | security, sandbox             | Planned                   |
| [NXR-026](026-launcher-env-via-args-fd.md)            | Pass launcher environment via `--args <fd>`   | v0.3.x    | security, sandbox             | Planned                   |
| [NXR-027](027-parallel-engineering-lanes.md)          | Parallel engineering lanes with a merge step  | v0.4      | engineering                   | Planned                   |
| [NXR-028](028-mcp-engineering-scope.md)               | MCP engineering scope                         | v0.5      | mcp, security, engineering    | Planned                   |
| [NXR-029](029-antigravity-live-validation.md)         | Antigravity live validation and promotion ADR | v0.3.x    | integration, antigravity      | Planned                   |

## v0.4 — Resource Intelligence

NXR-030 to NXR-034 were delivered in v0.4 ([ADR-020](../adr/020-resource-intelligence-scheduler.md)).

| Id                                                  | Title                                          | Milestone | Labels                         | Status      |
| --------------------------------------------------- | ---------------------------------------------- | --------- | ------------------------------ | ----------- |
| [NXR-030](030-quota-and-allowance-tracking.md)      | Quota and subscription-allowance tracking      | v0.4      | resource-controller            | Done (v0.4) |
| [NXR-031](031-pre-execution-cost-estimation.md)     | Pre-execution cost estimation and `maxCostUsd` | v0.4      | resource-controller            | Done (v0.4) |
| [NXR-032](032-history-scoring-routing-policy.md)    | Scoring routing policy using telemetry history | v0.4      | resource-controller, telemetry | Done (v0.4) |
| [NXR-033](033-dynamic-resource-discovery.md)        | Dynamic resource discovery                     | v0.4      | resource-registry              | Done (v0.4) |
| [NXR-034](034-engineering-telemetry-for-scoring.md) | Engineering lane outcomes as scoring input     | v0.4      | resource-controller, telemetry | Done (v0.4) |

## v0.5 — Nexar Desktop

Phases of [ADR-021](../adr/021-nexar-desktop.md); see also ADR-022 and ADR-023.

| Id                                              | Title                                                   | Milestone | Labels                             | Status                                   |
| ----------------------------------------------- | ------------------------------------------------------- | --------- | ---------------------------------- | ---------------------------------------- |
| [NXR-050](050-desktop-foundation.md)            | Desktop foundation: host package, shell, bridge, Cowork | v0.5      | desktop                            | Done                                     |
| [NXR-051](051-windows-compatibility.md)         | Windows compatibility pass, Windows CI, installer       | v0.5      | desktop, windows                   | Implemented (owner acceptance pending)   |
| [NXR-052](052-providers-and-key-store.md)       | Providers: sign-in, encrypted key store, local servers  | v0.5      | desktop, security                  | Implemented (live-unverified)            |
| [NXR-053](053-ai-behavior-settings.md)          | AI behavior settings per mode                           | v0.5      | desktop, integration               | Implemented (v1 matrix; live-unverified) |
| [NXR-054](054-scheduled-tasks.md)               | Scheduled tasks                                         | v0.5      | desktop, automation                | Planned                                  |
| [NXR-055](055-code-mode-wsl2.md)                | Code mode through the WSL2 plane (DSH default)          | v0.5      | desktop, engineering               | Implemented (owner live-validated)       |
| [NXR-056](056-cowork-openworker-agent.md)       | Cowork through OpenWorker (automations seam)            | v0.5      | desktop, openworker                | Implemented (live-unverified)            |
| [NXR-057](057-persistent-operating-sessions.md) | Persistent Operating Sessions                           | v0.5      | operating-layer, sessions, desktop | Done                                     |
| [NXR-058](058-operating-intent-and-lanes.md)    | Operating intent and lane orchestration                 | v0.5      | operating-layer, routing, desktop  | Done (lanes: NXR-055/056)                |

## v0.6 — Resource orchestration

[ADR-027](../adr/027-resource-orchestration-architecture.md) · [plan](../architecture/resource-orchestration-plan.md).

**Current v0.6 status (2026-10-09): Merged and validated.** PR39 merged at
`2f856f935a1ca51fc0f2c179386baa31bd82c3bd`; [CI 37955286149 attempt 1](https://github.com/mohmedhat797/Nexar-Ai/actions/runs/37955286149/attempts/1) passed. NXR-066 owner acceptance
is complete in the finalized scope, with native Code acceptance and unconfigured
Plane DSH Control clearly distinguished. The table below preserves original planning
labels; [current state](../devlog/project-current-state.md) and the
[official baseline](../devlog/evidence/Nexar_v0.6_Official_Baseline.md) govern actual
status. Next: NXR-070 architecture reconciliation, not implementation.

Order: NXR-060 → 061 → 062 → 059 → 063 → 064 → 065 → (067, optional) → 066. NXR-054 waits for NXR-066.

| Id                                                         | Title                                                                         | Milestone | Labels                                 | Status  |
| ---------------------------------------------------------- | ----------------------------------------------------------------------------- | --------- | -------------------------------------- | ------- |
| [NXR-059](059-openworker-nexar-delegation.md)              | OpenWorker → Nexar bounded work delegation                                    | v0.6      | operating-layer, openworker, security  | Planned |
| [NXR-060](060-provider-connections-and-resources.md)       | Provider connections, compatibility metadata and resource normalization       | v0.6      | resources, desktop, routing            | Planned |
| [NXR-061](061-resource-strategy-planner.md)                | Resource Strategy Planner (`strategy@1`)                                      | v0.6      | resource-intelligence, routing         | Planned |
| [NXR-062](062-engine-gateway.md)                           | Nexar Engine Gateway: Control Model Gateway and Intelligence Execution Bridge | v0.6      | operating-layer, routing, security     | Planned |
| [NXR-063](063-openworker-nexar-provider.md)                | OpenWorker NexarProvider and control-resource policy                          | v0.6      | openworker, routing, security          | Planned |
| [NXR-064](064-dsh-code-orchestration.md)                   | DSH Code orchestration through the plane Engine Gateway                       | v0.6      | engineering, deepseek-harness, routing | Planned |
| [NXR-065](065-providers-ux-consolidation.md)               | Providers and orchestration-control UX                                        | v0.6      | desktop, providers                     | Planned |
| [NXR-066](066-resource-orchestration-acceptance.md)        | Resource orchestration E2E and live acceptance                                | v0.6      | testing, acceptance                    | Planned |
| [NXR-067](067-experimental-subscription-model-adapters.md) | Experimental subscription model-turn adapters (owner-enabled)                 | v0.6      | providers, experimental, security      | Planned |

**Historical 2026-10-07 correction (superseded):** NXR-059–065 are implemented offline (the historical table above has not
tracked their commits). NXR-067a sign-in and NXR-067b's dynamic account resource publication are implemented.
[NXR-068: Dynamic Provider Model Catalogs](068-dynamic-provider-model-catalogs.md) passed local gates
and full exact-head CI for `0244d97`. NXR-066a is offline-tested; 066b is prepared, pending Windows
OpenWorker 0.3.1 update, matching new-head builds/CI and owner-initiated live results. Current detailed
status lives in [`project-current-state.md`](../devlog/project-current-state.md). PR #39 stays draft.

[NXR-069: OpenWorker Runtime Discovery](069-openworker-runtime-discovery.md) is a deferred
maintenance specification; no automatic scanning implementation has started. Headless evaluation
belongs to NXR-054 / v0.8 Automation after owner acceptance.

## Nexar Mobile (deferred)

Deferred by the owner until after the Operating Layer, Memory and Automation milestones.

| Id                                                      | Title                                       | Milestone | Labels                  |
| ------------------------------------------------------- | ------------------------------------------- | --------- | ----------------------- |
| [NXR-040](040-control-plane-adr-and-daemon-skeleton.md) | Control-plane ADR and local daemon skeleton | v0.6      | control-plane, security |
| [NXR-041](041-nexar-mobile-pwa-shell.md)                | Nexar Mobile PWA shell                      | v0.6      | mobile                  |

## GitHub issues

Each item is mirrored as a GitHub issue (the file in this directory remains the source of truth).
Issue numbers are sequential in NXR order (verified against GitHub on 2026-09-30):

| Item    | Issue | Item    | Issue | Item    | Issue |
| ------- | ----- | ------- | ----- | ------- | ----- |
| NXR-001 | #1    | NXR-013 | #9    | NXR-024 | #17   |
| NXR-002 | #2    | NXR-014 | #10   | NXR-030 | #18   |
| NXR-003 | #3    | NXR-015 | #11   | NXR-031 | #19   |
| NXR-004 | #4    | NXR-016 | #12   | NXR-032 | #20   |
| NXR-005 | #5    | NXR-020 | #13   | NXR-033 | #21   |
| NXR-010 | #6    | NXR-021 | #14   | NXR-040 | #22   |
| NXR-011 | #7    | NXR-022 | #15   | NXR-041 | #23   |
| NXR-012 | #8    | NXR-023 | #16   |         |       |

NXR-017 (document export formats, follow-up from v0.2) is issue #25. NXR-057 is issue #37 and
NXR-058 is issue #38.
