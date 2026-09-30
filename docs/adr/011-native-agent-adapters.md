# ADR-011: Native agent adapters and the v0.1 live execution proof

**Status:** Accepted (2026-09-30)

## Context

Nexar must support native agent resources (Claude Code, Codex, Antigravity) alongside model
resources, without forcing them through pi-ai or DSH. Subscription-backed access is best used
through each vendor's own supported runtime. For v0.1, a live end-to-end proof is desired, but the
only authenticated runtime available in the development environment is the `claude` CLI — no
DeepSeek, Anthropic, or OpenAI API keys are present, and extracting subscription credentials is
forbidden.

## Decision

- Native agents are `agent`-kind resources with dedicated adapters under `integrations/<agent>/`.
- v0.1 implements `@nexar/integration-claude-code`: spawns the installed `claude` CLI in print mode
  (`claude -p --output-format json`) with the prompt on stdin, a configurable model, a read-only
  default tool surface (`plan` permission mode), and a timeout; maps the JSON result
  (`result`, `total_cost_usd`, `usage`, `num_turns`, `is_error`) to `ExecutionResult`. It never reads
  Claude credentials; `probe` only checks the binary and `claude auth status`.
- The **v0.1 live proof** is: `nexar run` → Nexar task → NRC → registry → Claude Code adapter →
  Claude model → result → telemetry. It is opt-in and documented; CI proves the same internal path
  with the offline `echo` adapter and a fake `claude` binary.
- The DSH and pi paths are implemented with contract tests; their live smoke tests are documented
  manual steps pending credentials (ADR-002, ADR-003).

## Rationale

Uses an existing authenticated runtime through its supported interface (no credential handling),
proves the native-agent route that ADR-007 argues for, and yields an honest live result instead of
a faked one.

## Alternatives considered

- Live proof through DSH with the Claude subscription via pi-ai OAuth — rejected: requires handling
  subscription tokens outside the vendor runtime.
- No live proof — acceptable fallback, but weaker evidence.

## Consequences

The live proof exercises the native-agent path rather than the DSH path suggested in the original
plan; the DSH path is proven only against a protocol-faithful fake until a DeepSeek key is provided.

## Risks

`claude` CLI JSON output fields may change; mitigated by tolerant parsing and contract tests.

## Follow-up work

Codex (`codex exec --json`) and Antigravity adapters (v0.3); DSH live smoke once credentials exist.
