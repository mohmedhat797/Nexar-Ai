# ADR-007: AI Resource abstraction instead of model-only abstraction

**Status:** Accepted (2026-09-30)

## Context

Nexar must choose between API models, subscription-backed models, native coding agents (Claude
Code, Codex, Antigravity), agent harnesses (DSH), local models (Ollama/vLLM), and tool runtimes. A
`Model` abstraction cannot express "a coding agent with its own tool loop and subscription auth".

## Decision

- The core abstraction is the **AI Resource**, split into:
  - `ResourceDescriptor` (static, frozen config): id, displayName, `kind`, capabilities, runtime
    binding (adapter + locality), auth requirement (credential _reference_), cost profile, limits,
    data locality, tags, metadata.
  - `ResourceState` (dynamic): availability, auth state, quota, detail, observedAt.
  - `ResourceSnapshot` = descriptor + state — what routing consumes.
- `kind` is a **discriminated union** (`model` | `agent` | `tool-runtime`) rather than a flat enum:
  the hypothesis list (MODEL_PROVIDER, NATIVE_AGENT, CODING_AGENT, LOCAL_MODEL, API_PROVIDER,
  TOOL_RUNTIME, REMOTE_AGENT) collapses into these three shapes plus fields — e.g. a local model is
  `{ type: 'model', access: 'local' }`, a coding agent is an `agent` with the `coding` capability,
  a remote agent is an `agent` whose runtime locality is `remote`.
- Capabilities and task kinds are open string sets with well-known constants.
- Usage metrics use `Measured<T>` (`measured` | `estimated` | `unavailable`) so missing provider
  data is explicit, never `0`.

## Rationale

The union carries kind-specific fields with type safety while staying small; "coding" and "local"
are properties, not kinds, which avoids combinatorial enum growth. Separating static from dynamic
state avoids a giant mutable interface and lets probes update state without touching config.

## Alternatives considered

- Flat enum `ResourceType` — rejected: overlapping categories (a local model _is_ a model).
- One mutable `AIResource` object — rejected: races between config and health updates; hard to
  reason about in routing.

## Consequences

New resource families = new union member (rare) or new capability/tag (common, no code change).

## Risks

Capability strings are unvalidated beyond well-known constants; mitigated by config validation later.

## Follow-up work

Capability taxonomy review at v0.3; resource discovery from runtimes (e.g. pi-ai catalog, `claude`
model list) at v0.4.
