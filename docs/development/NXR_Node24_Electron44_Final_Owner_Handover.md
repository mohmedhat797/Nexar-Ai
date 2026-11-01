# Node 24 / Electron 44 owner handover

Status: **Node 24 fallback under final qualification; Electron security upgrade BLOCKED**. Full acceptance/publication outcomes remain pending in this source-bound candidate record.

The [focused investigation](NXR_DSH_Electron_Runtime_Compatibility_Investigation.md) reproduced the exact loader rejection in Electron 44.10.1 main and RunAsNode, while standalone Node 24.22.2 and retained Electron 44.5.1 each completed a real synthetic rc.5 ACP turn. Version reporting alone would have missed the incompatibility. Following the owner's explicit decision rule, this candidate retains accepted Electron temporarily and qualifies the Node foundation separately.

Secure decoupling is feasible through the existing adapter API, but packaged Desktop ships no standalone Node artifact or verifier. The [implementation-ready proposal](NXR_DSH_Electron_Runtime_Decoupling_Implementation_Proposal.md) covers distribution, trust anchors, containment, provenance, child ownership, errors, tests and rollback. It requires a separate approved assignment. No unverified/ambient executable or loader bypass is introduced here.

- Node development/CI exact pin: **24.22.2**; Windows and Linux side-by-side installations verified.
- Electron exact pin: **44.5.1 retained**; embedded Node **24.21.0** must be independently proved in source and packaged processes. The 44.10.1 security upgrade is **BLOCKED**, not completed.
- pnpm remains **10.33.0**; Node types align to **24.19.2**.
- DSH remains **0.2.1-rc.5** with unchanged manifest, overrides and runtime lock.
- New CI resolver rejects wrong patches/majors and invalid overrides; hosted/self-hosted workflows verify actual executables.
- Existing Windows/Linux Node 22 installations, main, PR 49, D′ worktree, owner profiles and installed Plane remain preserved.
- No accepted orchestration, resource-selection, permission, session, memory or isolation authority changed.

[Migration assessment](NXR_Node24_Migration_Assessment.md), [toolchain implementation](NXR_Node24_Toolchain_Implementation.md), [Electron security](NXR_Electron44_Security_Upgrade.md), [WSL compatibility](NXR_Node24_WSL_Compatibility.md), [future DSH prerequisite](NXR_DSH_022_Alpha2_Node24_Readiness.md), and [acceptance evidence](NXR_Node24_Electron44_Final_Acceptance.md) distinguish verified facts from pending gates.

Required before final handover: one complete Windows Full PASS, WSL native/isolation acceptance, actual source/packaged identities, installer/hash provenance, rollback evidence, security review, draft PR and exact-head hosted checks. No release, merge, real login or paid inference is performed automatically. Future alpha.2 readiness concerns Node prerequisites only.

Retained Electron does **not** inherit the October embedded-Node/Chromium security corrections from building with Node 24.22.2. Its exposure remains unresolved; existing renderer/IPC/sandbox protections are mitigations, not proof that vulnerabilities are unreachable. No intentionally failing 44.10.1 build is the final deliverable. A newer DSH alpha is not presumed to solve the loader restriction and is not deployed.

The next product milestone remains H′ after accepted B′/D′ and security disposition. This modernization does not implement H′, D′, provenance, routing or context features. Installed-Plane G-13 and historical WSL G-14 remain separate gates.
