# NXR-070 — Critical Findings Register

Independent audit of research commit `b843d04` against accepted v0.6 (`9e71014` / merge `2f856f9`, docs `677eefd`).
All corrections are PROPOSED and await owner approval. ADR-029 remains **Proposed**; implementation **NOT STARTED**.

Severity counts: **BLOCKER 2 · HIGH 7 · MEDIUM 9 · LOW 3 · OPPORTUNITY 3**.

| ID   | Sev     | Component                  | One-line summary                                                                                             |
| ---- | ------- | -------------------------- | ------------------------------------------------------------------------------------------------------------ |
| F-01 | BLOCKER | ADR governance             | ADR-029 ignores Accepted ADR-028/027 and redefines their decided concepts                                    |
| F-02 | BLOCKER | Baseline                   | Proposal not reconciled with accepted v0.6 deltas; status claims superseded                                  |
| F-03 | HIGH    | Domain model               | Instance/Binding/Environment/Driver duplicate existing contracts; `RuntimeBinding` name collision            |
| F-04 | HIGH    | Environment / NRC          | Assumes one cross-environment Registry/NRC; v0.6 is two independent hosts                                    |
| F-05 | HIGH    | Identity                   | Plane and Desktop report the same connection id for different principals                                     |
| F-06 | HIGH    | Multi-account              | Native isolation mechanism not identified; existing `codexHome` path is inconsistent with inventory identity |
| F-07 | HIGH    | Sessions/handoff           | 070J adds native resume (new cross-account risk) that v0.6 structurally avoids                               |
| F-08 | HIGH    | ACP (070E)                 | No requirement; duplicates ExecutionAdapter + DSH ACP client; third-party adapter; ACP v2 drift              |
| F-09 | HIGH    | NRC v2                     | Ranking redesign introduces bias/starvation; cash-budget dimension conflicts with owner scope                |
| F-10 | MEDIUM  | Acceptance                 | DSH Control unconfigured not accounted for in Control/Code scenarios                                         |
| F-11 | MEDIUM  | 070A                       | First slice proves existing properties, misses the real collision (`pi.<provider>.<model>`)                  |
| F-12 | MEDIUM  | Review independence        | "Verified principal" is unobtainable under Nexar's own rules                                                 |
| F-13 | MEDIUM  | Blueprint DAG              | Incorrect dependencies and late migration                                                                    |
| F-14 | MEDIUM  | Versioning/scope           | Eight new contract tags and a new retry architecture before need                                             |
| F-15 | MEDIUM  | Desktop IPC                | Fixed enums → open ids is a security-sensitive change not called out                                         |
| F-16 | MEDIUM  | Acceptance criteria        | Several DoD items not objectively testable                                                                   |
| F-17 | MEDIUM  | ChatGPT plan multi-account | Second account under one `ext_agent_host_id` unverified                                                      |
| F-21 | MEDIUM  | Context (Code lane)        | Code goal over 20,000 chars silently falls back to the turn text only (added at reconciliation)              |
| F-18 | LOW     | Research                   | T3 upstream moved 4/18 cited files within 2 days of pin                                                      |
| F-19 | LOW     | Research                   | Codex ACP candidate classification (official vs third-party) imprecise                                       |
| F-20 | LOW     | Hygiene (out of scope)     | Corrupted comment in `desktop-key-store.ts:30–31`                                                            |
| O-1  | OPP     | Migration                  | Default connection keeps legacy `connectionId` → zero-alias migration                                        |
| O-2  | OPP     | Multi-account              | First real second account = API-key connection (isolation by construction)                                   |
| O-3  | OPP     | Review                     | Connection/provider review diversity from existing metadata, opt-in                                          |

---

### F-01 — ADR-029 does not reconcile with Accepted ADR-028 / ADR-027 · **BLOCKER** · confidence HIGH

