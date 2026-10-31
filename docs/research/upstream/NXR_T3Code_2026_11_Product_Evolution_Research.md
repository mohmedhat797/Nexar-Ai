# T3 Code product evolution research for Nexar

Research date: 2026-11-01, Africa/Cairo. Status: research and proposed implementation planning; no product changes authorized or made.

## Executive decision

T3's highest-value lesson is making operational state understandable: which account is selected, what a usage observation means, what context moved, and why work is waiting. Nexar already owns the stronger architectural foundation for its Personal AI Operating Layer: NRC selection, immutable connections, canonical sessions, confirmed memory, and a single permission architecture. Improve those surfaces; do not import T3's orchestrator.

**Recommended next assignment after active D′: a small, separately approved Electron security maintenance slice, then H′ Providers UI v2.** Nexar pins Electron 44.5.1, embedding Node 24.21.0. T3's security correction uses Electron 44.10.0, embedding patched Node 24.22.1. This is a verified dependency discrepancy; an exploitable Nexar path has not been demonstrated. Investigate and close it before expanding Desktop functionality. The [next-milestone blueprint](../../development/NXR070_Next_Milestone_Implementation_Blueprint_Proposed.md) makes this bounded correction ready for assignment and includes H′'s follow-on design. [E17–E19, N13]

H′ remains the next **product** milestone: the owner explicitly chose bridge/E2E-only D′ followed immediately by H′. F′ can proceed independently from accepted A′, provided a separate engineer/reviewer is available. G′ follows C′ and F′; I′ is a separate context/persistence track; J′ remains owner acceptance. This report does not amend that approved dependency graph. [N01, N02]

## Verified repository state

| Item | Observation | Interpretation |
| --- | --- | --- |
| Accepted local and GitHub main | `6bc038021b66b8d093bad5a4fbd936794f048da3` | Fixed research base; not active feature code |
| PR 48 | Merged 2026-10-31T22:50:19Z, merge commit above | Baseline documentation is merged |
| Open PRs at initial inspection | None | No D′ PR to treat as accepted |
| D′ local worktree | `.nexar/worktrees/nxr070d`, branch `feat/nxr-070d-codex-homes` | Active; do not modify |
| D′ first observation | `8e1473e3cae132eddf618b9791da863647f08c69`, two commits beyond main; modified private-state files and untracked home-store implementation/tests | Partly implemented locally; unmerged and unaccepted |
| D′ subsequent observation | Short HEAD `2d8e271`, isolated-home commit added during research | Concurrency confirmed; findings are review recommendations, not a D′ audit verdict |
| D′ final state recheck | `c326451a05425f145f962ddf1c15552c5de39e2a`, per-owner Codex resource publication; further uncommitted connection/runtime changes | Still active, unmerged and outside this research's code assessment |
| Main working tree | Clean at inspection | No owner changes moved or overwritten |
| Historical research branch | `research/nxr-070-resource-fabric` at `b843d04…` retained | Original study recovered with `git show`, not reconstructed |
| Other registered worktrees | 15 initially, including B′, C′, reconciliation, security, maintenance, Claude and older acceptance work | Registration is not evidence that a process is currently active; no worktree retired |

Read-only `git branch -vv`, `git worktree list --porcelain`, main status, D′ status/log, remote main and PR queries established these facts. No credential contents or unrelated process environments were inspected. All substantive Nexar claims below refer to accepted main, not D′'s moving tree.

The final registered-worktree status audit found 16 checkouts including this research checkout. Outside this research, D′ had 7 changed tracked files; the older NXR-066 runtime-validation detached checkout had 16, the B′ audit checkout had one untracked item, and the NXR-070R research checkout had two untracked items. All other registered checkouts were clean at that observation. These are preservation signals, not permission to retire anything or proof which agent owns a running process.

The managed worktree tool created this research checkout at `C:/Users/Mohamed Medhat/.codex/worktrees/t3code-research/Nexar-Ai-main`, sharing `D:/Nexar-Ai-main/.git`. Its API has no destination option. A checked move to the suggested D: path failed with Git's cross-volume `Improper link`; the original checkout remained intact. This documented tooling exception avoids a second checkout or full clone. No existing worktree was removed. lean-ctx rejected that managed location and the external historical T3 checkout, so native Git mutations and context-mode analysis were used where necessary; no allowlist was changed.

