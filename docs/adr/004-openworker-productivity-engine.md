# ADR-004: OpenWorker as personal productivity and operations engine

**Status:** Accepted (2026-09-30).
Evidence: [`docs/research/upstream/openworker.md`](../research/upstream/openworker.md)
(inspected `andrewyng/openworker@e892350`, v0.3.0).

## Context

Nexar's personal-work side (documents, proposals, SOWs, meeting prep, email, calendar, files,
routine automation) needs a productivity engine with connectors, approvals, and artifact generation.
OpenWorker (MIT, Python/FastAPI server + React/Tauri desktop, open beta, pre-1.0 API) provides this.
Research findings:

- OpenWorker is a full **MCP client** (stdio + HTTP, OAuth, per-tool approval), configured via
  `mcp.json` or its `/v1/mcp` API.
- Its agent is **not** exposed as an MCP server or task API. Driving it from outside means its
  session WebSocket or its automations API (`POST /v1/automations`, poll for `result_text`).
- Its `openai` provider accepts a custom `base_url`.
- Unattended runs stall on approvals beyond workspace writes; the desktop keeps its auth token in
  memory only; managed Gmail/Calendar OAuth depends on an OpenWorker cloud broker.

## Decision

1. OpenWorker is a **first-class Nexar component** owning productivity workflows — not a disposable UI.
2. **No fork.** OpenWorker is integrated out-of-process and updated independently.
3. Primary seam (v0.2): **Nexar exposes an MCP server** (e.g. `nexar.submit_work`, `nexar.route`,
   `nexar.resources`) that OpenWorker consumes. Heavy reasoning/engineering work flows OpenWorker →
   Nexar → NRC-selected resource.
4. Secondary seam (v0.2+, pinned, contract-tested): Nexar → OpenWorker via its automations API,
   against a Nexar-supervised `openworker-server` with its own state dir.
5. v0.1 ships only the **Work Bridge contract** (`@nexar/integration-openworker`): a
   transport-agnostic `WorkRequest`/`WorkResponse` schema and a handler that turns a validated request
   into a Nexar task and runs it. Transports (MCP) come in v0.2.

## Rationale

MCP is the most stable, config-only seam OpenWorker offers and keeps both products independently
updatable. Keeping the bridge contract transport-agnostic means the MCP server, a future HTTP
control plane, and tests all share one validated shape.

## Alternatives considered

- Nexar as OpenWorker's model provider (OpenAI-compatible endpoint) — possible later; requires Nexar
  to implement Chat Completions tool-calling semantics. Deferred.
- Fork OpenWorker and embed Nexar — rejected (upstream isolation).
- Treat OpenWorker as a frontend only — rejected; it owns connectors, approvals, and artifacts.

## Consequences

Nexar remains the source of truth for routing, resource policy, and audit; OpenWorker remains the
source of truth for connectors and productivity workflows.

## Risks

Pre-1.0 API with no stability contract; approval handling for unattended runs; connector OAuth
depends on OpenWorker infrastructure.

## Follow-up work

v0.2: Nexar MCP server (stdio first), bridge authentication, OpenWorker config recipe, contract tests
pinned to an OpenWorker tag.
