# ADR-029 — Proposed Amendments (independent review)

Status of ADR-029 is unchanged: **Proposed**. These are reviewer proposals awaiting owner decision; none is applied to any branch.

## A. Header and relationship (required, F-01)

Replace the header block's last two bullets with:

> - Relationship: **Amends ADR-028** (§Domain and ownership: owner-configurable connections; §Rationale: lifts the multi-account deferral for API-key and Codex routes only) and **refines ADR-027** (§6 Control compatibility unchanged; §10 review diversity gains opt-in dimensions). ADR-027 and ADR-028 remain Accepted for everything not amended here.
> - Baseline: accepted v0.6 `9e71014` (merge `2f856f9`). Research base `4c69d1c` is historical.

Add after "Context and problem":

> **Vocabulary.** This ADR uses ADR-028 terms. _Connection_ (`ProviderConnection`, opaque `connectionId`) is what earlier drafts called a provider instance. _Route identity_ (`ProviderRuntimeIdentity`) is what earlier drafts called a runtime binding; the existing `RuntimeBinding` type in `contracts/src/resource.ts` keeps its current meaning. _Host_ (`machine`) is the environment: a separate Nexar composition with its own registry, NRC, telemetry and credentials.

## B. Accepted-baseline invariants (required, F-02)

Add a section "Invariants carried from v0.6":

> 1. Every capability/facet array member is validated before alias normalization; aliases resolve registered own properties only (834a865, 1feb97f).
> 2. Per-turn delegation admission uses the shared monotonic `DelegationUnitLimit`; no restart, fallback, grant remint, connection change or new policy resets or bypasses it (3cbd6a6).
> 3. Upstream protocol permission modes never grant Nexar authority; read-only grants deny write, shell, network and foreign MCP (4559857).
> 4. One-unit standalone grants exclude `reviewOf`; review lineage applies only to multi-unit grants within one grant (9e71014).
> 5. A native/provider session never outlives one Nexar turn unless a later ADR permits it; continuity is carried by canonical sessions and the context policy.
> 6. Default connections keep their v0.6 `connectionId`, so every existing resource id, pin, telemetry aggregate and session reference is unchanged.

## C. Domain graph replacement (material, F-03/F-04)

Replace the "Domain graph and lifecycle" table with:

| Concept           | Existing contract                          | Change                                                                                                                                                  | Persistence                                                |
| ----------------- | ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------- |
| Connection        | `ProviderConnection`, `ResourceConnection` | Add owner-configured `ConnectionDefinition {id, provider, method, label, enabled, credentialScope}`; defaults are built-in definitions with today's ids | Desktop settings `connections` (schemaVersion 1, additive) |
| Credential scope  | `CredentialRef`                            | Per-connection: keystore name (API), account blob name (plan), Nexar-created private home (native)                                                      | key store / private state                                  |
| Route identity    | `ProviderRuntimeIdentity`                  | Unchanged; for policy, key = `(machine, connectionId, runtimeId, routeId)`                                                                              | unchanged                                                  |
| Host              | `machine`                                  | Unchanged enum; each host allocates only its own resources                                                                                              | —                                                          |
| Inventory         | `ProviderModelInventory`                   | One inventory definition per (connection, route); additive capability-evidence fields                                                                   | existing cache                                             |
| Resource          | `ResourceDescriptor`                       | Non-default connections get connection-qualified ids from every source                                                                                  | —                                                          |
| Review dimensions | strategy `reviewDiversity`                 | Add opt-in `reviewDimensions`                                                                                                                           | strategy settings                                          |
| Context           | `context@1`                                | `context@2` typed fields, canonical session only                                                                                                        | session store                                              |

Delete rows: ProviderDriver, AccountIdentity (as verified fact), RuntimeDefinition, RuntimeEnvironment, RuntimeBinding (new), RuntimeSession, Resource@2, ResourceProfile, NRCDecision@2 (replace with additive explanation fields).

## D. Decision register D1–D18

