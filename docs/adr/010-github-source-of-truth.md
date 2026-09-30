# ADR-010: GitHub as durable engineering source of truth

**Status:** Accepted (2026-09-30)

## Context

Nexar is developed largely by AI sessions whose conversation context is ephemeral (cloud containers
are reclaimed; context windows are summarized). Anything not in the repository is effectively lost.

## Decision

- Everything durable lives in the repository: architecture, ADRs, research (with inspected commit
  SHAs), roadmap, backlog, devlogs, usage notes, release notes, known risks.
- `CLAUDE.md` is the compact operating context for future sessions; ADRs hold the reasoning.
- Work happens on feature branches, one logical Conventional Commit per accepted unit, pushed
  immediately; merges to `main` via reviewed pull requests. No force-push, no history rewrites.
- Backlog items are GitHub issues when issue tooling is available, otherwise specifications under
  `docs/backlog/` written so a future engineer or agent can act without chat history.

## Rationale

Makes the project resumable by any engineer or agent from the repository alone.

## Alternatives considered

External wiki/notes — rejected: drifts from code, not reviewable in PRs.

## Consequences

Documentation changes are reviewed like code. Research notes are dated snapshots, not living docs.

## Risks

Docs drift from implementation; mitigated by updating docs in the same commit as behavior changes.

## Follow-up work

Changelog discipline per release; periodic research refresh when upgrading pinned upstreams.
