# Historical research and T3 version delta

Date: 2026-11-01. Fixed Nexar base `6bc038021b66b8d093bad5a4fbd936794f048da3`. All E/H/N references resolve through the [evidence index](NXR_T3Code_2026_11_Product_Evolution_Research.md#evidence-index).

“V1 to latest” in this filename means **Nexar's successive research baselines**, not T3's product architecture versions. The original October sources already contained Orchestrator V2 code. V0.1.0 was its first stable release. No finding below claims that Nexar's first study evaluated only T3 Orchestrator V1.

## Original decision register, reconciled forward

The original NXR-070 document was retrieved from Git object `b843d04a8e84b281b8031809dbbe71cf69a311db:docs/research/upstream/nxr-070-t3code-goose-comparative-study.md`. Its proposed unit names are historical; they are **not** today's D′/F′/H′ labels.

| ID | Historical capability and source | Original decision | Subsequent owner/ADR outcome | Accepted-main implementation state |
| --- | --- | --- | --- | --- |
| HB01 | Driver versus instance identity; H01, H02 T1–3 | ADOPT identity; ADAPT driver; defer UI | ADR-029 extends existing contracts, rejects parallel Driver/Instance domain | A′ merged; connection keys exist, N03 |
| HB02 | Scoped native homes; H02 T4–5 | ADAPT scoped binding | OD-4b/D′ independent CODEX_HOME; no sharing/copying | D′ active local work; absent as complete merged workflow |
| HB03 | Provider env overrides/keychain import; H02 T4/T16 | REJECT raw secrets and third-party keychain import | Trusted credential store and minimal env retained | B′/native env guards, N03/N11 |
| HB04 | Codex model and rate-limit probe; H01; H02 T11/T15 | ADAPT bounded official native discovery | ADR-028 native inventory separate from plan Responses | Inventory implemented; richer connection-attributed observations remain F′/G′ |
| HB05 | Claude versioned manifest/custom catalog; H01; H02 T12 | Metadata-only fallback; reject entitlement inference | Unknown facts stay absent | Inventory source distinctions exist, N05 |
| HB06 | Current model versus preference; H01; H02 T6/T13 | ADOPT distinction | NRC remains sole selection authority, safe turn boundaries | NRC and per-invocation options exist; H′ presentation incomplete |
| HB07 | Session transition classifier; H02 T7–8 | ADAPT safe changes | ADR-030 DSH-first; native persistence deferred | App-owned continuity exists; native reuse intentionally not imported |
| HB08 | Bounded handoff/omissions and delivery receipt; H02 T9–10 | ADAPT; reject lossless claims | context@2 retained; context@3 approved as new I′ policy | context@2 implemented; classifier/sidecar planned |
| HB09 | Generic ACP worker; H02 G5–8 | ADAPT optional delegated worker | OD-2 defers generic ACP; managed DSH ACP retained | DSH adapter exists; original generic-worker recommendation superseded/deferred |
| HB10 | Full-access/approval bypass; H02 G5–6 | REJECT | Permission Broker remains authoritative | Existing permission/grant boundaries, N07 |
| HB11 | Network MCP passthrough; H02 G8 | DEFER, do not reuse | Broad HTTP MCP/external connector remains separate decision | Existing bounded Work Bridge, not T3 endpoint |
| HB12 | Native fork assumption; H02 G10 | REJECT assumed support | OD-3 native resume/fork deferred | Canonical store survives turns; no native fork authorization |
| HB13 | Bare-prompt fallback after handoff error; H02 G8–9 | REJECT silent loss | I′ required/unclassified overflow fails closed | Do not relabel existing context@2 as context@3 |
| HB14 | Reported versus estimated usage/cache/cost; H02 T14/G11–13 | ADAPT per-field provenance | F′ accepted; cost informational, no billing enforcement | Measured<T> and execution telemetry exist; F′ complete envelope absent |
| HB15 | Identity/freshness/pinning; H02 N3–5/N11 | KEEP NEXAR | Built-in compatibility, immutable binding, tombstones | A′/B′ merged; tested synthetic baseline, live pending |
| HB16 | Registry/Strategy/NRC/Bridge; H02 N6–12 | KEEP NEXAR | ADR-029/030 confirm single authorities | Implemented, N06/N07 |
| HB17 | Learned routing and billing controls; H02 T15 | DEFER; no benchmark evidence | OD-6/11 no budget and no default change | Existing policies retained; G′ opt-in planned |
| HB18 | Durable queue, restart continuation, usage reset recovery; H03 T05/06 and older source | DEFER queue; REJECT automatic continuation for Nexar | No replay after restart | FileSessionStore marks interrupted; no execution restarted, N09 |
| HB19 | Provider updates and metadata cache; H03 T10/T12 | ADAPT metadata only | UI-01 retained offline; UI-02..04 deferred | No scheduler/auto-update authorization, N14 |

The invalidated historical assumptions are concrete: connection contracts are no longer missing (A′), multi-API credential resolution is no longer a proposal (B′), connection diversity is no longer only a future design (C′), and DSH has replaced the older dual-harness target. Conversely, interface existence never established live multi-account behavior or independent acceptance. H01/H02's provider-instance@1/runtime-binding@1 proposals were replaced by the accepted existing-domain extension; do not revive their names as implementation requirements. [N01–N13]

## Release-by-release review

Exact full SHAs and publication times are in the [identity table](NXR_T3Code_2026_11_Product_Evolution_Research.md#frozen-upstream-identities). Stable source and intermediate Git trees were inspected; release bullets alone are classified DOCUMENTED unless a source/patch is separately cited.

| Release | Significant delta reviewed | Classification and evidence limits | Nexar consequence |
| --- | --- | --- | --- |
| NXR-068 `8c61e254…` | Driver/instance distinction, model inventory, handoff, native homes and usage recovery already exist | EXISTED_IN_ORIGINAL_STUDY; H01 and historical source trees | Preserve historical credit; no “new multi-account architecture” claim |
| Original NXR-070 `3143335f…` | Source-backed instance/auth/capability/transition and usage comparison | EXISTED_IN_ORIGINAL_STUDY; H02 | Baseline recommendations require later owner reconciliation |
| v0.1.0 `81493efb…` | V2 stable: delegates, forks, provider switch, queues, restart continuation, reset recovery, MCP | EXISTED_IN_V010; E03/H03 | Most orchestration ideas predate latest stable |
| v0.1.1 `fe27e8e3…` | Home layout, recovery worker and MCP access blobs change; UI/mobile/provider refinements | SIGNIFICANTLY_IMPROVED at selected surfaces; behavior must be read per change | Do not flatten .1 and .0 into identical implementations |
| v0.1.2 `044f0725…` | Mermaid renderer switch, timing-test cleanup, mobile lifecycle/model control parity; large test deletion reported | NEW_SINCE_V010 / BUG_FIXED, release DOCUMENTED; selected home/handoff blobs equal .1 | A test filename count cannot prove improving coverage; no Nexar test deletion proposal |
| v0.1.3 `d2c44031…` | Second-account warning appears; home handling changes; parent/native child completion, managed token renewal fixes reported | NEW warning / BUG_FIXED; E08 source, release docs | Warn about account continuity; do not import T3 token renewal into Nexar |
| v0.1.4 `783581d4…` | Home/MCP/handoff blobs change; settled-run acknowledgement and Claude MCP timeout fixes | BUG_FIXED, selected source/PR evidence; not an independent runtime test | Check settlement once and cleanup ownership; retain existing native timeout boundaries |
| v0.1.5 `6d450a42…` | Electron security patch; guest-diff exposure correction; new-thread choice avoids recently limited provider; Antigravity controls | BUG_FIXED / SIGNIFICANTLY_IMPROVED; E17 source; other bullets DOCUMENTED | Security review justified; quota preference is not permission for automatic account rotation |
| v0.1.6 `2359643c…` | Side chats; project pin/archive; local commit review; flagged secrets; stop/shared-worktree/branch/redaction fixes; scoped reads/rendering | NEW_SINCE_V010 / EXPERIMENTAL / BUG_FIXED / SIGNIFICANTLY_IMPROVED; E04–E25 | H′ clarity, F′ attribution, I′ transparency; small reliability evidence work |
| Nightly .3991 `15fe2832…` | Antigravity UA quota repair; default OpenCode text generation; effort-presentation change | EXPERIMENTAL release channel / BUG_FIXED; E02 | Reject undocumented UA mimicry as quota source |
| Nightly .4004 `54c5f252…` | Model-picker position stability; expo-device-hub 0.19.1 | BUG_FIXED / EXPERIMENTAL; E02 | Borrow stable layout principle, not nightly code/dependencies |
| Main `575579d6…` | Follow-up picker fixes for long labels, effort and agent options; related model traits/tests | EXPERIMENTAL / BUG_FIXED; E02 | Long-label and keyboard tests in H′; no assumption this is in stable |

## Source fingerprint cross-check

These are **blob fingerprints**, not code-level semantic equivalence claims across different paths. `—` means absent at this exact path, not absent capability. Complete recursive tree responses reported `truncated=false`. Source hashes are abbreviated for readability; release SHAs remain exact in the identity table.

| Pin | CodexHomeLayout | UsageLimitRecoveryWorker | ContextHandoffService | McpToolAccess | SideChatPane | MultipleAccountsNote | secretProviderDefinitions |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 068 | 8efd0b5d99 | a7fe7c2902 | 226c2119d3 | — | — | — | — |
| 070 | 8efd0b5d99 | a7fe7c2902 | 226c2119d3 | 6e882629bb | — | — | — |
| .0 | 9d4410da98 | a7fe7c2902 | 137f617710 | 3332350196 | — | — | — |
| .1 | b0bb7df4e2 | b6ebedfec4 | 137f617710 | 5cc8dc0c38 | — | — | — |
| .2 | b0bb7df4e2 | b6ebedfec4 | 137f617710 | 5cc8dc0c38 | — | — | — |
| .3 | f175a0fdd0 | b6ebedfec4 | 137f617710 | 5ff44be5c0 | — | 2185351c77 | — |
| .4 | f6d2ba9d44 | b6ebedfec4 | 1a1767b4df | b82d9bb5ae | — | 2185351c77 | — |
| .5 | f6d2ba9d44 | b6ebedfec4 | 1a1767b4df | b82d9bb5ae | — | 2185351c77 | — |
| .6 | f6d2ba9d44 | e46ac34c8b | 67a474d963 | b82d9bb5ae | 1a5bd1141b | 2185351c77 | 409df40bf1 |

This independently catches two easy mistakes: usage-reset recovery is older than .0, and shadow/direct homes are older than .6. New side chats are confirmed by PR 26901 and `useSideChat` behavior, not merely a new filename. [E04, E20, E31]

Introducing commits for the genuinely new .6 capabilities were checked against official PR metadata: local commit review `5ef56853ef1854da50bc1909c6c0a32700f2cb13` merged 2026-10-30T08:00:34Z; side chats `50c1c5dc536493826fc66e220598f38b831d5bde` merged 2026-10-31T07:03:39Z; project pin/archive `ffaa1dba76d86c073533055e48d7f8f015c8a7b7` merged 2026-10-31T09:37:18Z; flagged secrets UI `7a4f5b6188fed54ddc866723e39446a198b5835c` merged 2026-10-29T17:15:28Z. The second-account warning `560ddb14d90eba7652da4f7846e4b18d4d802aa4` merged 2026-10-26T21:41:58Z, consistent with first presence in .3. V0.1.0's source-control guide was also inspected and did not describe local commit review. [E08, E15, E20, E21, E25]

## Significant capability evolution

| Capability | Original/.0 | Stable .6 behavior | Nightly/main | Classification | Decision |
| --- | --- | --- | --- | --- | --- |
| Multiple native Codex accounts | Original architecture; direct/overlay by .0 | Shared continuation key for overlay, private auth exclusions, conflict errors; independent direct homes supported | No selected change established | EXISTED_IN_ORIGINAL_STUDY; SIGNIFICANTLY_IMPROVED | Adapt warning/conflict tests; reject shared continuation |
| Claude accounts | Config-scoped instances described originally | Separate config directories documented; SDK account and get_usage initialization visible | No selected change established | EXISTED_IN_ORIGINAL_STUDY; support is provider-specific | Defer E-2; do not equate directory with proven OS credential isolation |
| Model/effort selection | Original | Instance+model controls and capability-driven options | Picker geometry/traits changes | EXISTED_IN_ORIGINAL_STUDY; SIGNIFICANTLY_IMPROVED | H′ per-resource options, preserve Auto |
| Account identity | Original model | Maskable email presentation; warning once provider already signed in | None established | SIGNIFICANTLY_IMPROVED | Nexar labels/assurance; do not expose subject/email automatically |
| Usage windows | Original native Codex limits | Timestamped windows, partial merge, retained good observations after probe error | Antigravity compatibility change | EXISTED_IN_ORIGINAL_STUDY; BUG_FIXED | F′ per-field provenance/freshness; no unsupported scraping |
| Delegate/parent graph | By .0 documented; older V2 source | Child result batching, parent status handling, background/native subagents | No selected delta | EXISTED_IN_V010; SIGNIFICANTLY_IMPROVED | Project Bridge lineage only |
| Side chats | Not established original/.0 | Fork latest stable point, pending-start guard, first turn approval-required, unused-child cleanup | None established | NEW_SINCE_V010 | Defer persistent branching until separate session design |
| Project pin/archive | No claim of original support | New project commands/store migration; organization and archived visibility | None established | NEW_SINCE_V010 | P2 organization proposal after core UI |
| Local commit review | Existing diffs ≠ local commit-review mode | Local commits in Diff pane, E25 | None established | NEW_SINCE_V010 | P2 optional engineering UX; preserve guarded commit path |
| Secret providers | No selected source at .0–.5 | 1Password driver registered; UI controlled by T3CODE_FEATURE_SECRETS | No selected delta | NEW_SINCE_V010; EXPERIMENTAL | Defer; existing trusted store authoritative |
| Stop/force stop | Stop existed | Timeout becomes explicit unresponsive condition; force-stop control and provider-session lifecycle | None established | BUG_FIXED | Existing Nexar abort settlement reused; targeted tests first |
| Shared worktree deletion | Worktrees existed | Path normalization catches Windows case/slash aliases and trailing separators | None established | BUG_FIXED | Adapt platform-aware ownership test only where applicable |
| Branch changes during commit | Git existed | Commit action now under checkout lease | None established | BUG_FIXED | Review Nexar guarded commit/harvest paths; no generic rewrite |
| Streaming rendering | Existing UI | Preserve completed Markdown blocks; full rendering fallback for document-wide syntax | None established | SIGNIFICANTLY_IMPROVED | Profile before porting optimization |
| Run preparation | Existing orchestration | Read selected runs/messages instead of full thread projection | None established | SIGNIFICANTLY_IMPROVED | Principle only; Nexar file-session architecture differs |
| Security | Existing auth/scopes | Credential query parameters redacted; Electron update; truncated previews readonly | None established | BUG_FIXED | Security maintenance + redaction tests; no HTTP MCP adoption |

## Removal, discrepancy and uncertainty register

1. The .6 changelog both adds and reverts a composer rich-text toggle/shortcut (PR 26777 / 27390). Mark that proposed toggle **DEPRECATED_OR_REMOVED within the release interval**, not a stable feature. No Nexar parity task.
2. V0.1.2 reports removing roughly 11k low-signal tests. That is DOCUMENTED test-suite churn, not evidence that product capabilities were removed or that current coverage is exhaustive.
3. `ProviderUsageLimitsIngestion.ts` at .6 exports `Layer.empty`. An old file name is not evidence of active ingestion. Current provider probes/usageLimits merge helpers and usage contracts are the supporting evidence. Integration-wide completeness remains UNVERIFIED. [E05, E10]
4. “Use 1Password” in release highlights omits the feature flag. Source establishes the experimental gate. [E15]
5. “Deleting a thread no longer removes a shared worktree” is stronger than PR 24489 alone proves: that patch fixes the **client's deletion offer** by normalized path comparison. It is not a general server-side containment proof. [E13]
6. Reported 15×/200× run-preparation and other release performance numbers are maintainer claims, not measurements made here. The verified change is narrower reads. No Nexar speedup is predicted. [E22]
7. Codex image display and Claude MCP confirmation corrections are release-documented; end-to-end media/approval behavior was not executed here. Claims of full provider parity remain UNVERIFIED.
8. Session search, pagination, compaction, context meters, skills and notifications are covered by official flows and selected UI surfaces; exact first introduction for every subfeature is UNVERIFIED. Their existence is not automatically classified as new.

No broad provider removal was established by the selected evidence. Absence of a reviewed removal is not proof that no provider behavior changed. Recommendations depend on the affirmative findings above, not that negative assertion.
