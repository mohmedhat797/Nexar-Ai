# ADR-014: MCP server over stdio and Work Bridge v2

**Status:** Accepted (2026-09-30) · Issues: #6 (NXR-010), #7 (NXR-011), #8, #9

## Context

ADR-004 chose OpenWorker as the productivity engine. The research re-check
([`openworker.md`](../research/upstream/openworker.md)) found that OpenWorker exposes no agent service
but is an **MCP client**. It starts stdio servers as child processes, passes them only a minimal
environment plus the keys listed in their `env`, kills any tool call after 120 s, and renames tools to
`mcp__<server>__<tool>`. Scheduled automations appear not to load MCP tools (unverified). The v0.1
Work Bridge was only a contract: no transport, no project requirement, no async jobs.
[`mcp-sdk.md`](../research/upstream/mcp-sdk.md) selected the v2 split packages of the official SDK.

## Decision

- **MCP server, stdio only** (`@nexar/integration-mcp`, started with `nexar mcp serve`). It is the
  only package that imports `@modelcontextprotocol/*`, exact-pinned to `@modelcontextprotocol/server@2.2.0`
  (ADR-008, enforced by `scripts/check-boundaries.mjs`). There is no HTTP, SSE or socket option.
- **Tools:** `nexar.submit_work`, `nexar.work_status`, `nexar.route`, `nexar.resources`,
  `nexar.workflows`. Results are one JSON text block (OpenWorker forwards only text) plus the same
  object as `structuredContent`; failures are `isError` results. Only Nexar-authored messages of
  known codes reach the client; other errors become a generic one.
- **Per-call pipeline:** reload the client registry → authenticate `NEXAR_CLIENT_TOKEN` → check the
  tool scope → validate input → run → write exactly one audit record (ADR-015). The SDK's own input
  validation is bypassed on purpose, so a malformed call is still authenticated and audited.
- **Stdout is protocol-only.** Logs and the startup notice go to stderr; `console.log/info/debug/warn`
  are redirected to stderr while serving.
- **Work Bridge v2** (`@nexar/integration-openworker`, contract version 2):
  - `project` is required; `workingDirectory` is relative to the project's first working directory
    or absolute, and the engine canonicalizes it (ADR-012). The engine runs with the `project-only`
    policy.
  - **Async jobs:** `submit` waits at most `waitSeconds` (default 90, maximum 100) and otherwise returns
    `running`; `work_status` or a repeated `submit` returns the current state. Jobs are held in
    memory (newest 200) and cut off after 30 minutes.
  - **Idempotency:** `requestId` is the key, namespaced per client. Another client's id is
    indistinguishable from an unknown one.
  - **Result artifact:** optional `output: { filename, mediaType? }` stores the text (ADR-013).
  - **Route explanation:** every response carries the resource, policy, reason codes and explanation,
    including why each candidate was rejected when nothing is eligible.
  - **Workflow requests:** `workflow: { id, inputs }` replaces `request` + `taskKind`; the two shapes
    cannot be mixed (ADR-017).
  - Request input cannot widen scopes, projects or paths; the client's cost cap is applied as
    `min(request, client)`.

## Rationale

stdio matches how OpenWorker launches MCP servers and gives one identity per process: the token in
its environment. Keeping the server off the network removes the largest class of exposure while
Nexar has no approver authentication (ADR-016). Polling fits the 120 s limit. An in-memory job table
is enough because the server lives and dies with the OpenWorker session, and durable results use
artifacts.

## Alternatives considered

- **HTTP/SSE transport:** needs network authentication, TLS and origin handling; not planned before a
  security review.
- **Nexar calling OpenWorker's REST API:** a secondary seam, left for later; OpenWorker has no
  callable agent service.
- **The v1 `@modelcontextprotocol/sdk`:** older protocol line and a far larger dependency tree.
- **Persisting jobs to disk:** more state to secure and recover, with no current need.

## Consequences

- OpenWorker must be given a client token; all work is scoped and audited.
- Jobs are lost when the server stops; clients should use `output` for long results.
- Every tool call from OpenWorker is classed as external work and needs its approval.
- Scheduled OpenWorker automations may not see Nexar's tools (upstream behaviour, unverified).
- Verified live: OpenWorker v0.3.0's own MCP client (`coworker.mcp.MCPManager`) drove
  `nexar mcp serve` through claude-code to artifacts (details in the devlog report).

## Risks

- A pre-1.0 upstream and a fast-moving SDK (2.2.0 was two days old when chosen). Exact pins and
  contract tests limit the blast radius; re-check on upgrade.
- The token sits in OpenWorker's environment or `.env`.
- `clients.json` is serialized per process only; a CLI write racing the server can lose an update.

## Follow-up work

Per-workflow input schemas in the tool definition, token rotation UX, a security review before any
network transport, and the OpenWorker REST seam for deferred work.
