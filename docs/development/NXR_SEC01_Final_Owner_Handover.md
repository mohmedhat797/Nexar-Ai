# NXR-SEC-01 — Owner handover

**Date:** 2026-10-13. **Architect/reviewer:** Claude Opus 5.5. **Implementer:** none in this
package. Phase D was held because the feasibility gate was not met.
**Branch:** `fcr02/opus-integration` (local; not pushed). **Initial SHA:**
`0187bda5cc3810713a57b73850dfc8e8997de1f6`. **Final SHA:** the documentation commit recorded in the
session report; production code is unchanged from `e2a82ae`.
**PR [#41](https://github.com/mohmedhat797/Nexar-Ai/pull/41):** Draft, head `7337aa0`, unchanged.
**ADR-030:** Proposed; amendment drafted, not applied.

**Current status (2026-10-13, after OD-SEC-01 to OD-SEC-07):** `WINDOWS_NATIVE_ISOLATION_UNVERIFIED` ·
`COWORK_OS_ISOLATION_INCOMPLETE` · `NATIVE_UBUNTU_FULL_CI_DEFERRED` ·
`NXR_SEC01_BLOCKED_BY_EXTERNAL_FEASIBILITY_EVIDENCE` · `ADR030_PROPOSED` · `PR41_DRAFT_NOT_MERGED` ·
`NXR070_NOT_AUTHORIZED`. The security milestone is **not** complete.

## Verdicts

| Area                   | Verdict                                                                                                                                                                                                 |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Isolation architecture | `WINDOWS_NATIVE_ISOLATION_ARCHITECTURE_REQUIRES_REVISION`: the preferred design is sound but cannot be approved before the gate. OD-SEC-02 approved the AppContainer direction **for evaluation only**. |
| Feasibility            | `WINDOWS_NATIVE_ISOLATION_UNVERIFIED`                                                                                                                                                                   |
| Cowork security        | `COWORK_OS_ISOLATION_INCOMPLETE`                                                                                                                                                                        |
| Opus review            | `OPUS_SECURITY_REVIEW_BLOCKED` (no isolation implementation exists to review)                                                                                                                           |
| Windows                | `WINDOWS_FINAL_ACCEPTANCE_FAIL` (all executed gates pass; the mandatory isolation requirement is unmet)                                                                                                 |
| WSL2 Coding            | `WSL2_CODING_ACCEPTANCE_PASS`                                                                                                                                                                           |
| Cross-platform         | `CROSS_PLATFORM_ACCEPTANCE_NOT_CLAIMED` (OD-SEC-01)                                                                                                                                                     |
| Overall                | **`NXR_SEC01_BLOCKED_BY_EXTERNAL_FEASIBILITY_EVIDENCE`** (was `NXR_SEC01_BLOCKED_BY_OWNER_DEPENDENCY` until OD-SEC-03 authorized the gate; the gate evidence itself is still missing)                   |
| Next milestone         | `NXR070_PREREQUISITES_NOT_YET_SATISFIED`                                                                                                                                                                |

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
   requirement is unmet. Fast-forward integration of the local FCR-02 and NXR-SEC-01 commits is
   prepared (OD-SEC-07: ancestry, diff and Gitleaks verified) but **not pushed**. A push needs
   explicit authorization.
10. **Are the revised NXR-070 prerequisites satisfied?** No.

## Owner Decision Register

Recorded 2026-10-13. Decisions are quoted in substance; nothing here upgrades a security claim.

| Id        | Decision                                                                                                                                                                                                                                                                                                                                                                                                                                                    | Effect on status                                                                                                                                                                                                                                   |
| --------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| OD-SEC-01 | **Windows-first baseline.** The primary evaluation platform is Windows 11 Pro 25H2 x64 (build 26200), fully updated; 26H2 is an optional additional target. Native Ubuntu Full CI is **deferred by owner decision**. WSL2/bubblewrap Coding validation stays mandatory.                                                                                                                                                                                     | `NATIVE_UBUNTU_FULL_CI_DEFERRED` (not PASS). Cross-platform acceptance is not claimed. Existing Windows evidence is from build 26300, not yet repeated on 26200.                                                                                   |
| OD-SEC-02 | **Preferred isolation direction.** Windows AppContainer is approved for **feasibility evaluation**, with standard AppContainer and LPAC both evaluated. Cowork stays Windows-native, with no mandatory WSL2. This is not approval of an unverified production design.                                                                                                                                                                                       | The architecture direction is fixed for the gate. Neither mechanism has passed feasibility.                                                                                                                                                        |
| OD-SEC-03 | **Feasibility authorization.** A qualified engineer may run the documented gate in a dedicated, disposable Windows 11 Pro 25H2 VM, isolated from personal data and production credentials. No system changes on the owner's primary installation. Automated safety restrictions in Claude Code are not to be bypassed.                                                                                                                                      | The gate is authorized externally. This assistant does not run, reroute or delegate the blocked experiment; it reviews returned evidence.                                                                                                          |
| OD-SEC-04 | **Mandatory feasibility evidence**, items 1–10, using synthetic data and deterministic offline models:<br>1. intended AppContainer/LPAC identity;<br>2. ACP initialization;<br>3. scratch access;<br>4. OS-denied reads;<br>5. OS-denied writes;<br>6. network denial;<br>7. least-privilege gateway and bridge;<br>8. cancellation and cleanup;<br>9. no production credentials;<br>10. packaging support.<br>A Nexar policy rejection is not OS evidence. | Matches the existing exit criteria ([design §6](../architecture/unified-dsh-runtime/NXR_SEC01_Architecture_Design.md)) and test matrix ([report](../architecture/unified-dsh-runtime/NXR_SEC01_Security_Test_Report.md)). Both are kept unchanged. |
| OD-SEC-05 | **Production implementation gate:** feasibility passes, then independent Opus review of the evidence, then documented architecture and residual risks, then explicit owner approval. After that, Sonnet implements and Opus reviews.                                                                                                                                                                                                                        | Phase D is not started.                                                                                                                                                                                                                            |
| OD-SEC-06 | **Engineering baseline preserved:** FCR-01 and FCR-02 corrections are kept; DSH, NRC, Project Memory, Sessions and Coding are not redesigned. The two intermittent Windows failures stay open, instrumented observations. The DSH dependency advisories stay tracked debt, to be reassessed when dependencies or profiles change.                                                                                                                           | No reliability fix is claimed. The dependency tree is not claimed vulnerability-free.                                                                                                                                                              |
| OD-SEC-07 | **Git governance:** the local FCR-02 and NXR-SEC-01 changes may be **prepared** for fast-forward integration into Draft PR #41, after verifying ancestry, source identity, the complete diff and Gitleaks. No force-push, no merge to main, ADR-030 not Accepted, NXR-070 not started.                                                                                                                                                                      | Prepared and verified (fast-forward from `7337aa0`, Gitleaks clean). **Not pushed**: preparation is not push authorization.                                                                                                                        |

**Standing requirements:**

- Cowork OS read/write isolation is a **mandatory, unresolved** security requirement. A
  trusted-content release policy has **not** been accepted as a substitute.
- Explicit owner approval is still required before production isolation integration, ADR-030
  acceptance, and the PR #41 merge.

## Remaining dependencies

1. **External feasibility evidence:** the authorized engineer runs the gate in the disposable
   25H2 VM (OD-SEC-03/04) and returns the evidence. This is the critical path.
2. **Opus review of that evidence:** issues exactly one of `WINDOWS_NATIVE_ISOLATION_FEASIBLE`,
   `WINDOWS_NATIVE_ISOLATION_INFEASIBLE` or `WINDOWS_NATIVE_ISOLATION_UNVERIFIED`.
3. **If feasible:** owner approval of phase D (OD-SEC-05), then the ADR-030 amendment decision.
4. **If infeasible:** the owner chooses among WSL2 for Cowork (a product change), an upstream DSH
   change, or keeping Cowork restricted or unavailable. No trusted-content policy is adopted by
   default.
5. **Optional:** authorize the prepared fast-forward push into PR #41 (OD-SEC-07).

## Residual risks

- **Blocking security:** Cowork host-local read exposure (FCR-01-09), and the post-grant TOCTOU
  outside scratch (FCR-01-10).
- **Owner-controlled:**
  - the external feasibility evidence (the gate is authorized under OD-SEC-03, but not yet run);
  - the WSL2 fallback, if the gate fails;
  - the ADR amendment;
  - the PR #41 push and merge.
- **Tracked technical debt:** the DSH dependency advisories (MCP SDK OAuth, fflate). They are not
  reachable in the reviewed managed configuration and are reassessed on dependency or profile
  changes (OD-SEC-06).
- **Non-blocking debt:** R1 (stale lease-claim message), R2 (dirty-tree PASS label), the unsigned
  installer, and the deferred native Ubuntu gates.
- **Instrumented reliability observations:** the gateway child exit and the Providers second turn.
  Both are unresolved, and neither recurred.
