# NXR-063: OpenWorker NexarProvider and control-resource policy

**Milestone:** v0.6 — Resource orchestration · **Labels:** openworker, routing, security · **Depends on:** NXR-062 · **ADR:** [ADR-027](../adr/027-resource-orchestration-architecture.md) ([plan](../architecture/resource-orchestration-plan.md))

## Objective

OpenWorker's control loop runs on an owner-pinned or NRC-Auto control resource through Nexar's Control Model Gateway, so OpenWorker no longer owns a provider.

## Problem

ADR-026 §4 configures an API key directly into OpenWorker; there is no Nexar provider and no owner control-resource choice; upstream has no provider extension seam.

## Scope

- Choose the transport in order and record the decision: (1) upstream provider-extension seam (contribute); (2) supervised loopback gateway child via OpenWorker `openai` `base_url` (Chat Completions) with the plan §8 security rationale; (3) minimal maintained patch.
- Map Chat Completions ↔ `ControlTurnRequest`; keep provider-private extras server-side keyed by tool-call id within the pinned decision; SSE streaming.
- Verify OpenWorker at-rest handling of provider keys/tokens in its private state; prefer per-launch config and wipe on exit.
- Lane state `openworker-control-unavailable` with a precise reason; interim direct-key path kept and recorded until the provider ships; OpenWorker's own `openai-codex` store never used as a Nexar connection.

## Acceptance criteria

- [ ] Fake OpenWorker drives a multi-iteration loop through the gateway on a fake `model-turn` resource; pinned vs Auto; fallback restart; no key ever reaches OpenWorker in the gateway path.

## Security considerations

Desktop main opens no listener; any gateway child is loopback-only, token-bound, single-alias and supervised.
