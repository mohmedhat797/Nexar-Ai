# T3-informed feature prioritization

Date: 2026-11-01. Proposed decisions; no implementation authorization. [Evidence index](../research/upstream/NXR_T3Code_2026_11_Product_Evolution_Research.md#evidence-index), [capability register C01–42](../architecture/nxr-070/NXR070_T3Code_Latest_Architecture_Gap_Assessment.md#capability-gap-register), [work packages](NXR070_T3Code_Informed_Implementation_Roadmap.md#work-package-contract).

## Model and hard gates

Ratings 0–5 are explicit architectural/product judgements, not measured market demand. Score = sum(weight × rating / 5). Weights: user impact 20, strategic fit 15, problem frequency 10, feasibility 10, architecture compatibility 10, security safety 10, operational simplicity 5, dependency readiness 10, effort affordability 5, maintenance simplicity 5. Higher means better. Frequency ratings are inferred from recurrent workflow exposure, not collected user analytics. Effort is bounded separately in the roadmap.

Security/authority violations are hard gates, irrespective of score. A critical existing dependency finding can be P0 despite a modest weighted product score. Pending implementation acceptance is a dependency gate, not something a high score cancels. New scope requires a subsequent approved assignment. Confidence is independent of priority.

Vector order is the ten criteria above. The figures are reviewable decision aids, not false precision about engineering return.

| Candidate                                    | Vector              | Score /100 | Priority / disposition                                       | Dependency / target                             | Reason and evidence                                                                       |
| -------------------------------------------- | ------------------- | ---------- | ------------------------------------------------------------ | ----------------------------------------------- | ----------------------------------------------------------------------------------------- |
| W01 Complete current D′ acceptance           | 5,5,4,4,5,4,3,4,3,4 | 87         | P1 prerequisite; preserve current work                       | B′ → D′                                         | Accepted isolation unlocks user-facing multi-Codex; not a new implementation request, N02 |
| W02 Electron security correction             | 5,5,3,4,5,4,4,5,4,4 | 89         | **P0; IMPROVE_EXISTING**                                     | Proposed security maintenance → before H′       | Exact dependency gap and official patched runtime; exploitability unproven, E17–19/N13    |
| W03 Connection-first Providers UI v2         | 5,5,5,4,5,4,4,2,3,4 | 86         | **P1; IMPROVE_EXISTING**                                     | B′ + D′ accepted; H′                            | Makes merged B′ and D′ accessible; immediate owner-selected product sequence, N01/2/4     |
| W04 F′ attribution/per-field authority       | 4,5,5,4,5,4,4,5,3,4 | 88         | **P1; IMPROVE_EXISTING**                                     | A′ accepted; F′ independent                     | Connection-level audit gap in ExecutionRecord; G′ prerequisite, N10                       |
| W05 G′ evidence-aware intelligence           | 4,5,4,3,5,3,3,2,2,3 | 73         | P2; ADAPT_FOR_NEXAR                                          | C′ + F′; G′ opt-in                              | Useful after trustworthy data; no default/learned switch or quota ranking, N01/6          |
| W06 Context coverage and context@3           | 4,5,4,3,5,3,3,4,2,3 | 77         | P2; IMPROVE_EXISTING                                         | I′ separate track                               | Important continuity trust; sidecar integrity and legacy gates increase effort, N08/9     |
| W07 Delegation/review status projection      | 4,5,4,4,5,4,4,3,4,4 | 83         | P2; ADAPT_FOR_NEXAR, new bounded UI proposal                 | H′; C′; F′ for richer attribution               | Existing orchestration sufficient; explain waiting and actual review dimension, N06/7     |
| W08 Targeted lifecycle/path/redaction review | 4,5,3,4,5,4,5,5,4,5 | 87         | P1 evidence quick wins; corrections P0 only if defect proved | Existing boundary owner; separate small patches | Avoid duplicate stop implementation; source supports existing protections, E12–16/N07/11  |
| W09 Project pin/archive                      | 3,4,3,4,5,5,5,4,4,4 | 79         | P2; ADAPT_FOR_NEXAR, new proposal                            | After H′; own scope approval                    | Useful organization, weaker evidence than connection usability, E21                       |
| W10 Read-only local commit review            | 3,3,3,3,5,4,4,3,3,3 | 67         | P2; ADAPT_FOR_NEXAR, new proposal                            | After H′; own scope approval                    | Improves engineering review, less central to broader Personal AI layer, E25               |
| R04 Side chats/native branching              | 3,3,3,2,1,2,2,1,1,2 | 44         | P3; DEFER                                                    | Separate session/permission ADR                 | New canonical lineage/persistence is not cosmetic UI, E20/N09                             |
| R02 Secret-provider UI                       | 2,3,2,2,2,2,2,2,2,2 | 43         | P3; DEFER                                                    | Separate credential design                      | T3 experimental; current trusted store already solves core need, E15                      |

Scores are recomputed by documentation validation. Priority differs from score because prerequisites, security urgency, approved milestone boundaries and evidence confidence govern execution. For example W08 is cheap assurance, while H′ delivers a coherent user workflow; it does not follow that W08 should become a broad feature milestone.

## Priority decisions

**P0:** W02 is a bounded dependency-security maintenance proposal. Verify affected/patched runtime identities and exposure; choose a reviewed exact maintenance release and validate packaged Desktop behavior. No production fix was performed in this research. Do not label all T3 bug fixes Nexar defects.

**P1:** Finish active D′ on its own branch, accept its exact head, implement H′ after W02, and progress F′ independently if staffing/review capacity exists. W08 permits a small evidence review at the relevant boundary; existing tests can close an item without code changes.

**P2:** G′ after C′/F′, I′ as an independent track when persistence expertise/review is available, then selected W07/09/10 proposals. W07 is the strongest additional Nexar-specific proposal because it explains existing execution/review rather than adding another runtime.

**P3:** Hands-on stable UX validation, official native limit-interface feasibility, long-session profiling, branching/side chats and optional secret providers. These are not hidden dependencies that should hold H′ hostage.

**Rejected:** Full T3 runtime/orchestrator adoption; second NRC/session/memory/permission authority; shadow/shared native session homes; credential copying/import; automatic replay; broad HTTP MCP; cross-host routing; arbitrary plugins; auto provider install/update; quota from login; undocumented authenticated scraping/UA mimicry; learned routing/default switch. Concurrent Plan/Claude accounts remain deferred E-1/E-2 rather than implicitly approved. [N01/2/14, E02/04/15/27–31]

## Genuine quick wins and exclusions

| Quick win                                 | Evidence it is not wholly redundant                                                                                                                  | Smallest justified change                                                   | Gate                                                |
| ----------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- | --------------------------------------------------- |
| Clear row-level status and action wording | Current ConnectionManagement already warns that keys ≠ auth/reachability/quota; presentation is split across provider cards and connection list, N04 | Reuse that wording in H′ row/details; do not rebuild status domain          | TST-23 and fake-provider UI                         |
| Quota uncertainty wording                 | ResourcesView already says unknown ≠ unlimited, N04                                                                                                  | Preserve existing text and add source/checked-at only when real data exists | No synthetic zero/100% fields                       |
| Same-account explanation                  | Assurance labels and rotation assertion already exist, N03/4                                                                                         | Improve discoverability in H′; no extra account-verification workflow       | Different account refused; unknown not verified     |
| Stop/process regression                   | untilAborted already settles despite noncooperative work, N07                                                                                        | Inspect/extend only a missing quit/spawn/lease race test                    | No new scheduler or unrestricted force-kill         |
| Redaction sentinel                        | Existing redactor exists; T3 found query-param trace leaks, E16/N10                                                                                  | Cover actual URL/error/native stderr sink gaps if present                   | No prompts/subjects/credentials in captured outputs |
| Context transparency                      | Existing manifest exists, new classification does not, N08                                                                                           | Render current coverage facts accurately before I′ semantics                | No context@2 reinterpretation                       |
| Worktree alias ownership                  | Maintenance policy already protects unknown files; T3 Windows alias issue is concrete, E13                                                           | Check existing normalizer/test coverage before adding anything              | No cleanup or retirement in this assignment         |

Do not add a “quick win” feature flag for every UI component, a duplicate quota store, a new remote daemon, a generic provider configuration editor or automatic cleanup. The maintenance burden outweighs the evidence for immediate value.
