# NXR-020: DeepSeek Harness ACP adapter (cancel and permission round-trips)

**Milestone:** v0.3 — Engineering Machine · **Labels:** integration, deepseek-harness · **Depends on:** NXR-001, NXR-014

## Summary

Add an adapter that drives `dsh --profile acp` (Agent Client Protocol v1) so Nexar can cancel a running
task and answer DSH's permission requests.

## Problem

The SDK-profile adapter has no mid-turn cancel (abort kills the process) and no approval channel. In SDK or
headless mode, sensitive actions fail closed, and autonomy needs `DSH_PERMISSION_MODE=danger-full-access`
(approval `never`, no sandbox), which Nexar must not use ([ADR-002](../adr/002-deepseek-harness-execution-kernel.md),
[research note](../research/upstream/deepseek-harness.md)). ACP is the only DSH route with cancel and permission round-trips.

## Objective

Engineering tasks can run through DSH with real cancellation and with every permission request surfaced
to Nexar's approval framework, without ever granting full access by default.

## Scope

- ACP client in `integrations/deepseek-harness` (or a separate ACP package if reuse for other ACP agents is planned; decide in the PR).
- Session lifecycle: initialize, new session, prompt, stream updates, cancel, shutdown.
- Permission requests → `ApprovalGate` ([NXR-014](014-human-approval-framework.md)); default deny.
- Map ACP updates to `ExecutionEvent`s and results to `ExecutionResult`.
- Register as an `agent` resource with `interface: 'acp'`.

## Out of scope

- Replacing the SDK-profile adapter (keep it for simple/one-shot runs).
- MCP servers inside DSH sessions and non-DeepSeek routes.
- Other ACP agents (design so it is reusable, but implement only DSH).

## Technical notes

- Launch: `dsh --profile acp` with the same isolation as ADR-002: isolated `DSH_HOME`, minimal env, generated `--patch`
  overlay, per-task cwd, exact-pinned version. Verify the ACP method and notification names against the pinned
  `@deepseek-ai/dsh-acp` version and the ACP spec; do not guess them.
- Fail closed on unexpected server info or protocol shape, as in the SDK adapter.
- `AbortSignal` → ACP cancel, then process termination after a grace period; map to `EXECUTION_CANCELLED`.
- Unanswered permission requests time out as denied; never auto-approve.
- Uses `ExecutionContext` from [`@nexar/contracts`](../../packages/contracts/src/execution.ts).
- Research open question still relevant: real headless permission behavior (unverified).

## Acceptance criteria

- [ ] A fake ACP server drives contract tests for prompt, stream, cancel and permission flows.
- [ ] Cancel stops work and yields `EXECUTION_CANCELLED` within a bounded time.
- [ ] Every permission request is routed to the approval gate; no answer means denial.
- [ ] `DSH_PERMISSION_MODE=danger-full-access` is never set by the adapter.
- [ ] Opt-in live test passes against a pinned `dsh` with `DEEPSEEK_API_KEY`.

## Testing expectations

Offline contract tests against a fake ACP runtime run in CI. The live test uses
`describe.skipIf(!process.env.NEXAR_LIVE_TESTS)`, may cost money and never runs in CI.

## Security considerations

Permission prompts are the control surface against prompt injection: fail closed, bind answers to the
exact request, never expose a bypass. Scrub env, isolate `DSH_HOME`, keep session-log upload disabled, and
do not log prompts at info+. DSH declares "no security audit".
