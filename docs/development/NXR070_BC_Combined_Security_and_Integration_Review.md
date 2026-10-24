# NXR-070B′/C′ — Combined Security and Integration Review

Date: 2026-10-24. Engineer: OpenAI Codex. Final acceptance evidence is recorded separately in the stabilization report.

## Scope and dependency integrity

Starting ancestry: main `41b918b` → B′ `18c7cd0` → C′ `4c69766`. C′ stabilization commits `2bdf80a` and `2887939` concern Desktop test isolation, process cleanup, diagnostics and CI identity. A subsequent shared production callback correction belongs to B′ and must be propagated non-destructively to C′. No main merge, force-push, runtime upgrade or architecture-status change is authorized.

## Actual execution path

| Boundary                        | Source authority                                                                                                                                                | Evidence                                                         |
| ------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| Desktop → trusted IPC           | Existing ProvidersView/bridge contracts; host validates target and consent; renderer receives summaries, not stored credential values                           | Connection-consent and Desktop management tests                  |
| Persistent connection authority | ConnectionManager serializes mutation/admission, validates persisted semantics, preserves immutable IDs, lifecycle and recovery                                 | connection-authority, connection-manager and Plan-binding suites |
| Discovery → Registry → NRC      | Authoritative enabled connections publish canonical connection-qualified resources; stale inventories rejected; existing hard filters/pins remain authoritative | connection-runtime, Registry, inventory-guard and routing corpus |
| Admission → credentials         | connection-manager.ts validates provider/scope/host/generation/resource identity; leases share the mutation authority                                           | Actual synthetic transport and held-execution regressions        |
| Execution → accounting/cleanup  | Existing Gateway/Pi paths retain the selected account; disable blocks new admissions; prohibited active rotation/forget/remove/replace rejected                 | Complete offline integration suite                               |
| Plan identity                   | Trusted service compares retained private binding; replacement retires old IDs and preserves historical pins                                                    | Fake-IdP Plan-binding tests; no live sign-in                     |

First clean combined-source offline report: `2887939`, tree `b08e7ed316e04271dccbea7d154293c9aa9ff8ed`; `.nexar/ci/bc-offline-full-stabilization.json`, SHA256 `527a1388b6af11f9e62dfa31676220787c7ea755f04237c6bf1f84198487805f`:4,531 passed, 169 skipped, 4 pending, 0 failed. This predates the callback correction and is not final-source acceptance.

Relevant passed files there: authority 21, manager 19, consent 5, runtime 12, Plan 10, diversity 43, legacy golden corpus1, Gateway bridge 34, lifecycle 5 and private-state 19 (2 POSIX skipped). Later-source results must be read from the final acceptance manifest.

## Review Diversity and settlement

Resource, immutable connectionKey and canonical provider preferred/required constraints share existing NRC hard filters. Unknown identity cannot prove independence; host remains attribution. Planning, dynamic allocation and revalidation retain reviewed allocation identity and dimension-specific unavailable reasons.

The Gateway race regression at `packages/engine-gateway/src/bridge.test.ts:153` explicitly holds an unrelated allocation computed from an earlier ledger. The writer settles to actual resource `b` before release. Assertions require identity `b`, settled cost 0.25 and reviewer `a`. Cancellation preserves valid state and the monotonic unit limit.

Production anchors: `bridge.ts:532` retains allocation input; `:552–564` reconciles later settlements/cost; `:639` records actual execution identity and cost. Existing Engineering Lane/core execution paths allocate/revalidate through NRC before adapter execution. Failed required diversity cannot authorize extra work or downgrade into the implementation account/provider.

## Stabilization security review

The native ACL guard is unchanged. The test still captures marker existence before the first promise yield. Existing owner/private ACL, parent preservation, hard-link/junction and fail-closed tool assertions remain. A stale marker never substitutes for a current ACL check. The underlying historical startup failure remains unexplained.

The E2E harness observes owned OS process exit before profile reuse/removal, attempts all closes despite errors, retains profiles on incomplete cleanup and preserves diagnostics. It does not claim every detached descendant is universally detected.

The callback correction preserves host/method/path/state validation and reserves the first outcome before draining. Only HTTP finish permits publication. An aborted response publishes no authorized outcome; existing cancellation/lifetime bounds remain. A separate reviewer found no actionable security defect in this change. Attribution of the prior intermittent Plan failure remains unproven.

## Invariants retained

- DSH is the sole primary harness, exactly 0.2.0-rc.2; NRC is the sole resource authority.
- Permission Broker, routing hard filters, pins and monotonic delegation limits remain authoritative.
- Existing WSL2/Bubblewrap Cowork and Coding boundaries remain; no security settings changed.
- FileSessionStore and ProjectMemoryStore remain authoritative. No session/memory migration or account rebinding was introduced.
- Built-in/catalog IDs, connection identity and legacy policy/golden contracts remain unchanged.
- No real credentials, provider sign-in, paid inference, later NXR-070 slice, T3 integration or upstream automation was used.
- Existing upstream dependency debt is unchanged; the tree is not declared vulnerability-free.

## Review independence and findings

The separate read-only review agent checked B′/C′ authority/settlement paths and stabilization changes. It found a P2 teardown issue in the first revision: one failed close prevented attempts on remaining owned apps. That issue was corrected and re-reviewed before acceptance. It also identified the callback completion-ordering defect, subsequently covered by deterministic regressions on B′.

No new confirmed credential-scope, immutable-binding, required-diversity or execution-admission bypass was found in the inspected source. This is a focused review with executed regressions, not proof that every possible vulnerability is excluded.

**INDEPENDENT_OWNER_REVIEW_PENDING.** Root-cause and platform gates remain separate from source-review findings.
