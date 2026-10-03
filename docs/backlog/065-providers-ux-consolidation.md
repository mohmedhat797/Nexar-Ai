# NXR-065: Providers UX consolidation

**Milestone:** v0.6 — Resource orchestration · **Labels:** desktop, providers · **Depends on:** NXR-060 · **ADR:** [ADR-027](../adr/027-resource-orchestration-architecture.md) ([plan](../architecture/resource-orchestration-plan.md))

## Objective

Settings → Providers shows providers with their connection methods; an advanced view shows resources.

## Problem

The Providers tab is organised by implementation (API keys, subscriptions, local servers), not by provider.

## Scope

- Provider cards (Anthropic, OpenAI, Google, DeepSeek, Mistral, OpenRouter, Local/Custom) × supported methods; unsupported methods hidden or shown with the reason.
- Advanced resource view (id, connection, adapter, capabilities, auth, quota provenance, cost class, health).
- Owner resource policy contract (allowed lanes, preference tier, prefer-subscription, privacy, reservations); Auto default with overrides.

## Acceptance criteria

- [ ] Renderer/E2E: connections per provider, statuses, no secret in the page; policy round-trips through validated IPC.

## Security considerations

Keys never cross IPC; subscription logins stay vendor-owned.
