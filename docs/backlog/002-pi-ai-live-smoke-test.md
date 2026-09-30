# NXR-002: pi-ai live smoke test

**Milestone:** v0.1 — Foundation · **Labels:** integration, pi, testing · **Depends on:** none

## Summary

Prove `@nexar/integration-pi` against a real model: either a provider API key or a local Ollama /
OpenAI-compatible endpoint via `baseUrl`. Record what real usage and error shapes look like.

## Problem

The pi adapter is tested only with pi-ai's `fauxProvider()` ([ADR-003](../adr/003-pi-ai-multi-provider-layer.md)).
The [research note](../research/upstream/pi.md) verified the API only offline: no real provider call was
made, and behavior against Ollama/vLLM/LM Studio, real `usage.cost` values and error paths are unverified.

## Objective

An opt-in live test showing `nexar run` → NRC → pi adapter → real model → result with measured token
usage and catalog-estimated cost, and a documented procedure for running it.

## Scope

- Live test using `describe.skipIf(!process.env.NEXAR_LIVE_TESTS)`, with two variants: API key
  (env var named in the resource descriptor) and local endpoint (OpenAI-compatible `baseUrl`).
- Verify usage mapping: tokens `measured`, cost `estimated` (basis: pi-ai catalog rates).
- Verify failure mapping for bad key, unknown model and unreachable endpoint (`stopReason: 'error'`).
- Document the procedure in `docs/devlog/`.

## Out of scope

- Streaming ([NXR-004](004-streaming-text-output.md)) and tool calling.
- OAuth/subscription providers through pi-ai (disabled in v0.1 by ADR-003).
- Catalog-driven discovery ([NXR-033](033-dynamic-resource-discovery.md)).

## Technical notes

- Package: `integrations/pi`; depends only on exact-pinned `@earendil-works/pi-ai` (0.99.2 at research time).
- Call shape (research, verified offline): `builtinModels()` → `models.getModel(provider, id)` →
  `models.complete(model, context, { signal, maxTokens })`; `msg.usage` has `input`, `output`,
  `cacheRead`, `cacheWrite`, `cost.total`.
- pi-ai reports failures as `stopReason: 'error' | 'aborted'`, not throws; the adapter maps them to
  `NexarError` codes (`AUTH_REQUIRED`, `PROVIDER_ERROR`, `EXECUTION_CANCELLED`).
- For local models use `@earendil-works/pi-ai/api/openai-completions.lazy` with a custom base URL (verify
  the exact option name against the pinned version).
- Pi types must not leave the adapter; the test asserts only on Nexar `ExecutionResult` fields.

## Acceptance criteria

- [ ] The live test passes with an API key (provider stated in the devlog) or a local Ollama model.
- [ ] Usage is reported as `measured` tokens and `estimated` cost, never a fabricated `0`.
- [ ] Bad-key, unknown-model and unreachable-endpoint cases yield the expected `NexarError` codes.
- [ ] Without `NEXAR_LIVE_TESTS` the tests are skipped and `pnpm check` is unchanged.
- [ ] Findings on the research open questions (local endpoints, cost accuracy) are recorded.

## Testing expectations

CI remains offline with `fauxProvider()`. Live tests are opt-in via `NEXAR_LIVE_TESTS=1`, use a tiny prompt and
low `maxTokens`, and are never run in CI. The local-endpoint variant should skip itself if the endpoint is
unreachable rather than fail.

## Security considerations

API key comes only from the env var named in the config reference; never log or commit it. Do not call
pi-ai `login()` or use OAuth flows. Do not log prompts at info or above. Keep the provider allowlist.
