# ADR-006: Local-first system architecture

**Status:** Accepted (2026-09-30)

## Context

Nexar handles highly sensitive material and uses subscription-authenticated runtimes installed on
the owner's computer. A mobile client and an always-on node are planned but not needed yet.

## Decision

- The primary runtime is the owner's computer. Nexar Core is a library; the CLI is a thin client.
- State lives in a git-ignored `.nexar/` directory (telemetry JSONL, runtime homes), files 0600.
- No cloud infrastructure in v0.1. Cloud model providers are used only as selected resources.
- The future Control Plane (v0.5) is a local daemon first; a remote/always-on node is an explicit
  later decision with its own ADR.

## Rationale

Native agents authenticate against local subscriptions; local execution avoids moving code and
documents through Nexar-owned servers; zero infra cost fits the project stage.

## Alternatives considered

Hosted control plane from day one — rejected: cost, attack surface, and no current need.

## Consequences

Availability is tied to the owner's machine until v0.5+. Telemetry is local-only.

## Risks

Local state loss (no sync/backup yet); mobile access requires a secure tunnel design later.

## Follow-up work

v0.5 control-plane ADR (daemon API, device pairing, remote access model).
