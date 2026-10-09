# ADR-029: Connection-Scoped Resources and Canonical Continuity (Resource Fabric v2, reconciled)

- Status: **Proposed** (not adopted; owner approval pending)
- Date: 2026-10-09 (final corrections C1–C5 and clarifications K1–K2 applied; see [closure report](../architecture/nxr-070/NXR070_Final_Corrections_Closure_Report.md))
- Supersedes as a draft: `b843d04:docs/adr/029-resource-fabric-provider-runtime-v2.md` (Codex research, base `4c69d1c`)
- Baseline: accepted v0.6 `9e71014` (merge `2f856f9`, CI `37955286149`); main `677eefd` (docs CI `37958959182` attempt 2)
- Relationship: **amends ADR-028** §"Domain and ownership" and its deferral of multi-account UI (for the tiers below only); **refines ADR-027** §10 (review diversity) and **ADR-024** §10 (context policy). ADR-024/027/028 remain authoritative for everything not amended here. ADR-014/015/016/018/019/020/021/022 are unchanged.
- Implementation: **NOT STARTED.** Approval of this ADR does not authorize live login, allowance use or source reuse.
- Companion documents: [Blueprint](../architecture/nxr-070/NXR070_Implementation_Blueprint_Reconciled.md), [Security](../architecture/nxr-070/NXR070_Security_Threat_Model_Reconciled.md), [Decision register](../architecture/nxr-070/NXR070_Architecture_Decision_Register.md), [Execution plan](../architecture/nxr-070/NXR070_Execution_Plan_Reconciled.md), [Traceability](../architecture/nxr-070/NXR070_Reconciliation_Traceability.md), [Approval brief](../architecture/nxr-070/NXR070_Final_Architecture_Approval_Brief.md). Audit evidence: [Findings register](../architecture/nxr-070/audit/NXR070_Critical_Findings_Register.md).

## 1. Context

v0.6 already has the hard parts:

- connection- and route-scoped inventories with generation guards;
- stable hashed resource ids;
- hard-filter-first routing;
- pinned Control;
- bounded worker grants;
- canonical sessions with per-turn native sessions;
- strict Desktop/plane boundaries.

What it lacks is **owner-configurable connections**. Connection ids, credential slots, inventory sources and native runtime homes are fixed, one per provider route. As a result Nexar cannot hold two accounts of one provider and cannot tell the plane's accounts from Desktop's. Nor can it reliably carry goals, constraints and decisions across model switches: the Code lane can drop all prior context on overflow (F-21).

The original draft proposed a new entity graph:

- ProviderDriver and ProviderInstance;
- RuntimeDefinition, RuntimeEnvironment, RuntimeBinding and RuntimeSession;
- Resource@2, ResourceProfile and NRCDecision@2;
- an ACP worker;
- native session bindings.

The audit found that most of these rename existing contracts (F-03), conflict with ADR-028 (F-01), and drop v0.6 invariants added after the research base (F-02). This ADR keeps the draft's goals and correct rejections, and grows the existing contracts instead.

## 2. Vocabulary (ADR-028 terms; no new entity names)

| Term                  | Contract                                                                                        | Meaning                                                                                                                                                         |
| --------------------- | ----------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Connection            | `ProviderConnection` / `ResourceConnection`, `connectionId`                                     | One owner-recognized way to reach a provider with one credential scope **and one account** (what the draft called a "provider instance")                        |
| Connection definition | `ConnectionDefinition` (PROPOSED, additive)                                                     | The configuration record of a connection: built-in or owner-created                                                                                             |
| Credential scope      | `ConnectionCredentialScope` (PROPOSED, additive)                                                | The Nexar-owned secret location: key-store name, account blob, Nexar-created native home, or none                                                               |
| Account binding       | private connection state `{credentialGeneration, identityAssurance, bindingRecord?}` (PROPOSED) | The account a connection stands for, fixed for the connection's lifetime (§4.3). Never part of any identity hash; only the assurance label reaches the renderer |
| Route identity        | `ProviderRuntimeIdentity`                                                                       | `{provider, connectionId, runtimeId, routeId, machine}`. The existing `RuntimeBinding` type (`adapter, locality, options`) keeps its meaning                    |
| Host                  | `machine`                                                                                       | A separate Nexar composition (`desktop`, `plane`) with its own registry, NRC, telemetry and credentials                                                         |
| Connection key        | `connectionKey(host, connectionId)` (PROPOSED)                                                  | The key used by policy, telemetry and lifecycle. Never a path or environment name                                                                               |

