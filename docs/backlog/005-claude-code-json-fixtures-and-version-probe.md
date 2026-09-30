# NXR-005: Claude Code CLI JSON fixtures and version tracking

**Milestone:** v0.1 — Foundation · **Labels:** integration, claude-code, testing · **Depends on:** none

## Summary

Record real `claude -p --output-format json` outputs as sanitized fixtures, add a contract fixture test
for the adapter's parser, and report the `claude` version from `probe`.

## Problem

[ADR-011](../adr/011-native-agent-adapters.md) maps `result`, `total_cost_usd`, `usage`, `num_turns` and
`is_error` from the CLI's JSON, but the adapter is tested against a fake `claude` binary written by
hand. CLI output fields can change between releases; today nothing detects that, and the probe does not
say which version ran.

## Objective

Real output shapes (success, error, non-zero exit) are pinned as fixtures, the parser is tested
against them, and the resolved `claude` version is visible in probe detail and `ExecutionResult.resolved.runtimeVersion`.

## Scope

- Capture outputs from a real authenticated `claude` (success, `is_error`, permission-denied, timeout).
- Sanitize: remove session ids, paths, prompts and any account details before committing.
- Contract test: parse each fixture and assert the `ExecutionResult` mapping and `Measured` usage.
- Probe: run `claude --version` (no paid call) and include it in `ResourceState.detail`.
- Set `resolved.runtimeVersion` on execution results.

## Out of scope

- Streaming output ([NXR-004](004-streaming-text-output.md)).
- Changing the read-only `plan` default or widening the tool surface.
- Pinning or installing `claude` for users.

## Technical notes

- Package: `integrations/claude-code`; invocation `claude -p --output-format json`, prompt on stdin.
- Parsing is tolerant: unknown fields ignored, missing usage figures become `unavailable(reason)`, never `0`.
- `probe` checks the binary and `claude auth status` only; it must stay side-effect free and free of cost.
- Use `ResourceState.detail` for the version string; `observedAt` from the injected clock.
- Delegate Skills' research notes that `claude` output differs across versions (verified on 2.1.220 and
  2.1.271 upstream; 2.1.286 locally): record the version alongside each fixture.

## Acceptance criteria

- [ ] Fixtures exist for success, `is_error: true`, and a non-zero-exit case, each annotated with the `claude` version.
- [ ] A test fails if a fixture no longer maps to the expected `ExecutionResult`.
- [ ] `probe` reports the `claude` version in `detail` when the binary is present.
- [ ] `ExecutionResult.resolved.runtimeVersion` is populated.
- [ ] A fixture review confirms no credentials, session ids or personal paths are present.

## Testing expectations

Fixture tests are offline and deterministic. Capturing new fixtures needs a live authenticated `claude`
and is a manual step (opt-in, `NEXAR_LIVE_TESTS=1` for any automated live check); never in CI.

## Security considerations

Do not read or copy Claude's own credentials; only run the supported CLI. Scrub fixtures of tokens,
account info and file paths before commit. Launch `claude` with the explicit minimal env already used by the adapter.
