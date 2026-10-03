# NXR-064: DSH as the Code orchestrator inside the engineering envelope

**Milestone:** v0.6 — Resource orchestration · **Labels:** engineering, deepseek-harness, routing · **Depends on:** NXR-061, NXR-062 · **ADR:** [ADR-027](../adr/027-resource-orchestration-architecture.md) ([plan](../architecture/resource-orchestration-plan.md))

## Objective

DSH orchestrates planning/write lanes with an NRC-selected control resource and reaches worker resources only through a lane-scoped Nexar bridge.

## Problem

DSH is only a lane resource needing `DEEPSEEK_API_KEY`; its planning and sub-agents are unused; Nexar resource ownership inside DSH is undefined.

## Scope

- Time-boxed spike: DSH local/base-URL control route; DSH MCP client vs ACP capability for a lane-local relay over a launcher-owned descriptor (no network in bwrap).
- Control resource selection (`agent-loop-control:dsh`); `DEEPSEEK_API_KEY` no longer required.
- Lane bridge implementation; DSH sub-agent providers not used as Nexar routes.
- Without a DSH control resource: native-agent lanes (NXR-055 path), recorded as `executor: native`.

## Acceptance criteria

- [ ] Fake DSH orchestrates a lane and delegates a unit through the lane bridge to a fake subscription agent; sandbox, patch policy, gates, review, approval, commit unchanged.

## Security considerations

All ADR-018/019/025 controls stay; agents never push; no network in the sandbox.
