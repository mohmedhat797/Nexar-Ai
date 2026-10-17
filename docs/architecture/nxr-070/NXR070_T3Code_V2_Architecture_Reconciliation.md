# NXR-070R — T3 Code V2 Architecture Reconciliation

**Date:** 2026-10-17 (Africa/Cairo). **Prepared by:** Codex.
**Status:** Research recommendation; implementation not authorized by this document.
**Evidence observed:** 2026-10-16 UTC / 2026-10-17 Africa/Cairo, during this assignment.
**Governing baseline:** Nexar main `6ea56f99d758bc18698c1fa5770b399a283fe6ad`.

## 1. Recommendation

Proceed to owner review of an amended, still-Proposed ADR-029. Preserve its connection-scoped
identity, immutable account binding, conservative quota semantics and staged multi-account roadmap.
Use T3 V2 as a source of specific design patterns, not as Nexar's orchestration substrate.

The first implementation assignment, after approval, should remain **070A′: connection identity
and compatibility contracts**, with offline collision and identity fixtures. Do not combine that
assignment with DSH replacement, native-session persistence, a durable agent queue, or T3 MCP integration.

Keep DSH at `0.2.0-rc.2`. The newer `0.2.1-alpha.5` is an evaluation candidate, not an approved
upgrade. Its ACP wire dependency is unchanged, but lifecycle, plugins, tool surface and model
adapter dependencies have changed. Compatibility has not been executed in this assignment.

The most important reconciliation is a **context-policy collision**: ADR-030 has already shipped
a Project Memory-aware `context@2`; PR #40 proposes a different `context@2`, sidecar and downgrade
model. Reusing that identifier or implementing the proposal literally would confuse historical
records and could weaken accepted memory behavior. Reserve a new policy name, provisionally
`context@3`, subject to owner approval. [N01] [N04] [P01]

## 2. Verified repository and upstream identities

| Item                                   | Observed identity                                                                          | Meaning                                                                                           |
| -------------------------------------- | ------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------- |
| Remote Nexar main; local `origin/main` | `6ea56f99d758bc18698c1fa5770b399a283fe6ad`                                                 | Both matched through `git ls-remote` and local object inspection                                  |
| Starting checkout                      | `feat/nexar-resource-orchestration`, `9e71014979db7a7619bb6ac909b8418a0d198573`, clean     | Not the research baseline; left unchanged                                                         |
| Research checkout                      | `D:/Nexar-Ai-main/.nexar/nxr070r`, `codex/nxr070r-architecture`                            | Created from the verified main commit; documentation only                                         |
| PR #41                                 | Merged; merge commit `6ea56f9…`; head `3153459396e220a63633f8b4c82eb2b866200377`           | GitHub reports merged at 2026-10-16T21:05:15Z                                                     |
| ADR-030                                | Accepted, dated 2026-10-17                                                                 | Status and decisions at main override earlier Proposed reports                                    |
| PR #40                                 | Open, Draft, unmerged; head `40576f8f8760a71fc3f701e6e7098def9664323f`                     | Recorded base SHA `677eefd282fb240cb9583dead80ae100bdeab176`; 19 changed paths, all documentation |
| ADR-029                                | Proposed in PR #40; absent from main                                                       | No Resource Fabric implementation is delivered by that PR                                         |
| T3 historical Nexar study              | `8c61e254fd07249b8c420c44d62e8ecd72a78a20`                                                 | NXR-068 reference, 2026-10-06                                                                     |
| T3 latest stable release               | `v0.1.0` → `81493efb71e8e8244f95d3e9f71d8369654ab151`                                      | GitHub release is non-prerelease, published 2026-10-15T23:18:08Z                                  |
| T3 current main                        | `67bca6c224b3caf61dc7824f6487d754bcad8f8c`                                                 | GitHub main observed unchanged from the supplied reference; commit time 2026-10-16T21:44:44Z      |
| T3 nightly                             | `v0.1.1-nightly.20261016.3203` listed on releases                                          | Separate prerelease stream; not substituted for stable                                            |
| Nexar DSH build pin                    | `@deepseek-ai/dsh@0.2.0-rc.2`                                                              | Verified in `dsh-runtime.json` and its committed package lock                                     |
| DSH npm dist-tags                      | `latest=next=0.2.0-rc.2`; `alpha=0.2.1-alpha.5`                                            | Tags are discovery observations; exact pins remain authoritative                                  |
| DSH pinned source tag                  | `dsh-v0.2.0-rc.2` → `639ed015397290b3745d163aafe02ffee4aa3f84`                             | Git source identity, not a provenance attestation for the npm artifact                            |
| DSH newer source tag                   | `dsh-v0.2.1-alpha.5` → `1517a4dbca0a2789ff1d41ba439600f8547d23fa`                          | GitHub prerelease published 2026-10-16T12:23:28Z                                                  |
| DSH newer npm package                  | `0.2.1-alpha.5`, published 2026-10-16T12:31:49.659Z                                        | Available; source-reviewed here; not installed or runtime-verified here                           |
| DSH GitHub release classification      | Inspected rc.2 and alpha.5 records both `prerelease: true`; `releases/latest` returned 404 | No non-prerelease selected by that endpoint; npm latest is not a stability guarantee              |

