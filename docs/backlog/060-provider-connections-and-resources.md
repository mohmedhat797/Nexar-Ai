# NXR-060: Provider connections and resource normalization

**Milestone:** v0.6 — Resource orchestration · **Labels:** resources, desktop, routing · **Depends on:** — · **ADR:** [ADR-027](../adr/027-resource-orchestration-architecture.md) ([plan](../architecture/resource-orchestration-plan.md))

## Objective

Every provider connection (subscription, API, local, custom) becomes Nexar resources in one registry, and Desktop Auto routes to real resources.

## Problem

Subscriptions appear only through PATH discovery, connections are not modelled, and the first-run Desktop config makes the echo test double the default resource, so Auto ignores an authenticated Claude Code.

## Scope

- `ProviderConnection` contract (`subscription | api | local | custom`, status, adapters) and `metadata.connection` on every resource source.
- Probe-backed native subscription source (Claude Code, Codex; Antigravity experimental).
- Capability `agent-loop-control:<engine>` on resources an engine may legitimately use as its control model.
- First-run Desktop config without `local-echo`; one-time migration (with backup) of an untouched echo-default config; echo stays for tests/CLI.

## Acceptance criteria

- [ ] Anthropic subscription + API, OpenAI subscription + API, Google native (unsupported/experimental honestly), Gemini API, DeepSeek API and a local endpoint coexist in one snapshot without separate routers.
- [ ] Auto on a fresh Desktop with an authenticated native agent selects it; with nothing eligible it reports `NO_ELIGIBLE_RESOURCE` with reasons.

## Security considerations

No secret in connections; discovered never means authenticated.
