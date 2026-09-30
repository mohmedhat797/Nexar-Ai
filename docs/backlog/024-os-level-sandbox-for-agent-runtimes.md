# NXR-024: OS-level sandbox for agent runtimes

**Milestone:** v0.3 — Engineering Machine · **Labels:** security · **Depends on:** none

## Summary

Run subprocess agent runtimes (DSH, Claude Code, Codex, relays) inside an OS-level sandbox, using
bubblewrap on Linux or containers, so a prompt-injected agent cannot reach beyond its task directory.

## Problem

The [security model](../architecture/security.md) lists "no OS-level sandbox around agent runtimes yet" as
a known gap: Nexar relies on each runtime's own permission model. Agents run as the owner's OS user and,
per the [DSH research](../research/upstream/deepseek-harness.md), can read runtime credential files.
Model output is untrusted, and the v0.3 milestone adds more autonomous agents.

## Objective

A reusable launch wrapper that confines a runtime to its working directory, its isolated home under
`.nexar/runtimes/`, and only the network access it needs.

## Scope

- A Nexar-owned `SandboxLauncher` abstraction in `@nexar/core` (or a small dedicated package) wrapping subprocess spawn.
- Linux backend using `bwrap`, with read-only system mounts, writable task cwd and runtime home only, unshared PID/IPC, and no access to `$HOME` credentials.
- Network policy: none, or allowlisted egress via a proxy, per resource (model providers must be reachable).
- Fallback behavior when no sandbox is available: refuse by default for `write`-capable tasks, with an explicit owner opt-out that is logged.
- `nexar doctor` reports sandbox availability.
- Adopt in at least one adapter as the first consumer (Claude Code or DSH); others follow.

## Out of scope

- macOS/Windows backends and container-image distribution (document as follow-ups).
- Sandboxing Nexar itself or in-process adapters (pi-ai).
- Replacing runtimes' own permission systems.

## Technical notes

- The repo's development relay already needs `bubblewrap` + `socat` ([ADR-009](../adr/009-delegate-skills-development-workflow.md)), so the dependency is familiar.
- Adapters keep passing the scrubbed minimal env ([ADR-008](../adr/008-upstream-isolation.md)); the sandbox adds filesystem and network confinement.
- Runtimes that need their own login (Claude/Codex) may require a read-only bind of their credential store; decide
  per runtime without Nexar reading it, and document each (verify against upstream).
- Sandbox failures map to `CONFIGURATION_ERROR` or `RESOURCE_UNAVAILABLE`, not silent fallback.

## Acceptance criteria

- [ ] A sandboxed process cannot read files outside its mounts (tested with a probe script).
- [ ] A sandboxed process cannot write outside the task cwd and runtime home.
- [ ] Network is denied by default and opened only as configured.
- [ ] Missing `bwrap` yields a clear error or an explicit, logged opt-out, never silent unsandboxed execution.
- [ ] `nexar doctor` shows sandbox status.

## Testing expectations

Offline tests launch harmless probe scripts; tests that need `bwrap` skip with a reason when it is
unavailable. No paid calls.

## Security considerations

The sandbox is defense in depth, not a replacement for approvals ([NXR-014](014-human-approval-framework.md)).
Avoid mounting `$HOME`, sockets (for example Docker) or the repo's `.git` unless required. Review every bind mount.