- **Original assumption:** ADR-029 can introduce ProviderDriver/Instance/RuntimeBinding/Environment as a fresh domain graph.
- **Evidence (VERIFIED):** `git show b843d04:<each of 4 primary docs> | grep -c 'ADR-028\|ADR-027'` → 0 references in every document. ADR-028 (Accepted, 2026-10-06) already decides: "Provider → connection → runtime/session → model inventory → resources. Extend existing `ProviderConnection` … do not introduce a second router or a giant driver interface … One provider can have multiple opaque Nexar connection ids and multiple runtime/route ids per connection." It also defers "multi-account UI, broad protocol capabilities, ACP execution migration". Repository rule (CLAUDE.md): change an architectural decision only via a new/amended ADR.
- **Problem:** Approving ADR-029 as written leaves two Accepted ADRs with different vocabularies for one concept (connection vs instance), and silently reverses ADR-028's deferrals.
- **Impact:** Parallel abstractions in code; reviewers cannot tell which ADR governs; drift between Desktop and plane implementations.
- **Correction:** ADR-029 header: "Amends ADR-028 (§Domain and ownership, §Rationale deferrals) and refines ADR-027 (§6, §10)". Add a mapping table (see Reconciliation §2) and adopt ADR-028 vocabulary: **connection** (= proposed instance), **route identity** (= proposed binding), **machine/host** (= environment). Exact wording in `ADR029_Proposed_Amendments.md` §A.
- **Alternatives considered:** Supersede ADR-028 entirely (rejected: ADR-028 is implemented and correct); keep both vocabularies with a glossary (rejected: invites duplicate types).
- **Files/contracts:** `docs/adr/029-*.md`, `docs/adr/028-*.md` (amendment note), all four NXR-070 docs.
- **Required test:** Docs check: every NXR-070 doc term resolves to a contract symbol or is marked PROPOSED-NEW with justification.
- **Priority:** Before approval.

### F-02 — Proposal not reconciled with accepted v0.6 · **BLOCKER** · confidence HIGH

- **Assumption:** Research base `4c69d1c` is close enough to accepted v0.6.
- **Evidence (VERIFIED):** `git diff --stat 4c69d1c 9e71014` = 26 files, +2149/−212, including `bridge.ts`, `endpoint.ts`, `capabilities.ts`, `cowork.ts`, relay schema. Comparative study line 23 still says "Frozen records show incomplete NXR-066b acceptance" (**INCORRECT now**: accepted at `9e71014`). The handoff (`NXR-070_Architecture_Reconciliation_Handoff.md`) requires reconciliation before owner approval.
- **Problem:** Invariants from 3cbd6a6 (shared monotonic per-turn unit counter), 4559857 (mode ≠ authority), 9e71014 (no `reviewOf` in standalone one-unit schema), 834a865 (member validation before alias) are absent from D8/D13/070H/070J.
- **Impact:** A unit implemented from the current blueprint could reset unit counters on restart/new connection or reintroduce `reviewOf` into one-unit grants — regressions of accepted security fixes.
- **Correction:** Add "Accepted-baseline invariants" section to ADR-029 (text in Amendments §B) and to every unit's Security row; correct status statements.
- **Required test:** Each implementing unit re-runs the v0.6 regression suites for `engine-gateway`, `mcp` relay and `cowork` unchanged; add a test that a new connection/restart does not reset `DelegationUnitLimit`.
- **Priority:** Before approval.

### F-03 — Over-abstracted entity model; `RuntimeBinding` name collision · **HIGH** · confidence HIGH

