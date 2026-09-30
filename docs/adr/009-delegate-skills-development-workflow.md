# ADR-009: Delegate Skills development workflow

**Status:** Accepted (2026-09-30).
Evidence: [`docs/research/upstream/delegate-skills.md`](../research/upstream/delegate-skills.md)
(inspected `amElnagdy/delegate-skills@6826b36`, skills labeled 0.5.0).

## Context

Nexar is built by an orchestrating Claude session (Opus) that owns architecture, review, and
commits, delegating well-scoped implementation to a cheaper implementer (Sonnet). Delegate Skills
provides `claude-delegate`: a relay that runs `claude -p` with a restricted tool surface, a shell
sandbox, and structured artifacts, and **never commits**. Delegate Skills is _also_ a candidate
product-time component of Nexar's engineering machine (v0.3). The two uses must not be confused.

## Decision

**Development-time (now):**

- Orchestrator: Claude Opus. Implementer: Claude Sonnet via `claude-delegate`
  (`relay.mjs --model claude-sonnet-5-5`; verified in the session stream as `claude-sonnet-5-5`).
- Loop: Opus writes a self-contained brief (objective, why, context, in/out of scope, contracts,
  acceptance criteria, tests, security + git constraints) → Sonnet implements without committing →
  Opus reviews the full diff and re-runs `pnpm check` → Opus fixes or re-dispatches → Opus commits
  (one logical Conventional Commit) and pushes.
- One engineering concern per brief. Sonnet never has architectural authority and is never the
  final reviewer.
- Environment specifics (cloud container): the relay's Linux sandbox needs `bubblewrap` + `socat`;
  the sandbox has **no network**, so the orchestrator installs dependencies before dispatch; the child
  inherits the parent session id, so `--session`/`--resume-last` are **not** used — rework is a fresh
  dispatch with a delta brief. Briefs and run artifacts stay outside the repo.
- The skill is installed per-machine (`npx skills add amElnagdy/delegate-skills`), not vendored.

**Product-time (v0.3, not implemented):** a `@nexar/integration-delegate-skills` adapter may invoke
pinned relays as subprocesses and map `result.json` (`delegate-relay.result.v1`) into Nexar's
`ExecutionResult`/telemetry, with Nexar owning worktrees, review gates, and commits.

## Rationale

Keeps expensive judgment in the orchestrator and routine implementation in the implementer, with a
hard commit boundary. The relay's structured result makes review auditable.

## Alternatives considered

Native Claude subagents only — usable for research (done for upstream research here), but the relay
gives an explicit permission profile and artifacts for implementation work.

## Consequences

Every implementation commit is authored by the orchestrator after review; briefs are the durable
unit of delegation.

## Risks

Relay result schema has no published JSON Schema; skill version labels are not release pins; relay
live-verified upstream only on macOS (works here on Linux with bubblewrap).

## Follow-up work

v0.3: product-time adapter, worktree-per-task isolation, lane configuration.
