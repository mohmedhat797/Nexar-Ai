# ADR-030 version amendment: owner-authorized DSH 0.2.1-rc.3 candidate

- Superseded as the current target by the [rc.5 version amendment](030-version-amendment-dsh-021-rc5.md), 31 October 2026.
- Authorization: project owner, 26 October 2026 (Africa/Cairo), NXR-070-BC Runtime Installation Reliability & Controlled DSH Upgrade assignment.
- Status: exact target implemented; source/WSL and disposable rollback verified; Windows Full failed during package installation. Dependency advisory disposition and independent owner acceptance remain outstanding. This record does not grant integration approval.
- Previous approved runtime: `@deepseek-ai/dsh@0.2.0-rc.2`.
- Authorized candidate: exactly `@deepseek-ai/dsh@0.2.1-rc.3`.
- Architecture authority: [ADR-030](030-unified-dsh-first-agent-runtime.md), unchanged; [ADR-029](029-connection-scoped-resources-and-canonical-continuity.md), unchanged.

The owner explicitly superseded the prior version freeze for this target only. There is no authorization for later releases, ranges, dist-tags, optional plugin activation, native session takeover, another primary harness, T3 integration, or automatic upstream updates. The original ADR and historical acceptance reports retain their tested versions.

The candidate is developed on `feat/nxr-dsh-021-rc3-upgrade`, stacked on C′/PR #45 while B′/PR #44 and C′ remain unmerged. Its installation, acceptance evidence, rollback evidence and Draft PR remain distinct from rc.2 reliability work. A passing candidate must not be used to relabel an older failed run or close an unproven historical cause.

NRC remains the resource authority. ConnectionManager and trusted host resolution retain credential and immutable account authority. Permission Broker, FileSessionStore and ProjectMemoryStore retain their accepted roles. WSL2/Bubblewrap Cowork, sandboxed Coding, review diversity and delegation limits remain mandatory.

The candidate requires exact lockfile and published artifact integrity, real ACP/permission/cancellation compatibility, connection-bound credential execution, private instruction homes, preserved sessions and memory, full Windows acceptance, packaged runtime identity, WSL regressions, secret scanning, and disposable rollback verification. Native DSH session files are private runtime implementation state, not Nexar canonical sessions; native resume is not enabled.

Rollback must preserve the previous source/lock/runtime identity and Nexar connection IDs, credential references, generations, retired identities, sessions and memory. No owner state or global WSL runtime is migrated by this branch. Any incompatible persistent-state discovery blocks automatic rollback and integration until explicitly resolved.

Current evidence and final acceptance status belong in [compatibility assessment](../development/NXR070_DSH_021_RC3_Compatibility_Assessment.md), [implementation](../development/NXR070_DSH_021_RC3_Implementation.md), [acceptance](../development/NXR070_DSH_021_RC3_Acceptance.md), and [owner handover](../development/NXR070_DSH_Upgrade_Final_Owner_Handover.md). Owner acceptance and merge remain separate actions.
