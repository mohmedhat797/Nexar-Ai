# NXR-SEC-01 — Security test report

**Date:** 2026-10-13. **Source:** `0187bda5cc3810713a57b73850dfc8e8997de1f6` (production code
identical to `e2a82aeba3236b9e099100535c4ba1f9f87b3dda`).
**Verdict:** `COWORK_OS_ISOLATION_INCOMPLETE`. No OS-level Cowork isolation test was executed,
because no isolation implementation exists and the feasibility gate is not authorized in this
environment ([design §6](NXR_SEC01_Architecture_Design.md)).

## How to read this report

- **PASS (app):** proven by Nexar application controls, on current code, with existing automated
  tests.
- **PASS (OS):** proven by a Windows denial with Nexar code bypassed. **None exist yet for DSH.**
- **NOT EXECUTED:** a required OS-level test that cannot run until the launcher exists and the
  gate passes.
- **Historical:** the FCR-02 spike, which used a Node probe rather than DSH; machine state was
  cleaned up, so the evidence is the record in
  [FCR02_Architecture_Decision.md](FCR02_Architecture_Decision.md).

## Required matrix

| Test                                   | Expected                 | Current Cowork (host-local)                                                                                                      | OS-level (target)                                              |
| -------------------------------------- | ------------------------ | -------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| Read approved scratch file             | PASS                     | PASS (app) — real DSH, `local.real.test.ts`                                                                                      | NOT EXECUTED (historical probe: allowed)                       |
| Read unauthorized host file            | OS-LEVEL DENIED          | **FAILS the requirement**: real pinned DSH reads a synthetic outside file (`local.real.test.ts`, by design as proof of exposure) | NOT EXECUTED (historical probe: `EPERM`)                       |
| Write approved scratch file            | Governed by Nexar policy | PASS (app) — per-call broker, real DSH                                                                                           | NOT EXECUTED                                                   |
| Write unauthorized host file           | OS-LEVEL DENIED          | Denied by app policy only (broker, physical checks)                                                                              | NOT EXECUTED (historical probe: `EPERM`)                       |
| Parent traversal                       | DENIED                   | PASS (app) — `cowork-policy.test.ts`, `dsh-cowork-path.test.ts`                                                                  | NOT EXECUTED                                                   |
| External symlink/junction              | DENIED                   | PASS (app) — junction, link and hard-link fixtures                                                                               | NOT EXECUTED (historical probe: `EPERM`)                       |
| Direct filesystem API outside boundary | OS-LEVEL DENIED          | **Not denied** (same OS identity)                                                                                                | NOT EXECUTED (historical probe: `EPERM`)                       |
| Unauthorized network destination       | DENIED                   | Profile disables web/shell; **OS network open**                                                                                  | NOT EXECUTED (historical probe: loopback and internet blocked) |
| Approved gateway communication         | PASS                     | PASS (app) — gateway tests, real DSH via fake model                                                                              | NOT EXECUTED (historical probe: HTTP over a brokered pipe)     |
| ACP initialization                     | PASS                     | PASS — real DSH                                                                                                                  | NOT EXECUTED                                                   |
| DSH tool execution                     | PASS                     | PASS — real DSH write through the broker                                                                                         | NOT EXECUTED                                                   |
| Owner approval                         | PASS                     | PASS (app) — `dsh-cowork.test.ts` ask-before-write                                                                               | NOT EXECUTED                                                   |
| Artifact creation / import             | PASS                     | PASS — `cowork.e2e.ts` (source and packaged E2E)                                                                                 | NOT EXECUTED                                                   |
| Session persistence                    | PASS                     | PASS — sessions suites, lease races (mutation-checked in FCR-02)                                                                 | n/a (host side)                                                |
| Project Memory isolation               | PASS                     | PASS (app) — project-scoped context, real DSH context suite                                                                      | NOT EXECUTED (OS: other projects' files)                       |
| Context compaction                     | PASS                     | PASS — `dsh-cowork.context.real.test.ts`                                                                                         | NOT EXECUTED                                                   |
| Process cancellation                   | PASS                     | PASS — cancellation suites                                                                                                       | NOT EXECUTED                                                   |
| Failed launcher initialization         | FAIL CLOSED              | n/a (no launcher)                                                                                                                | NOT EXECUTED                                                   |
| Runtime crash cleanup                  | PASS                     | PASS (app) — homes and scratch removed, grants revoked                                                                           | NOT EXECUTED                                                   |
| Credential inheritance checks          | PASS                     | PASS (app) — environment allowlist; no provider key or `NODE_OPTIONS`; token not in argv                                         | NOT EXECUTED (OS: credential files unreadable)                 |
| Concurrent Cowork turns                | PASS                     | PASS (app) — separate folders; **same OS identity**                                                                              | NOT EXECUTED (per-turn SID)                                    |

The "Current Cowork" results come from the FCR-02-reviewed suites, which pass on the
Full-CI-tested implementation `e2a82ae`:

- Windows unit and integration: 4,308 passed, 162 skipped, 4 pending, 0 failed;
- source and packaged E2E: 22/22 each.

See [FCR02_Reliability_Diagnostics.md](../../development/FCR02_Reliability_Diagnostics.md).

## Evidence required for `COWORK_OS_ISOLATION_VERIFIED`

1. The feasibility gate passes in an authorized disposable Windows 11 VM (design §6, items 1–9).
2. Phase D implementation, reviewed by Opus against the diff.
3. The full matrix above passes in its **OS-level** column, on real DSH. At least these must be
   kernel denials with the broker bypassed, recorded as the error class only:
   - direct API read outside the boundary;
   - direct API write outside the boundary;
   - junction escape;
   - host loopback;
   - internet;
   - process creation.
4. Fail-closed tests prove that an isolation failure never runs DSH host-local.
5. Windows Full CI, source and packaged E2E, and a fresh installer, all on the implementing commit.

Negative tests use only synthetic fixtures created by the test. No real personal documents or
credentials are opened.
