# NXR-065: Providers and orchestration-control UX

**Milestone:** v0.6 — Resource orchestration · **Labels:** desktop, providers · **Depends on:** NXR-060, NXR-063 · **ADR:** [ADR-027](../adr/027-resource-orchestration-architecture.md) ([plan](../architecture/resource-orchestration-plan.md))

## Objective

Settings → Providers shows providers with their connections (registration); Settings → AI Behavior / Orchestration chooses how they are used.

## Problem

The Providers tab is organised by implementation, and there is no control-resource or experimental-route setting.

## Scope

- Provider cards (Anthropic, OpenAI, Google, DeepSeek, Mistral, OpenRouter, Local/Custom) × supported methods; experimental methods labelled and off by default; plane connections shown read-only under "Engineering plane".
- AI Behavior / Orchestration: per mode Engine, Control Resource (Auto or a compatible resource), Fallback (Auto/None); prefer-subscription; review diversity; experimental enablement.
- Advanced resource view (id, connection, adapter, capabilities incl. `model-turn`, auth, quota provenance, cost class, support, health).

## Acceptance criteria

- [ ] Renderer/E2E: connections per provider; control dropdown lists only compatible resources; pinning round-trips via validated IPC; no secret in the page.

## Security considerations

Keys and tokens never cross IPC; vendor logins stay vendor-owned; experimental logins run in main.
