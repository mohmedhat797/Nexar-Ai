# Nexar v0.6 official baseline

**Nexar v0.6 — Merged and Validated**, 2026-10-09.

## Exact provenance

| Record | Verified value |
| --- | --- |
| Source PR | [#39 — Resource orchestration](https://github.com/mohmedhat797/Nexar-Ai/pull/39) |
| Final implementation / live deployment | `9e71014979db7a7619bb6ac909b8418a0d198573` |
| Merge commit / tested main baseline | `2f856f935a1ca51fc0f2c179386baa31bd82c3bd` |
| Merge method and timestamp | Merge commit, 2026-10-09 15:55:10 UTC |
| Merged source tree | `12c0657ccda425333898a7f6f5194da293015296`, identical to implementation |
| Post-merge exact-head validation | [CI 37955286149 attempt 1](https://github.com/mohmedhat797/Nexar-Ai/actions/runs/37955286149/attempts/1); all three jobs passed |
| Pre-merge implementation CI | [37948529346 attempt 1](https://github.com/mohmedhat797/Nexar-Ai/actions/runs/37948529346/attempts/1), also [PR CI 37948509609](https://github.com/mohmedhat797/Nexar-Ai/actions/runs/37948509609) |

This document is a subsequent documentation-only publication. Its containing
commit is not the merge SHA or a new live deployment. Final documentation HEAD
and its independent CI receipt are recorded in the local finalization report,
avoiding a self-referential commit/CI update loop. No implementation code changes
belong to that publication.

## Supported runtime architecture

Nexar retains global ownership of provider connections, executable intelligence
resources, Resource Registry, Resource Strategy, deterministic NRC eligibility,
canonical Operating Sessions and authorization. Registry publishes inventory
facts; Strategy expresses plan intent; NRC selects eligible resources with
explainable reasons. Discovery and authentication are distinct from execution
health. Dynamic inventories preserve runtime/connection identity, generation,
freshness and stable model resource IDs; stale or rejected models cannot become
authoritative through a static fallback catalog.

The Engine Gateway separates Control Model Gateway model turns from Intelligence
Bridge delegated worker execution. Control is pinned throughout its engine loop;
safe whole-loop recovery creates a new decision rather than switching vendor in
the middle of tool-call lineage. Workers may differ per bounded delegated unit.
Model-turn, tool-use and native-agent execution remain distinct capabilities.

Windows Electron Desktop is the owner-facing application. Main owns services and
validated IPC; renderer has sandbox/context isolation and no Node integration.
Cowork uses supervised Windows OpenWorker 0.3.1. Code crosses the strict
Desktop/WSL2 plane protocol to hardened `nexar-plane`; native Claude Code and
Codex execute behind existing adapters. DSH ACP integration and its gateway
contracts exist, but the validation Plane's DSH Control loop remains unconfigured
and is not claimed operational by native-worker evidence.

Provider credentials stay within Nexar's encrypted owned sign-in/key references
or officially runtime-owned native sessions. No cookies/private credentials from
another application are harvested. Existing authenticated connections were reused
for validation; no new login, credential copying or migration occurred.

Canonical sessions persist turn, task, resource and artifact attribution. Runtime
process sessions and provider-private reasoning/tool state remain behind adapters;
v0.6 does not implement the proposed generalized Resource Fabric session graph.
Architecture references: [ADR-027](../../adr/027-resource-orchestration-architecture.md),
[ADR-028](../../adr/028-dynamic-provider-sessions-and-model-inventory.md),
[security model](../../architecture/security.md).

## Corrected security and delegation behavior

Every untrusted capability-array member validates before alias normalization;
malformed requirements reject explicitly rather than weakening NRC requirements.
Aliases resolve only registered own properties. Existing legitimate mappings
remain available.

Trusted per-turn unit limits preserve default 16 and explicitly restricted 1.
Admission uses a monotonic shared turn counter across concurrent requests,
failures, gateway restart/fallback and grant remint. Model output cannot raise it.
Read-only delegated Cowork uses upstream interactive mode while Nexar's permission
broker denies writes, shell, network and foreign MCP. For trusted one-unit turns,
private relay configuration advertises/validates a strict standalone schema
without `reviewOf`; extra references reject, while default multi-unit review
relationships retain same-grant earlier-unit integrity.

Existing action-bound approvals, containment, runtime cancellation and sandbox
controls remain authoritative. NRC selection does not grant filesystem, tool,
network or commit permission. Plane automount/Windows interop remain disabled;
bubblewrap self-tests pass. These are verified controls under the documented
threat model, not a guarantee against a compromised host or all native-runtime
escape/orphan-process cases.

## Validation and acceptance

- Local correction gates: full `pnpm check` 4089 passed / 158 expected skips;
  targeted 488 / 5 skips; source and packaged Desktop E2E 22 each; Gitleaks clean.
- Matching Plane generation: 770 regressions; doctor and six sandbox tests pass;
  source bundle independently verified; configuration and validation Git state
  preserved. Desktop compiled-main hash
  `81acc2c505c687720c3ead9bdc24f4430fde1ad923353592c5b0f3cf96a01922`.
- Post-merge CI independently verifies the actual merge SHA on Ubuntu/Windows,
  required regression/build/security steps, source Desktop E2E, Windows packaging,
  packaged Desktop E2E and exact-head installer artifact. Expected platform skips
  remain skips. No paid model test runs in CI.
- Historical SOW, native Code and integrated multi-turn acceptance passed at
  `2f26b36f35d874702e29e4c9ef3f63d6aea1a216`.
- Final targeted acceptance at `9e71014979db7a7619bb6ac909b8418a0d198573` passed exactly
  one read-only standalone Claude Code unit, completed result return and parent
  completion; strict schema, capabilities, NRC attribution, one-unit grant,
  revocation, idle cleanup and unchanged validation API snapshot verified.
  [Full sanitized acceptance attribution](nxr-066-owner-acceptance.md) preserves
  earlier failures and their original SHAs.

## Active deployments, limitations and rollback

Desktop and Plane remain active at the validated implementation generation
`9e71014979db7a7619bb6ac909b8418a0d198573`; the merged tree is identical. A documentation
commit or merge-parent SHA does not imply the active binaries were rebuilt with
that SHA. No public release, version tag or additional rollout was performed.

Known limitations: unconfigured Plane DSH Control; unavailable Antigravity in this
environment; unsigned Windows installer; existing Windows Job Object/orphan
containment and documented native-runtime constraints. Multi-account Resource
Fabric lifecycle, generalized ACP agents, provider-session handoff, NRC v2 and
other research proposals are not implemented. Scheduler/memory/mobile/cloud work
remains separately deferred. No new monetary cap, budget manager, timeout or retry
architecture was introduced; available cost/usage metadata is not a billing
guarantee.

Rollback references: previous main `76de2e1c41975d13eb215f2c0858605348ccfa3d`
and previous Desktop/Plane generation
`455985746c51ff381dd0b1a24fdbb40129088119`. Rollback would require a separate
authorized deployment or normal reviewed revert; never hard-reset owner data or
force-push main. Previously verified source bundles are retained locally.

## Next milestone

NXR-070 architecture reconciliation against this baseline, then owner review of
Proposed ADR-029. Research branch `research/nxr-070-resource-fabric` at
`b843d04a8e84b281b8031809dbbe71cf69a311db` remains isolated and unmerged;
implementation NOT STARTED. Follow the
[reconciliation handoff](../../architecture/NXR-070_Architecture_Reconciliation_Handoff.md).
