# NXR-070R — Architecture Approval and Execution Brief

**Date:** 2026-10-17 (Africa/Cairo). **Prepared by:** Codex.
**Status:** Ready for owner architecture review; production implementation not started.
**Source baseline:** Nexar main `6ea56f99d758bc18698c1fa5770b399a283fe6ad`.
**Companions:** [source reconciliation](NXR070_T3Code_V2_Architecture_Reconciliation.md) and
[upstream update architecture](../NEXAR_Upstream_Intelligence_Architecture.md).

## 1. Executive recommendation

Accept the direction of connection-scoped Resource Fabric v2 after amending PR #40 for the
Accepted ADR-030 baseline. Authorize **070A′ only** as the first production slice, after the
architecture decision and an explicit implementation assignment. It should establish identity
contracts and compatibility fixtures without changing credentials, runtime selection, account
login, persistent connections or routing results.

Nexar now has one primary runtime, DSH, with Cowork and Coding profiles. PR #41 is merged and
ADR-030 is Accepted. Do not carry forward the previous “ADR-030 awaiting acceptance” gate.
PR #40 remains an open Draft at `40576f8f8760a71fc3f701e6e7098def9664323f` and contains only
documentation. ADR-029 remains Proposed and its implementation is not authorized by this brief.

Two decisions need particular care:

1. Reuse existing connection/inventory identities rather than importing T3's driver hierarchy.
2. Preserve accepted `context@2` and Project Memory. PR #40 uses that same policy name for a
   different classifier/sidecar design; approve a new version and migration contract before
   implementing that later continuity slice.

Keep `@deepseek-ai/dsh@0.2.0-rc.2`. The latest npm production-facing tags still name that version.
The available `0.2.1-alpha.5` offers relevant changes, including a patched MCP-client dependency,
but changes ACP lifecycle and the profile/tool surface and still has unresolved dependency debt.
It needs a separate compatibility assignment, not inclusion in the first NRC identity change.

## 2. What the evidence establishes

| Question                    | Verified answer                                                                                         |
| --------------------------- | ------------------------------------------------------------------------------------------------------- |
| Current main                | Remote main and local origin/main both 6ea56f99d758bc18698c1fa5770b399a283fe6ad                         |
| PR #41                      | Merged at 2026-10-16T21:05:15Z; its head was 3153459396e220a63633f8b4c82eb2b866200377                   |
| ADR-030                     | Accepted, dated 2026-10-17; old Proposed/host-local paragraphs remain as documentation inconsistencies  |
| NXR-070 proposal            | PR #40 is open Draft, unmerged; 19 changed paths, all docs; ADR-029 absent from main                    |
| T3 stable                   | v0.1.0, source 81493efb71e8e8244f95d3e9f71d8369654ab151                                                 |
| T3 observed main            | 67bca6c224b3caf61dc7824f6487d754bcad8f8c; separate from the stable source                               |
| DSH                         | Nexar build pin/latest/next 0.2.0-rc.2; alpha 0.2.1-alpha.5                                             |
| New compatibility execution | None: no candidate install, paid prompt, WSL experiment, build or Full CI                               |
| Deliverable state           | Three new local Markdown documents; no production changes, dependency updates, ADR edits, push or merge |

