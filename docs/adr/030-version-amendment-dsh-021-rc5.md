# ADR-030 version amendment: owner-authorized DSH 0.2.1-rc.5 target

- Authorization: project owner, 31 October 2026, NEXAR DSH Upgrade Scope Amendment.
- Status: implemented on `feat/nxr-dsh-021-rc3-upgrade`. Integration still requires independent owner acceptance. This record does not grant integration approval.
- Replaces: [rc.3 version amendment](030-version-amendment-dsh-021-rc3.md) as the current target. rc.3 was never accepted or released.
- Previous approved runtime: `@deepseek-ai/dsh@0.2.0-rc.2`.
- Authorized target: exactly `@deepseek-ai/dsh@0.2.1-rc.5`.
- Architecture authority: [ADR-030](030-unified-dsh-first-agent-runtime.md) and [ADR-029](029-connection-scoped-resources-and-canonical-continuity.md), both unchanged.

## Decision

The owner moved the target from rc.3 to rc.5 because rc.4 fixes diagnostics leaking into stdout in ACP mode. Nexar confirmed this on the real runtimes: rc.3 ends a turn with `dsh sent a line that is not valid JSON`, and rc.5 does not.

This authorizes this exact version only. `0.2.2-alpha.2` is explicitly not adopted. There is no authorization for ranges, dist-tags, optional plugins, native session takeover, another primary harness or automatic upstream updates.

NRC, ConnectionManager, Permission Broker, FileSessionStore, ProjectMemoryStore, WSL2/Bubblewrap Cowork, sandboxed Coding and Review Diversity keep their accepted roles. The Nexar overlay that disables upstream saved credentials stays mandatory, because the native mechanism still exists in rc.5.

## Consequences

Rollback is a source revert to rc.2 plus a fresh managed installation, and was verified in disposable state. Native DSH session files stay private runtime state, and native resume stays off.

Branch name and stack ancestry are unchanged, so PR #46 keeps its history.

Evidence is in the [rc.5 compatibility and upgrade delta](../development/NXR070_DSH_RC5_Compatibility_and_Upgrade_Delta.md).