## Frozen upstream identities

Release publication times below are UTC; the research date is Cairo's 1 November.

| Reference | Exact source SHA | Published UTC |
| --- | --- | --- |
| NXR-068 | `8c61e254fd07249b8c420c44d62e8ecd72a78a20` | Historical study 2026-10-06 |
| Original NXR-070 | `3143335fc3a568cbbb5174764961889272135cb9` | Historical study 2026-10-08 |
| v0.1.0 | `81493efb71e8e8244f95d3e9f71d8369654ab151` | 2026-10-15T23:18:08Z |
| v0.1.1 | `fe27e8e3dc12dcbb108e9a28fd9b8cb65f34ae92` | 2026-10-21T02:29:41Z |
| v0.1.2 | `044f07257c9684ae4543bd1e1ebf9c394e9e3830` | 2026-10-22T20:44:22Z |
| v0.1.3 | `d2c440312e5f39d59827ed466838a623516454d6` | 2026-10-27T06:09:26Z |
| v0.1.4 | `783581d461dc72cdd8f78fc8abb4ad536dfc4547` | 2026-10-29T07:44:41Z |
| v0.1.5 | `6d450a4284852af137b2f3407fddd89eb76e7644` | 2026-10-29T13:08:50Z |
| Latest stable v0.1.6 | `2359643cffa6ba9ee84d6f2694b935de54a8013e` | 2026-10-31T10:52:24Z |
| Previously supplied nightly .3991 | `15fe2832727893cbdd2214383f9f971474849695` | 2026-10-31T16:47:26Z |
| Latest published prerelease v0.1.7-nightly.20261031.4004 | `54c5f25249961a1aa0b61932329092eadbd9d6fc` | 2026-10-31T23:24:23Z |
| Observed main | `575579d68ac4bae09f8426a345d4a3eac1e90c67` | Commit time 2026-10-31T23:19:39Z |

GitHub release metadata and `git ls-remote` independently agreed on v0.1.0–6 and .4004. Main is one commit ahead of .4004; .4004 is eight commits ahead of stable. Release publication time is not commit time. A preview and Android beta were excluded from the desktop stable decision. The supplied .3991 reference is superseded, not silently relabeled. [E01, E02]

## What changed and what did not

Multi-instance identity, scoped lifecycles, native Codex model/limit probes, model-versus-runtime distinctions, portable handoff, and usage recovery were already present in the October studies. V0.1.0 also explicitly documented cross-provider delegation, forks, merge-back tools, native histories, persisted queues, restart continuation and reset-bound auto-resume. None is a new v0.1.6 discovery. [H01–H03, E03]

Verified new since v0.1.0: side-chat UI/workflow, project pin/archive, local commit review, and experimental secret-provider configuration. Important maturation includes force-stop handling, narrow run-preparation reads, streaming Markdown isolation, account warnings, worktree path equivalence, branch-action serialization, context visibility, and credential URL redaction. Exact first stable versions are asserted only where release/diff/tree evidence supports them. [E04–E16, E20–E25]

Nightly's quota-probe User-Agent change is especially instructive: a quota display depending on an undocumented compatibility trick is not an approved Nexar production signal. It remains research evidence, not an adoption candidate. Main's model-picker change is useful UX evidence but is not stable functionality. [E02]

## Product recommendations

| Recommendation | Value | Boundary |
| --- | --- | --- |
| H′ connection-first overview plus inline details | Makes B′/D′ usable without technical identity clutter | Project existing connection, inventory and NRC state; no renderer routing |
| Separate configured, installed, authenticated, reachable, model, quota and eligibility facts | Prevents misleading “Available” badges | Unknown remains unknown; timestamps and sources visible |
| F′ execution attribution and G′ evidence-aware observations | Trustworthy history and explanations | No external native-history import, billing enforcement or learned default |
| Context coverage inspector | Explains retained and omitted material | Existing manifests first; context@3 only through I′ |
| Delegation progress and review-independence explanations | Makes engineering work comprehensible | Project Bridge/NRC lineage; do not add a second execution graph authority |
| Focused lifecycle/security regressions | Prevents account confusion and orphaned work | Verify existing protection before changing code |

