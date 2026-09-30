# ADR-016: Human approval framework (fail-closed, action-bound)

**Status:** Accepted (2026-09-30) · Issue: #10 (NXR-014)

## Context

Later milestones will send email, change calendars, publish documents, or push code. The approval
model must exist before any such capability, must belong to Nexar rather than to a UI, and must be
impossible to satisfy accidentally.

## Decision

- `@nexar/approvals` owns approvals. The CLI, OpenWorker, and the future mobile client are only
  approval _interfaces_; they call `decide()`.
- The default mode is `deny-all`, which applies whenever no approval handler exists. Each of the
  following denies: denial, expiry, abort, store failure, unknown or corrupt state, restart (pending
  requests from a previous process are cancelled, never resumed), and a fingerprint mismatch.
- **Binding:** each approval is bound to a SHA-256 fingerprint of the canonical JSON of the exact
  action (type, target, parameters). `grant.consume(action)` recomputes it immediately before
  execution, so "approve A, execute B" fails.
- **Single use:** a `.consumed` marker is created with `O_EXCL`, and a per-request lock serializes
  transitions across processes.
- **Stored metadata only:** records hold the summary, risk, type, fingerprint, and safe metadata.
  Action parameters, such as email bodies, are never stored.
- **Order of checks:** `performOutwardAction` first requires a registered executor. Only then does
  it request approval, consume it, and execute.
- **v0.2 registers no executors**, so even an approved outward action cannot run. Nexar produces
  drafts only.

## Rationale

Binding and single use prevent approval reuse and substitution. Denying by default makes every
failure mode safe. Keeping the model independent of any UI lets v0.5 mobile approvals reuse it
unchanged.

## Alternatives considered

- Per-UI approval flows: rejected; they would be inconsistent.
- In-memory approvals: rejected; they do not survive an explicit restart and give the CLI nothing
  to act on.

## Consequences

Adding an outward capability means implementing an executor plus an ADR. Approval is then enforced
automatically.

## Risks

- `decide()` trusts its caller to have established who the approver is. The v0.5 control plane must
  authenticate approvers.
- A crash between the consume marker and the record write leaves that approval unusable. This fails
  closed.

## Follow-up work

Mobile and OpenWorker approval interfaces (v0.5), notifications, and approval classes per workflow.
