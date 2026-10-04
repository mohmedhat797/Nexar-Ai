# NXR-064: DSH Code orchestration through the plane Engine Gateway

**Milestone:** v0.6 — Resource orchestration · **Labels:** engineering, deepseek-harness, routing · **Depends on:** NXR-061, NXR-062 · **ADR:** [ADR-027](../adr/027-resource-orchestration-architecture.md) ([plan](../architecture/resource-orchestration-plan.md))

## Objective

DSH orchestrates planning/write lanes; its control loop and work units use plane resources through the plane's Engine Gateway.

## Problem

DSH is only a lane resource needing `DEEPSEEK_API_KEY`; its planning and sub-agents are unused; Nexar resource ownership inside DSH is undefined.

## Scope

- Time-boxed spike: DSH LLM route to an OpenAI-compatible base URL (plane-local Control Model Gateway over a launcher-owned descriptor/socket relayed into bwrap, like the egress proxy); DSH MCP client vs ACP for a lane-local Intelligence Bridge relay.
- Control resource per lane loop (owner policy for Code; `model-turn` plane resources); `DEEPSEEK_API_KEY` no longer required.
- Work units through the bridge; DSH sub-agent providers not used as Nexar routes.
- Without a DSH control resource: native-agent lanes (NXR-055 path), recorded as `executor: native`.

## Decision and split (2026-10-04)

Spike done: [ADR-027 §9b](../adr/027-resource-orchestration-architecture.md), evidence in
[`dsh-control-routing.md`](../research/upstream/dsh-control-routing.md). Pi-ai route `nexar` →
plane-local translator on a unix socket, socat into the sandbox; units via an ACP-mounted stdio relay.

- **064a:** move the bridge endpoint host and the Chat Completions translator into shared packages
  (Desktop unchanged in behaviour); sandbox launcher "Nexar services" mount (`gateway.sock` socat
  bridge, `bridge.sock`, read-only relay, `NO_PROXY=127.0.0.1` only then).
- **064b:** the DSH lane on the plane: per-lane grant and pinned control decision
  (`orchestration.code.controlResource`), overlay route `nexar`, ACP `mcpServers` relay, fallback
  `executor: native`; fake DSH + E2E.

## Acceptance criteria

- [ ] Fake DSH orchestrates a lane: control turns via the plane gateway, one unit via the bridge to a fake subscription agent; sandbox, patch policy, gates, review, approval, commit unchanged.

## Security considerations

All ADR-018/019/025 controls stay; agents never push; no network in the sandbox; no credentials cross `wsl.exe`.
