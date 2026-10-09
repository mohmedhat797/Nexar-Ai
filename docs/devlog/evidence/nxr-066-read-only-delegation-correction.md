# NXR-066 read-only delegation compatibility correction

Date: 2026-10-09. Scope: confirmed v0.6 finalization blocker, based on
`3cbd6a66426407be6a588506a32fc47046f888ae`. No new feature, budget, timeout,
retry, provider authentication, NRC or Resource Fabric design is introduced.

## Observed acceptance failure

Matching Desktop and Plane at the base SHA passed deployment preflight. Exact-head
CI [37834534177 attempt 1](https://github.com/mohmedhat797/Nexar-Ai/actions/runs/37834534177/attempts/1)
passed. OpenWorker was 0.3.1, ChatGPT inventory had seven fresh models, native
workers were available, and no owner session was active.

One read-only review was submitted with trusted `maxDelegatedUnits: 1`:

- Session: `ses_c8f833a2e22846963053272b0be3ceb4`.
- Turn: `turn_67a040c3382820cf98ff6495596b3e10`.
- Parent task: `task_7a6169a1-1214-4def-9e80-89ad5acdf7fb`.
- Control resource: `inventory:048a60e3b9b7892e466eff536385c50a2168da981a4d3ac61cd0f4c44ba0f2b3`
  (`gpt-5.6-luna`), reason `control.auto`, gateway path, zero restarts.
- Grant: `c77c20b3-c4c9-46df-9aae-66ae51269c2a`, access read-only,
  grant maximum 1 and shared turn counter maximum 1.
- Parent succeeded in approximately 31 seconds; zero Bridge submissions,
  allocations or completed workers were observed. No worker resource or job ID
  exists for this attempt. Capability validation and NRC worker eligibility were
  not reached.
- Grant revoked, session inactive, no artifact imported, original permission
  restored. README size and UTF-8 canonical project API digest were unchanged.
  These API hashes are not relabeled as a fresh physical-byte fixture scan.

Verdict: **TARGETED_LIVE_ACCEPTANCE_FAIL**. A parent response does not establish
completed delegation. No automatic repeat occurred.

## Root cause and evidence

`apps/desktop/src/main/cowork.ts` selected upstream `discuss` for every read-only
turn, including an active Intelligence Bridge relay. Nexar's
`integrations/openworker/src/policy.ts` deliberately allows only the two exact
Bridge tool names in read-only mode; grants independently enforce read-only
scope. The upstream mode prevented those calls from reaching that policy.

Pinned OpenWorker v0.3.1
[`coworker/permissions.py`](https://github.com/andrewyng/openworker/blob/b9b35036668dfb1653f3aa35bafb9aeea6d47c3c/coworker/permissions.py)
defines `DISCUSS` as read-only and hard-denies consequential tools before MCP
trust or human approval. MCP retains external risk; Nexar's downstream approval
cannot override that earlier denial. This independently confirms a compatibility
defect consistent with the observed zero-submission run. A raw upstream denial
event was not captured; no fabricated provider error code is assigned.

The fake upstream previously ignored `set_mode` when executing delegation, so its
read-only delegation test passed against behavior the real runtime denies.

## Small correction and security preservation

An active delegation relay uses upstream `interactive` (approval) mode. A
read-only turn without active delegation retains `discuss`. Nexar's effective
read-only permission remains unchanged: grants are read-only, the same counter
limits all turn grants, and the policy permits only the two registered Bridge
tools while denying writes, shell, network and unknown tools. No upstream bypass
or auto-approval mode is selected. Read-only turns still import no draft.

The fixture now observes each session's mode and rejects delegation in `discuss`
before any relay invocation. A read-only delegation scenario also probes a file
write, shell execution and foreign MCP tool; all must be denied. Regression cases
cover the default 16 and restricted 1 unit ceilings, actual completed delegation,
approval-mode selection, read-only grants and no imported artifact. Existing
nondelegating read-only/discuss, ask-before-write, capability and admission security
assertions remain.

The two strengthened cases failed against the original production mode selection.
Targeted/full quality gates, source and packaged E2E, secret scanning, commit,
remote head and exact-head CI receipts are stored under
`.nexar/nxr066-remediation/`; publication does not imply deployed/live acceptance.

## Remaining stop gate

The original acceptance authorization permits one manually initiated attempt.
It was consumed. The correction needs its own full exact-head CI and matching
Desktop/Plane deployment. A further paid live attempt requires renewed owner
authorization. Keep PR #39 unmerged until the acceptance/merge conditions are
satisfied; do not use historical acceptance at `2f26b36` to claim this changed
behavior executed successfully. DSH Control remains unconfigured and outside
this Cowork correction. No release, tag, ADR-029 adoption or NXR-070 implementation.
