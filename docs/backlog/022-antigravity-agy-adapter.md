# NXR-022: Google Antigravity (`agy`) adapter

**Milestone:** v0.3 — Engineering Machine · **Labels:** integration, antigravity · **Depends on:** none

## Summary

Add `@nexar/integration-antigravity`, an adapter that runs Google's Antigravity CLI (`agy`) as an
`agent` resource for coding work.

## Problem

[ADR-007](../adr/007-ai-resource-abstraction.md) and [ADR-011](../adr/011-native-agent-adapters.md) name
Antigravity as a native agent resource for v0.3; no adapter exists. Nothing in this repo documents
`agy`'s non-interactive interface beyond the Delegate Skills note on its relay.

## Objective

A coding task can be routed to `agy`, executed non-interactively in an allowlisted directory, and returned
as an `ExecutionResult`, or the blocker is documented if `agy` has no suitable non-interactive mode.

## Scope

- Spike first: determine `agy`'s non-interactive invocation, output format, auth and sandbox options; record them in `docs/research/upstream/` with the inspected version.
- If suitable, implement `integrations/antigravity` with `supports`, `probe` and `execute`.
- Contract tests against a fake `agy` binary.
- Example resource in `config/`.
- If not suitable, write the findings and close the item with a documented decision.

## Out of scope

- Delegate Skills' `agy-delegate` relay ([NXR-023](023-delegate-skills-adapter.md)).
- Handling Google credentials; GUI automation of the Antigravity app.
- Live tests in CI.

## Technical notes

- Do not invent `agy` flags: verify against upstream docs and `agy --help`; record the version.
- The Delegate Skills [research note](../research/upstream/delegate-skills.md) lists the `agy` relay's session
  fields as `conversationId` and `projectId` and no documented cost/tokens; expect usage to be `unavailable`.
- The same note warns that the agy relay churns quickly, so expect upstream instability: pin the version and
  keep parsing tolerant.
- Follow the `integrations/claude-code` structure and [ADR-008](../adr/008-upstream-isolation.md).
- `probe` is side-effect free and never makes paid calls.

## Acceptance criteria

- [ ] A research note documents the verified `agy` interface (or why it cannot be integrated), with version.
- [ ] If implemented, contract tests pass for success, error, timeout, abort and malformed output.
- [ ] `nexar doctor` shows `agy` availability and version.
- [ ] Usage is `Measured`; unknown values are `unavailable`, never `0`.
- [ ] `agy` names, flags and formats appear only in `integrations/antigravity`.

## Testing expectations

Fake-binary contract tests run offline in CI. Live tests are opt-in (`NEXAR_LIVE_TESTS=1`) and need an
authenticated `agy`.

## Security considerations

Do not read or copy Google/Antigravity credentials; use the supported CLI only. Minimal explicit env,
allowlisted working directory, restrictive tool/sandbox defaults, untrusted output, no prompts in
info+ logs.
