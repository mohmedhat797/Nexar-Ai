# NXR-014: Human approval framework for outward-facing and destructive actions

**Milestone:** v0.2 — Personal Work · **Labels:** security, core · **Depends on:** none

## Summary

Introduce a Nexar-owned approval mechanism: actions that send, publish, push, delete or otherwise affect the
outside world are paused until a human approves, and every decision is recorded.

## Problem

The [security model](../architecture/security.md) states that destructive or outward-facing actions "will
require explicit human approval once Nexar performs them (v0.2+)". v0.1 performs none, so no mechanism
exists. Agents and documents are prompt-injectable, and the upstreams differ: DSH needs an ACP client to
answer permissions or `danger-full-access`, and OpenWorker's unattended runs stall on approvals
(see the [DSH](../research/upstream/deepseek-harness.md) and [OpenWorker](../research/upstream/openworker.md) notes).

## Objective

A single approval model attached to tasks, usable by the CLI now and by the mobile client later
([NXR-041](041-nexar-mobile-pwa-shell.md)), that fails closed.

## Scope

- Domain types in `@nexar/contracts`: approval request (id, task id, action kind, summary, risk class, expiry) and decision.
- An `ApprovalGate` port in `@nexar/core`; the engine calls it before an approval-requiring action.
- Fail-closed default: no answerer, timeout or error means denied.
- CLI answerer: interactive prompt plus `nexar approvals list|approve|deny`.
- Telemetry/audit event for each request and decision.

## Out of scope

- Mobile or push notification UI ([NXR-041](041-nexar-mobile-pwa-shell.md)).
- Translating to/from each upstream's own permission protocol (ACP work, [NXR-020](020-deepseek-harness-acp-adapter.md)).
- Policy learning or "always allow" rules beyond a simple per-project allowlist.

## Technical notes

- Approvals attach to tasks, not to a UI ([architecture overview](../architecture/overview.md), section 9).
- Likely new `NexarError` behavior: denial maps to `POLICY_REJECTED` (existing code in `@nexar/contracts`).
- Keep the gate synchronous from the engine's view via a promise resolved by the answerer; honor `AbortSignal`.
- Persist pending approvals under `.nexar/` (mode 0600) so a restart does not silently approve or lose them.
- Approval summaries must be redacted of secrets; never include full file contents.

## Acceptance criteria

- [ ] An action flagged approval-required does not execute until approved.
- [ ] Denial, expiry, abort and missing answerer all result in no action and a recorded outcome.
- [ ] Approval requests and decisions appear in telemetry/audit with task id and decider.
- [ ] CLI can list, approve and deny pending requests.
- [ ] The type definitions are documented in an ADR amendment or a new ADR.

## Testing expectations

Offline tests with a scripted fake answerer: approve, deny, timeout, abort, persistence across restart.
No network or live tests required.

## Security considerations

Fail closed everywhere. Approval ids must be unguessable and single-use. Decisions must be bound to the exact
action summarized (no approve-then-substitute). Do not show secrets in approval text or logs.