## 3. Invariants carried from v0.6 (must hold in every unit)

- **B1.** Every capability array member is validated before alias normalization. Aliases resolve registered own properties only (`834a865`, `1feb97f`).
- **B2.** Per-turn delegation admission uses the shared monotonic `DelegationUnitLimit`. No restart, fallback, grant remint, connection change, rotation or policy change resets or bypasses it (`3cbd6a6`).
- **B3.** Upstream permission modes never grant Nexar authority. Read-only grants deny write, shell, network and foreign MCP (`4559857`). NRC selection never grants file, tool, network or commit permission.
- **B4.** One-unit standalone grants exclude `reviewOf`. Review lineage applies only within a multi-unit grant (`9e71014`).
- **B5.** A native or provider session lives for at most one Nexar turn; a Control restart is a new upstream session (`apps/desktop/src/main/cowork.ts`). Continuity is carried by canonical sessions and the context policy.
- **B6.** Built-in connections keep their v0.6 `connectionId`s. Every existing resource id, pin, telemetry aggregate and session reference stays byte-identical.
- **B7.** Write-capable lanes run only through the sandbox launcher. Native child environments stay explicit allowlists; Codex never receives API-key variables.
- **B8.** v0.6 session records (`schemaVersion: 1`, strict schemas in `packages/sessions/src/record.ts`) stay readable by the v0.6 reader. NXR-070 adds no field to session or turn records (§4.6.5).
- **B9.** `FileSessionStore` (`packages/sessions/src/store.ts`) remains the only writer of the session directory. It holds the process lease (`.lease`), serializes writes per session, checks revisions, and writes atomically: exclusive temp file, `fsync`, replace, mode 0600, directory 0700, canonical-directory check. NXR-070 adds no second writer.

## 4. Decision

### 4.1 Connections and identity

- `BUILTIN_CONNECTIONS` reproduces v0.6 exactly:
  - `anthropic.subscription`, `openai.subscription`, `google.subscription`, `deepseek.api`;
  - `openai.chatgpt-plan`;
  - `${provider}.api` for each API provider, with today's runtime and route ids and `machine`.
- Owner-created and replacement connections get an id generated by the host's main process: `<built-in family id>.c<suffix>`, for example `openai.api.c…`, `openai.subscription.c…`, `openai.chatgpt-plan.c…`. The suffix is 10 lowercase base32 characters from a cryptographic random source.
- **Collision detection is mandatory.** Generation checks the candidate against built-ins, live connections and tombstones inside the serialized settings mutation, and retries on collision. Uniqueness is enforced by that persistent check, not assumed from randomness.
- Ids are immutable. A retired connection's id is tombstoned and never released (B′).
- Identity never includes:
  - the label or rotation generation;
  - the assurance level or binding record;
  - model or routing preferences;
  - timestamps or prices;
  - any credential value.
- Resource ids:
  - built-in connections keep today's ids;
  - owner connections get connection-qualified ids from every source;
  - inventory sources already hash `connectionId`;
  - the pi API catalog uses `catalog:<sha256(connectionKey, provider, model)>` for non-default connections.
- A resource executes only with its own connection's credential scope. An adapter given a resource whose scope differs from its connection's rejects it with `CONFIGURATION_ERROR`.

### 4.2 Hosts

- Each host is an independent authority. It allocates only its own resources; another host's resources appear only as read-only projections.
- Desktop host-qualifies plane connection DTOs on receipt; no plane wire change is needed.
- `machine` keeps its persisted literals `desktop` and `plane`, which are hashed into existing ids. Any future host uses a new opaque literal (`host.<suffix>`), so existing identities never change.
- Host is **attribution and explanation metadata only** in NXR-070. It is never a routing or review dimension.
- Distributed allocation, federation, remote execution, cross-host review routing and cross-host credentials are out of scope and need their own ADR.

