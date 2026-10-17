# NXR-070 — Owner Decision Brief

**Verdict: ARCHITECTURE_READY_WITH_REQUIRED_AMENDMENTS.** ADR-029 stays **Proposed**. Implementation is **NOT STARTED**.

## 1. Should the current architecture be approved?

**Not as written.** The goals are right: Nexar owns resources, multiple accounts are supported, no credentials are harvested, Control stays pinned, and unknowns stay honest. But the proposal conflicts with Accepted ADR-028, which already decided "multiple connections per provider, no driver mega-interface". It also skips the security fixes accepted after its research base, and builds new entities over contracts that already exist. Approve it **with the amendments** in `ADR029_Proposed_Amendments.md`.

## 2. What must change first

1. ADR-029 must declare that it amends ADR-028 and refines ADR-027, and must use their vocabulary: connection, route identity, host (F-01).
2. Add the v0.6 invariants: shared unit counter, no `reviewOf` in one-unit grants, protocol mode ≠ authority, member validation, per-turn native sessions, and unchanged default ids (F-02).
3. Shrink the domain model. Extend `ProviderConnection` with owner-configured definitions and credential scopes, and drop the new Driver, Instance, Binding, Environment and Session entities (F-03).
4. Treat each host (Desktop, plane) as a separate authority. No cross-host allocation (F-04/F-05).
5. Replace native session binding with a typed `context@2` (F-07).

## 3. Decisions that need your approval

| ID   | Decision                                                                                                                         | Recommendation |
| ---- | -------------------------------------------------------------------------------------------------------------------------------- | -------------- |
| OD-1 | Approve ADR-029 with amendments A–E                                                                                              | Approve        |
| OD-2 | Move the ACP worker out of NXR-070                                                                                               | Defer          |
| OD-3 | No native session resume/fork; adopt `context@2`                                                                                 | Approve        |
| OD-4 | Multi-account order: API keys → Codex (separate `CODEX_HOME`) → ChatGPT plan only if OpenAI confirms → Claude only after a spike | Approve        |
| OD-5 | Review default stays "different resource"; "different connection/provider" available as an option                                | Approve        |
| OD-6 | No budget or billing enforcement in NXR-070                                                                                      | Confirm        |

## 4. What should be deferred

- ACP agent runtimes. Nexar already has an ACP client in DSH, and `codex-acp` is a third-party adapter.
- Native resume/fork.
- Cross-host allocation.
- Remote environments.
- Learned quality ranking.
- Cash budgets.
- HTTP MCP.
- Claude multi-account, until `CLAUDE_CONFIG_DIR` isolation is proven.
- ChatGPT-plan second account, until OpenAI confirms multiple accounts per installation.
- DSH Control configuration, which is a separate task.

## 5. Is NXR-070A ready for implementation?

**Not the original 070A.** It mostly tests guarantees v0.6 already has, and it misses the one real collision: API-key models are named `pi.<provider>.<model>` with no account in the id.

**The corrected 070A′ is ready once you approve.** It is a connection identity contract:

- built-in connections keep today's exact ids, so every pin and history entry is unchanged;
- extra connections get account-specific ids from every source;
- plane and Desktop connections are told apart;
- golden tests prove nothing existing moves.

It needs no UI, no login and no model calls, and it can be reverted.

## 6. Safest next engineering action

1. Apply the amendments to the research documents. This is docs-only (070-0) and the original author or I can do it on a branch for your review.
2. After your approval, implement 070A′ offline, with exact-head CI green before anything stacks on it.
3. Then 070B′: a second API-key account end to end. It is the first real multi-account feature, fully testable offline.

Nothing in this review changed `main`, Gemini's checkout, Codex's research branch, credentials or deployments.