- **Assumption:** Twelve entities (Driver, Instance, AccountIdentity, RuntimeDefinition, RuntimeEnvironment, RuntimeBinding, RuntimeSession, Inventory@2, Resource@2, Observation, Profile, Handoff) are needed.
- **Evidence (VERIFIED):** `ProviderRuntimeIdentity{provider, connectionId, runtimeId, routeId, machine}` (`contracts/src/inventory.ts`) already is instance+runtime+route+environment; `inventoryResourceId` hashes it. `RuntimeBinding` already exists in `contracts/src/resource.ts` with a different meaning (`adapter, locality, options`); the comparative study's N2 even cites it. ADR-029 §"Driver versus host" itself says "first-slice value does not depend on introducing a new package".
- **Problem:** Most entities are renamings (redundant), two are runtime state that v0.6 deliberately does not keep (RuntimeSession), and one name collides with a live contract.
- **Impact:** Duplicate types and mapping layers; confusing `RuntimeBinding` in imports; larger migration surface.
- **Correction:** Ownership matrix in Blueprint-Reviewed §2. Keep: `ProviderConnection` (extended with owner-configured `ConnectionDefinition`), `ProviderRuntimeIdentity`, `ProviderModelInventory`, `ResourceDescriptor`. Add only: `ConnectionDefinition` (configuration), `ConnectionCredentialScope` (configuration), `ReviewDimensions` (policy). Rename any future tuple type to avoid `RuntimeBinding`.
- **Alternatives:** Adopt T3's driver/instance types verbatim (rejected: Effect-schema-specific, upstream churn F-18).
- **Required test:** `boundaries` check that no new package is introduced in 070A–C; type test that `RuntimeBinding` keeps its current meaning.
- **Priority:** Before implementation.

### F-04 — One Registry/NRC across environments is assumed; v0.6 has two hosts · **HIGH** · confidence HIGH

- **Assumption:** ADR-029 diagram feeds desktop and plane bindings into one Registry → NRC v2; NRC v2 doc: "if a plane agent satisfies coding … and a desktop model satisfies report drafting, NRC can select each for its unit".
- **Evidence (VERIFIED):** Desktop and plane each `compose()` their own registry/controller (`core/src/create-nexar.ts:76`); plane resources reach Desktop only as `readiness.resources` DTOs (`code-plane.ts:433–435`, `behavior.ts:106`) for display/pin candidates; Code routing happens on the plane; plane credentials are plane-local by design.
- **Problem:** Cross-host allocation would require federation of decisions, grants and credentials across the plane boundary — none exists and the security model forbids host credential transfer.
- **Impact:** Units built on a unified-registry assumption either fail or quietly add a cross-host execution path.
- **Correction:** Define environment = **host authority**. Each host's NRC allocates only its own resources; Desktop holds a read-only projection of plane facts. Cross-host allocation is DEFERRED to a future ADR (Amendments §D4).
- **Required test:** Desktop NRC never returns a plane resource id from `allocate`; plane DTOs carry no executable binding.
- **Priority:** Before approval.

### F-05 — Plane/Desktop connection-id collision · **HIGH** · confidence HIGH

- **Evidence (VERIFIED):** `connectionOf` maps agent `claude-code` → `anthropic.subscription` regardless of host (`connection.ts` NATIVE); `planeResourceSchema.connection` has no `machine` (`plane-protocol/src/schemas.ts:132–148`); plane readiness builds it via `connectionOf` (`apps/cli/src/plane-readiness.ts:180`). Plane's Claude login is a different principal from Desktop's.
- **Problem:** Equal connection ids for different accounts.
- **Impact:** Today display only; becomes a correctness/security defect as soon as connection-level review diversity (D13), per-connection telemetry or disable/remove is introduced (a "disable Desktop Anthropic" could match plane rows; diversity could treat two accounts as one or vice versa).
- **Correction:** Connection identity used for policy = `(machine, connectionId)`. Desktop qualifies plane DTO connections on receipt (no plane wire change needed in 070A′); new plane-side definitions use host-qualified ids.
- **Required test:** Fixture with Desktop and plane Claude: distinct qualified connection keys; disable on one does not affect the other.
- **Priority:** 070A′.

### F-06 — Native multi-account mechanism unidentified; `codexHome` inconsistency · **HIGH** · confidence HIGH (Codex) / MEDIUM (Claude)

