# NXR-070 architecture reconciliation handoff

**NXR070_READY_FOR_ARCHITECTURE_RECONCILIATION**. This handoff starts no
implementation, approves no ADR and changes no research branch.

## Frozen references

| Reference                                   | SHA / status                                                                                                                                         |
| ------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| Official v0.6 merged and validated baseline | `2f856f935a1ca51fc0f2c179386baa31bd82c3bd`, [CI 37955286149 attempt 1](https://github.com/mohmedhat797/Nexar-Ai/actions/runs/37955286149/attempts/1) |
| Final live-tested implementation            | `9e71014979db7a7619bb6ac909b8418a0d198573`, same source tree as merge                                                                                |
| Research branch                             | `research/nxr-070-resource-fabric`                                                                                                                   |
| Research publication                        | `b843d04a8e84b281b8031809dbbe71cf69a311db`                                                                                                           |
| Original research source base               | `4c69d1cd76c8182313f762a90dd7925c98dfa7bc`                                                                                                           |
| ADR-029                                     | Proposed; not adopted                                                                                                                                |
| Resource Fabric / NRC v2 implementation     | NOT STARTED                                                                                                                                          |

Read the frozen research deliverables before revising them:

- [T3 Code / Goose comparative study](https://github.com/mohmedhat797/Nexar-Ai/blob/b843d04a8e84b281b8031809dbbe71cf69a311db/docs/research/upstream/nxr-070-t3code-goose-comparative-study.md).
- [Proposed ADR-029](https://github.com/mohmedhat797/Nexar-Ai/blob/b843d04a8e84b281b8031809dbbe71cf69a311db/docs/adr/029-resource-fabric-provider-runtime-v2.md).
- [Implementation blueprint](https://github.com/mohmedhat797/Nexar-Ai/blob/b843d04a8e84b281b8031809dbbe71cf69a311db/docs/architecture/nxr-070-resource-fabric-implementation-blueprint.md).
- [NRC v2 / Resource Intelligence design](https://github.com/mohmedhat797/Nexar-Ai/blob/b843d04a8e84b281b8031809dbbe71cf69a311db/docs/architecture/nxr-070-nrc-v2-resource-intelligence.md).
- [Backlog 070](https://github.com/mohmedhat797/Nexar-Ai/blob/b843d04a8e84b281b8031809dbbe71cf69a311db/docs/backlog/070-resource-fabric-provider-runtime-v2.md).

## Baseline capabilities to retain

Retain contracts in `packages/contracts/src/{resource,connection,inventory,gateway}.ts`,
registry inventory/materialization, deterministic Strategy/NRC, pinned Control
Gateway and bounded worker Bridge. Reuse host composition/native inventory seams,
pi/account model turns, native Claude/Codex adapters, canonical sessions and
Operating context. Preserve Desktop encrypted key-store/auth lifecycle, validated
IPC, provider inventories and negotiated Plane transport. Current engines stay
OpenWorker Cowork and DSH/native Code; engines never own global provider policy.

## Research-to-accepted-baseline deltas

| Accepted delta after the research source base                 | Reconciliation requirement                                                                                 |
| ------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `1feb97f`: canonical delegation vocabulary and aliases        | Use actual supported capabilities, validate before normalization, preserve aliases                         |
| `2f26b36`: in-turn delegation polling/session continuity      | Preserve completed-result return and supervised parent lifecycle                                           |
| `f5925b9`: historical SOW/Code/integrated acceptance evidence | Replace frozen incomplete-status assumptions with correctly attributed evidence                            |
| `834a865`: malformed-array / inherited-key fixes              | All proposed capability projections reject raw malformed members; own-property mappings only               |
| `3cbd6a6`: shared trusted per-turn admission                  | Runtime/binding/session redesign must not reset unit counters through restart or another grant             |
| `4559857`: interactive delegation with read-only broker       | Protocol mode is distinct from Nexar permission authority; preserve write/shell/network/foreign-MCP denial |
| `9e71014`: strict standalone invocation schema                | One-unit contracts exclude review lineage; default multi-unit review integrity remains strict              |
| Final targeted live PASS and merge                            | Adopt this exact accepted baseline; do not treat old failed attempts as successes                          |

Exact seams to re-inspect include `apps/desktop/src/main/cowork.ts`,
`integrations/mcp/src/{bridge-relay,bridge-relay-main}.ts`,
`packages/engine-gateway/src/{bridge,endpoint,gateway}.ts`,
`packages/contracts/src/{capabilities,gateway}.ts`, their regression suites,
and the owner acceptance evidence. The existing permission and grant lifecycle
is an invariant for any later provider/runtime projection.

## Open architecture decisions and prerequisites

Review the proposed ProviderInstance / RuntimeBinding / RuntimeEnvironment
ownership, stable resource ID compatibility, account isolation and credential
references. Review NRC v2 facts/provenance/explainability independently of
authorization and orchestration. Preserve unknown quota/usage semantics and
measured versus estimated evidence; no arbitrary provider quality scores.
The owner did not require new budget/cost enforcement for v0.6; any proposed future
cost dimension requires a separate architecture/scope decision, not an acceptance
retrofit.

ACP is an optional AgentRuntime facet, not a provider-layer replacement or automatic
Control resource. Offline conformance/security spikes precede subscription testing;
Antigravity ACP remains unverified. Review multi-account lifecycle, migration aliases,
resume/fork semantics, bounded context handoff, capability negotiation and permission
translation. A second account must not silently reuse another account's credentials,
pins, native sessions or execution grants.

Plane DSH Control remains unconfigured, and historical native Code results cannot
be used as proof of that loop. Existing engine limitations remain clearly separated
from the proposed Resource Fabric design. Do not configure it during reconciliation.

## Recommended next exact task

In the isolated research worktree, first verify branch/head/cleanliness and preserve
existing work. Reconcile the frozen proposal against `2f856f935a1ca51fc0f2c179386baa31bd82c3bd` once,
using the delta table and current source/tests. Prepare an architecture-only amended
study, ADR decision register and blueprint with explicit compatibility/security
invariants and offline acceptance fixtures. Review any Git reconciliation/rebase
before publication; no such mutation was performed in this finalization task.

Submit the reconciled proposal for owner architecture approval. ADR-029 remains
Proposed until that decision. Only after approval should 070A begin: the blueprint's
minimal read-only compatibility projection, preserving IDs/pins/auth/execution and
proving second-instance collision isolation with fake resources. No Resource Fabric
code, ACP installation, live auth or allowance-consuming research test is authorized
by this handoff.