### 4.3 Account binding, rotation and lifecycle

**Rule: a connection never changes account.** Its id, resource ids, pins, history and recorded decisions always refer to the account it was created for. A different account is always a different connection. Nothing is redirected.

**Identity assurance** of each credential entry:

| Level                         | Evidence                                                                                                                                                                                                     | Outcome                                                                                                                                                                                                                                       |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `VERIFIED_SAME_ACCOUNT`       | Trusted provider evidence of continuity. Today only the ChatGPT plan: the signature-verified ID-token subject, compared inside the plan authentication service with the connection's retained binding record | Accepted; same connection, `credentialGeneration` +1                                                                                                                                                                                          |
| `OWNER_ASSERTED_SAME_ACCOUNT` | Provider exposes no reliable account identity (API keys, native Codex) and the owner explicitly confirms "same account"                                                                                      | Accepted; same connection; the label stays "owner-asserted" and is never shown as verified; the assertion time is recorded                                                                                                                    |
| `VERIFIED_DIFFERENT_ACCOUNT`  | Trusted evidence that the account differs from the binding record                                                                                                                                            | **Rejected** for this connection, with no override. Credentials are not stored and the connection is unchanged. The owner can add a new connection (multiple plan connections need E-1) or, for the single plan, use **Replace plan account** |
| `IDENTITY_UNKNOWN`            | Continuity cannot be established and the owner has not confirmed                                                                                                                                             | Not stored until the owner either asserts same account (→ owner-asserted) or chooses "this is a different account" (→ add a new connection instead)                                                                                           |

**Binding record.**

- For connections with verifiable identity (today the ChatGPT plan), the plan service keeps the verified subject in a separate encrypted key-store entry: the connection's binding record.
- **Forget credentials** deletes tokens and keys only. It keeps the binding record and the account association.
- The binding record is kept with a removed connection's tombstone, so Restore returns the same account. It is deleted only by **Replace plan account**. It never crosses IPC and never reaches logs, telemetry, records or the renderer.
- For connections without verifiable identity, the binding is the owner's assertion history (timestamps only).

**Re-entering credentials after Forget** follows the same table:

- the same verified account restores the connection;
- a verified different account is rejected;
- an unknown identity needs an owner assertion or a new connection.

**Forget credentials never changes which account a connection represents.**

**Built-in single ChatGPT plan before gate E-1.** At most one _active_ plan connection exists at any time.

- **Rotation and re-sign-in** with the same account are verified-same and continue the same connection.
- **Different account:** the sign-in is rejected for the current connection, and the UI offers **Replace plan account** (OD-15). If OD-15 is declined, the rejection stands, with no switch path until E-1. Replace is an explicit, confirmed owner action:
  1. It is refused while any execution or refresh is bound to the plan connection.
  2. It forgets the current tokens.
  3. It retires the current plan connection: tombstoned, binding record deleted, resources unpublished, pins fail `pin.connection-removed`, history kept under the old ids.
  4. It creates a new connection `openai.chatgpt-plan.c<suffix>`, which the new sign-in binds to.
- **What Replace preserves and claims:**
  - It preserves today's ability to switch the plan account without redirecting any pin, session reference, history or decision.
  - It is sequential replacement, which v0.6 already allows (disconnect, then sign in), not concurrent multi-plan.
  - Holding two plan accounts at once remains gated by **E-1** and is not claimed.
  - The built-in id `openai.chatgpt-plan` is never re-pointed (B6). Once retired, it stays tombstoned.

**In-flight safety.**

- One API request uses the credential resolved for that request. Per-call resolution is the existing v0.6 pattern: `resolveSecret`/`resolveCredential` are injected into the pi adapter.
- A Control loop or delegated unit makes many requests.
- A native agent process reads, and may refresh, credentials in its runtime home at times Nexar does not control. Nexar does not claim native authentication is immutable during execution.
- Therefore Rotate, Forget, Replace, Delete-home and any Nexar-initiated re-login are **refused while any execution, inventory refresh or native process is bound to the connection** (fail-closed).