- **Evidence:** T3 isolates native accounts by per-instance `CODEX_HOME` / `CLAUDE_CONFIG_DIR` (VERIFIED `ProviderInstanceEnvironment.ts` at pin; `CodexAdapterV2.ts:1524`). `CODEX_HOME` is officially documented ("root for config, auth, logs, sessions"; must pre-exist) — VERIFIED via developers.openai.com/codex/environment-variables. `CLAUDE_CONFIG_DIR` official documentation status is **UNVERIFIED**; community reports disagree on scope. Nexar Codex adapter already accepts per-resource `runtime.options.codexHome` (`integrations/codex/src/settings.ts`), but `codexDefaultInventorySource` and the fixed identity `openai.subscription` ignore it (`host/src/native-inventories.ts`); Claude adapter inherits parent env (`claude-code/src/env.ts`).
- **Problem:** The blueprint leaves native multi-account as an abstract "isolation spike" without naming the only official mechanism; meanwhile a latent inconsistency lets a configured resource execute under home B while being attributed to the default connection's inventory/identity.
- **Impact:** Account confusion in attribution and diversity; wrong-account execution if pins are reused.
- **Correction:** `ConnectionCredentialScope` for native routes = Nexar-created private home directory per connection; invariant: a resource's effective home is its connection's home (adapter rejects mismatches); inventory source per connection; login only via official CLI login in that home, owner-initiated. Claude remains **unsupported for multi-account** until a spike proves isolation on Windows and plane. Do not adopt current T3's Codex `shadowHomePath`, which separates `auth.json` but shares the rest of the state. It depends on the runtime's private credential-file layout and shares sessions across accounts.
- **Required test:** Fake Codex runtime records `CODEX_HOME`; two connections → two homes; resource with mismatched home → `CONFIGURATION_ERROR`; inventory identities differ.
- **Priority:** 070D′ (after 070B′).

### F-07 — 070J introduces native session resume that v0.6 structurally avoids · **HIGH** · confidence HIGH

- **Evidence (VERIFIED):** OpenWorker session id = `turnId` (`cowork.ts:596–601`, "A restart is a whole new upstream session"); `ExecutionAdapter.execute` is stateless; `context@1` is rebuilt from canonical history every turn (`operating/src/context.ts`).
- **Problem:** v0.6 already achieves cross-model continuity portably; scenarios "session resumes under wrong account", "native state shared" cannot occur. 070J's session-binding store and resume/fork reopen that risk class for unclear benefit; the delivery-receipt machinery is only needed for asynchronous injection into live native sessions.
- **Correction:** Replace 070J with `context@2` (typed goals/constraints/decisions/artifact refs/pending work/review requirements) inside canonical sessions; required items never silently truncated (reject + explain). Defer native resume/fork to a future ADR with an evidenced requirement (Amendments §D9).
- **Required test:** Golden test: provider switch between turns produces same `context@2` manifest hash for same canonical history; overflow of required items rejects.
- **Priority:** Before approval (scope).

### F-08 — 070E optional ACP worker lacks a requirement and duplicates existing paths · **HIGH** · confidence HIGH

- **Evidence:** VERIFIED `ExecutionAdapter` is the agent-run port; Bridge executes any adapter (`host/src/bridge-ports.ts`); live acceptance ran a delegated native Claude Code unit. VERIFIED Nexar already has an ACP v1 client + `PermissionBroker` (`deepseek-harness/src/acp/run.ts:35`, `permissions.ts:53`). VERIFIED (web) `codex-acp` is a Zed/ACP-community adapter (Apache-2.0 per package indexes), reportedly moving to `@agentclientprotocol/codex-acp` on the Codex App Server, and honors `CODEX_API_KEY`/`OPENAI_API_KEY` — whereas Nexar's Codex env deliberately strips those to prevent billing switches, and Nexar's Codex inventory deliberately avoids app-server. VERIFIED ACP docs now publish protocol v2 with restructured capabilities (`session` baseline incl. resume/close; `session.mcp.{stdio,http}`); DSH client hard-requires `protocolVersion === 1`.
- **Problem:** 070E adds a large (L/high) unit, a new subprocess/trust boundary and a dependency on a moving third-party adapter without a capability Nexar lacks.
- **Correction:** DEFER out of NXR-070. If revived: extract DSH ACP client into an internal shared module, negotiate v1/v2, strip API-key env, classify as `experimental-client-compat`.
- **Required test (if revived):** ACP version matrix (1, 2, unknown), env allowlist test, permission broker reuse.
- **Priority:** Scope decision before approval.

### F-09 — NRC v2 ranking redesign: bias, starvation, budget scope · **HIGH** · confidence MEDIUM

