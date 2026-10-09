# NXR-066 Cowork delegation-unit restriction

**2026-10-09 authorization update:** The owner authorized matching deployment,
one targeted read-only live attempt and conditional merge, and withdrew the
acceptance-specific USD 3, five-minute and no-internal-retry ceilings. The earlier
stop gates below are historical requirements of this remediation checkpoint.
Existing runtime timeouts, cancellation and recovery remain in force. The new
attempt at `3cbd6a6` failed to delegate because of an independent upstream mode
incompatibility; see the [correction evidence](nxr-066-read-only-delegation-correction.md).
No second paid attempt or merge has occurred.

Date: 2026-10-08. Scope: owner-authorized runtime-limit remediation on
`feat/nexar-resource-orchestration`, based on
`834a865264ad9b9b06501983c14207b91cedc6f0`. No deployment or live acceptance is
part of this correction.

## Root cause and correction

Cowork previously supplied `BRIDGE_MAX_UNITS = 16` to every Intelligence Bridge
grant. The supported turn submission had no trusted lower override. Prompt
instructions could request one review but could not prevent a second admission.
Grant-local counters alone would also allow a newly minted delegation-owned
grant to forget earlier admissions.

The existing owner turn-submission contract now accepts optional
`maxDelegatedUnits`, an integer from 1 through 16. Omission preserves 16. The
contracts validator rejects invalid values, inherited fields and accessor
properties before normalization or schema copying. Invalid restrictions produce
`VALIDATION_ERROR` (`delegation-limit.invalid`), never the permissive default.
Desktop IPC retains its strict schema and existing trusted sender guards. The
field is propagated as an ephemeral Operating run option, including confirmation,
and into Cowork. It is absent from model-facing delegation tool arguments, prompt
parsing and persisted session contracts. No settings UI or security policy changes
are introduced.

Cowork creates exactly one host-owned `DelegationUnitLimit` per running turn. Its
immutable identity binds session, turn, project and engine; its private counter is
not serialized to OpenWorker or the model. Every gateway or delegation-owned grant
receives the same object and the validated maximum. A forged object, mismatched
identity or wider grant is rejected. Control restarts retain the existing grant;
gateway setup fallback passes the same counter to the replacement grant.

The Intelligence Bridge validates the complete request, capabilities, grant,
lineage and existing policy before synchronously reserving a slot. Reservation
occurs before job creation, NRC allocation or worker execution. A second valid
submission after a one-unit reservation receives `POLICY_REJECTED` with reason
`unit-limit`; it causes no second allocation or worker call. Reservations are
monotonic: allocation failure, execution failure, cancellation, grant revocation
and reminting do not refund them. Invalid requests rejected before admission do
not consume a slot. The turn's `finally` closes its counter before existing grant,
provider, MCP and scratch cleanup.

The counter lives with the running Cowork turn, not a reusable global registry.
An app restart cannot resume that in-flight turn with an empty counter: existing
session recovery interrupts active execution, and confirmation without the
original in-memory options fails closed. Existing submission-key idempotency
prevents replay from starting a second execution or widening the running policy.
Lower-level trusted host APIs remain internal; this is not a new model-controlled
grant-minting interface.

## Regression coverage and validation plan

- Contracts: omission/default, every supported integer, malformed numeric and
  nonnumeric values, inherited properties, getters and null-prototype own fields.
- Operating and IPC: rejection before turn creation, one-unit propagation,
  idempotent replay, inherited input rejection and expired confirmation options.
- Bridge: all 16 default units, second-unit rejection, simultaneous submissions
  across grants, zero additional allocations/executions, failure and cancellation
  retention, remint retention, identity/widening rejection and closed-counter
  rejection. Existing capability-security and legitimate alias tests remain.
- Endpoint: control retry/restart and delegation-owned remint retain admission;
  model arguments cannot override the limit; legitimate capability aliases still
  normalize before allocation.
- Cowork: production IPC → Operating → delegation-owned grant propagation,
  restricted control restart, gateway → delegation-owned setup fallback sharing
  the same counter, unchanged default grant and cleanup.

Required publication gates are targeted regressions, full `pnpm check`, source
Desktop E2E, Windows packaging, packaged Desktop E2E, boundary/secret checks and
full exact-head CI. Builds run in an isolated validation checkout, preserving the
active owner-profile Desktop and Plane. Actual results, input hashes, commit,
remote head and CI evidence are recorded in the local remediation report rather
than treating this design note as evidence that all gates have passed.

## Remaining live-acceptance limits

| Limit | Enforcement and limitation |
| --- | --- |
| Delegated units | Hard runtime admission bound for the turn, including all its grants; default 16, explicitly restricted 1. This does not limit the number of control-model messages or internal calls made within one native agent unit. |
| Time | Cowork's existing default timeout is ten minutes per attempt. Gateway grant TTL covers two attempts (twenty minutes); a delegation-owned grant uses ten minutes. Grant expiry rejects new authenticated requests; it is not a five-minute deadline for already-running provider work. Bridge jobs have separate request/default timeouts and abort signals. Cooperative cancellation does not prove a vendor-side execution or billing cutoff. No time architecture changes are made. |
| Cost | `maxCostUsd` reaches delegated allocation as `budgetUsd`/remaining cost requirements. Known cost settles after execution; unavailable cost remains unaccounted. It does not establish an end-to-end USD 3 hard billing cap over control turns plus subscription/native work. Usage receipts distinguish measured, estimated and unavailable data. No cost-accounting implementation is added. |
| Automatic retries | Control Gateway defaults to one extra attempt for retryable provider failures. Cowork Auto fallback can restart the whole control loop once. A unit limit cannot prevent those control calls or establish that a native agent never retries internally. No retry defaults are changed. |
| Read-only | Existing permission/approval and sandbox boundaries remain. A read-only review prompt alone does not narrow the owner's drafts-only permission. Future acceptance must verify the effective permission and artifact boundary. |

The unit correction therefore does **not** make the earlier one-turn, one-unit,
five-minute, estimated USD 3, no-retry acceptance automatically executable. The
remaining bounds require a separately reviewed, authorized plan; stop before
inference when they cannot be enforced or safely respected. DSH Control remains
unconfigured and is not configured by this work. Historical acceptance at
`2f26b36` does not validate this new correction.

## Next stop gates

After local gates and full exact-head CI succeed, prepare matching Desktop/Plane
deployment instructions and stop. Replacing the active runtimes requires explicit
deployment authorization. Current-head live delegation requires separate bounded
live authorization and resolution of the remaining limits. PR #39 must remain
unmerged; no release, tag, ADR-029 change or NXR-070 implementation is included.
