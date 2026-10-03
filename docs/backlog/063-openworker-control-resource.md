# NXR-063: OpenWorker control resource

**Milestone:** v0.6 — Resource orchestration · **Labels:** openworker, routing · **Depends on:** NXR-060, NXR-059 · **ADR:** [ADR-027](../adr/027-resource-orchestration-architecture.md) ([plan](../architecture/resource-orchestration-plan.md))

## Objective

OpenWorker's own agent loop runs on an NRC-selected control resource: an owner-allowed API connection or a local endpoint (Ollama / OpenAI-compatible).

## Problem

ADR-026 §4 ties OpenWorker to API keys for all work; there is no local option and no control/worker split.

## Scope

- Select the control resource with `agent-loop-control:openworker` (+ tool-use, latency preference).
- Configure local endpoints through OpenWorker's `ollama` provider or `openai` `base_url`.
- Verify OpenWorker's at-rest handling of provider keys in its private state; minimise (per-launch config, wipe on exit).
- Precise unavailable reason ("needs a control model: add a local model (free) or allow an API key").

## Acceptance criteria

- [ ] Fake OpenWorker receives the NRC-selected control provider; local-only path works with no key; no subscription is ever a control resource.

## Security considerations

OpenWorker's `openai-codex` provider (emulated Codex-client OAuth) is never configured.