All are Nexar proposals or adaptations, not claims that T3 supplies an NRC explanation UI. “Why selected / why excluded,” quota uncertainty and review independence are **Nexar-specific design proposals** combining existing RouteDecision and Resource Fabric contracts. [N03–N10]

## Already implemented: avoid redundant work

Accepted main has immutable connection IDs and host-qualified keys (A′), API-key connections with account-binding assurance, lifecycle confirmations, tombstones and per-connection resolution (B′), and connection/provider review dimensions (C′). It also has bounded inventory, NRC explanations, unknown quota handling, abort-aware delegation, context@2 with required Project Memory, and FileSessionStore interruption without replay. Source presence is verified; the existing acceptance report records synthetic automated results at `c97136b`, not independent or real-account acceptance on this research branch. Changes between that tested revision and main include test corrections and documentation; do not present the old run as an exact-main rerun. [N03–N12]

## Risks and deliberate rejections

Retain DSH `0.2.1-rc.5`, NRC, trusted credential management, Permission Broker, FileSessionStore and ProjectMemoryStore. Retain WSL2/bubblewrap and Coding sandbox boundaries. Reject T3 runtime/orchestrator adoption, shared native account sessions, credential copying, automatic replay/resume, broad HTTP MCP and cross-host routing. E-1/E-2, native persistence and upstream schedulers remain deferred. T3's 1Password headline is feature-flagged; adopting its secret-provider system would add integration and lifecycle burden without closing H′'s immediate problem. [N01, N02, N13, E15]

Existing release gaps remain: clean installation/signing, real-account scenarios, installed Plane compatibility and independent acceptance. Research did not update the Plane, install packages, launch upstream code, run paid inference or execute heavyweight CI. No security exploit was run. [N12]

## Evidence method and limits

`SOURCE_VERIFIED`: implementation or patch inspected. `TEST_VERIFIED`: this research actually executed the relevant test; **no upstream/runtime test receives this label here**. `DOCUMENTED`: official flow/release. `HANDSON_VERIFIED`: actual interaction; none claimed. `INFERRED`: reasoned proposal. `UNVERIFIED`: support or operational behavior not established. Inspected tests are labeled SOURCE_VERIFIED (test inspected), never passed tests.

Git trees at all nine historical/stable pins were inspected without truncation for selected capability fingerprints; official source, release PR patches, test scenarios and user documentation were selectively read. This is a comprehensive capability-family assessment, not a line-by-line audit of the 33,147-entry upstream tree or a security certification. No large T3 clone or development installation was created. Hands-on usability remains partial: prerequisites/scripts were reviewed, but no disposable OS profile/VM and isolated provider-home execution was established. Source/documentation evaluation cannot prove interaction quality, accessibility conformance or performance timings.

## Evidence index

Evidence IDs below are shared by all eight documents. Paths under a pinned URL identify the inspected implementation; PR links provide change rationale, and the pinned stable file supplies immutable final behavior. Reuse is design-level reimplementation; no upstream production source is copied into Nexar.

### Historical and Nexar authorities