- **Evidence:** v1 (`intelligence-policy.ts`) uses weighted factors with neutral 0.5 for unknown and owner preference first; Desktop default policy is `resource-intelligence` (`config-store.ts:19`). NRC v2 doc proposes lexicographic order with "4. Known applicable quota/cost preference" above measured success, stage 6 "known cost budget", metric "No execution attempt escapes grant/retry/cash/allowance limits". Owner directive (handoff + baseline doc): no new budget/cost enforcement.
- **Problem:** (a) "known quota preference" ranks vendors that report quota above those that do not — unknown is no longer neutral; (b) strict lexicographic owner tiers stop non-preferred resources from ever accumulating history (starvation, cold-start lock-in); (c) cash budgets re-enter scope.
- **Correction:** `resource-intelligence@2` = v1 scoring unchanged + new hard filters (connection disabled/removed, host, review dimensions) + provenance-tagged facts + explanation. Quota stays as v1 (known exhaustion = hard; headroom never rewards "known" over "unknown"). Remove cash budget from mandatory scope (Amendments §D11/D12).
- **Required test:** Seeded permutation test: swapping "quota unknown" ↔ "quota known with headroom" for otherwise equal candidates does not change rank; v1 golden corpus unchanged when v2 not selected.
- **Priority:** Before 070G′.

### F-10 — DSH Control unconfigured not reflected · **MEDIUM** · confidence HIGH

- **Evidence:** Baseline doc: "validation Plane's DSH Control loop remains unconfigured"; Code lanes ran `executor: native`.
- **Impact:** Acceptance rows C/D/F involving Code Control cannot pass live; native success is not Control evidence.
- **Correction:** Acceptance plan scopes Control scenarios to Cowork; Code Control acceptance requires a separate owner-approved DSH configuration task (not NXR-070).
- **Required test:** Acceptance evidence schema field `controlEngine` must be `openworker` for any Control row.

### F-11 — 070A proves existing properties and misses the real collision · **MEDIUM** · confidence HIGH

- **Evidence (VERIFIED):** Inventory ids already differ per `connectionId` (sha256 tuple). API-key catalog ids are `pi.<provider>.<model>` with connection `${provider}.api` (`pi/src/catalog-discovery.ts:104,141`) — a second OpenAI key would collide. Read-time alias precedent exists (`migratePlanResourceId`).
- **Correction:** 070A′ = connection identity contract: default connection ids equal today's constants (legacy ids byte-identical, no alias manifest); non-default connections use connection-qualified ids for **all** resource sources incl. pi catalog; host-qualified policy key (F-05); golden id vectors. No "ownership explanation" output change.
- **Required test:** Golden vectors for every current fixed identity; collision test for two API-key connections; NRC golden decisions unchanged.

### F-12 — "Verified principal" independence is unobtainable · **MEDIUM** · confidence HIGH

- **Evidence:** `inventory.ts` forbids "account identifiers, tokens or credential-derived hashes" in identity; native runtimes expose no privacy-safe account id; ChatGPT `sub` is stored but must not be emitted.
- **Problem:** If "principal" becomes a required review dimension, every review rejects (unknown ≠ distinct).
- **Correction:** Dimensions = resource, connection (owner-declared distinct account), provider family, host. "Principal" = owner assertion on a connection, labelled unverified. Default remains v1 resource-id rule.

### F-13 — Dependency graph errors · **MEDIUM** · confidence HIGH

- H depends on G/F although review/connection filters need only A/B; I (UI) waits for H; K (migration) runs after I/J although the first non-default connection (B) is the migration point; E blocks nothing but sits on the critical path to J. Corrected DAG in Blueprint-Reviewed §4.

### F-14 — Version-tag and retry-architecture creep · **MEDIUM** · confidence MEDIUM

- Eight new tags (`provider-instance@1` … `context-handoff@1`) and "one shared per-turn/unit retry budget". Baseline doc: "No new … retry architecture was introduced". Existing bounds: Control restart once, `DelegationUnitLimit`. **Correction:** version only persisted/wire schemas that change (`context@2`, settings `connections`); reuse existing retry bounds.

### F-15 — Fixed enums → open ids across IPC · **MEDIUM** · confidence HIGH

