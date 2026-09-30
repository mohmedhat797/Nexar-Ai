# NXR-033: Dynamic resource discovery

**Milestone:** v0.4 — Resource Intelligence · **Labels:** resource-registry · **Depends on:** none

## Summary

Implement `ResourceSource`s that discover resources automatically: the pi-ai model catalog, installed
agent CLIs, and local runtimes such as Ollama, instead of requiring each to be hand-written in config.

## Problem

[ADR-007](../adr/007-ai-resource-abstraction.md) and the [roadmap](../roadmap/ROADMAP.md) plan discovery
for v0.4, and `@nexar/resource-registry` has a discovery seam (`ResourceSource`), but resources come only
from static config. pi-ai ships a catalog of many providers and models ([research](../research/upstream/pi.md)),
and owners install new CLIs and local models without updating Nexar config.

## Objective

The registry merges discovered resources with configured ones, with config taking precedence, and
discovery never makes paid calls or leaks secrets.

## Scope

- pi-ai catalog source: map `models.getModels()` entries (context window, max tokens, reasoning, input, cost) to `ResourceDescriptor`s, filtered by the adapter's provider allowlist.
- Installed-CLI source: detect `claude`, `codex`, `agy`, `dsh` on `PATH` and create default agent resources.
- Local runtime source: query a configured Ollama/OpenAI-compatible endpoint's model list (verify the endpoint shape against upstream).
- Merge rules: config overrides discovered fields (for example rates, tags, capabilities); owner can disable sources or exclude ids.
- `nexar resources --discovered` marks the origin of each resource.
- Refresh cadence and caching, with an injected clock.

## Out of scope

- Quota (NXR-030) and scoring (NXR-032).
- Auto-enabling resources that need credentials: discovered resources start as `unauthenticated` or `unknown` until probed.
- Discovery of remote services not configured by the owner.

## Technical notes

- Only `@nexar/integration-pi` may import pi-ai ([ADR-008](../adr/008-upstream-isolation.md)). The source is provided by the integration and registered through the registry's seam; the registry itself stays upstream-free.
- Descriptors carry credential references only: derive the env var name from config or provider conventions, never a value.
- Capabilities for discovered models come from catalog flags (for example `reasoning`); otherwise use a conservative default.
- Catalog rates are estimates: `CostProfile` for pi models is labeled catalog-based; version drift between pi-ai and DSH's embedded copy is a known risk.
- Discovery is read-only: no network except the owner-configured local endpoint.

## Acceptance criteria

- [ ] Sources can be enabled or disabled in config; a failing source does not break the registry.
- [ ] Discovered resources merge with configured ones deterministically, with config winning.
- [ ] No discovered resource exposes a secret or claims `authenticated` without a probe.
- [ ] `nexar resources` shows the origin of each resource.
- [ ] Provider allowlist is honored for the pi catalog.

## Testing expectations

Offline tests with fake sources, `fauxProvider()` catalog data, a fake `PATH` and a fake local endpoint
(HTTP stub). Live discovery against a real Ollama is opt-in (`NEXAR_LIVE_TESTS=1`).

## Security considerations

Discovery must not execute arbitrary binaries beyond `--version`-style calls on known names, and must
never read runtime credential stores. Treat endpoint responses as untrusted input; bound their size.
