# NXR-021: Codex native agent adapter

**Milestone:** v0.3 — Engineering Machine · **Labels:** integration, codex · **Depends on:** none

## Summary

Add `@nexar/integration-codex`, an adapter that runs OpenAI's Codex CLI in non-interactive mode
(`codex exec --json`) as an `agent` resource.

## Problem

[ADR-011](../adr/011-native-agent-adapters.md) makes native agents first-class resources and names Codex
for v0.3. Only Claude Code exists today. Codex is subscription-backed through its own login, so Nexar
must use the vendor CLI rather than handle tokens.

## Objective

`nexar run` can route a coding task to Codex, run it in a chosen working directory with a restricted
sandbox, and return a Nexar `ExecutionResult` with honest usage.

## Scope

- New package `integrations/codex` following the structure of `integrations/claude-code`.
- `supports`, `probe` (binary present, version, login status) and `execute` (`codex exec --json`).
- Parse the JSON event output into result text, events and usage; unknown fields ignored.
- Timeout, `AbortSignal` handling, minimal env, per-task cwd.
- Example resource in `config/` (`agent: 'codex'`, `interface: 'cli'`, subscription auth: runtime-managed).
- Contract tests against a fake `codex` binary.

## Out of scope

- Live tests requiring a Codex login (document them as opt-in manual steps).
- Delegate Skills relay use ([NXR-023](023-delegate-skills-adapter.md)).
- Any handling of Codex credentials.

## Technical notes

- Verify every flag and the JSON event schema against upstream before coding (`codex exec --json`, sandbox
  and approval options, model selection); the research notes in this repo do not document Codex's CLI.
- The Delegate Skills [research note](../research/upstream/delegate-skills.md) says `codex-delegate` exposes
  a `threadId` and documents no cost/tokens; if the CLI stream lacks usage, report `unavailable(reason)`, never `0`.
- Default to the most restrictive sandbox/read-only mode the CLI offers; widening is an explicit resource option.
- `probe` must not make paid calls; check `--version` and login state via a supported command (verify which).
- Follow [ADR-008](../adr/008-upstream-isolation.md): the `codex` name, flags and format stay inside the package.

## Acceptance criteria

- [ ] Adapter passes contract tests against a fake `codex` (success, error, timeout, abort, malformed output).
- [ ] `nexar doctor` reports Codex availability and version via `probe`.
- [ ] Usage is `Measured`; missing data is `unavailable`.
- [ ] Default execution is sandboxed/read-only; write access requires explicit resource config.
- [ ] Only `integrations/codex` references `codex` flags or output formats.

## Testing expectations

Offline contract tests with a fake binary run in CI. A live test is opt-in (`NEXAR_LIVE_TESTS=1`), requires
an authenticated Codex install, and never runs in CI.

## Security considerations

Never read or copy Codex's credentials; use only the supported CLI. Launch with a minimal explicit env
and an allowlisted working directory. Treat output as untrusted. Do not log prompts at info+.