| Action                                             | Definition                                     | Credentials                                                                                                       | Inventory and resources                               | Pins                                                  | Active executions                                                       | Confirmation                                 | Reversible                                                                         |
| -------------------------------------------------- | ---------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------- | ----------------------------------------------------- | ----------------------------------------------------------------------- | -------------------------------------------- | ---------------------------------------------------------------------------------- |
| **Disable**                                        | `enabled=false`                                | retained                                                                                                          | generation invalidated; resources unpublished         | kept; fail `pin.connection-disabled`; no substitution | running work finishes under its pinned decision; new admissions refused | single explicit action                       | yes: Enable, then refresh                                                          |
| **Rotate**                                         | unchanged                                      | replaced only under same-account assurance; `credentialGeneration` +1                                             | invalidated                                           | kept                                                  | **refused while active**                                                | assurance flow above                         | via another rotation                                                               |
| **Remove** (owner connections only)                | tombstoned; id never released                  | **retained** by default and listed as "retained credentials"; binding record kept with the tombstone              | as Disable                                            | fail `pin.connection-removed`                         | refused while active (Disable first)                                    | dialog listing affected pins and preferences | yes: Restore from tombstone (same id, same account) while credentials are retained |
| **Forget credentials**                             | unchanged; account association kept            | Nexar-owned key, blob or token deleted for this connection only; vendor grants are not revoked (stated in the UI) | auth becomes `unauthenticated`; inventory invalidated | as Disable                                            | refused while active                                                    | explicit confirmation naming the connection  | re-enter credentials of the **same** account                                       |
| **Replace plan account** (single plan, before E-1) | old connection retired; new connection created | old tokens forgotten; old binding record deleted                                                                  | old resources unpublished                             | old pins fail `pin.connection-removed`                | refused while active                                                    | explicit confirmation listing affected pins  | no (old connection stays tombstoned; history retained)                             |
| **Delete Nexar-owned runtime home**                | unchanged                                      | the home's contents are deleted                                                                                   | invalidated                                           | as Disable                                            | refused while any process uses the home                                 | explicit confirmation                        | no                                                                                 |

Deletion is allowed only for a directory Nexar created:

- it must sit under the fixed private root `<appData>/Nexar/runtime-homes/`;
- it must carry a Nexar marker file and be recorded in the connection definition;
- `lstat` must show no symlink or reparse point at any level.

The vendor's default home (for example `~/.codex`) and any owner-declared path are never deleted. Deletion is logical file removal; physical erasure on SSDs is not claimed. A native re-login performed by the owner outside Nexar inside a Nexar home cannot be detected; this is a documented residual risk (R-03).

### 4.4 Multi-account roadmap (owner-confirmed order, Decision A)

| Tier | Route                              | Mechanism                                                                                                                                       | Gate                                                                                                                                                                      |
| ---- | ---------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1    | API-key connections                | per-connection key-store name `<PROVIDER>_API_KEY__C<SUFFIX>`                                                                                   | none beyond this ADR                                                                                                                                                      |
| 2    | Codex accounts                     | one complete Nexar-created `CODEX_HOME` per connection (officially documented variable); login only via the official Codex CLI, owner-initiated | fake-runtime conformance; owner live login                                                                                                                                |
| 3    | ChatGPT plan accounts (concurrent) | per-connection account blob                                                                                                                     | **E-1**: official evidence that multiple accounts per installation (`ext_agent_host_id`) are supported, plus isolation tests. Sequential replacement (§4.3) is not tier 3 |
| 4    | Claude subscription accounts       | per-connection config home (`CLAUDE_CONFIG_DIR`, official status unverified)                                                                    | **E-2**: independent demonstration of credential, settings and session isolation on Windows and plane                                                                     |

Tiers 3 and 4 stay on the roadmap as objectives; no isolation is claimed before their gate passes. Shadow-home layouts that share runtime state across accounts are rejected. Third-party credential reads are rejected.

### 4.5 Routing and review independence

- `deterministic@1` and `resource-intelligence@1` stay byte-for-byte unchanged, and v1 remains the default.
- An opt-in `resource-intelligence@2` reuses v1 scoring and adds:
  - hard filters for disabled or removed connections;
  - required review dimensions;
  - provenance-tagged facts;
  - explanation fields: policy version, facts digest and rejected reasons.
