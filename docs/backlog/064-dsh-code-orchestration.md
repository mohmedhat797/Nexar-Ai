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

## Acceptance criteria

- [ ] Fake DSH orchestrates a lane: control turns via the plane gateway, one unit via the bridge to a fake subscription agent; sandbox, patch policy, gates, review, approval, commit unchanged.

## Security considerations

All ADR-018/019/025 controls stay; agents never push; no network in the sandbox; no credentials cross `wsl.exe`.
