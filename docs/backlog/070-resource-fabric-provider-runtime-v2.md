# NXR-070: Resource Fabric / Provider Runtime v2 and NRC Intelligence

Status: Architecture proposal ready for owner review. Implementation NOT STARTED; permission NOT GRANTED. ADR-029 remains Proposed. Research base: 4c69d1cd76c8182313f762a90dd7925c98dfa7bc, origin/feat/nexar-resource-orchestration, 2026-10-08. No authoritative v0.6 acceptance/project-state file is changed.

Nexar retains provider/resource policy, canonical sessions, Resource Strategy and NRC. OpenWorker remains Cowork; DSH remains Code. Evolve current contracts using T3 instance/lifecycle patterns and optional Goose-style ACP interoperability; do not embed or replace those products.

Primary specifications:

- [Evidence-backed comparative study](../research/upstream/nxr-070-t3code-goose-comparative-study.md)
- [Proposed ADR-029 and owner decision register](../adr/029-resource-fabric-provider-runtime-v2.md)
- [Implementation blueprint, exact seams, units and rollback](../architecture/nxr-070-resource-fabric-implementation-blueprint.md)
- [NRC v2, Resource Intelligence and offline evaluation](../architecture/nxr-070-nrc-v2-resource-intelligence.md)

First unit: 070A read-only compatibility projection from existing connection/runtime/inventory to instances/bindings/environment, retaining IDs/pins/execution and proving a second account with fixtures. Then B instances; C runtime/environments; D inventory/capabilities; E optional ACP worker; F observations; G profiles; H NRC v2; I settings; J handoff; K compatibility migration; L owner acceptance. Dependencies and each unit's scope/contracts/security/tests/rollback/DoD are defined only in the blueprint to avoid conflicting duplicates.

Architecture acceptance: four source-backed primary documents, pinned upstream commits/licenses, honest VERIFIED/INFERRED/UNVERIFIED labels, current implementation map, 30+ dimension comparison, dual recommendation/reuse labels, migration/security/decision register, independently testable first slice, NRC deterministic rules and future acceptance A–J. Documentation gates and full pnpm check pass before commit.

Future implementation acceptance: distinct account/runtime/environment ownership; authoritative fresh inventory; model-turn and agent-run resources; unchanged Control pinning; bounded Worker grants; policy-driven Auto and explainable rejection/fallback; verified required review independence; bounded portable handoff; no credential leaks or permission bypass; all applicable v0.6 regression fixtures and opt-in owner results. Unknown usage/quota/quality stays unknown. Full exact-head CI and matching changed Desktop/plane builds precede live provider/model work, merge and release.

Blocked from implementation pending owner architecture approval and independently accepted/reconciled v0.6. New live login, allowance-consuming calls and source reuse need their own scoped authorization/review. Non-goals: engine replacement, scheduler/memory/automation/mobile/cloud plane, learned routing, automatic billing, network MCP changes, acceptance/debugging work on the other operator's branch. Push research branch only; no merge or normal merge PR.