- Unknown quota is rank-neutral: known headroom never outranks unknown. Known exhaustion is a hard rejection.
- NXR-070 adds no monetary budget enforcement.

**Review dimensions:**

- `resource` is the default (v1 behavior).
- `connection` is optional, compared on `connectionKey`. Because a connection never changes account (§4.3), distinct keys mean distinct owner-recognized accounts.
- `provider` is optional.
- Each optional dimension is `preferred` or `required`.

**What review independence guarantees:**

- Connection distinctness is owner-declared or verified per the assurance labels. It is not proof of independent people or organizations.
- Unknown is never treated as distinct.
- A **required** dimension that no eligible candidate on this host satisfies fails the review allocation explicitly (`strategy.diversity.<dimension>.unavailable`). It never silently downgrades.
- `host` is recorded in explanations only, and the strategy schema rejects it as a dimension.
- B4 holds.

### 4.6 Continuity (owner-confirmed, Decision B)

Native sessions remain per turn (B5). NXR-070 adds no resume, fork or native-session persistence. `context@2` is built only from the canonical session plus Nexar-owned structured records.

**4.6.1 Classification (deterministic; never decided by a model).** The owner's direction is a conservative policy: capacity pressure never makes anything optional.

| Class                                             | Source                                                                                                                                                                                                               | Handling                                    |
| ------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------- |
| C1 Confirmed constraints                          | Owner-confirmed items: an explicit owner action such as "Keep as constraint", or structured input fields marked required                                                                                             | Required: never omitted                     |
| C2 Persisted decisions                            | Nexar records: approvals, commits, accepted review verdicts, owner-confirmed decisions; re-derived from canonical records on every build                                                                             | Required: never omitted                     |
| C3 Structured requirements and review obligations | Task requirements, strategy review requirements, workflow inputs marked required, the current Code goal; re-derived on every build                                                                                   | Required: never omitted                     |
| C4 Optional                                       | **Only content with a documented, owner-approved optional classification.** Recommended default: turns the owner explicitly marked optional or superseded. Artifact bodies are always by reference and never inlined | Omittable, with disclosure (§4.6.3)         |
| C5 Unclassified                                   | Everything else: **all prior owner text and all prior model output**, regardless of age or window                                                                                                                    | Retained. Never omitted because of capacity |

- Model output can _suggest_ a constraint or decision, but only an owner action or a Nexar structured record promotes an item to C1–C3 or marks one C4.
- Content inside `<untrusted-input>` can never change any item's class.

**4.6.2 Capacity.** Three separate limits apply.

1. **Protocol character limits:**
   - Code goal: 20,000 characters (`MAX_GOAL_CHARS`);
   - Cowork context budget: 24,000 characters (`MAX_CONTEXT_CHARS`).
2. **Model token capacity:** the inventory's `limits.contextWindowTokens` when known.
3. **Reserve for generation and tools:**
   - the known `maxOutputTokens`, otherwise 25% of the window;
   - plus the tool-schema bytes the engine sends.

Characters are never equated with tokens. When the window is known, the conservative check is: **UTF-8 bytes of the handoff ≤ window − reserve**. This relies on the documented assumption that byte-level tokenizers emit at most one token per byte. When the window is unknown, only the protocol limits apply and capacity is recorded as `unknown`; no capacity is invented.

**4.6.3 Assembly and overflow.**

1. Include C1–C3 with source attribution: turn id, record id, or owner action.
2. Include all C5.
3. Fill the remaining budget with C4, newest first.
4. Disclose each omitted C4 item, as turn ids and counts, in the handoff header and the sidecar.

If C1–C3 do not fit, reject with `context.required-overflow`. If C1–C3 plus C5 do not fit, reject with `context.unclassified-overflow`. Each rejection names the classes and sizes, and the owner can:

- mark turns optional;
- or approve an **independent turn**.

An independent turn requires an explicit per-turn owner action. It is recorded as policy `context@2/independent`, and the prompt states that prior context was not sent. Oversized turns are **never** converted automatically: the v0.6 Code-lane request-only fallback (`packages/operating/src/service.ts:607–625`) is removed for `context@2` turns.

**4.6.4 Trust.**