| ID | Evidence |
| --- | --- |
| H01 | [NXR-068 inventory study at accepted main](https://github.com/mohmedhat797/Nexar-Ai/blob/6bc038021b66b8d093bad5a4fbd936794f048da3/docs/research/upstream/provider-model-inventory-patterns.md) |
| H02 | [Original NXR-070 at b843d04](https://github.com/mohmedhat797/Nexar-Ai/blob/b843d04a8e84b281b8031809dbbe71cf69a311db/docs/research/upstream/nxr-070-t3code-goose-comparative-study.md) |
| H03 | [NXR-070R v0.1.0 reconciliation](../../architecture/nxr-070/NXR070_T3Code_V2_Architecture_Reconciliation.md) |
| N01 | [Owner decisions](../../architecture/nxr-070/NXR070_Owner_Decisions_2026-10-17.md), [accepted execution plan](../../architecture/nxr-070/NXR070_Execution_Plan_Reconciled.md), [accepted blueprint](../../architecture/nxr-070/NXR070_Implementation_Blueprint_Reconciled.md) |
| N02 | [D′ readiness and owner sequencing decisions](../../development/NXR070D_Implementation_Readiness_Package.md), [ADR-029](../../adr/029-connection-scoped-resources-and-canonical-continuity.md), [ADR-030](../../adr/030-unified-dsh-first-agent-runtime.md), [ADR-028](../../adr/028-dynamic-provider-sessions-and-model-inventory.md) |
| N03 | `packages/contracts/src/connection.ts`; `apps/desktop/src/main/connection-manager.ts`, `connection-runtime.ts`, `connection-state.ts` and their tests at main above |
| N04 | `apps/desktop/src/renderer/components/ProvidersView.tsx`, `ConnectionManagement.tsx`, `ResourcesView.tsx`; `apps/desktop/src/shared/connections.ts`, `channels.ts`; `apps/desktop/src/main/connection-channels.ts` |
| N05 | `packages/resource-registry/src/inventory.ts`; `packages/host/src/native-inventories.ts`, `inventory-guard.ts`; `integrations/codex/src/inventory.ts`; `integrations/claude-code/src/inventory.ts` |
| N06 | `packages/resource-controller/src/controller.ts`, `hard-filters.ts`, `review-diversity.ts`, `explain.ts`, `intelligence-policy.ts`; `packages/contracts/src/routing.ts`, `intelligence.ts` |
| N07 | `packages/engine-gateway/src/bridge.ts` (`DelegationUnitLimit`, `untilAborted`), `endpoint.ts`; `integrations/deepseek-harness/src/`; `packages/host/src/bridge-ports.ts` |
| N08 | `packages/operating/src/context.ts`, `service.ts`; `packages/project-memory/src/store.ts`, `render.ts`; `apps/desktop/src/renderer/components/SessionTurnView.tsx` |
| N09 | `packages/sessions/src/store.ts` (`FileSessionStore.acquireLease`), `record.ts`, tests |
| N10 | `packages/contracts/src/telemetry.ts`, `measured.ts`; `packages/telemetry/src/reader.ts`, `history.ts`, `quota-source.ts`, `redact.ts` |
| N11 | `integrations/codex/src/env.ts`, `process.ts`, `adapter.ts`; `integrations/claude-code/src/adapter.ts`, `env.ts`, fake runtime fixtures and tests |
| N12 | [Current status](../../development/NEXAR_Current_Development_Status_2026-10-31.md), [gap register](../../development/NXR070_Operational_Acceptance_Gap_Register.md), [post-merge acceptance](../../development/NXR070_Post_Merge_Integration_Acceptance.md) |
| N13 | `apps/desktop/package.json` Electron 44.5.1; `integrations/deepseek-harness/dsh-runtime.json` 0.2.1-rc.5; `config/upstreams.json` (older reference metadata, not installed-version authority) |
| N14 | [Upstream Intelligence architecture](../../architecture/NEXAR_Upstream_Intelligence_Architecture.md), [decision register](../../architecture/nxr-070/NXR070_Architecture_Decision_Register.md) |

N03–N13 source paths resolve against [the immutable Nexar tree](https://github.com/mohmedhat797/Nexar-Ai/tree/6bc038021b66b8d093bad5a4fbd936794f048da3). Their inspected functions and limitations are specified in the gap assessment and blueprint.

### T3 and security evidence

| ID | Pinned source / official change |
| --- | --- |
| E01 | [Releases](https://github.com/pingdotgg/t3code/releases), [v0.1.6 release](https://github.com/pingdotgg/t3code/releases/tag/v0.1.6); exact identity table above freezes observations |
| E02 | [Stable → nightly comparison](https://github.com/pingdotgg/t3code/compare/2359643cffa6ba9ee84d6f2694b935de54a8013e...54c5f25249961a1aa0b61932329092eadbd9d6fc), [nightly → main](https://github.com/pingdotgg/t3code/compare/54c5f25249961a1aa0b61932329092eadbd9d6fc...575579d68ac4bae09f8426a345d4a3eac1e90c67) |
| E03 | [V0.1.0 release](https://github.com/pingdotgg/t3code/releases/tag/v0.1.0), [original handoff source](https://github.com/pingdotgg/t3code/blob/3143335fc3a568cbbb5174764961889272135cb9/apps/server/src/orchestration-v2/ContextHandoffService.ts) |
| E04 | [CodexHomeLayout](https://github.com/pingdotgg/t3code/blob/2359643cffa6ba9ee84d6f2694b935de54a8013e/apps/server/src/provider/Drivers/CodexHomeLayout.ts), [tests](https://github.com/pingdotgg/t3code/blob/2359643cffa6ba9ee84d6f2694b935de54a8013e/apps/server/src/provider/Drivers/CodexHomeLayout.test.ts) |
| E05 | [CodexProvider](https://github.com/pingdotgg/t3code/blob/2359643cffa6ba9ee84d6f2694b935de54a8013e/apps/server/src/provider/CodexProvider.ts), [ClaudeProvider](https://github.com/pingdotgg/t3code/blob/2359643cffa6ba9ee84d6f2694b935de54a8013e/apps/server/src/provider/ClaudeProvider.ts) |
| E06 | [ProviderInstanceRegistryMutator](https://github.com/pingdotgg/t3code/blob/2359643cffa6ba9ee84d6f2694b935de54a8013e/apps/server/src/provider/ProviderInstanceRegistryMutator.ts), [registry](https://github.com/pingdotgg/t3code/blob/2359643cffa6ba9ee84d6f2694b935de54a8013e/apps/server/src/provider/ProviderInstanceRegistry.ts) |
| E07 | [ProviderInstanceCard](https://github.com/pingdotgg/t3code/blob/2359643cffa6ba9ee84d6f2694b935de54a8013e/apps/web/src/components/settings/ProviderInstanceCard.tsx), [AddProviderInstanceDialog](https://github.com/pingdotgg/t3code/blob/2359643cffa6ba9ee84d6f2694b935de54a8013e/apps/web/src/components/settings/AddProviderInstanceDialog.tsx) |
| E08 | [MultipleAccountsNote](https://github.com/pingdotgg/t3code/blob/2359643cffa6ba9ee84d6f2694b935de54a8013e/apps/web/src/components/settings/MultipleAccountsNote.tsx), [provider FAQ](https://github.com/pingdotgg/t3code/blob/2359643cffa6ba9ee84d6f2694b935de54a8013e/docs/user/faq.md) |
| E09 | [Model picker](https://github.com/pingdotgg/t3code/blob/2359643cffa6ba9ee84d6f2694b935de54a8013e/apps/web/src/components/chat/ProviderModelPicker.tsx), its browser tests in the same directory |
| E10 | [Usage contracts](https://github.com/pingdotgg/t3code/blob/2359643cffa6ba9ee84d6f2694b935de54a8013e/packages/contracts/src/providerUsageLimits.ts), [merge/selection](https://github.com/pingdotgg/t3code/blob/2359643cffa6ba9ee84d6f2694b935de54a8013e/packages/provider-core/src/server/usageLimits.ts) |
| E11 | [ContextHandoffService](https://github.com/pingdotgg/t3code/blob/2359643cffa6ba9ee84d6f2694b935de54a8013e/apps/server/src/orchestration-v2/ContextHandoffService.ts), [portable handoff guide](https://github.com/pingdotgg/t3code/blob/2359643cffa6ba9ee84d6f2694b935de54a8013e/docs/user/portable-handoffs.md) |
| E12 | [Stop source correction](https://github.com/pingdotgg/t3code/commit/6b1245cceda1d504b6f16b438e16f2a2e08f3388), `ProviderTurnControlService`, `ThreadManagementService`, `ThreadStop.test.ts` |
| E13 | [Shared-worktree correction](https://github.com/pingdotgg/t3code/commit/f5bc64b7b7bcc2ff021febbfcf96f0b5043016cf), `apps/web/src/worktreeCleanup.ts` and tests |
| E14 | [Branch-switch correction](https://github.com/pingdotgg/t3code/commit/2c3779762b5ae58c3ef4ae69bc9cb0b97ff74783), `GitWorkflowService.ts`, `GitManager.test.ts` |
| E15 | [Secrets flag](https://github.com/pingdotgg/t3code/blob/2359643cffa6ba9ee84d6f2694b935de54a8013e/apps/web/src/env.ts), [secret driver registry](https://github.com/pingdotgg/t3code/blob/2359643cffa6ba9ee84d6f2694b935de54a8013e/apps/server/src/secrets/secretProviderDefinitions.ts), [introducing commit](https://github.com/pingdotgg/t3code/commit/7a4f5b6188fed54ddc866723e39446a198b5835c) |
| E16 | [Trace redaction correction](https://github.com/pingdotgg/t3code/commit/6d46336476941257d774be7c7733e9caf201fec2), `EnvironmentAuth.ts`, `McpOAuth.ts`, `httpObservability.ts` and tests |
| E17 | [T3 Electron patch](https://github.com/pingdotgg/t3code/commit/6d82a22e9df93f1dd14afa89d820b7dd1b624eef) |
| E18 | [Electron 44.5.1](https://releases.electronjs.org/release/v44.5.1), [Electron 44.10.0](https://releases.electronjs.org/release/v44.10.0) |
| E19 | [Node October security advisory](https://nodejs.org/en/blog/vulnerability/october-2026-security-releases) |
| E20 | [Side-chat workflow](https://github.com/pingdotgg/t3code/blob/2359643cffa6ba9ee84d6f2694b935de54a8013e/apps/web/src/components/chat/useSideChat.ts), [introducing commit](https://github.com/pingdotgg/t3code/commit/50c1c5dc536493826fc66e220598f38b831d5bde) |
| E21 | [Project pin/archive introducing commit](https://github.com/pingdotgg/t3code/commit/ffaa1dba76d86c073533055e48d7f8f015c8a7b7), stable `ProjectCommands.ts`, `ProjectStore.ts`, migration `076_ProjectionProjectsPinArchive.ts` |
| E22 | [Run preparation PR 27105](https://github.com/pingdotgg/t3code/pull/27105), stable `apps/server/src/orchestration-v2/ThreadLaunchService.ts` |
| E23 | [Streaming Markdown PR 27417](https://github.com/pingdotgg/t3code/pull/27417), stable `apps/web/src/components/chat/markdownStreamBlocks.ts` and tests |
| E24 | [Truncated preview correction](https://github.com/pingdotgg/t3code/commit/12d1e4c23c8bf714df2c3e01586fb8e2a25df2fd), `FilePreviewPanel.tsx`, browser test |
| E25 | [Local commit review introducing commit](https://github.com/pingdotgg/t3code/commit/5ef56853ef1854da50bc1909c6c0a32700f2cb13), [source-control guide](https://github.com/pingdotgg/t3code/blob/2359643cffa6ba9ee84d6f2694b935de54a8013e/docs/user/source-control.md) |
| E26 | [Thread organization guide](https://github.com/pingdotgg/t3code/blob/2359643cffa6ba9ee84d6f2694b935de54a8013e/docs/user/thread-sidebar.md), [composer guide](https://github.com/pingdotgg/t3code/blob/2359643cffa6ba9ee84d6f2694b935de54a8013e/docs/user/composer.md) |
| E27 | [Usage guide](https://github.com/pingdotgg/t3code/blob/2359643cffa6ba9ee84d6f2694b935de54a8013e/docs/user/usage.md), stable `codexUsageLimits.ts`, `claudeUsageLimits.ts` and tests |
| E28 | [Remote access guide](https://github.com/pingdotgg/t3code/blob/2359643cffa6ba9ee84d6f2694b935de54a8013e/docs/user/remote-access.md), [service guide](https://github.com/pingdotgg/t3code/blob/2359643cffa6ba9ee84d6f2694b935de54a8013e/docs/user/background-service.md) |
| E29 | [Permissions guide](https://github.com/pingdotgg/t3code/blob/2359643cffa6ba9ee84d6f2694b935de54a8013e/docs/user/permission-modes.md), [McpToolAccess](https://github.com/pingdotgg/t3code/blob/2359643cffa6ba9ee84d6f2694b935de54a8013e/apps/server/src/mcp/McpToolAccess.ts) |
| E30 | [Welcome wizard](https://github.com/pingdotgg/t3code/blob/2359643cffa6ba9ee84d6f2694b935de54a8013e/docs/user/welcome-wizard.md), [Codex setup](https://github.com/pingdotgg/t3code/blob/2359643cffa6ba9ee84d6f2694b935de54a8013e/docs/user/providers-codex.md), [Claude setup](https://github.com/pingdotgg/t3code/blob/2359643cffa6ba9ee84d6f2694b935de54a8013e/docs/user/providers-claude.md) |
| E31 | [UsageLimitRecoveryWorker](https://github.com/pingdotgg/t3code/blob/2359643cffa6ba9ee84d6f2694b935de54a8013e/apps/server/src/orchestration-v2/UsageLimitRecoveryWorker.ts), [RestartContinuation](https://github.com/pingdotgg/t3code/blob/2359643cffa6ba9ee84d6f2694b935de54a8013e/apps/server/src/orchestration-v2/RestartContinuation.ts) |
| E32 | [Delegated completion tests](https://github.com/pingdotgg/t3code/blob/2359643cffa6ba9ee84d6f2694b935de54a8013e/apps/server/src/orchestration-v2/DelegatedCompletionDelivery.test.ts), [subagent UI](https://github.com/pingdotgg/t3code/blob/2359643cffa6ba9ee84d6f2694b935de54a8013e/apps/web/src/components/chat/ProviderSubagentBar.tsx) |

## Deliverables and verdict

- [Historical/version delta](NXR_T3Code_V1_to_Latest_Delta_Matrix.md)
- [Usability benchmark](NXR_T3Code_Usability_Benchmark.md)
- [Architecture and capability gaps](../../architecture/nxr-070/NXR070_T3Code_Latest_Architecture_Gap_Assessment.md)
- [Prioritization](../../development/NXR070_T3Code_Feature_Prioritization.md)
- [Implementation roadmap and work packages](../../development/NXR070_T3Code_Informed_Implementation_Roadmap.md)
- [Next-milestone blueprint](../../development/NXR070_Next_Milestone_Implementation_Blueprint_Proposed.md)
- [Owner decision brief](../../development/NXR070_T3Code_Research_Owner_Decision_Brief.md)

Overall: `NEXAR_T3_RESEARCH_COMPLETE_WITH_LIMITATIONS`. Source-backed planning is ready; direct usability, real-account isolation and production acceptance are not claimed.

## Publication validation

The review diff contains exactly eight added Markdown documents and no modified pre-existing files. Validation checked 42 unique capability IDs, 12 recomputed weighted scores, existing source/change-map paths, local document links, balanced fenced blocks and LF/no-BOM/control-character rules. External URL resolution passed for all 54 non-Nexar URLs referenced by the new documents; three pinned Nexar GitHub references were checked through authenticated GitHub API reads. The original study's historical blob is `526e159bd15c5b369b4365ace5a955123df0b0d0`.

Prettier passed for all five applicable architecture/development documents; the repository intentionally excludes `docs/research/**`, so the three research documents received structural/encoding/link checks rather than a misleading Prettier claim. `git diff --cached --check` and the staged Gitleaks 8.28.0 redacted scan passed. No product tests, upstream runtime tests, provider traffic or heavyweight CI were run for this documentation-only change. The T3 stable/nightly/main identities and unchanged Nexar main/no-open-PR state were re-queried before publication; D′ remained active. Scope/authority/assumption review retained the explicit limitations and rejected adoption patterns above.
