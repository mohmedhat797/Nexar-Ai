# ADR-005: Nexar Resource Controller ownership and responsibility

**Status:** Accepted (2026-09-30)

## Context

Nexar must decide, for every task, which AI resource executes it. Upstreams each have their own
routing (DSH provider routes, pi-ai model registry, Delegate Skills lanes), but none reasons across
_all_ of the owner's resources — subscriptions, API keys, native agents, local GPUs — or explains its
choice. This is the core of Nexar's value and must survive any upstream being replaced.

## Decision

- The **Nexar Resource Controller (NRC)** is Nexar-owned and answers only "who should execute?".
- Responsibilities are split into three replaceable parts:
  - **Resource Registry** — what exists and its current state; discovery seam (`ResourceSource`);
    health/auth probes. Makes no routing decisions.
  - **Routing Policy** — a pure, deterministic function
    `evaluate({ task, candidates }) → assessments` (eligible, score, reasons).
  - **Resource Controller** — composes them, partitions selected/alternatives/rejected, and returns
    an explainable `RouteDecision`. Callers depend only on `ResourceRouter.route(task)`.
- v0.1 policy (`deterministic@1`): task kind → required capabilities; hard filters (capability,
  availability, auth, privacy, context); preference tiers (task-preferred > kind-preferred > default);
  stable tie-break by id. "No eligible resource" is a decision outcome, not an exception.
- Every assessment carries machine-readable reason codes plus human text.

## Rationale

Separating state, policy, and composition lets v0.4 introduce quota/cost/latency/history-aware
scoring by swapping the policy only. Explainability is required for debugging, user trust, and
future learning (reason codes become features).

## Alternatives considered

- Delegate routing to DSH or pi-ai — rejected: they only see their own resources.
- Scoring/ML policy now — rejected as premature; no telemetry history exists yet.

## Consequences

Task kinds are data (config), not code: adding a kind = adding a rule. Policy output is validated
(one assessment per candidate).

## Risks

Deterministic rules can be too coarse for mixed tasks; mitigated by explicit
`requirements.capabilities` and `preferredResourceIds` on tasks.

## Follow-up work

v0.4: quota/cost/latency awareness, historical success scoring from telemetry, reservation policy
(e.g. keep premium subscription headroom for high-judgment tasks).

## Amendment (2026-10-04): resource orchestration

The NRC gains a plan-level **Resource Strategy Planner** (`strategy@1`) and runtime
revalidation ([ADR-027](027-resource-orchestration-architecture.md) §6). It remains "who executes"; it never decomposes work.