- All prior content stays inside `<untrusted-input>`.
- `context@2` is a summary of canonical content. It is never native runtime state, and it never carries permissions, grants, approvals or authorization.
- Content sent to a different provider is canonical-session content already visible to the owner. The `dataLocality` filter still applies.

**4.6.5 Persistence, sidecar integrity and downgrade compatibility.**

Evidence from v0.6 (`packages/sessions/src/record.ts`, `packages/sessions/src/store.ts`):

- **Strict schemas.** The session, turn and context schemas are `z.strictObject` with `schemaVersion: z.literal(1)`. An unknown key makes the session corrupt: `parseSession` throws, and `list` shows the session as `unavailable`.
- **Free policy string.** `context.policy` is any string of 1–64 characters.
- **Listing filter.** The store lists only `^(ses_[0-9a-f]{32})\.json$`.
- **Deletion.** The store deletes only its lease file and its own temporary file on a failed write. It has no session deletion or backup API.
- **Write and read protocol.** See B9. Reads go through `readBounded`: regular file, single link, size-bounded, real path inside the canonical directory, handle identity re-checked.

Contract:

1. **Manifest.** `context@2` turns write the existing seven-field manifest unchanged in shape, with `policy` `context@2`, `context@2/code-goal` or `context@2/independent`, and `hash` covering the full handoff. The v0.6 reader loads these sessions.

2. **Sidecar document.** The file is `ses_<id>.context.json` (`session-context@1`). Its fields:
   - `schemaVersion: 1`, `sessionId`;
   - `boundRevision`: the session `revision` it was written against;
   - `coveredTurns[]`: `{turnId, index, digest}`. The digest is the SHA-256 of a fixed canonical projection of the turn: id, index, state, owner text, outcome text, approval ids, task links, artifact ids;
   - `promotions[]`: C1 items, each `{itemId, text ≤ 2,000 chars, sourceTurnId?, sourceDigest?, createdAt}`, with the text stored as content;
   - `optionalMarks[]`: C4 marks, each `{turnId, turnDigest}`;
   - `disclosures[]`: each `{turnId, reason}`;
   - `capacity`.

   C2 and C3 are **never** stored only in the sidecar; they are re-derived from canonical records on every build.

3. **Single writer.** Only `FileSessionStore` writes the sidecar. It does so through new store methods that run under the same lease, the same per-session `serialized` chain and the same `expectedRevision` check as session mutations (B9).
   - A turn mutation that changes context writes the session first, then the sidecar bound to the new revision.
   - Owner actions that change only classification ("Keep as constraint", "Mark optional") rewrite only the sidecar, bound to the current revision, after an `expectedRevision` check.

4. **Atomic write and crash recovery.**
   - The sidecar is written with the store's `writeFileAtomic`: exclusive temp file `.ses_<id>.context.<hex>.tmp` (0600), `fsync`, replace, `chmod 0600`.
   - A crash between publishing the session and publishing the sidecar leaves a sidecar bound to an older revision. That case is detected and reconciled exactly like a downgrade (item 6).
   - A crash before the replace leaves the previous sidecar intact.
   - Leftover temp files that match exactly `.ses_<32 hex>.context.<12 hex>.tmp`, are regular single-link files and sit inside the canonical directory are removed during lease acquisition; nothing else is touched.

5. **Bounds and file safety.**
   - Sidecar ≤ 1 MiB; ≤ 256 promotions; ≤ `MAX_TURNS` covered turns and marks; ≤ 1,000 disclosures.
   - Strict schema (`z.strictObject`), forbidden-key check, read via `readBounded`: symlinks, junctions and hard links are refused; real-path containment is checked.
   - File mode 0600, directory 0700.

6. **Staleness detection and reconciliation.** The sidecar is fresh only if `sidecar.sessionId === session.id`, `boundRevision === session.revision`, and every covered turn's digest matches the session. Otherwise it is **stale**: a valid filename does not establish freshness. Reconciliation runs under the lease and the session's serialized chain:
   - **Covered turns with unchanged digests** keep their marks.
   - **Changed or missing turns:** their optional marks are dropped, which fails toward retention. Promotions sourced from them are kept, because the text is stored, and flagged `source-changed` or `source-missing` for owner review. They stay C1.
   - **Turns not covered**, for example added by v0.6 after a downgrade or after a crash, are C5.
   - The sidecar is then rewritten bound to the current revision.

   Reconciliation never drops a promotion and never makes anything optional.