- `INVENTORY_SOURCE_IDS` (4 literals), `credentialNames` (8), `blobNames` (1), `CONNECTION_CREDENTIAL_NAMES` (1) are strict allowlists today; opening them widens renderer-controllable input. **Correction:** bounded id pattern + main-side existence check + forged-id negative tests; ids never become paths/env names without a fixed prefix/suffix scheme validated by `CREDENTIAL_NAME_PATTERN`.

### F-16 — Non-objective DoD items · **MEDIUM** · confidence HIGH

- e.g. 070A "identical where observable", 070L "owner accepts scoped results", K "proven migration". **Correction:** measurable criteria in Blueprint-Reviewed §6.

### F-17 — ChatGPT plan second account unverified · **MEDIUM** · confidence MEDIUM

- 067 uses one `ext_agent_host_id = urn:uuid:<installation>` per installation; whether OpenAI accepts two concurrent dynamic-client grants for different accounts under one host id is UNVERIFIED. Keep single plan account until a documentation check/spike.

### F-18 — T3 upstream churn · **LOW** · confidence HIGH

- Between pin `3143335` and HEAD `31b04e2` (2026-10-09, 132 commits): `apps/server/src/provider/ProviderDriver.ts`, `ProviderInstanceEnvironment.ts`, `orchestration-v2/ContextHandoffBudget.ts`, `provider/cursorKeychainToken.ts` no longer exist at those paths — moved to `packages/provider-core/src/server/{adapterDriver,instanceEnvironment}.ts`, `ContextHandoffService.ts` and `packages/provider-cursor/src/server/keychainToken.ts` (the prohibited keychain-read pattern persists upstream); providers extracted into packages (`provider-core`, `provider-acp`, `provider-acp-registry`, `provider-pi`, …). Pinned links remain valid. **Correction:** cite pins only; adopt patterns, never layout.

### F-19 — ACP candidate classification · **LOW** · confidence MEDIUM

- "Initial candidate: plane-only delegated Codex ACP" does not state it is a third-party adapter. Support class must be `experimental-client-compat` with vendor-native auth.

### F-20 — Corrupted comment · **LOW** · out of NXR-070 scope

- `apps/desktop/src/main/desktop-key-store.ts:30–31`: "readable through \n esolveSecret" (a `` `r `` sequence lost). Cosmetic; fix in a hygiene commit.

### F-21 — Code lane drops prior context on overflow · **MEDIUM** · confidence HIGH (added at reconciliation)

- **Evidence (VERIFIED):** `packages/operating/src/service.ts:607–625`. When the `context@1` prompt is longer than `MAX_CODE_GOAL_CHARS` (20,000, the plane's `MAX_GOAL_CHARS`), the goal becomes `turn.text` only. The manifest records `CODE_GOAL_REQUEST_ONLY_POLICY` with `omittedTurns`, but the turn proceeds.
- **Impact:** Constraints and decisions from earlier turns are lost in the Code lane without an owner-visible rejection. This is the failure owner requirement C forbids.
- **Correction:** In `context@2`, required sections are never dropped. If they do not fit in 20,000 characters, reject with `context.required-overflow` and request an explicit smaller handoff. Without required items, v0.6 behavior is kept (OD-10).
- **Required test:** TST-25 (reconciled blueprint).

### O-1 — Zero-alias migration · OPPORTUNITY

Default connection id = current constant ⇒ `inventoryResourceId` unchanged ⇒ pins, history (`telemetry/history.ts:107` keyed by resource id) and session records keep resolving with no alias manifest. Only non-default connections get new ids.

### O-2 — API-key second connection first · OPPORTUNITY

Separate API keys are separate billing identities by construction; fully offline-testable with a fake OpenAI-compatible server; no vendor-home or OAuth question. Delivers real multi-account value in 070B′.

### O-3 — Opt-in connection/provider review diversity · OPPORTUNITY

`metadata.connection` already carries `id`/`provider`; a strategy setting `reviewDimensions: ['resource','connection'|'provider']` (preferred/required) is a small, testable NRC change that strengthens independence without principal evidence.
