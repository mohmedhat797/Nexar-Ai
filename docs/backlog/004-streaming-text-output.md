# NXR-004: Streaming text output for adapters and CLI

**Milestone:** v0.1 — Foundation · **Labels:** core, integration · **Depends on:** none

## Summary

Make adapters emit `text-delta` events as the model produces text, and let `nexar run` print them
incrementally instead of waiting for the final result.

## Problem

`ExecutionContext.onEvent` and the `ExecutionEvent` union (`status`, `text-delta`, `tool-call`) already
exist in [`@nexar/contracts`](../../packages/contracts/src/execution.ts), but no adapter emits `text-delta`
and the CLI only prints the final text. Long tasks look frozen.

## Objective

Streaming works end to end for pi, DeepSeek Harness and Claude Code, with the final `ExecutionResult`
unchanged, and the CLI renders deltas as they arrive.

## Scope

- pi adapter: iterate `models.streamSimple(...)` and map text deltas to `text-delta` (research sketch:
  `text_delta`, `toolcall_end`, `done`, `error` events; verify against the pinned version).
- DSH adapter: map `session.event` payloads that carry assistant text to `text-delta`; treat payloads as
  opaque JSON and ignore unknown ones.
- Claude Code adapter: use `--output-format stream-json` (verify flags, e.g. whether `--verbose` is
  required, against the installed `claude`) and map assistant text blocks.
- CLI `run`: print deltas to stdout as they arrive; keep a non-streaming fallback and a flag/TTY rule.
- Echo adapter: emit deltas too, so the offline path exercises streaming.

## Out of scope

- Tool-call rendering beyond the existing `tool-call` event.
- Streaming to remote clients (control plane, [NXR-040](040-control-plane-adr-and-daemon-skeleton.md)).
- Changing `ExecutionResult` or telemetry schemas.

## Technical notes

- Packages: `@nexar/core` (engine passes `onEvent` through), `@nexar/cli`, `@nexar/integration-{echo,pi,deepseek-harness,claude-code}`.
- Final `text` must equal the concatenation of deltas (or the adapter's authoritative final text); usage
  stays `Measured<number>`.
- Abort must stop the stream promptly (`EXECUTION_CANCELLED`); upstream stream errors map to `NexarError`.
- Never put prompts in info-level logs; deltas go to the callback/stdout, not the logger.
- DSH has no mid-turn cancel in SDK mode: abort terminates the process ([ADR-002](../adr/002-deepseek-harness-execution-kernel.md)).

## Acceptance criteria

- [ ] Each of the four adapters emits `text-delta` events in its contract tests.
- [ ] `nexar run` streams output when stdout is a TTY and prints the same final text otherwise.
- [ ] Aborting mid-stream stops output and yields `EXECUTION_CANCELLED`.
- [ ] Final `ExecutionResult.text` and usage are identical with and without a listener.
- [ ] Malformed or unknown upstream stream frames are ignored or mapped to `PROVIDER_ERROR`, never a crash.

## Testing expectations

Offline contract tests per adapter: `fauxProvider()` streaming for pi, the fake `dsh` runtime emitting
`session.event`, and a fake `claude` binary printing `stream-json` lines. Live streaming checks are opt-in
via `NEXAR_LIVE_TESTS=1`.

## Security considerations

Stream frames are untrusted upstream output: parse defensively and never evaluate them. Do not write
deltas to logs or telemetry (they contain prompts and client data).
