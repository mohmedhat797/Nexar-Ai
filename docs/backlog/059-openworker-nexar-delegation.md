# NXR-059: OpenWorker → Nexar turn-scoped delegation

**Milestone:** v0.6 — Resource orchestration · **Labels:** operating-layer, openworker, security · **Depends on:** NXR-062 · **ADR:** [ADR-027](../adr/027-resource-orchestration-architecture.md) ([plan](../architecture/resource-orchestration-plan.md))

## Objective

OpenWorker delegates substantive Cowork units to Nexar, which executes them on NRC-selected resources (subscription agents included) inside the same turn.

## Problem

A Cowork turn today runs entirely on one API model OpenWorker was configured with; subscriptions can never do Cowork work.

## Scope

- Turn-scoped ADR-015 client: tools `nexar.intelligence_submit` / `nexar.intelligence_status` only, the session project, access ≤ draft, TTL = turn timeout, budget; revoked at turn end.
- Register a stdio MCP server entry in the private OpenWorker (`POST /v1/mcp`) with the token by `${…}` reference; remove it at turn end.
- Submit-and-poll so every tool call returns under OpenWorker's 120 s limit.
- Nexar policy allows OpenWorker's permission request for exactly this server/tools (recorded); everything else stays denied (ADR-026 §3).
- Children: same `rootSessionId`/`turnId`/`correlationId`, `depth + 1`, chain contains `openworker`; no turn, no project write, no approval, no outward action; re-entry refused.

## Acceptance criteria

- [ ] Fake OpenWorker issues MCP tool calls; a delegated unit runs on a fake subscription agent and the result returns to the same turn; drafts imported by Nexar.
- [ ] Negatives: expired/revoked token, scope widening, wrong project, depth > 2, re-entry, budget exhausted, cancellation.

## Security considerations

The bridge must never let OpenWorker reach approvals, commits, outward executors or another session.
