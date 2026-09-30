# NXR-010: Nexar MCP server (stdio) for OpenWorker

**Milestone:** v0.2 — Personal Work · **Labels:** openworker, mcp · **Depends on:** none

## Summary

Expose Nexar to OpenWorker as a stdio MCP server with three tools: `nexar.submit_work`, `nexar.route`
and `nexar.resources`, backed by the existing Work Bridge contract.

## Problem

[ADR-004](../adr/004-openworker-productivity-engine.md) chose "OpenWorker → Nexar over MCP" as the
primary seam. v0.1 ships only the transport-agnostic Work Bridge contract in
`@nexar/integration-openworker`; nothing OpenWorker can actually connect to. Per the
[research note](../research/upstream/openworker.md), OpenWorker is a full MCP client (stdio + HTTP)
configured via `mcp.json` or `/v1/mcp`, but does not expose its agent as a callable service.

## Objective

An OpenWorker user adds one `mcp.json` entry and can have Nexar route and execute heavy work, with
results and the routing explanation returned as tool output.

## Scope

- stdio MCP server entrypoint (for example `nexar mcp serve`) in the CLI or a thin app/package.
- Tools: `nexar.submit_work` (validates a `WorkRequest`, runs it through the engine, returns a
  `WorkResponse`), `nexar.route` (returns a `RouteDecision` without executing), `nexar.resources`
  (returns resource snapshots with state).
- Input schemas reuse the Work Bridge validation; errors return `NexarError` code and message.
- An OpenWorker `mcp.json` recipe in the docs.

## Out of scope

- Authentication and audit ([NXR-011](011-work-bridge-authentication-and-audit-log.md)); HTTP transport.
- Nexar → OpenWorker via the automations API (secondary seam, separate work).
- Approval forwarding ([NXR-014](014-human-approval-framework.md)).

## Technical notes

- Reuse `@nexar/integration-openworker` for request validation and mapping; the transport lives outside it
  so the contract stays transport-agnostic. Engine and router from `@nexar/core` and `ResourceRouter`
  in `@nexar/contracts`; set `TaskOrigin.source = 'openworker'`.
- MCP SDK: pick a maintained TypeScript MCP SDK and exact-pin it; confine it to one package (verify the choice
  and its license before adopting).
- Never write protocol data to stdout except MCP frames; logs go to stderr (already the telemetry default).
- Research open question: scheduled OpenWorker automation runs may not load MCP tools (unverified); test
  interactive sessions first and document the limitation.

## Acceptance criteria

- [ ] `nexar.submit_work`, `nexar.route` and `nexar.resources` are listed by an MCP client and return valid results.
- [ ] Invalid input returns a structured error (`VALIDATION_ERROR`), not a crash.
- [ ] `NO_ELIGIBLE_RESOURCE` is returned as an explainable decision, not a transport error.
- [ ] stdout carries only MCP frames; all logs go to stderr.
- [ ] A documented `mcp.json` snippet works against a pinned OpenWorker tag (note the tag).

## Testing expectations

Offline tests with an in-process MCP client against the echo adapter cover all three tools and error paths.
Testing against a real OpenWorker is opt-in (`NEXAR_LIVE_TESTS=1`) and manual.

## Security considerations

Requests are untrusted task input ([security model](../architecture/security.md), boundary 3). Do not
expose credentials through `nexar.resources` (credential references only). Do not log prompts at info+.
Authentication is tracked in NXR-011; until then bind to stdio only.
