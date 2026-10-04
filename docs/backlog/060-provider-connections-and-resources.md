# NXR-060: Provider connections, compatibility metadata and resource normalization

**Milestone:** v0.6 — Resource orchestration · **Labels:** resources, desktop, routing · **Depends on:** — · **ADR:** [ADR-027](../adr/027-resource-orchestration-architecture.md) ([plan](../architecture/resource-orchestration-plan.md))

## Objective

Provider → connections → resources → compatibility metadata in one registry, and Desktop Auto routes to real resources.

## Problem

Subscriptions appear only through PATH discovery, connections and support classes are not modelled, nothing states control compatibility, and the first-run Desktop config pins the echo test double so Auto ignores an authenticated Claude Code.

## Scope

- Fix first: first-run Desktop config without `local-echo` / `defaultResourceId: local-echo`; one-time migration (with backup) of an untouched echo-default config; echo stays a test/dev and CLI built-in resource.
- `ProviderConnection` contract (`method`, `authClass`, `support`, `enabled`, `machine`) and `metadata.connection` on every source; no secrets.
- Probe-backed vendor-native subscription source (Claude Code, Codex; Antigravity experimental) alongside pi catalog (API) and local endpoints.
- Well-known capability `model-turn` on pi model resources whose model supports tools; never on native CLI agents; `ENGINE_CONTROL_REQUIREMENTS` data for OpenWorker and DSH.
- Plane readiness reports plane connections/resources (ids, method, support, auth state) as an additive `nexar-plane/1` field.
- States kept distinct: installed, authenticated, available, compatible, eligible, selected.

## Acceptance criteria

- [ ] One snapshot represents Anthropic (subscription + API), OpenAI (subscription + API), Google (native subscription, honestly experimental/unverified + Gemini API), DeepSeek API and Local (Ollama, LM Studio, custom) without separate routers.
- [ ] Auto on a fresh Desktop with an authenticated native agent selects it; with nothing eligible it reports `NO_ELIGIBLE_RESOURCE` with reasons; migration is idempotent and backed up.
- [ ] Control-candidate lists contain only `model-turn` + `tool-use` resources; native CLIs are excluded.

## Security considerations

No secret in connections or readiness; discovered never means authenticated; authenticated never means compatible.
