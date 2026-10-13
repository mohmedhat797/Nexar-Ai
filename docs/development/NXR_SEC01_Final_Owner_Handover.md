# NXR-SEC-01 — Owner handover

**Date:** 2026-10-13. **Architect/reviewer:** Claude Opus 5.5. **Implementer:** none in this
package. Phase D was held because the feasibility gate was not met.
**Branch:** `fcr02/opus-integration` (local; not pushed). **Initial SHA:**
`0187bda5cc3810713a57b73850dfc8e8997de1f6`. **Final SHA:** the documentation commit recorded in the
session report; production code is unchanged from `e2a82ae`.
**PR [#41](https://github.com/mohmedhat797/Nexar-Ai/pull/41):** Draft, head `7337aa0`, unchanged.
**ADR-030:** Proposed; amendment drafted, not applied.

## Verdicts

| Area                   | Verdict                                                                                                                   |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| Isolation architecture | `WINDOWS_NATIVE_ISOLATION_ARCHITECTURE_REQUIRES_REVISION` (preferred design is sound; cannot be approved before the gate) |
| Feasibility            | `WINDOWS_NATIVE_ISOLATION_UNVERIFIED`                                                                                     |
| Cowork security        | `COWORK_OS_ISOLATION_INCOMPLETE`                                                                                          |
| Opus review            | `OPUS_SECURITY_REVIEW_BLOCKED` (no isolation implementation exists to review)                                             |
| Windows                | `WINDOWS_FINAL_ACCEPTANCE_FAIL` (all executed gates pass; the mandatory isolation requirement is unmet)                   |
| WSL2 Coding            | `WSL2_CODING_ACCEPTANCE_PASS`                                                                                             |
| Cross-platform         | `CROSS_PLATFORM_ACCEPTANCE_NOT_CLAIMED` (OD-SEC-01)                                                                       |
| Overall                | **`NXR_SEC01_BLOCKED_BY_OWNER_DEPENDENCY`**                                                                               |
| Next milestone         | `NXR070_PREREQUISITES_NOT_YET_SATISFIED`                                                                                  |

## What was done

- **Preflight.** The branch fast-forwards from PR #41's head. HEAD is clean and identical outside
  `docs/` to the Full-CI-tested `e2a82ae`.
- **Phase A.** The Cowork authority map was traced from source
  ([design §2](../architecture/unified-dsh-runtime/NXR_SEC01_Architecture_Design.md)). The OS hands
  DSH the owner's full identity, child processes and open network. Every restriction is
  application-level.
- **Phase B.** Options were evaluated against Microsoft documentation:
  - the classic AppContainer (plus the LPAC variant) is **preferred**;
  - restricted token / Low IL is rejected (does not restrict reads);
  - a dedicated user account is rejected (needs admin; ACL-dependent);
  - Win32 App Isolation is rejected (preview, MSIX);
  - Windows Sandbox / VM is rejected (admin, latency);
  - WSL2 remains an owner-approval fallback.
- **Threat model and test plan:**
  [NXR_SEC01_Isolation_Threat_Model.md](../architecture/unified-dsh-runtime/NXR_SEC01_Isolation_Threat_Model.md)
  and [NXR_SEC01_Security_Test_Report.md](../architecture/unified-dsh-runtime/NXR_SEC01_Security_Test_Report.md).
- **OD-SEC-01** is recorded in the acceptance matrix: native Ubuntu gates are deferred and not
  claimed, with a reinstatement trigger. **A17** (Cowork OS isolation) is added as mandatory.
- **WSL2 Coding regression** passed on the exact current source
  ([NXR_SEC01_Windows_Acceptance.md](NXR_SEC01_Windows_Acceptance.md)).
- **ADR-030** gained a clearly marked proposed amendment that is not in effect. The status is
  unchanged.

## What was not done, and why

- **Feasibility gate (phase C).** Not run.
  - Earlier AppContainer experiments in this environment were stopped by automated safety checks,
    and per the directive they are not retried by other routes.
  - The directive also requires an authorized disposable Windows test environment, which this
    workstation is not.
- **Production integration (phases D–G).** Not started, because the gate came first. No isolation
  code, launcher or installer change exists. The current installer and CI evidence describe the
  **non-isolated** Cowork.

## Answers

1. **Is Cowork genuinely OS-isolated?** No. It runs with the owner's identity; the controls are
   application-level only.
2. **Can Nexar run Cowork on Windows without WSL2?** Yes, today, but host-local and not isolated.
   The isolated design also needs no WSL2, but it is unverified.
3. **Can isolated DSH perform real drafting tasks?** Unknown. Real DSH has never run inside the
   boundary.
4. **Are host files protected from direct DSH reads?** No. A real pinned DSH reads a synthetic
   outside file (FCR-01-09).
5. **Does NRC remain the routing authority?** Yes. This is unchanged and verified (gateway
   pinning, accounting, route guard).
6. **Is Project Memory protected?** At the application level, yes: owner-only writes, project-scoped
   context, lease-gated. At the OS level, no: Cowork could read the files directly.
7. **Does the packaged Windows application work?** Yes. Full CI with packaged E2E passed 22/22 on
   `e2a82ae`; installer SHA-256 `27cd71fe…`.
8. **Is ADR-030 ready for owner acceptance?** No. Cowork isolation (OD-SEC-02) is unmet, and the
   amendment depends on the gate.
9. **Is PR #41 ready for owner-controlled merge?** No for release purposes, because the isolation
   requirement is unmet. The reviewed local FCR-02 commits can still be fast-forwarded into the
   Draft PR when you authorize it.
10. **Are the revised NXR-070 prerequisites satisfied?** No.

## Owner decisions and dependencies

1. **Authorize the feasibility gate:** a disposable Windows 11 VM plus an engineer to execute
   design §6, outside this assistant session if needed. This is the critical path.
2. After a passing gate, authorize phase D (Sonnet implements, Opus reviews), then approve or
   reject the ADR-030 amendment.
3. If the gate fails, choose among option C (WSL2 for Cowork, a product change), an upstream DSH
   change, or keeping Cowork restricted or unavailable. No trusted-content policy has been adopted
   on your behalf.
4. Set the supported Windows baseline for the isolation feature.
5. Authorize the fast-forward push of `fcr02/opus-integration` into PR #41 (optional; docs and
   diagnostics only beyond the reviewed FCR-02 changes).

## Residual risks

- **Blocking security:** Cowork host-local read exposure (FCR-01-09), and the post-grant TOCTOU
  outside scratch (FCR-01-10).
- **Owner-controlled:** the gate environment, the WSL2 fallback, the ADR amendment, the Windows
  baseline, and tracking of the DSH dependency advisories (MCP SDK OAuth, fflate; not reachable
  in managed Cowork).
- **Non-blocking debt:** R1 (stale lease-claim message), R2 (dirty-tree PASS label), the unsigned
  installer, and the deferred native Ubuntu gates.
- **Instrumented reliability observations:** the gateway child exit and the Providers second turn.
  Both are unresolved, and neither recurred.