GitHub PR state was obtained through the authenticated read-only connector. Upstream source was
read from pinned Git objects in separate research repositories. No upstream binaries or package
install scripts were executed. npm metadata inspection is not an installation observation:
the actual versions in an independently installed owner's application were not probed.

Remote state sources: [PR #41](https://github.com/mohmedhat797/Nexar-Ai/pull/41),
[PR #40](https://github.com/mohmedhat797/Nexar-Ai/pull/40), and their GitHub REST pull-request
records. Git checks included status, branches/worktrees, ls-remote, rev-parse, ls-tree, show,
selected path diffs and blob-identity comparisons. PR #40's API record reported the older base
SHA shown above; the current target branch main was independently verified at 6ea56f9.

The npm package metadata inspected did not supply `gitHead` for these DSH versions.
The tag-to-artifact relationship therefore needs provenance/build verification during an actual
upgrade. Matching version strings alone is insufficient. Artifact integrity values and the
upgrade procedure are in [the upstream architecture](../NEXAR_Upstream_Intelligence_Architecture.md).

## 3. Accepted Nexar architecture and concrete gaps

| Area                      | Current production evidence at main                                                                                                  | Consequence for NXR-070                                                                                                        |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------ |
| Resource identity         | `ProviderConnection`, `ResourceConnection`; `ProviderRuntimeIdentity` contains provider, connectionId, runtimeId, routeId, machine   | Extend these types; do not add parallel Driver/Instance/Binding/Environment domain objects [N02]                               |
| Inventory materialization | `inventoryResourceId` hashes the immutable inventory identity and discriminated model selection                                      | Reuse connection qualification already present; preserve built-in IDs and migration aliases [N03]                              |
| API discovery and secrets | pi catalog discovery and Desktop key-store credential-name allowlists remain provider-oriented; the plan blob has its own fixed name | Multiple connections require actual connection-aware credential resolution and catalog identity work, not just new cards [N05] |
| Routing and review        | NRC hard filters precede scoring; Strategy and Bridge preserve allocation lineage and resource-level review behavior                 | Add connection/provider review dimensions only after OD-5; unavailable required diversity must fail [N06]                      |
| DSH authority             | Managed ACP profiles, one NRC route, per-turn runtime home; Control Gateway and Bridge own selection, grants and accounting          | New connections must flow through existing authority, not into a provider picker inside DSH [N01] [N07]                        |
| Cowork boundary           | Production Windows Cowork uses WSL2/bubblewrap and strict helper hello; no unavailable-isolation host fallback                       | Identity work must preserve per-turn mounts, relay scope and fail-closed deployment compatibility [N08]                        |
| Memory/context            | `buildContext` already emits `context@2`, includes complete owner-confirmed Project Memory, and records requiredIds/requiredHash     | PR #40's proposed policy is an extension beyond the current implementation, not its first implementation [N04]                 |
| Sessions                  | `FileSessionStore` owns a single-writer lease; recovery marks running turns interrupted without replay                               | No T3 thread store, automatic continuation or second sidecar writer [N09]                                                      |
| Native resources          | Existing native Coding resources retain sandboxed work-unit execution; managed DSH profiles stay primary                             | A native provider session must not become canonical Nexar history or a second primary harness [N01]                            |

The accepted policy does **not** already implement PR #40's conservative C1–C5 classifier or its
`session-context@1` sidecar. Current conversation history is bounded to six successful prior turns,
2,000 characters per side and 24,000 conversation characters; Project Memory is rendered separately
and required entries are not silently dropped. The distinction matters: preserve the accepted
required-memory protection while separately approving stronger historical-context classification.
[N04]

The current Code-goal path still has a 20,000-character request-only projection with a distinct
manifest policy. It also passes `requiredContext` separately. Do not claim all context is dropped,
or that the old PR's requirement to change this path is already implemented. Reconcile the future
overflow policy against both the goal and required-context channels. [N10]

## 4. What changed in T3 since Nexar's research

The NXR-068 snapshot already contained provider drivers/instances, V2 orchestration and transition
policy. It is inaccurate to present every V2 feature as newly introduced after that snapshot.
The stable release establishes a release boundary; selective Git object comparisons establish
the following source deltas. [N11] [T01]

| Surface                   | Historical snapshot → stable v0.1.0                                                                                                                                         | Stable → observed main                                  | Nexar implication                                                                                                              |
| ------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| Driver SPI                | `apps/server/src/provider/ProviderDriver.ts` moved to `packages/provider-core/src/server/driver.ts` (Git detected 84% rename similarity); separate `adapterDriver.ts` added | Driver blob changed again; adapterDriver blob unchanged | Refresh references; learn separation, not package topology [T02]                                                               |
| Instance reconciliation   | `ProviderInstanceRegistryMutator.ts` blob unchanged                                                                                                                         | Blob changed                                            | At stable, existing dispose-before-recreate and at-most-one-instance contract remains; main is a separate review target [T03]  |
| Context handoff           | `ContextHandoffService.ts` and transition-policy blobs changed                                                                                                              | Those two blobs unchanged                               | Study current bounded delivery and continuation identity; do not infer lossless cross-provider history [T07]                   |
| Durable effects           | `EffectOutbox.ts` changed                                                                                                                                                   | Changed again                                           | Version recovery behavior independently; copying a queue is a program-level scope change [T05]                                 |
| Usage recovery            | `UsageLimitRecoveryWorker.ts` blob unchanged                                                                                                                                | Changed                                                 | Auto-resume was already present in the older research snapshot; refreshed stable behavior remains opt-in and reset-bound [T06] |
| Codex homes               | `Drivers/CodexHomeLayout.ts` changed                                                                                                                                        | Blob unchanged                                          | Stable has direct-home and auth-overlay/shadow-home modes; only independent homes fit Nexar's approved direction [T04]         |
| MCP access                | `McpToolAccess.ts` absent at old path; present at stable                                                                                                                    | Changed again                                           | Inspect source-level read/write checks; do not equate tools being advertised with permission to invoke them [T08]              |
| Provider update discovery | Maintenance and cached latest-version services exist; current main `ProviderLatestVersions.ts` explicitly caches found/missing results                                      | Main source reviewed for that service                   | Adopt bounded metadata caching as a pattern, not automatic provider maintenance [T10]                                          |

These are selected path comparisons, not an exhaustive semantic audit of T3 main.
A new main SHA or nightly is AVAILABLE evidence only until separately evaluated.
The stable release notes corroborate V2's release scope; implementation findings above derive
from source files, not only release marketing. [T01]

## 5. Capability reconciliation matrix

“Required change” describes future approved work. No row authorizes implementation.

| T3 capability                        | Actual implementation                                                                                                  | Nexar equivalent                                                | Gap                                                                | Decision | Required change                                                                                   |
| ------------------------------------ | ---------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------- | ------------------------------------------------------------------ | -------- | ------------------------------------------------------------------------------------------------- |
| 1. Driver/instance separation        | ProviderDriver creates scoped ProviderInstances; ProviderAdapterDriver separately creates orchestration adapters [T02] | Integration adapters + ProviderConnection + inventory sources   | Factories/config often assume one connection                       | ADAPT    | Compose existing ports per connection; no new vendor-shaped core type                             |
| 2. Connection identity               | Instance ID routes threads; driver kind selects implementation [T02]                                                   | ProviderRuntimeIdentity and connection metadata                 | Central built-in definitions and non-default API catalog IDs       | ADAPT    | 070A′; immutable connection key and equality fixtures                                             |
| 3. Multi-account credentials         | Driver owns per-instance state; Codex supports direct home or auth-overlay home sharing parts of a common home [T04]   | Encrypted Desktop store; owner-declared native homes            | New connection scopes and independent native homes                 | ADAPT    | Keep independent CODEX_HOME, reject T3 shadow/shared-home pattern and credential copying          |
| 4. Provider inventory                | Per-instance snapshots, generation, refresh/probe and model catalogs [T02] [T09]                                       | ADR-028 bounded inventories                                     | Multiple definitions and cache invalidation per connection         | ADOPT    | Reuse freshness/provenance states; no paid generation/auth during background discovery            |
| 5. Model capability discovery        | Adapter declares runtime capabilities; model catalog exposes model choices; capability-driven degradation [T02] [T09]  | Native-agent/model-turn separation, verified entry facts        | Future fields need evidence and failure semantics                  | ADAPT    | Keep runtime capability separate from model entitlement; unknown stays absent                     |
| 6. Health checks                     | snapshotProbe and managed instance lifecycle report readiness independently of execution [T09]                         | Provider checks, inventory guard, resource state                | Connection-specific stale/disabled states                          | ADAPT    | Bounded checks; unavailable is explicit; never infer quota from authentication                    |
| 7. Resource selection                | ModelSelection names instance plus model/options; adapter classifies transitions [T07]                                 | NRC route decisions, strategy and Control pin                   | UI connection selection and pins for new IDs                       | ADAPT    | NRC remains sole selection authority; changes take effect at safe turn boundaries                 |
| 8. Agent delegation                  | MCP delegate_task creates child threads; DispatchModeLimit bounds modes; task status/cancel/wait [T08] [T11]           | Intelligence Bridge and monotonic DelegationUnitLimit           | No need for a second child-thread graph                            | REJECT   | Do not replace Bridge or grant lifecycle; retain bounded units and independent review             |
| 9. Background work                   | Runtime items/rosters track commands, monitors and subagents; restart notes describe cancelled awaited work [T11]      | Existing schedules and supervised turns                         | Long-lived agents/background completion are separate product scope | DEFER    | Future ADR for admission, ownership, cancellation and recovery                                    |
| 10. Durable task queues              | SQL effect outbox, leases and explicit replay/process-loss categories [T05]                                            | Current canonical session records; bounded Bridge jobs          | No equivalent durable agent queue established here                 | DEFER    | Separate queue ADR and at-least-once/idempotency analysis; not an identity prerequisite           |
| 11. Restart recovery                 | RestartContinuation stores intent, checks pending human input and caps continuation chains [T05]                       | Session lease recovery marks interrupted, no replay [N09]       | Different authorization semantics                                  | REJECT   | Preserve current no-replay behavior; do not import automatic turns                                |
| 12. Context handoff                  | Bounded canonical-history selection with coverage and omission metadata; continuation-aware switch [T07]               | Canonical sessions + Project Memory + context manifests         | Conservative classification and sidecar remain proposed            | ADAPT    | New policy identifier; owner-confirmed promotions; no lossless-history claim                      |
| 13. Native session resume            | Continuation identity and adapter-specific session/selection transition determine reuse/resume/handoff [T07]           | Per-turn DSH homes; native resources outside canonical history  | Deliberately no managed native persistence                         | DEFER    | OD-3 remains; no permission/session carry-over across turns                                       |
| 14. Account usage limits             | ProviderUsageLimitsIngestion plus persisted usage-limit/reset recovery [T06]                                           | Measured/unknown quota facts and NRC hard filters               | Supported connection-scoped observations                           | ADAPT    | Only documented vendor/owner/accounted observations; reset is an observation, not fresh authority |
| 15. MCP integration                  | Authenticated HTTP /mcp, scoped credentials, read/write tool checks, broad thread/project operations [T08]             | Nexar inbound stdio Work Bridge; per-turn internal Bridge relay | Transport, project and delegated-authority mismatch                | DEFER    | Separate owner-approved bounded read-only external connector evaluation; no endpoint inheritance  |
| 16. Provider updates                 | Coordinated maintenance plus standalone server/desktop updating and latest-version cache [T10] [T12]                   | Exact-pinned DSH bundle and explicit WSL provisioning           | No permanent evaluated-update ledger                               | ADAPT    | Metadata-only discovery and separately approved compatibility pipeline                            |
| 17. Wholesale orchestration adoption | Event stores, provider threads, checkpoints, recovery and multi-harness control [T05] [T07]                            | One DSH runtime and one Nexar canonical session system          | Incompatible ownership model                                       | REJECT   | Preserve ADR-030; reference architecture only                                                     |

In this matrix ADOPT means adopt the narrowly described principle, not copy upstream code.
No upstream source was copied into production. Any later source reuse needs license and security
review and must remain behind ADR-008 adapter boundaries.

## 6. PR #40 reconciliation and amendment register

The reconciled PR #40 already rejects the original research's duplicate Driver/Instance/
RuntimeBinding/Environment entities. It contains no production implementation. Do not critique it
as though the unreconciled research draft were still its final blueprint. Its old baseline,
context design and release assumptions still require the following amendments. [P01] [P02] [P03]

| ID  | Category                                | Current assumption/location                                                                                                      | Required reconciliation                                                                                                                                                                                        |
| --- | --------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| R01 | Textual amendment                       | ADR-029 baseline; blueprint header; execution/approval briefs cite 9e71014/677eefd                                               | Freeze main 6ea56f9 and ADR-030 Accepted; retain older SHAs as historical fixtures only                                                                                                                        |
| R02 | Already compatible                      | ADR-029 §2/§4.1; AD-1                                                                                                            | Keep ProviderConnection/ProviderRuntimeIdentity; no parallel instance hierarchy                                                                                                                                |
| R03 | Already compatible                      | B1–B7, §4.3–4.5                                                                                                                  | Preserve raw-capability validation, monotonic admission, immutable binding, stable built-ins, strict review lineage and authority separation                                                                   |
| R04 | Textual amendment                       | Inherited old Cowork/Code baseline in main reconciliation handoff; ADR-030's description of the superseded dual-harness proposal | State DSH Cowork and Coding profiles; remove OpenWorker-as-target assumptions wherever inherited; keep historical reports historical                                                                           |
| R05 | Actual contract change + owner decision | ADR-029 §4.6, REQ-40, OD-3/10/13/14 all call the proposed classifier context@2                                                   | Preserve accepted context@2; name proposed semantics context@3 or another owner-approved new version; do not reinterpret old manifests                                                                         |
| R06 | Actual contract change                  | ADR-029 §4.6.5 assumes unchanged seven-field v0.6 manifest                                                                       | Current ContextManifest also has requiredIds/requiredHash; preserve them and test the actual strict reader; decide any new fields explicitly                                                                   |
| R07 | Actual contract change + owner decision | Session-scoped “Keep as constraint” promotions and sidecar can overlap new Project Memory ownership                              | Project-scoped confirmed knowledge stays in ProjectMemoryStore; sidecar holds session classifications/provenance and references. Do not create a second project-fact store or session writer                   |
| R08 | Actual contract change                  | Missing sidecar inferred from any historical context@2* manifest                                                                 | Existing ADR-030 turns legitimately have no sidecar. Require an explicit new-policy marker; absence for old policy is normal; absence for new policy fails closed                                              |
| R09 | Actual contract change                  | I′ rollback to context@1; TST-45/49/55 use only 9e71014 reader                                                                   | Roll back to accepted ADR-030 build/context@2, preserving Project Memory. Keep v0.6 fixtures as extra history, not the only rollback target                                                                    |
| R10 | Textual amendment + test refresh        | Native Ubuntu + Windows exact-head gate at every unit, blueprint §3/execution §4                                                 | Use recorded Windows-first governance: Full Windows, source/packaged Desktop and mandatory WSL2 boundary/Coding checks; native Ubuntu remains deferred unless owner revises                                    |
| R11 | Textual amendment                       | DSH Code Control “unconfigured/outside NXR-070” statements in execution/approval/closure                                         | Keep private owner configuration out of scope; preserve currently implemented managed Coding ACP/NRC contract and its documented native-key exception; do not infer live configuration from historical wording |
| R12 | Actual contract change                  | B′ credential/catalog design still targets old fixed key and single plan structures                                              | Extend current encrypted key store, per-call resolvers, inventory generations and active-turn bindings together; no new secret authority in DSH or WSL Cowork                                                  |
| R13 | Actual contract change                  | A′ centralizes built-ins but examples reflect v0.6                                                                               | Golden fixtures must include main's current identity tuples, plan migration alias and accepted profile metadata; leave hashes/pins byte-identical                                                              |
| R14 | Owner decision                          | OD-5 review dimensions                                                                                                           | Preserve resource default; add connection/provider only when approved; changing account is not changing provider                                                                                               |
| R15 | Deferred by governance                  | E-1/E-2; native resume/fork, remote hosts, HTTP MCP, learned quality, OD-11 default policy                                       | Stable T3 features do not satisfy vendor-support gates or authorize scope expansion                                                                                                                            |
| R16 | Textual amendment + separate scope      | No permanent upstream update proposal in PR #40                                                                                  | Link the companion update architecture; discovery never means installation or dynamic routing authority                                                                                                        |
| R17 | Textual amendment                       | Existing acceptance reports/main ADR contain old Proposed/host-local text                                                        | Cite Accepted ADR header/decisions and merged source as current authority; record stale narrative for a later owner-reviewed documentation cleanup                                                             |

R05–R09 require more than a word substitution: they affect policy identity, sidecar activation,
migration, rollback and memory integrity. A later documentation amendment must update the linked
ADR, register, threat model, blueprint, execution plan, traceability and TST expectations together.
This assignment deliberately leaves those existing documents and ADR statuses unchanged.

### Proposed ADR-029 wording for owner review

1. **Runtime:** “Resource Fabric extends the accepted ADR-030 architecture. DSH is the primary
   runtime; Cowork and Coding remain profiles. NRC owns connections, routing, grants and accounting.”
2. **Context:** “Accepted context@2 and existing manifests remain unchanged. Conservative classified
   handoff uses a separately versioned policy. Required owner-confirmed Project Memory survives all
   projections and compaction; a historical context@2 manifest does not imply a missing sidecar.”
3. **Persistence:** “FileSessionStore is the only canonical-session/sidecar writer under its lease.
   ProjectMemoryStore owns project-wide confirmed facts under the existing owner-state authority.
   Session marks reference their sources; promotion into project knowledge requires owner confirmation.”
4. **Rollback:** “New-policy rollback returns to the accepted ADR-030 baseline, never disables
   required Project Memory, and leaves sidecars, memory records, identities and credentials intact.”
5. **Updates:** “Upstream availability cannot change a production pin, helper protocol, permission
   ceiling, credential reference, connection identity or NRC selection. Upgrade execution is a
   separate explicitly approved compatibility change.”

These are proposed amendment texts, not changes to an Accepted ADR or acceptance of ADR-029.

## 7. DSH candidate compatibility assessment

| Surface                    | Evidence and delta                                                                                                                                                      | Assessment / required gate                                                                                                                                        |
| -------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| ACP transport              | Both source package manifests pin @agentclientprotocol/sdk 1.4.0; candidate keeps stdio initialize/new/prompt/cancel, configuration and one-shot permission paths [D01] | Structurally promising; wire/version/capability tests still mandatory                                                                                             |
| Profiles/overlay           | Candidate ACP patch removes the default personaSuffix working-directory text; Nexar replaces system-prompt config and injects required context [D02] [N07]              | Verify whole-row replacement and pinned context on every step; do not assume defaults are harmless                                                                |
| Lifecycle/cancellation     | Candidate session.ts changes cancellation completion, descendant draining/waiting and status/error handling [D01]                                                       | High-impact compatibility surface despite same SDK dependency; prove cancellation and teardown with real runtime                                                  |
| Tool catalog               | Candidate base patch adds remote-access, working-directory and tool-working-directory rows and changes other row composition [D02]                                      | Inspect effective composed rows/tools for both profiles. Presence of a row alone does not prove it is enabled or exposed. Unknown callable tools must fail closed |
| Plugins                    | engines.dsh is preferred over peer requirements; exact exemptions and prerelease range behavior implemented [D03]                                                       | No plugin installation/hot replacement in managed Nexar profiles; audit any changes to disabled-row coverage                                                      |
| SDK/team APIs              | Alpha release family adds session/wait-related integration requirements and changes agent-team delivery; invariant plugin/export removal was announced in alpha.1 [D04] | Does not justify switching managed ACP to SDK or adopting internal Cordis APIs                                                                                    |
| Routing/model providers    | Candidate npm dsh-llm-pi-ai depends on pi-ai ^1.1.0; main's locked runtime has pi-ai 0.87.1 [D05]                                                                       | Re-evaluate NRC tool/schema/reasoning/usage compatibility and freeze a candidate dependency closure                                                               |
| Compaction                 | Candidate compaction implementation handles routed history and cancellation; upstream compaction features have evolved [D06]                                            | Required Project Memory must appear before/after actual compaction and auxiliary model requests; count usage once through gateway                                 |
| Credentials/global context | New release family adds shared AGENTS-home lookup, working-directory APIs and remote helpers [D04]                                                                      | Revalidate private HOME/DSH_HOME/environment, inherited instruction discovery and no host key visibility; no automatic new mounts or egress                       |
| WSL/bubblewrap             | Nexar verifies helper protocol, release, exact DSH version and capability set before a turn [N08]                                                                       | A new DSH pin must be a coordinated Windows/helper release; current mismatches must remain blocked                                                                |
| Published artifact         | npm integrity/signatures available; gitHead absent in inspected top-level package metadata [D05]                                                                        | Registry-declared identity only. Verify artifact bytes, dependency closure and provenance during approved evaluation                                              |

No ACP conformance, permissions, prompts, paid calls, WSL experiments, installers or CI were run
against the candidate. The assessment is **EVALUATED_SOURCE_ONLY / RUNTIME_COMPATIBILITY_UNKNOWN**.

### Dependency security evidence

The committed runtime lock contains @modelcontextprotocol/client/core 2.0.0, root fflate 0.8.3,
and nested fflate 0.8.2 under @deepseek-ai/libreoffice-kit 0.1.5. GitHub advisory
[GHSA-6qxp-vccf-f47h] affects client versions below 2.2.0 in the 2.x range; [GHSA-px8p-9vwx-vf98]
affects the nested 0.8.2 ZIP64 path. Neither the root fflate version nor application isolation
makes the dependency tree vulnerability-free. [N12]

Candidate npm dsh-mcp-client pins client 2.2.0, addressing that package's advisory range.
Candidate upstream pnpm lock still includes libreoffice-kit 0.1.5 and fflate 0.8.2 as well as 0.8.3.
Therefore “alpha fixes all dependency issues” is unsupported. A candidate's source lock is also
not proof of the closure that Nexar would actually install. Reassess reachability if HTTP/OAuth
MCP, Office conversion, plugins or remote access are enabled. Keep existing debt tracked; a newly
reachable path triggers expedited review, not automatic alpha installation. [D05] [D07]

## 8. Owner decisions and readiness

| Decision      | Repository state in PR #40                                       | Reconciliation disposition                                                                                           |
| ------------- | ---------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| OD-1          | ADR-029 package approval pending                                 | Approve only an ADR-030-reconciled version; do not accept this old package verbatim                                  |
| OD-2          | Remove optional ACP worker pending                               | Keep deferred; DSH's managed ACP transport is required and must not be confused with a new generic ACP work resource |
| OD-3          | Canonical continuity; native resume/fork deferred, confirmed     | Preserve direction; update the proposed policy name and current-memory assumptions                                   |
| OD-4a / OD-4b | Multiple API keys, then independent Codex homes confirmed        | Preserve order; auth remains owner-initiated                                                                         |
| OD-4c / OD-4d | Concurrent ChatGPT-plan / Claude accounts evidence-gated         | E-1/E-2 remain unmet by this research; T3 implementation is not vendor support evidence                              |
| OD-5          | Review dimensions pending                                        | Explicit approval before changed review allocation                                                                   |
| OD-6          | No monetary budget/billing enforcement, confirmed                | Preserve; telemetry/unknown-cost semantics remain honest                                                             |
| OD-7 / OD-8   | Lifecycle and immutable account-binding semantics pending        | Approve with active execution/refresh/native-process exclusions                                                      |
| OD-9          | Frozen desktop/plane identities, pending                         | Preserve names; future hosts are new authorities, not federation                                                     |
| OD-10         | Overflow rejection/no automatic independent turn pending         | Reconcile with current required-context and Code-goal channels                                                       |
| OD-11         | New default routing policy deferred                              | Keep resource-intelligence@2 opt-in until evidence and a later default decision                                      |
| OD-12         | Live login/provider tests owner-initiated per action             | Unchanged; none performed                                                                                            |
| OD-13         | Conservative direction confirmed; optional categories pending    | Never classify prior instructions as optional solely to fit capacity                                                 |
| OD-14         | Sidecar direction conditionally accepted; final approval pending | Reapprove the ownership, activation, compatibility and rollback changes R05–R09                                      |
| OD-15         | Sequential Replace plan account pending                          | Preserve tombstone/new-ID semantics; no concurrent-plan claim                                                        |

Additional approval is needed for the new context policy identifier and amended persistence
design, the update-management scope/schedule, any prerelease DSH evaluation, and any T3 external
connector. These are separate from accepting 070A′ and from permission to push/merge.

**Readiness:** ready for architecture decisions; **not** unconditional implementation or release
authorization. ADR-030 acceptance is satisfied. ADR-029 approval and a narrowly scoped 070A′
assignment remain the next program gates.

## 9. Evidence index

Nexar links below are pinned to the inspected main. PR links are pinned to the actual PR #40 head.
T3 links use stable v0.1.0's resolved commit unless explicitly marked main. Symbols/sections named
in the report identify the relevant code; tests were inspected as source, not executed here.

Additional directly inspected implementation sources at the same frozen Nexar baseline:
[connection contracts](https://github.com/mohmedhat797/Nexar-Ai/blob/6ea56f99d758bc18698c1fa5770b399a283fe6ad/packages/contracts/src/connection.ts),
[Control Gateway](https://github.com/mohmedhat797/Nexar-Ai/blob/6ea56f99d758bc18698c1fa5770b399a283fe6ad/packages/engine-gateway/src/gateway.ts),
[Intelligence Bridge](https://github.com/mohmedhat797/Nexar-Ai/blob/6ea56f99d758bc18698c1fa5770b399a283fe6ad/packages/engine-gateway/src/bridge.ts),
[session manifest](https://github.com/mohmedhat797/Nexar-Ai/blob/6ea56f99d758bc18698c1fa5770b399a283fe6ad/packages/sessions/src/types.ts),
[Project Memory rendering](https://github.com/mohmedhat797/Nexar-Ai/blob/6ea56f99d758bc18698c1fa5770b399a283fe6ad/packages/project-memory/src/render.ts),
[plan identity/migration](https://github.com/mohmedhat797/Nexar-Ai/blob/6ea56f99d758bc18698c1fa5770b399a283fe6ad/apps/desktop/src/main/plan-inventory-identity.ts),
[pi catalog discovery](https://github.com/mohmedhat797/Nexar-Ai/blob/6ea56f99d758bc18698c1fa5770b399a283fe6ad/integrations/pi/src/catalog-discovery.ts),
[quota evaluation](https://github.com/mohmedhat797/Nexar-Ai/blob/6ea56f99d758bc18698c1fa5770b399a283fe6ad/packages/resource-controller/src/quota.ts),
and [WSL provisioning](https://github.com/mohmedhat797/Nexar-Ai/blob/6ea56f99d758bc18698c1fa5770b399a283fe6ad/scripts/provision-wsl-cowork-helper.mjs).

Additional stable T3 sources:
[adapter contract](https://github.com/pingdotgg/t3code/blob/81493efb71e8e8244f95d3e9f71d8369654ab151/packages/provider-core/src/server/ProviderAdapter.ts),
[model normalization](https://github.com/pingdotgg/t3code/blob/81493efb71e8e8244f95d3e9f71d8369654ab151/packages/provider-core/src/server/ModelCatalog.ts),
[MCP contract](https://github.com/pingdotgg/t3code/blob/81493efb71e8e8244f95d3e9f71d8369654ab151/docs/orchestration-v2/orchestrator-mcp-server.md),
and [handoff implementation](https://github.com/pingdotgg/t3code/blob/81493efb71e8e8244f95d3e9f71d8369654ab151/apps/server/src/orchestration-v2/ContextHandoffService.ts).

- [N01] ADR-030, decisions 1–9 and B1–B9.
- [N02] Existing connection and inventory contracts.
- [N03] inventoryResourceId/materializeInventory and plan migration identity.
- [N04] buildContext, ContextManifest and project-memory rendering.
- [N05] DesktopKeyStore and pi catalog discovery.
- [N06] NRC Strategy/filters/quota.
- [N07] DSH profiles/overlay and Control Gateway/Bridge.
- [N08] verifyCoworkHello and accepted WSL helper provisioning.
- [N09] FileSessionStore acquireLease/recover.
- [N10] Operating service Code-goal projection.
- [N11] NXR-068 pinned comparative inventory research.
- [N12] Exact committed DSH dependency lock.
- [P01] Proposed ADR-029.
- [P02] Decision register.
- [P03] Blueprint and linked test/requirement matrix.
- [P04] Execution plan.
- [T01] T3 stable release and source boundary.
- [T02] Driver and adapter contracts.
- [T03] Instance reconciliation contract.
- [T04] Codex home layout.
- [T05] Durable effect outbox; RestartContinuation.ts in the same directory.
- [T06] UsageLimitRecoveryWorker.ts; ProviderUsageLimitsIngestion.ts under provider.
- [T07] Context handoff; ProviderSessionTransitionPolicy.ts in the same directory.
- [T08] MCP access enforcement; toolkits/orchestrator and official MCP document.
- [T09] Snapshot probing and model normalization.
- [T10] Provider maintenance coordinator.
- [T11] DispatchModeLimit and RestartBackgroundNote.
- [T12] Official standalone update instructions.
- [D01] Candidate ACP index/session and package manifest.
- [D02] Candidate base/profile composition.
- [D03] Candidate plugin compatibility.
- [D04] DSH release history.
- [D05] npm metadata; includes version-specific dependencies and declared integrity.
- [D06] Candidate compaction implementation.
- [D07] Candidate source lock, not an installed Nexar lock.

[N01]: https://github.com/mohmedhat797/Nexar-Ai/blob/6ea56f99d758bc18698c1fa5770b399a283fe6ad/docs/adr/030-unified-dsh-first-agent-runtime.md
[N02]: https://github.com/mohmedhat797/Nexar-Ai/blob/6ea56f99d758bc18698c1fa5770b399a283fe6ad/packages/contracts/src/inventory.ts
[N03]: https://github.com/mohmedhat797/Nexar-Ai/blob/6ea56f99d758bc18698c1fa5770b399a283fe6ad/packages/resource-registry/src/materialize.ts
[N04]: https://github.com/mohmedhat797/Nexar-Ai/blob/6ea56f99d758bc18698c1fa5770b399a283fe6ad/packages/operating/src/context.ts
[N05]: https://github.com/mohmedhat797/Nexar-Ai/blob/6ea56f99d758bc18698c1fa5770b399a283fe6ad/apps/desktop/src/main/desktop-key-store.ts
[N06]: https://github.com/mohmedhat797/Nexar-Ai/blob/6ea56f99d758bc18698c1fa5770b399a283fe6ad/packages/resource-controller/src/strategy.ts
[N07]: https://github.com/mohmedhat797/Nexar-Ai/blob/6ea56f99d758bc18698c1fa5770b399a283fe6ad/integrations/deepseek-harness/src/profiles.ts
[N08]: https://github.com/mohmedhat797/Nexar-Ai/blob/6ea56f99d758bc18698c1fa5770b399a283fe6ad/apps/desktop/src/main/wsl-cowork.ts#L179
[N09]: https://github.com/mohmedhat797/Nexar-Ai/blob/6ea56f99d758bc18698c1fa5770b399a283fe6ad/packages/sessions/src/store.ts
[N10]: https://github.com/mohmedhat797/Nexar-Ai/blob/6ea56f99d758bc18698c1fa5770b399a283fe6ad/packages/operating/src/service.ts#L577
[N11]: https://github.com/mohmedhat797/Nexar-Ai/blob/6ea56f99d758bc18698c1fa5770b399a283fe6ad/docs/research/upstream/provider-model-inventory-patterns.md
[N12]: https://github.com/mohmedhat797/Nexar-Ai/blob/6ea56f99d758bc18698c1fa5770b399a283fe6ad/integrations/deepseek-harness/dsh-runtime.package-lock.json
[P01]: https://github.com/mohmedhat797/Nexar-Ai/blob/40576f8f8760a71fc3f701e6e7098def9664323f/docs/adr/029-connection-scoped-resources-and-canonical-continuity.md
[P02]: https://github.com/mohmedhat797/Nexar-Ai/blob/40576f8f8760a71fc3f701e6e7098def9664323f/docs/architecture/nxr-070/NXR070_Architecture_Decision_Register.md
[P03]: https://github.com/mohmedhat797/Nexar-Ai/blob/40576f8f8760a71fc3f701e6e7098def9664323f/docs/architecture/nxr-070/NXR070_Implementation_Blueprint_Reconciled.md
[P04]: https://github.com/mohmedhat797/Nexar-Ai/blob/40576f8f8760a71fc3f701e6e7098def9664323f/docs/architecture/nxr-070/NXR070_Execution_Plan_Reconciled.md
[T01]: https://github.com/pingdotgg/t3code/releases/tag/v0.1.0
[T02]: https://github.com/pingdotgg/t3code/blob/81493efb71e8e8244f95d3e9f71d8369654ab151/packages/provider-core/src/server/driver.ts
[T03]: https://github.com/pingdotgg/t3code/blob/81493efb71e8e8244f95d3e9f71d8369654ab151/apps/server/src/provider/ProviderInstanceRegistryMutator.ts
[T04]: https://github.com/pingdotgg/t3code/blob/81493efb71e8e8244f95d3e9f71d8369654ab151/apps/server/src/provider/Drivers/CodexHomeLayout.ts
[T05]: https://github.com/pingdotgg/t3code/blob/81493efb71e8e8244f95d3e9f71d8369654ab151/apps/server/src/orchestration-v2/EffectOutbox.ts
[T06]: https://github.com/pingdotgg/t3code/blob/81493efb71e8e8244f95d3e9f71d8369654ab151/apps/server/src/orchestration-v2/UsageLimitRecoveryWorker.ts
[T07]: https://github.com/pingdotgg/t3code/blob/81493efb71e8e8244f95d3e9f71d8369654ab151/apps/server/src/orchestration-v2/ProviderSessionTransitionPolicy.ts
[T08]: https://github.com/pingdotgg/t3code/blob/81493efb71e8e8244f95d3e9f71d8369654ab151/apps/server/src/mcp/McpToolAccess.ts
[T09]: https://github.com/pingdotgg/t3code/blob/81493efb71e8e8244f95d3e9f71d8369654ab151/packages/provider-core/src/server/snapshotProbe.ts
[T10]: https://github.com/pingdotgg/t3code/blob/81493efb71e8e8244f95d3e9f71d8369654ab151/apps/server/src/provider/providerMaintenanceCommandCoordinator.ts
[T11]: https://github.com/pingdotgg/t3code/blob/81493efb71e8e8244f95d3e9f71d8369654ab151/apps/server/src/orchestration-v2/DispatchModeLimit.ts
[T12]: https://github.com/pingdotgg/t3code/blob/81493efb71e8e8244f95d3e9f71d8369654ab151/docs/user/updating.md
[D01]: https://github.com/deepseek-ai/deepseek-harness/blob/1517a4dbca0a2789ff1d41ba439600f8547d23fa/packages/acp/acp/src/session.ts
[D02]: https://github.com/deepseek-ai/deepseek-harness/blob/1517a4dbca0a2789ff1d41ba439600f8547d23fa/packages/bundle/base/cordis.patch.yml
[D03]: https://github.com/deepseek-ai/deepseek-harness/blob/1517a4dbca0a2789ff1d41ba439600f8547d23fa/packages/boot/app-boot/src/plugin-compatibility.ts
[D04]: https://github.com/deepseek-ai/deepseek-harness/releases
[D05]: https://registry.npmjs.org/@deepseek-ai/dsh
[D06]: https://github.com/deepseek-ai/deepseek-harness/blob/1517a4dbca0a2789ff1d41ba439600f8547d23fa/packages/compaction/compaction-basic/src/index.ts
[D07]: https://github.com/deepseek-ai/deepseek-harness/blob/1517a4dbca0a2789ff1d41ba439600f8547d23fa/pnpm-lock.yaml
[GHSA-6qxp-vccf-f47h]: https://github.com/advisories/GHSA-6qxp-vccf-f47h
[GHSA-px8p-9vwx-vf98]: https://github.com/advisories/GHSA-px8p-9vwx-vf98