The authoritative evidence is the pinned GitHub/Git/source/registry material in the
[reconciliation evidence index](NXR070_T3Code_V2_Architecture_Reconciliation.md#9-evidence-index).
Historical NXR-SEC-02B acceptance reports describe already completed baseline work; this task
does not re-run or expand those acceptance results.

## 3. NXR-070 implementation priorities

Keep the existing PR #40 sequence as a basis, with the context amendments below.

| Priority                  | Slice                                          | Purpose                                                                                                                         | Gate / limit                                                                                                  |
| ------------------------- | ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| First                     | 070A′ identity contracts                       | Central built-ins, immutable connection keys, collision-checked owner IDs, connection-qualified non-default catalog IDs         | Owner approves amended architecture; no persistence/auth/UI                                                   |
| Next                      | 070B′ API-key connections/lifecycle            | Per-connection encrypted credential references, catalog resolution, active-binding exclusions, tombstones and account assurance | OD-7/8/15; preserve defaults, one connection cannot change account                                            |
| Then                      | 070C′ review dimensions and 070D′ Codex homes  | Optional connection/provider diversity; independent native account homes                                                        | OD-5; no shared/shadow credential homes or automatic login                                                    |
| Later                     | 070F′ provenance and 070G′ opt-in intelligence | Connection-level facts, honest usage/quota and versioned explainability                                                         | No billing enforcement; unknown not unlimited; OD-11 default remains deferred                                 |
| Later                     | 070H′ Providers UI                             | Clear connection identity, lifecycle and assurance                                                                              | Domain/credential contracts already tested; renderer gains no authority                                       |
| Separate continuity slice | Amended 070I′                                  | Conservative canonical-history classification and integrity-checked session marks                                               | New context policy, preserved Project Memory, owner category/persistence decisions, current-baseline rollback |
| Unscheduled               | 070E′ concurrent plan accounts                 | Only if officially supported and isolated                                                                                       | E-1, then separate owner-initiated acceptance                                                                 |
| Final                     | 070J′ acceptance                               | Owner review of source-bound Windows/WSL and product evidence                                                                   | Release approval remains distinct from architecture approval                                                  |

Do not implement all rows as one change. Continuity can be designed in parallel after its decisions,
but must not delay the small identity proof by importing a new runtime or queue.

## 4. What should not be implemented

- A second primary harness, OpenWorker revival, wholesale T3 orchestration, or a T3 thread store.
- New Driver/Instance/RuntimeBinding/RuntimeEnvironment identities duplicating existing contracts.
- Native DSH session persistence/resume/fork or inherited permission grants.
- T3 delegation/background-agent/durable-queue/restart auto-resume machinery.
- Automatic provider/account switching, credential copying, shared Codex shadow homes or private API scraping.
- Concurrent ChatGPT-plan or Claude accounts before E-1/E-2 evidence and owner approval.
- Monetary budgets/billing enforcement, learned quality scores or a new default routing policy.
- DSH alpha installation, floating latest pins, plugins, remote helpers or broader tool/egress surfaces.
- T3 MCP execution integration, a network-exposed Nexar MCP server or a general HTTP relay into Cowork.
- An updater deployment, schedule, push/merge, or acceptance of ADR-029 merely because these documents exist.

Existing bounded Code-lane native work resources remain valid. They are not a license to start
another primary agent loop in Desktop direct fallback.

## 5. Owner decision checklist

This table preserves recorded decisions rather than treating recommendations as approvals.

| Decision group                        | Current authority                                                                | Decision still needed                                                                                                        |
| ------------------------------------- | -------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| Architecture adoption — OD-1          | ADR-029 package recommended/pending                                              | Approve an amended package against main 6ea56f9 and ADR-030; not PR #40 verbatim                                             |
| Optional ACP worker — OD-2            | Pending removal from NXR-070                                                     | Confirm deferral; preserve DSH managed ACP as the accepted transport                                                         |
| Multi-account order — OD-4a/b         | Confirmed: API keys, then independent Codex homes                                | No revision recommended; authorize concrete slices separately                                                                |
| Higher account tiers — OD-4c/d        | Further evidence required                                                        | E-1 official concurrent plan support; E-2 Claude home isolation/support; no evidence supplied here closes either             |
| Review diversity — OD-5               | Pending                                                                          | Resource default; optional connection/provider; required unavailable dimension fails; host attribution only                  |
| Costs — OD-6                          | Confirmed no new billing enforcement                                             | No revision recommended                                                                                                      |
| Lifecycle/account binding — OD-7/8/15 | Pending detailed approval                                                        | Immutable account per connection, refusal while active, same-account assurance, tombstone/new-ID Replace                     |
| Host naming — OD-9                    | Pending                                                                          | Freeze desktop/plane, no host federation                                                                                     |
| Canonical continuity — OD-3           | Direction confirmed; no native persistence                                       | Preserve direction; approve separate policy identifier for additional classification                                         |
| Overflow/optional data — OD-10/13     | Pending overflow detail; conservative direction confirmed, category list pending | Required/unclassified overflow fails; no capacity-driven omission or automatic independent turn                              |
| Sidecar — OD-14                       | Conditional acceptance, final approval pending                                   | Approve revised owner-store boundaries and current-reader/rollback compatibility, not the obsolete context@2 activation rule |
| New default policy — OD-11            | Deferred                                                                         | Keep deferred until later measured evidence                                                                                  |
| Live tests — OD-12                    | Owner-initiated per action                                                       | No standing permission inferred from architecture acceptance                                                                 |

NXR-070R adds these **proposed review decisions**, not new recorded owner approvals:

| Proposed decision               | Recommended choice                                                                                                            | Why                                                                                    |
| ------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| R-DEC-01 — Context version      | Use context@3, or another unused explicit version                                                                             | Accepted context@2 already has different semantics and legitimate sidecar-free history |
| R-DEC-02 — Memory ownership     | ProjectMemoryStore owns confirmed project facts; FileSessionStore alone writes canonical sessions and classification sidecars | Avoid duplicate fact stores, conflicting promotion authority and a second writer       |
| R-DEC-03 — Compatibility target | Roll back to accepted ADR-030/main baseline and retain historical v0.6 readers as additional fixtures                         | A rollback to context@1 must not disable required Project Memory                       |
| R-DEC-04 — Upstream scope       | Approve metadata/evaluation design first; schedule only after implementation and execution-location review                    | Discovery is not runtime authorization                                                 |
| R-DEC-05 — DSH candidate        | Hold current pin; optionally assign a separate exact alpha compatibility evaluation with security priority                    | Newer is not accepted; no combined NRC/runtime change                                  |
| R-DEC-06 — T3 connector         | Defer production integration; allow a later explicitly scoped read-only protocol study only for a concrete owner need         | Existing HTTP MCP/tool authority differs from Nexar's boundary                         |

Preserve the accepted Windows-first scope. A future release must name the owner-selected Windows
environment and mandatory WSL2 regressions; do not reinstate native Ubuntu as a blocker merely by
copying PR #40's old execution plan. Existing platform-decision records and any unresolved
machine-specific baseline detail should be cited explicitly when preparing that release.

## 6. First safe implementation milestone

### Suggested assignment

**Title:** NXR-070A′ — Connection Identity Compatibility Slice  
**Role/model:** Principal TypeScript engineer using the owner's chosen coding model; independent
reviewer before integration. This brief does not dispatch an agent.  
**Input baseline:** verified current main, these three documents, proposed ADR-029 and register at
PR #40 head, accepted ADR-027/028/030, existing identity and NRC tests.  
**Start condition:** owner approves the reconciled identity design and explicitly assigns this slice.

### Scope

1. Extend `packages/contracts/src/connection.ts` with the minimal connection definition/credential
   scope references and a pure connection key using the existing host and connection identifiers.
   Reuse `ProviderConnection` and `ProviderRuntimeIdentity`; no new parallel authority.
2. Centralize current built-in connection definitions and compare them with every current producer:
   native resource metadata, host inventories, plan identity and existing API catalog defaults.
3. Add pure owner-ID generation with injected randomness and mandatory collision checking against
   supplied live/built-in/tombstone identities. Persistence/serialized settings mutation is B′.
4. Add the non-default API catalog resource-ID function and offline two-connection fixtures.
   Existing built-in IDs and inventory hash algorithms remain unchanged.
5. If needed, add pure Desktop attribution for received plane DTO connections, preserving the
   negotiated wire format. Do not change plane protocol or treat host attribution as federation.

Expected production seams are `packages/contracts/src/connection.ts`,
`packages/resource-registry/src/materialize.ts`, `packages/host/src/native-inventories.ts`,
`apps/desktop/src/main/plan-inventory-identity.ts`, and the existing Desktop plane DTO seam.
Choose the smallest actual diff after re-reading main; these are not instructions to edit all
listed modules regardless of need.

**Explicit exclusions:** settings/tombstone storage, secret changes, credential rotation, login,
native home creation, paid generation, new resource publication, UI redesign, NRC scoring changes,
gateway/Bridge changes, context policy/sidecar implementation, DSH or helper upgrades.

### Exit criteria

| Check                           | Required result                                                                                                                                                         |
| ------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Built-in compatibility          | Golden fixtures keep every existing connection tuple, resource ID, plan alias/pin and relevant default descriptor byte-identical                                        |
| Non-default collision isolation | Two fake connections for one provider/model have different IDs; each remains stable across label, preference, observation-time and credential-generation changes        |
| Generator behavior              | Injected RNG collisions against live/built-in/tombstones retry or fail explicitly; no secret-derived identity; no accidental reuse                                      |
| Host identity                   | desktop and plane remain distinct attribution keys; no wire or cross-host routing change                                                                                |
| Contract consistency            | Current inventory identity and connection metadata remain coherent across producers; no provider types in domain contracts                                              |
| NRC/authority                   | Existing route, Control pin, bounded fallback, raw-capability, monotonic admission and review-lineage fixtures remain unchanged                                         |
| Runtime/security                | DSH pin, effective profiles, minimal child environments and WSL containment unchanged; no new execution path                                                            |
| Persistence                     | No new persisted data and no session/memory/credential rewrites; rollback is a code-only revert                                                                         |
| Validation                      | Repository pnpm check and applicable mandatory Windows/WSL acceptance gates recorded at stable source identity before integration; no paid tests or assertion weakening |
| Review handover                 | Focused diff, test evidence, identity fixtures, non-goals, source SHA and code-only rollback; no push/merge without owner assignment                                    |

This slice proves identity contracts. It does **not** claim working multi-account login,
connection lifecycle, credential isolation across real accounts or a completed Resource Fabric.

## 7. Relationship between NRC and upstream management

NRC decides which authorized connection/resource may execute a task. Upstream management reports
what software versions and architectural changes exist. Keep them separate:

- New upstream availability must not publish a resource, alter an account binding, change a route
  or enlarge a grant.
- Accepted upgrades preserve connection IDs, resource IDs, credential references, canonical
  sessions, Project Memory and owner decisions.
- Compatibility results can inform owner decisions and administrative readiness, not secretly
  change NRC policy.
- The updater can be implemented independently after its own approval; it is not a prerequisite
  for the small identity slice.
- DSH promotion requires the 19-gate procedure, paired Windows/Linux helper identities and explicit
  production approval. Metadata discovery alone runs no runtime tests or deployment.

## 8. Conclusions requested by the owner

1. **Adopt from T3 now:** scoped lifecycle/readiness patterns, connection-aware inventory,
   separation of implementation kind from connection identity, capability/provenance discipline
   and bounded metadata caching. Adapt these into Nexar's existing contracts.
2. **Defer:** durable agent queues, background agents, automatic reset/restart continuation,
   native resume/fork, cross-host orchestration, generic ACP workers and new policy defaults.
3. **External T3 integration:** not needed for NXR-070A′ and not recommended for production now.
   A later owner-authorized read-only MCP study may be useful; HTTP transport, project mapping,
   revocation and permission/delegation ceilings require independent approval and protocol tests.
4. **Upgrade DSH now:** no. Preserve 0.2.0-rc.2; alpha.5 is source-evaluated only. Treat the MCP
   security fix as a reason to prioritize an isolated evaluation, not skip compatibility gates.
5. **Manage future upgrades safely:** source-controlled policy manifest, local metadata/event
   ledger, daily metadata checks and weekly summaries after owner opt-in; exact identities,
   advisory triage, separate approvals, real compatibility gates and paired-artifact rollback.
6. **First implementation slice:** owner-approved 070A′ identity contracts and fake collision/
   compatibility fixtures, followed by API-key connection lifecycle after its detailed decisions.
7. **Remaining owner choices:** amended ADR-029/OD-1; OD-2/5/7/8/9/10/13/14/15 details; new context
   policy and memory/sidecar reconciliation; updater scope/schedule; separate candidate/external
   connector authorization. E-1/E-2 and OD-11 remain deferred, not silently resolved.

If development resumes tomorrow, first approve the ADR-030 reconciliation and then assign only
070A′: it removes the identity foundation risk without changing runtime, accounts or security
boundaries. Completion is proved by stable built-in identity/pin fixtures, distinct fake
connection IDs for the same provider/model, unchanged NRC/permission behavior, source-bound
required validation and an independently reviewed code-only diff. Do not start by upgrading DSH
or importing T3's orchestrator.
