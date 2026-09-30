# Nexar roadmap

Each milestone proves one layer before the next builds on it. Versions only move with an
architectural justification recorded in an ADR. Backlog items per milestone live in
[`docs/backlog/`](../backlog/).

## v0.1 — Foundation _(delivered)_

Delivered: [v0.1 foundation report](../devlog/v0.1-foundation-report.md).

Prove the architecture: domain contracts, AI Resource abstraction, Resource Registry, deterministic
and explainable Resource Controller, telemetry, typed errors, the execution-adapter boundary with
DeepSeek Harness, pi-ai, Claude Code and offline echo adapters, the OpenWorker Work Bridge contract,
a minimal CLI (`doctor`, `resources`, `route`, `run`), CI, ADRs, upstream research.
Exit: `pnpm check` green in CI; offline end-to-end path proven; at least one live path proven or
its blocker documented.

## v0.2 — Personal Work _(delivered)_

Delivered: projects and path policy, artifact store, approvals framework, client auth and audit, stdio
MCP server, Work Bridge v2 and data-driven workflows ([ADR-012](../adr/012-project-context-and-path-policy.md)
to [ADR-017](../adr/017-data-driven-workflows.md); items NXR-010 to NXR-016 in the
[backlog](../backlog/README.md)). Verified live with OpenWorker v0.3.0's MCP client ([v0.2 report](../devlog/v0.2-personal-work-report.md)). Not delivered:
sending or changing anything outward (no executors exist; drafts only). DSH and pi-ai live model runs
remain blocked on credentials (#1, #2). Follow-up: DOCX/PDF/PPTX export
([NXR-017](../backlog/017-document-export-formats.md)), unscheduled.

Original scope:

- Nexar MCP server (stdio first) exposing `submit_work`, `route`, `resources` for OpenWorker (ADR-004).
- Bridge authentication and request audit.
- Technical documentation generation; SOW and proposal workflows with repeatable templates.
- Meeting brief generation; calendar and email _preparation_ (drafts, never auto-send).
- Project context: per-project settings and document sets.
- Artifact generation and storage (`ArtifactRef` → files under the project).
- Human approval for outward-facing actions.

Not planned before a security review: an HTTP (network) MCP transport, and DOCX/PDF/PPTX export.

## v0.3 — Engineering Machine

DeepSeek Harness + native agents + Delegate Skills engineering fleet.

- DSH: live execution, ACP adapter (cancel + approvals), MCP servers for DSH sessions.
- Native agents: Codex (`codex exec --json`), Antigravity, Pi coding agent (sandboxed).
- Product-time Delegate Skills adapter: lanes (feature/tests/review), worktree-per-task isolation.
- Codebase analysis, implementation / test / review lanes, automated gates before accept.
- Capability taxonomy review.

## v0.4 — Resource Intelligence

The NRC evolves from deterministic policy to capability- + quota- + cost- + latency- +
historical-performance-aware scoring (still explainable; no ML until telemetry history justifies it).

- Quota and subscription-allowance tracking (reset times, reservation policy).
- Cost estimation before execution (`maxCostUsd` enforcement).
- Historical success/quality/latency from telemetry.
- Dynamic resource discovery (pi-ai catalog, installed CLIs, local runtimes).

## v0.5 — Nexar Mobile

Mobile-first PWA and remote control via a local Nexar Control Plane daemon.

- Control-plane ADR (daemon API, device pairing, remote access model).
- Text + voice conversation, task status, approvals, notifications, artifact preview, project
  switching, remote task triggering.

## v0.6 — Memory & Personal Context

Persistent project and personal context: retrieval over documents and past work, preference memory,
privacy-scoped storage.

## v0.7 — Automation

Scheduled and event-driven Nexar workflows (cron-like schedules, webhooks, file/email triggers) with
approvals and budgets.

## v1.0 — Personal AI Operating Layer

Stable integrated platform: stable contracts (semver), upgrade playbooks for each upstream, security
review, documented recovery, and owner-grade reliability.
