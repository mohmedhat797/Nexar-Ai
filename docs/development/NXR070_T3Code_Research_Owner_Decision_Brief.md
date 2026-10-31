# Owner decision brief — T3 Code research

Date: 2026-11-01, Africa/Cairo. Research only; no implementation or merge performed. Accepted Nexar baseline: `6bc038021b66b8d093bad5a4fbd936794f048da3`.

## What we learned

T3 stable is v0.1.6 at `2359643cffa6ba9ee84d6f2694b935de54a8013e`. Latest observed published nightly is v0.1.7-nightly.20261031.4004 at `54c5f25249961a1aa0b61932329092eadbd9d6fc`; observed main is `575579d68ac4bae09f8426a345d4a3eac1e90c67`.

Multi-account architecture, model inventory, context handoff and usage-reset recovery were already in the old research. Delegation/fork/queue/restart behavior was already in v0.1.0. New value includes side chats, project pin/archive, local commit review and experimental secret-provider UI, plus substantial lifecycle, rendering and security corrections. These are not all appropriate for Nexar. [Verified identities, evidence and limitations](../research/upstream/NXR_T3Code_2026_11_Product_Evolution_Research.md).

One practical security finding changes the immediate recommendation: Nexar's Electron 44.5.1 embeds Node 24.21.0, while T3 moved to Electron 44.10.0 with patched Node 24.22.1. A bounded exact-pin maintenance review/correction should precede further Desktop feature work. Actual Nexar exploitability has not been proven. [Official Electron release](https://releases.electronjs.org/release/v44.10.0), [Node advisory](https://nodejs.org/en/blog/vulnerability/october-2026-security-releases).

## What to adopt and improve

1. Make Providers connection-first, with account labels, lifecycle actions, model options and separate status facts. Authentication, health, quota, entitlement and eligibility must remain distinct.
2. Attribute executions to immutable connections and expose per-field source/freshness. Keep quota uncertainty visible and API-equivalent cost separate from actual bills.
3. Explain existing NRC choices and review independence. T3's coding UI does not supply this Nexar-specific product opportunity.
4. Explain context transfer coverage and omissions; implement context@3 only in approved I′, with FileSessionStore-owned sidecars.
5. Use targeted process/path/redaction regressions before considering product changes. Existing Nexar abort handling already addresses part of T3's stop failure mode.

## What is already built

A′ identity, B′ multi-API-key connections and C′ review diversity are merged. Native/model inventory separation, NRC routing/explanations, Measured telemetry, canonical interruption without replay, context@2 and confirmed Project Memory already exist. Rebuilding them would waste effort. Automated acceptance is synthetic and historical; independent and real-account acceptance remains pending.

D′ is active local development, not accepted main. Its worktree advanced during research and contained uncommitted home-isolation work at first inspection. No part of that checkout was edited. Its approved independent-home design stays intact. [Detailed capability states](../architecture/nxr-070/NXR070_T3Code_Latest_Architecture_Gap_Assessment.md).

## What to avoid

Do not adopt T3 as runtime/orchestrator, shared-session shadow homes, copied native credentials, another NRC/session/memory/permission authority, automatic replay or quota-reset resume, broad HTTP MCP, cross-host federation, automatic provider updates or arbitrary provider plugins. Do not use undocumented quota scraping/User-Agent mimicry. Concurrent Plan accounts and multiple Claude subscriptions remain E-1/E-2 research gates.

DSH stays pinned at 0.2.1-rc.5. Canonical sessions, Project Memory, permission grants and WSL/Coding isolation remain authoritative. No accepted ADR is changed.

## What to build next and why

**Next assignment: proposed NXR-T3-SEC01 / W02, the bounded Electron security maintenance slice, after current D′ or independently from accepted main if a separate engineer is authorized. Next product milestone: H′ Providers UI v2 immediately after its B′/D′ prerequisites and security disposition.** H′ makes the already-built connection foundation usable and follows the owner's bridge-only D′ decision. F′ can run concurrently from A′ if separate implementation/review capacity exists.

Suggested execution:

`D′ acceptance → security maintenance → H′ → integration review → G′ after F′/C′; I′ independently → J′ owner acceptance`.

F′'s parallelism does not require a new architecture decision. Do not start a giant branch containing this entire roadmap. W07 progress/review UI, W09 project organization and W10 read-only commit review are additional proposals, not silent additions to H′ or J′.

## Engineering cost and remaining decisions

Planning ranges for one familiar engineer: security 1–3 days, H′ 5–9, F′ 3–6, G′ 4–8, I′ 8–15. Review, packaging queues, owner/provider checks and unresolved platform issues add time. D′ remaining effort cannot be estimated without its eventual exact-head review. These are assumptions for work sizing, not delivery dates.

Only immediate new approval: **authorize the bounded security-maintenance assignment**, followed by a separate H′ implementation assignment under existing accepted scope. No need to re-decide independent Codex homes, NRC authority, context@3 identity, F′ prerequisites or E-1/E-2 exclusions. Optional W07/09/10 scope can be decided later. Signing/clean installation and installed Plane deployment remain existing release/owner gates; this research does not authorize deployment or real account actions.

## Review package

| Document                                                                                         | Purpose                                                                  |
| ------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------ |
| [Executive report](../research/upstream/NXR_T3Code_2026_11_Product_Evolution_Research.md)        | Frozen versions, conclusions and evidence index                          |
| [Historical/version matrix](../research/upstream/NXR_T3Code_V1_to_Latest_Delta_Matrix.md)        | Original recommendations versus later decisions; .0–.6/nightly delta     |
| [Usability benchmark](../research/upstream/NXR_T3Code_Usability_Benchmark.md)                    | Fifteen journeys; source/documentation-based ratings and hands-on limits |
| [Architecture gaps](../architecture/nxr-070/NXR070_T3Code_Latest_Architecture_Gap_Assessment.md) | 42 capability rows, D′ review, observation governance, security gates    |
| [Priorities](NXR070_T3Code_Feature_Prioritization.md)                                            | Weighted model, hard gates and quick wins                                |
| [Roadmap](NXR070_T3Code_Informed_Implementation_Roadmap.md)                                      | Eleven work packages, dependencies, tests, rollback and estimates        |
| [Next blueprint](NXR070_Next_Milestone_Implementation_Blueprint_Proposed.md)                     | Security slice A–Q and detailed H′ follow-on contracts/journeys/tests    |

Publication branch: `research/nxr-t3code-v016-product-evolution`, based on accepted main. Documentation-only draft PR; exact commit/head is supplied in the publication handover. No automatic merge or product implementation.

## Verdicts

- Historical: `T3_HISTORICAL_RESEARCH_RECONCILED`
- Upstream: `T3_LATEST_SOURCE_RESEARCH_COMPLETED` (selected capability-family source review; not exhaustive audit)
- Usability: `T3_USABILITY_ASSESSMENT_PARTIAL` (no direct stable runtime interaction)
- Gaps: `NEXAR_T3_CAPABILITY_GAPS_MAPPED`
- Architecture: `NEXAR_T3_ARCHITECTURE_RECOMMENDATIONS_READY`
- Roadmap: `NEXAR_T3_INFORMED_ROADMAP_READY`
- Blueprint: `NEXAR_NEXT_MILESTONE_BLUEPRINT_READY`
- Overall: `NEXAR_T3_RESEARCH_COMPLETE_WITH_LIMITATIONS`
