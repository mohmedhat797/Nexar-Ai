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

## v0.3 — Engineering Machine _(delivered)_

Delivered: sandboxed, multi-agent engineering tasks (bubblewrap sandbox, private worktrees, lane plans, gates, review, owner-approved local commits), Codex, DSH ACP and Delegate Skills relay adapters, and an experimental Antigravity adapter ([ADR-018](../adr/018-engineering-execution-plane.md), [ADR-019](../adr/019-engineering-lanes-and-resources.md); NXR-020 to NXR-024; [v0.3 report](../devlog/v0.3-engineering-machine-report.md)). Verified live with two end-to-end runs; WSL2 checks A1–A6 passed on the owner machine on 2026-10-03 (NXR-055); Antigravity remains an owner-run follow-up.

Original scope:

- DSH: live execution, ACP adapter (cancel + approvals), MCP servers for DSH sessions.
- Native agents: Codex (`codex exec --json`), Antigravity, Pi coding agent (sandboxed).
- Product-time Delegate Skills adapter: lanes (feature/tests/review), worktree-per-task isolation.
- Codebase analysis, implementation / test / review lanes, automated gates before accept.
- Capability taxonomy review.

## v0.4 — Resource Intelligence _(delivered)_

The NRC gained an explainable, quota-, cost- and history-aware policy, `resource-intelligence@1`
([ADR-020](../adr/020-resource-intelligence-scheduler.md)); `deterministic@1` stays the default. No ML.

- Quota observations with provenance and freshness (owner-declared allowances accounted by Nexar,
  documented vendor signals), reservations, strict-unknown mode (NXR-030).
- Pre-execution cost estimation, `maxCostUsd` enforcement, estimate vs actual (NXR-031).
- Historical success and latency from telemetry, engineering lane quality per role (NXR-032, NXR-034).
- Discovery of installed CLIs, the pi-ai catalog and owner-listed local endpoints, with provenance
  (NXR-033).
- `nexar route --explain`, deterministic fallback that keeps every hard filter.

Report: [`docs/devlog/v0.4-resource-intelligence-report.md`](../devlog/v0.4-resource-intelligence-report.md) ·
next: [`v0.5-readiness.md`](v0.5-readiness.md).

## v0.5 — Nexar Desktop _(in progress: Operating Layer merged; NXR-054 remaining)_

A desktop app on the owner's laptop, Windows first ([ADR-021](../adr/021-nexar-desktop.md)), that works
on project folders like Claude Cowork or the Codex app, with Nexar's engine underneath. Owner-approved
mockup: workspace with Cowork and Code modes, files and changes panels, approvals, AI resources,
themes, AI behavior settings, providers and scheduled tasks.

- **Done:** foundation: shared composition (`@nexar/host`), Electron shell, typed and validated bridge,
  projects, Cowork chat, resources, approvals, workflows, themes (NXR-050;
  [report](../devlog/v0.5-desktop-phase1-report.md), [guide](../guides/local-development.md)).
- Windows compatibility pass and a Windows CI job; installer (NXR-051).
- Providers with subscription sign-in, API keys in an encrypted key store, local servers
  ([ADR-022](../adr/022-provider-credentials.md), NXR-052).
- AI behavior settings per mode wired to the runtimes (NXR-053).
- Scheduled tasks with budgets and approvals ([ADR-023](../adr/023-scheduled-tasks.md), NXR-054).
- Code mode through the WSL2 engineering plane with DSH as the default agent (NXR-055).
- Cowork through OpenWorker via the ADR-004 automations seam (NXR-056).
- **Operating Layer** ([ADR-024](../adr/024-operating-layer-and-sessions.md)): persistent multi-turn
  Operating Sessions (NXR-057) and intent/lane orchestration (NXR-058). One conversation per project;
  the Operating Router picks the lane (Cowork/OpenWorker, Code/DSH or direct), the NRC picks the
  resource. Order: Windows gate → sessions → providers → Code → Cowork → AI behavior → integrated E2E;
  scheduled tasks (NXR-054) follow.
- **State (2026-10-04):** NXR-051/052/053/055/056/057/058 merged (PR #36). NXR-055 is owner
  live-validated; live validation of NXR-056, NXR-053, NXR-052 and the installer (NXR-051) remains.
  Current state: [`project-current-state.md`](../devlog/project-current-state.md).

## v0.7 — Memory & Personal Context

Persistent project and personal context: retrieval over documents and past work, preference memory,
privacy-scoped storage.

## v0.8 — Automation

Event-driven Nexar workflows (webhooks, file/email triggers) and an always-on scheduler, building on
the in-app scheduled tasks of v0.5 (ADR-023), with approvals and budgets.

## Nexar Mobile _(deferred)_

Deferred by the owner (2026-10-02) until after the Operating Layer, Memory and Automation
milestones; no mobile, control-plane daemon or remote access work before then.

Mobile-first PWA and remote control via a local Nexar Control Plane daemon.

- Control-plane ADR (daemon API, device pairing, remote access model).
- Text + voice conversation, task status, approvals, notifications, artifact preview, project
  switching, remote task triggering.

## v1.0 — Personal AI Operating Layer

Stable integrated platform: stable contracts (semver), upgrade playbooks for each upstream, security
review, documented recovery, and owner-grade reliability.