7. **Missing, corrupt, unsupported or foreign sidecar.**
   - **Missing, with no `context@2*` manifest in the session's turns:** this is a normal `context@1` or v0.6 session. The sidecar is created on first need, and all prior content is C5.
   - **Missing, but a `context@2*` manifest exists:** promotions or marks may have been lost. `context@2` turns are refused with `context.store-missing` until the owner chooses **Reconstruct typed context**. Reconstruct rebuilds from canonical records (C2/C3 re-derived, all else C5) and tells the owner that prior promotions are unavailable.
   - **Corrupt, oversized, unsupported `schemaVersion`, linked, or bound to another session:** `context@2` turns are refused with `context.store-unreadable`. The file is never rewritten or deleted automatically. **Reconstruct typed context** first renames it to `ses_<id>.context.<timestamp>.quarantine` (0600, preserved, excluded from both the v0.6 and the sidecar filename patterns), then writes a new sidecar.
   - In every case, context is never built without known required items. Reconstruction errs toward retention.

8. **Backup, deletion and orphans.**
   - NXR-070 adds no session deletion. v0.6 has none.
   - A sidecar without a matching session file is an orphan. It is ignored by builds, reported in diagnostics, and **never deleted automatically**.
   - Restoring a session from backup without its sidecar falls under item 7 (missing). Restoring an older session next to a newer sidecar falls under item 6 (digest mismatch, so stale).
   - Any future deletion feature must remove the session and its sidecar in one serialized store operation, under its own ADR.

9. **Forward and downgrade.**
   - **Forward:** `context@1` sessions are read unchanged; their prior content is C5.
   - **Downgrade:** v0.6 reads `context@2` sessions (TST-45) and ignores sidecars and quarantine files.
   - **Upgrade:** turns added or changed under v0.6 are detected by revision and digest (item 6).

10. **Native-session boundary.** Any future native-session lifecycle needs its own ADR and a separate store keyed by `(connectionKey, credentialGeneration)`. It must never be stored in session records, manifests or sidecars, and may never carry authority. NXR-070 writes nothing of this kind.

### 4.7 Execution

The Control Model Gateway, Intelligence Bridge, `createEngineExecutor` and the `ExecutionAdapter` contract are unchanged. Agent-run workers keep using `ExecutionAdapter`. No third gateway and no `AgentExecutionPort` are added.

### 4.8 Telemetry

Execution records and aggregates gain:

- `connectionKey`;
- the assurance label;
- per-field authority: `measured | runtime-reported | vendor-reported | estimated | owner-declared | unknown`.

Records written before this change read as `legacy`. Records hold ids, counts and reasons only: no labels, paths, key names or subjects.

### 4.9 Deferred and rejected

| Deferred (needs its own ADR)                         | Rejected                                         |
| ---------------------------------------------------- | ------------------------------------------------ |
| ACP agent runtime                                    | third-party credential and keychain reads        |
| native resume and fork                               | Goose-style Auto → bypass/full-access mapping    |
| concurrent multi-plan (E-1)                          | secret-hashed identities                         |
| Claude multi-account (E-2)                           | shadow homes sharing state across accounts       |
| cross-host allocation, review routing and federation | model-decided context classification             |
| remote environments                                  | capacity-driven omission of unclassified context |
| learned quality ranking                              | automatic conversion to an independent turn      |
| budgets and billing                                  | rebinding a connection to a different account    |
| HTTP/SSE MCP                                         | a second session-directory writer                |
| switching the default to `@2`                        | —                                                |

## 5. Reconciliation of draft decisions D1–D18

