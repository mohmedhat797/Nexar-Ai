# ADR-003: pi-ai as the direct multi-provider execution layer

**Status:** Accepted, amended by research (2026-09-30).
Evidence: [`docs/research/upstream/pi.md`](../research/upstream/pi.md)
(inspected `earendil-works/pi-mono@d4d74eb`, npm `@earendil-works/pi-ai@0.99.2`).

## Context

Nexar needs unified access to many model providers (API-key, OAuth/subscription, local
OpenAI-compatible) with streaming, usage, and cost. Research findings:

- Canonical project moved to `earendil-works/pi-mono`; `@mariozechner/*` is deprecated (frozen at
  0.73.1). Current package `@earendil-works/pi-ai@0.99.2`, Node ≥ 22.19.
- 0.99 introduced an instance API (`builtinModels()`, `models.getModel(provider, id)`,
  `models.complete(model, context, options)`); the old global API moved to `/compat` and will be
  removed. Breaking changes are routine (0.87 → 0.99 in about a week; 52 npm versions in a month).
- Failures surface as `stopReason: 'error' | 'aborted'` rather than throws. `Usage` exposes input,
  output, cache read/write tokens and a catalog-estimated cost.
- OAuth providers exist (Claude Pro/Max, ChatGPT, Copilot) but carry policy risk (third-party
  Anthropic subscription use is billed as extra usage; obfuscated first-party client IDs).
- DeepSeek Harness already embeds pi-ai (`^0.87.1`) inside its own LLM adapter.

## Decision

1. pi-ai is Nexar's **direct model execution layer**: `@nexar/integration-pi` runs `model`-kind
   resources whose runtime binding is `pi`, in-process.
2. Depend **only** on `@earendil-works/pi-ai`, **exact-pinned** (no caret). Do not depend on
   pi-agent-core, pi-coding-agent, or the server/durable packages.
3. The adapter uses the instance API, an explicit **provider allowlist**, API-key credentials from
   the env var named in the resource descriptor, and OpenAI-compatible custom endpoints for local
   models (Ollama/vLLM/LM Studio). **OAuth/subscription flows through pi-ai are disabled** in v0.1.
4. pi-ai types never cross the adapter boundary. `stopReason` is mapped to `NexarError` codes; usage
   is reported as `measured` tokens and `estimated` cost (basis: pi-ai catalog rates).
5. Nexar does **not** place its own pi adapter underneath DeepSeek Harness — DSH's route to pi-ai is
   configured through DSH's own overlay (ADR-002).
6. CI uses pi-ai's `fauxProvider()`; no network.

## Rationale

pi-ai is the most complete maintained provider abstraction in the ecosystem, MIT-licensed, and
already used by DSH. Exact pinning plus a single adapter package absorbs its churn. Subscription
access is better served by native runtimes that are sanctioned for it (ADR-011).

## Alternatives considered

- Vercel AI SDK / provider SDKs directly — more code for the same coverage; revisit if pi-ai churn
  becomes unmanageable (the adapter boundary makes this a local change).
- Pi coding agent (`pi --mode rpc`) as an agent resource — deferred to v0.3 (no permission system;
  must be sandboxed). Delegate Skills' `pi-delegate` is an alternative route.
- Routing everything through pi-ai — rejected: native agents are preferable for autonomous coding.

## Consequences

Model catalog and pricing come from pi-ai's generated catalog; Nexar resource descriptors reference
pi-ai model ids. Upgrading pi-ai is a deliberate change with contract tests.

## Risks

Breaking API changes every few weeks; catalog-estimated cost is not a bill; version skew with DSH's
embedded pi-ai.

## Follow-up work

Live smoke test (opt-in, needs an API key or local Ollama); streaming events; tool calling; model
catalog import into resource discovery (v0.4).

## Amendment (2026-10-04): resource orchestration

pi-ai remains the direct execution adapter for `api` and `local`/`custom` connections ([ADR-027](027-resource-orchestration-architecture.md)
§3–4); OAuth/subscription flows stay disabled. pi-ai resources may also be selected as an engine's
**control** model (§7).
