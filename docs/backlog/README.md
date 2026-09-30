# Nexar backlog

Specifications for planned work, one file per item, grouped by milestone from the
[roadmap](../roadmap/ROADMAP.md). Each file is written to be understood without chat history and can be
pasted verbatim as a GitHub issue body ([ADR-010](../adr/010-github-source-of-truth.md)).

Every item uses the same sections: Summary, Problem, Objective, Scope, Out of scope, Technical notes,
Acceptance criteria, Testing expectations, Security considerations. Ids are stable: `NXR-00x` is v0.1
follow-ups, `01x` v0.2, `02x` v0.3, `03x` v0.4, `04x` v0.5.

## v0.1 — Foundation (follow-ups)

| Id                                                            | Title                                              | Milestone | Labels                                 |
| ------------------------------------------------------------- | -------------------------------------------------- | --------- | -------------------------------------- |
| [NXR-001](001-deepseek-harness-live-smoke-test.md)            | DeepSeek Harness live smoke test                   | v0.1      | integration, deepseek-harness, testing |
| [NXR-002](002-pi-ai-live-smoke-test.md)                       | pi-ai live smoke test                              | v0.1      | integration, pi, testing               |
| [NXR-003](003-migrate-to-typescript-7.md)                     | Migrate to TypeScript 7                            | v0.1      | tooling, tech-debt                     |
| [NXR-004](004-streaming-text-output.md)                       | Streaming text output for adapters and CLI         | v0.1      | core, integration                      |
| [NXR-005](005-claude-code-json-fixtures-and-version-probe.md) | Claude Code CLI JSON fixtures and version tracking | v0.1      | integration, claude-code, testing      |

## v0.2 — Personal Work

| Id                                                         | Title                                                               | Milestone | Labels                    |
| ---------------------------------------------------------- | ------------------------------------------------------------------- | --------- | ------------------------- |
| [NXR-010](010-nexar-mcp-server.md)                         | Nexar MCP server (stdio) for OpenWorker                             | v0.2      | openworker, mcp           |
| [NXR-011](011-work-bridge-authentication-and-audit-log.md) | Work Bridge authentication and request audit log                    | v0.2      | openworker, security      |
| [NXR-012](012-documentation-workflows.md)                  | Documentation workflows (technical docs, SOW, proposals)            | v0.2      | personal-work             |
| [NXR-013](013-meeting-brief-and-communication-drafts.md)   | Meeting brief generation and calendar/email preparation             | v0.2      | personal-work, openworker |
| [NXR-014](014-human-approval-framework.md)                 | Human approval framework for outward-facing and destructive actions | v0.2      | security, core            |
| [NXR-015](015-project-context.md)                          | Project context (settings, document sets, directory allowlists)     | v0.2      | core                      |
| [NXR-016](016-artifact-storage.md)                         | Artifact storage (`ArtifactRef` → project files)                    | v0.2      | core                      |

## v0.3 — Engineering Machine

| Id                                                    | Title                                | Milestone | Labels                        |
| ----------------------------------------------------- | ------------------------------------ | --------- | ----------------------------- |
| [NXR-020](020-deepseek-harness-acp-adapter.md)        | DeepSeek Harness ACP adapter         | v0.3      | integration, deepseek-harness |
| [NXR-021](021-codex-native-agent-adapter.md)          | Codex native agent adapter           | v0.3      | integration, codex            |
| [NXR-022](022-antigravity-agy-adapter.md)             | Google Antigravity (`agy`) adapter   | v0.3      | integration, antigravity      |
| [NXR-023](023-delegate-skills-adapter.md)             | Product-time Delegate Skills adapter | v0.3      | integration, delegate-skills  |
| [NXR-024](024-os-level-sandbox-for-agent-runtimes.md) | OS-level sandbox for agent runtimes  | v0.3      | security                      |

## v0.4 — Resource Intelligence

| Id                                               | Title                                          | Milestone | Labels                         |
| ------------------------------------------------ | ---------------------------------------------- | --------- | ------------------------------ |
| [NXR-030](030-quota-and-allowance-tracking.md)   | Quota and subscription-allowance tracking      | v0.4      | resource-controller            |
| [NXR-031](031-pre-execution-cost-estimation.md)  | Pre-execution cost estimation and `maxCostUsd` | v0.4      | resource-controller            |
| [NXR-032](032-history-scoring-routing-policy.md) | Scoring routing policy using telemetry history | v0.4      | resource-controller, telemetry |
| [NXR-033](033-dynamic-resource-discovery.md)     | Dynamic resource discovery                     | v0.4      | resource-registry              |

## v0.5 — Nexar Mobile

| Id                                                      | Title                                       | Milestone | Labels                  |
| ------------------------------------------------------- | ------------------------------------------- | --------- | ----------------------- |
| [NXR-040](040-control-plane-adr-and-daemon-skeleton.md) | Control-plane ADR and local daemon skeleton | v0.5      | control-plane, security |
| [NXR-041](041-nexar-mobile-pwa-shell.md)                | Nexar Mobile PWA shell                      | v0.5      | mobile                  |