| #   | Decision                               | Verdict                                       | Rationale / evidence                                                                                                                                          |
| --- | -------------------------------------- | --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D1  | Nexar owns resources/policy            | **Accept as proposed**                        | Matches v0.6 (gateway, NRC, key store).                                                                                                                       |
| D2  | First-class instance identity          | **Accept with amendments**                    | Use ADR-028 connections; opaque id; defaults keep legacy ids (O-1).                                                                                           |
| D3  | Driver composition / optional ports    | **Accept with amendments**                    | Keep existing ports (`ExecutionAdapter`, `InventorySource`, `ModelTurnPort`); no driver type, no new package in first units.                                  |
| D4  | Environment binding                    | **Accept with amendments**                    | Environment = host authority; no cross-host allocation (F-04); host-qualified connection key (F-05).                                                          |
| D5  | Resource IDs preserved via aliases     | **Accept with amendments**                    | Default-connection rule removes the alias manifest; keep `legacyId`/`migratePlanResourceId` precedent; qualify `pi.*` ids for non-default connections (F-11). |
| D6  | Inventory authority                    | **Accept as proposed**                        | Already ADR-028 behavior.                                                                                                                                     |
| D7  | ACP scope                              | **Defer**                                     | F-08.                                                                                                                                                         |
| D8  | Permissions                            | **Accept with amendments**                    | Add invariant B3.                                                                                                                                             |
| D9  | Session transitions / portable handoff | **Accept with amendments**                    | Portable handoff = `context@2`; native resume/fork deferred (F-07).                                                                                           |
| D10 | Control pinning                        | **Accept as proposed**                        | Matches `gateway.ts`.                                                                                                                                         |
| D11 | Telemetry authority                    | **Accept with amendments**                    | Per-field provenance on aggregates; no cash budget, no billing manager.                                                                                       |
| D12 | NRC ranking                            | **Accept with amendments**                    | v1 scoring retained in `resource-intelligence@2`; unknown quota strictly neutral (F-09).                                                                      |
| D13 | Review diversity                       | **Accept with amendments**                    | Dimensions resource/connection/provider/host; principal = owner assertion; invariant B4 (F-12, O-3).                                                          |
| D14 | MCP transport                          | **Accept as proposed** (reject HTTP/SSE here) | ADR-014/015; ACP v2 `session.mcp.http` does not change this.                                                                                                  |
| D15 | No third gateway                       | **Accept as proposed**                        | Bridge + `ExecutionAdapter` already cover agent-run. Remove "AgentExecutionPort".                                                                             |
| D16 | No secret/history reuse                | **Accept as proposed**                        | T16 pattern persists upstream; keep REJECT.                                                                                                                   |
| D17 | Patterns, not source                   | **Accept as proposed**                        | F-18 strengthens it.                                                                                                                                          |
| D18 | First vertical slice                   | **Accept with amendments**                    | Replace with 070A′ (connection identity contract), see Blueprint-Reviewed §3.                                                                                 |

### Replacement wording for material decisions

**D4 (Environment).**

> Each host (`machine`) is a separate authority with its own registry, NRC, telemetry and credentials. A host allocates only its own resources; another host's resources appear only as read-only projections. Connection keys used by policy, telemetry and lifecycle are `(machine, connectionId)`. Cross-host allocation, remote environments and shared credentials between hosts need a separate ADR.

**D5 (Resource identity).**

> Built-in default connections keep their v0.6 `connectionId`s, so their resource ids are unchanged and no alias manifest is needed. Owner-created connections get an opaque id `<provider>.<method>.<suffix>` (suffix: 8–12 lowercase base32, generated by main) and connection-qualified resource ids from every source, including the pi API catalog. Pins never move to another connection; a pin whose connection is removed fails with `pin.connection-removed`.

**D7 (ACP).**

> No ACP worker is part of NXR-070. A future ACP runtime is a new `ExecutionAdapter` built on an internal ACP client extracted from the DSH integration, with v1/v2 version negotiation, API-key env stripping and support class `experimental-client-compat`, under its own ADR.

**D9 (Sessions).**

> Native and provider sessions remain per-turn. Cross-model continuity is carried by canonical sessions and `context@2`: typed goals, constraints, decisions, artifact references, pending work and review requirements, bounded by the smaller of 24,000 characters and the target's known context capacity. Required items are never truncated silently; overflow rejects with an explanation. Native resume or fork needs a later ADR.

**D12 (Ranking).**

> `resource-intelligence@2` keeps v1 scoring and neutral-unknown semantics, and adds hard filters for disabled/removed connections, host, and required review dimensions, plus provenance-tagged facts and explanation fields. Known quota exhaustion rejects; known headroom never ranks above unknown. Cost stays informational; NXR-070 adds no monetary budget enforcement. `deterministic@1` and `resource-intelligence@1` are byte-for-byte unchanged.

**D13 (Review).**

> Strategy may require or prefer distinctness on `resource` (default, v1), `connection`, `provider` and `host`. Connection distinctness means different owner-declared connections; it is not verified account independence and is labelled so. Unknown never counts as distinct. Standalone one-unit grants carry no review lineage.

**D18 (First slice).**

> NXR-070A is the connection identity contract: built-in connection definitions equal to today's constants, host-qualified connection keys, connection-qualified ids for non-default connections from every resource source, golden id vectors, and unchanged NRC decisions. It has no UI, credential, login or execution change.

## E. Threat model and migration sections

- Remove threat rows that exist only because of deferred features (ACP frames, native resume across accounts); keep them in a "deferred threats" appendix.
- Migration phases: 0 reconcile → A identity contract → B API-key connections → C review dimensions → D Codex connections → (E plan account, conditional) → F provenance → G NRC@2 → H UI → I context@2 → J acceptance. Replace "Phase 6: remove compatibility" with "Built-in defaults are permanent; there is no compatibility retirement step".
