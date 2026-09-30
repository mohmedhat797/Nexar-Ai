# ADR-001: Nexar monorepo strategy

**Status:** Accepted (2026-09-30)

## Context

Nexar consists of a small stable domain (contracts, registry, controller, core), several
integration adapters for fast-moving upstreams, and future apps (CLI, control plane, mobile PWA).
These must evolve together while keeping dependency direction strict. The upstreams Nexar integrates
with (DeepSeek Harness, pi-ai, Delegate Skills relay) are Node/TypeScript; OpenWorker is Python but
is integrated out-of-process.

## Decision

- One repository, **pnpm workspaces** with three groups: `apps/*`, `packages/*` (Nexar domain),
  `integrations/*` (one package per upstream adapter).
- **TypeScript (strict)** on Node ≥ 22.19, ESM only, plain `tsc -b` project references, Vitest,
  ESLint (type-aware) and Prettier. One gate: `pnpm check`.
- **TypeScript pinned to 6.x**: TypeScript 7 is current, but `typescript-eslint` does not support
  it yet (it refuses to load). Upgrade when it does.
- Python only where justified (none in v0.1); use `uv` when it is.
- No Nx/Turborepo/Lerna, no microservices, message brokers, Kubernetes, or distributed databases.
- Packages are created when their milestone starts — no empty placeholders.

## Rationale

The simplest structure that enforces the dependency rule (domain → nothing; integrations → domain;
apps → both). `tsc -b` gives incremental builds and correct ordering without an orchestrator at
this size. Node ≥ 22.19 is the floor required by pi-ai 0.99 and DeepSeek Harness.

## Alternatives considered

- Polyrepo per component — rejected: cross-cutting contract changes would need coordinated releases.
- Turborepo/Nx — rejected for v0.1: caching gains are negligible at ~10 packages; adds config surface.
- Bundlers (tsup/tsdown) — rejected: libraries are consumed in-repo; `tsc` output is sufficient.

## Consequences

Adding a package = create dir + one reference in root `tsconfig.json` (Vitest aliases are automatic).
All packages are `private`; nothing is published to npm in v0.1.

## Risks

Build orchestration may become slow as packages grow; revisit at ~25 packages or when CI > 5 min.
TypeScript 6 → 7 migration pending on typescript-eslint.

## Follow-up work

Add `apps/control-plane` (v0.5), `apps/mobile` (v0.5), `integrations/delegate-skills` (v0.3) when
their milestones start.
