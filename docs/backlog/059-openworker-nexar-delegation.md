# NXR-059: OpenWorker → Nexar bounded work delegation

**Milestone:** v0.6 — Resource orchestration · **Labels:** operating-layer, openworker, security · **Depends on:** NXR-062 · **ADR:** [ADR-027](../adr/027-resource-orchestration-architecture.md) ([plan](../architecture/resource-orchestration-plan.md))

## Objective

OpenWorker delegates bounded substantive units (extract, synthesize, draft, review) to Nexar's Intelligence Execution Bridge, which runs them on strategy-allocated, NRC-revalidated resources (subscription agents included) inside the same turn. This is not the control loop (NXR-063).

## Problem

A Cowork turn today runs entirely on one model OpenWorker was configured with; subscriptions can never do Cowork work.

## Scope

Transport decision: [ADR-027 §9a](../adr/027-resource-orchestration-architecture.md).

- **059a — bridge host and relay:** Desktop main hosts the `IntelligenceBridge` (NXR-062b) behind a per-launch local IPC endpoint (named pipe / `0600` unix socket), framed and bounded, every request authenticated by a turn grant token; grant minting/revocation (ADR-015 scope, TTL); a stateless stdio MCP relay in `integrations/mcp` exposing `nexar.intelligence_submit` / `nexar.intelligence_status` (submit-and-poll, each call well under 120 s, JSON in a text block).
- **059b — OpenWorker wiring:** per turn, register the `nexar` MCP entry via OpenWorker REST with the endpoint and token in `env`, delete it at turn end; serialize Cowork turns per OpenWorker server while delegation is on; Nexar policy allows exactly the two bridge tools (recorded), all other MCP stays denied; child lineage `depth + 1`, chain contains `openworker`, children never start OpenWorker; fake OpenWorker gains a minimal MCP stdio client; offline E2E.

## Acceptance criteria

- [ ] Fake OpenWorker issues MCP tool calls; delegated units run on different fake resources (one subscription agent) per the turn ledger; results return to the same turn; drafts imported by Nexar.
- [ ] Negatives: expired/revoked token, scope widening, wrong project, depth > 2, re-entry, budget exhausted, cancellation, timeout.

## Security considerations

The bridge must never let OpenWorker reach approvals, commits, outward executors or another session.
