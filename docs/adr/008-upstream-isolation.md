# ADR-008: Upstream isolation and anti-corruption boundaries

**Status:** Accepted (2026-09-30)

## Context

All major upstreams are pre-1.0 and fast-moving (DSH: near-daily prereleases; pi-ai: 52 versions in
a month; OpenWorker: 163 commits in 30 days; Delegate Skills: ~390 commits in 3 months). Nexar must
survive their changes without its domain collapsing.

## Decision

1. Each upstream is integrated by exactly one package under `integrations/<name>/`. Only that package
   may reference upstream packages, binaries, protocols, or file formats.
2. Integration packages implement Nexar-owned interfaces (`ExecutionAdapter`, Work Bridge) and never
   export upstream types.
3. Prefer, in order: documented protocol/CLI out-of-process → pinned SDK dependency → in-process
   internals (never). No forks unless an ADR justifies one.
4. Exact version pins for upstream dependencies and documented pinned versions for external
   binaries; upgrades are deliberate commits with contract tests.
5. Every adapter has contract tests against a fake/faux upstream that run in CI without network or
   credentials; live tests are opt-in (`NEXAR_LIVE_TESTS=1`).
6. Upstream errors map to `NexarError` codes; upstream usage maps to `Measured<T>`.

## Rationale

Confines the blast radius of an upstream breaking change to one package and one test suite; makes
"replace DSH / Pi / OpenWorker / a provider" a local change (the project's success criterion).

## Alternatives considered

Direct imports across the codebase — rejected (the failure mode this ADR exists to prevent).

## Consequences

Some duplication (e.g. a small JSON-RPC client instead of DSH's SDK) in exchange for decoupling.

## Risks

Fakes can drift from real upstream behavior; mitigated by recording real protocol samples during
opt-in live runs and pinning versions.

## Follow-up work

Lint rule forbidding upstream package imports outside `integrations/` (backlog).