| #   | Draft decision                  | Reconciled outcome                                                                                                              |
| --- | ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| D1  | Nexar owns resources and policy | Kept (§4)                                                                                                                       |
| D2  | First-class instance identity   | Amended: connections with immutable, collision-checked opaque ids, one account per connection; built-ins unchanged (§4.1, §4.3) |
| D3  | Driver composition              | Amended: existing ports only; no driver type, no new package (§4.7)                                                             |
| D4  | Environment binding             | Amended: host = independent authority and attribution only (§4.2)                                                               |
| D5  | Ids preserved via aliases       | Amended: no alias manifest is needed (B6); catalog ids are connection-qualified (§4.1)                                          |
| D6  | Inventory authority             | Kept (ADR-028)                                                                                                                  |
| D7  | Optional ACP worker             | Deferred (§4.9)                                                                                                                 |
| D8  | Nexar permissions authoritative | Kept, plus B3                                                                                                                   |
| D9  | Session transitions and handoff | Amended per owner Decision B: conservatively classified `context@2` with an integrity-checked sidecar (§4.6)                    |
| D10 | Control pinning                 | Kept; lifecycle actions refused while active (§4.3)                                                                             |
| D11 | Telemetry authority             | Amended: provenance only; no budget (§4.8)                                                                                      |
| D12 | NRC ranking                     | Amended: `@2` reuses v1 scoring; quota neutrality (§4.5)                                                                        |
| D13 | Review diversity                | Amended: resource (default), connection, provider; host attribution only; no silent downgrade; B4 (§4.5)                        |
| D14 | Stdio-only MCP                  | Kept                                                                                                                            |
| D15 | No third gateway                | Kept (§4.7)                                                                                                                     |
| D16 | No secret or history reuse      | Kept; extended to shadow homes (§4.4)                                                                                           |
| D17 | Patterns, not source            | Kept                                                                                                                            |
| D18 | First slice                     | Amended: NXR-070A′, the identity contract (Blueprint §4)                                                                        |

## 6. Migration and rollback

The change is purely additive:

- **Settings.** A new `connections` section (`schemaVersion 1`). If it is absent, only the built-ins exist. If it is corrupt or unrecognized, Nexar fails closed to the built-ins and never rewrites the file on read. A backup is taken before the first write.
- **Sessions.** No change to the record schema (B8). Typed context lives in sidecars written only by the existing store (B9, §4.6.5).
- **No retirement step.** Built-ins are permanent and never re-pointed. Retired connections stay tombstoned.
- **Rollback.**
  - Turning the feature flag off hides owner connections. Their credentials, homes, binding records and tombstones are retained, and their pins fail explicitly.
  - A code-only revert is safe for the identity contract, the review dimensions, `@2` and provenance.
  - Reverting `context@2` is safe because v0.6 reads its sessions (TST-45) and ignores sidecars and quarantine files. Re-enabling reconciles (TST-49). No session migration happens in either direction, and nothing is deleted.

## 7. Security consequences

See the [reconciled threat model](../architecture/nxr-070/NXR070_Security_Threat_Model_Reconciled.md), risks R-01 to R-15. No existing v0.6 control is weakened. The renderer never supplies ids, paths or scope names. Credential values and account subjects never cross IPC.

## 8. Proposed amendment notes for accepted ADRs (text only; not applied)

- **ADR-028**, append: "Amended by ADR-029 (if accepted): connections become owner-configurable per the tiers in ADR-029 §4.4; built-in connection ids are frozen; a connection never changes account."
- **ADR-027 §10**, append: "Review diversity dimensions beyond resource id are defined in ADR-029 §4.5 (opt-in; host is attribution only)."
- **ADR-024 §10**, append: "`context@2` (ADR-029 §4.6) adds conservative classification and a sidecar written only by `FileSessionStore`; the session record schema is unchanged."

## 9. Consequences

- **Gains:**
  - multiple API-key and Codex accounts without changing anything that already exists;
  - no pin, history or decision is ever redirected to another account;
  - single-plan switching is preserved through an explicit Replace;
  - honest, gated tiers for the concurrent ChatGPT plan and Claude;
  - required and unclassified context survives model switches or fails visibly;
  - downgrade-safe, single-writer persistence.
- **Costs:**
  - an additive settings section;
  - lifecycle and Replace UI;
  - per-connection homes;
  - classification actions;
  - a sidecar with reconciliation;
  - more overflow rejections in long sessions, by owner choice.
- **Not delivered:** native session continuity, ACP runtimes, concurrent multi-plan, and cross-host execution or review.
