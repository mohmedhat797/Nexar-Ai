# NXR-001: DeepSeek Harness live smoke test

**Milestone:** v0.1 — Foundation · **Labels:** integration, deepseek-harness, testing · **Depends on:** none

## Summary

Run the `@nexar/integration-deepseek-harness` adapter against a real `dsh` runtime with a real
`DEEPSEEK_API_KEY`, and capture the real protocol traffic to harden the fake runtime used in CI.

## Problem

The DSH path is proven only against a protocol-faithful fake ([ADR-011](../adr/011-native-agent-adapters.md)).
The fake was written from documentation and source reading, so it may drift from real behavior. Open
questions in the [research note](../research/upstream/deepseek-harness.md) (headless permission
behavior, `finalResponse` semantics, telemetry defaults) are unverified.

## Objective

A documented, opt-in live test that proves `nexar run` → NRC → DSH adapter → `dsh --profile sdk` →
DeepSeek → result → telemetry, plus recorded real samples that the fake runtime is checked against.

## Scope

- Opt-in live test using `describe.skipIf(!process.env.NEXAR_LIVE_TESTS)` and `DEEPSEEK_API_KEY`.
- Record real `initialize`, `session/prompt`, `session.event`, `session.status`, `shutdown` frames.
- Compare recorded frames with the fake runtime; fix the fake and/or the adapter where they differ.
- Record the answers to the research open questions that the run can settle.

## Out of scope

- ACP, cancel and approval round-trips ([NXR-020](020-deepseek-harness-acp-adapter.md)).
- Non-DeepSeek provider routes through DSH.
- Running live tests in CI.

## Technical notes

- Adapter: `integrations/deepseek-harness`; spawns an exact-pinned `dsh --profile sdk` (npm
  `@deepseek-ai/dsh@0.2.0-rc.2` at research time) with an isolated `DSH_HOME` under
  `.nexar/runtimes/deepseek-harness/`, a minimal env, and a `--patch` overlay ([ADR-002](../adr/002-deepseek-harness-execution-kernel.md)).
- Wire protocol: newline-delimited JSON-RPC 2.0; methods `initialize`, `session/prompt`, `shutdown`.
- Map results to `ExecutionResult` with `Measured<number>` usage; use `unavailable()` for figures DSH does not report.
- Check that `session-log-deepseek` is disabled in the overlay and that no session-log upload occurs.
- Samples are recorded payloads: scrub keys and prompts, and store them as test fixtures only after review.
- Research open questions to settle: does `finalResponse` correspond to the prompt; what happens under
  `workspace-write` + `ask` with no answerer (unverified upstream).

## Acceptance criteria

- [ ] `NEXAR_LIVE_TESTS=1 DEEPSEEK_API_KEY=… pnpm test` runs the live test and it passes.
- [ ] Without the env vars the live test is skipped and `pnpm check` is unchanged.
- [ ] Recorded real frames are committed as scrubbed fixtures, with the `dsh` version noted.
- [ ] A fake-vs-real comparison test fails if the fake's frame shapes diverge from the fixtures.
- [ ] Findings (and any fixes to the adapter) are written to `docs/devlog/`.

## Testing expectations

CI stays offline: the fixture-comparison test runs against the fake with no network. Only the live test
needs `NEXAR_LIVE_TESTS=1` and may cost money; it must use a minimal prompt and a low token limit.

## Security considerations

The key is read only from the env var named in the resource's credential reference and injected only into
the `dsh` child. Never commit `.credentials.yaml`, `DSH_HOME` contents or unscrubbed recordings. Do not
log prompts at info or above. Confirm DSH's default session-log upload stays disabled.
