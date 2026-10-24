# NXR-070B′/C′ — Combined Security and Integration Review

Date: 2026-10-24. Engineer: OpenAI Codex. Final acceptance evidence is recorded separately in the stabilization report.

## Scope and dependency integrity

Starting ancestry: main `41b918b` → B′ `18c7cd0` → C′ `4c69766`. C′ stabilization commits `2bdf80a` and `2887939` concern Desktop test isolation, process cleanup, diagnostics and CI identity. The production callback correction belongs to B′ commit `f1482e6`; C′ received it through non-destructive merge `b618fbe`. C′ acceptance source is `1c584208c8580ef3d9ba94e510fb30c58d88796d`. The identical11 shared infrastructure files were subsequently backported to B′ commit `aa803793f5b4ec0ff2105b5f19b86f3a0bdb01c3`, without C′ feature code. No main merge, force-push, runtime upgrade or architecture-status change occurred.

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

The final clean C′ aggregate report `report-2026-10-24T01-29-48-293Z.json` passed all16 required stages at `1c584208`, tree `ec47d9ff4db3eed7fdde870c1a2b60773fa5225b`. Offline:4,535 passed,169 skipped,4 pending,0 failed. Relevant passed files: authority21, manager19, consent5, runtime12, Plan10, diversity43, legacy golden corpus1, Gateway bridge34, lifecycle5, callback-server10 and private-state19 (2 POSIX skipped). Private-state includes8 actual native ACL tests and11 tool/boundary tests. Supplemental same-source serial WSL full suite:4,678 passed,30 skipped,0 failed,0 pending. Full report identity, exact commands, installer/helpers and hashes are in [Windows acceptance](NXR070_Windows_Acceptance_Stabilization.md).

### Final call-graph review anchors

`apps/desktop/src/main/connection-manager.ts:668` validates resource/provider/host/scope/generation; its serialized admission at736 shares the mutation authority. `packages/host/src/inventory-guard.ts:45` retains an execution lease and releases it in finally; lines34–42 retain the probe/refresh lease. Private Plan subject comparison remains in `apps/desktop/src/main/chatgpt-plan.ts:456`; permanent retirement remains in ConnectionManager608. These source anchors must be read alongside the tests, rather than treating a descriptor or a stored connection as proof of execution. The12 connection-runtime tests use actual persisted connection publication, Registry/NRC and synthetic transport, demonstrating A/B credential separation and lifecycle invalidation without paid inference.

B′ manager, KeyStore, SettingsStore, Plan service and callback production blobs at `f1482e6` match tested C′ `1c584208` exactly. Registry materialization differs only in its input type (ConnectionDefinition to the relevant id/machine/builtIn Pick), leaving the canonical ID body unchanged. Stabilization adds no second account, routing or credential authority.

## Review Diversity and settlement

Resource, immutable connectionKey and canonical provider preferred/required constraints share existing NRC hard filters. Unknown identity cannot prove independence; host remains attribution. Planning, dynamic allocation and revalidation retain reviewed allocation identity and dimension-specific unavailable reasons.

The Gateway race regression at `packages/engine-gateway/src/bridge.test.ts:153` explicitly holds an unrelated allocation computed from an earlier ledger. The writer settles to actual resource `b` before release. Assertions require identity `b`, settled cost 0.25 and reviewer `a`. Cancellation preserves valid state and the monotonic unit limit.

Production anchors: `bridge.ts:532` retains allocation input; `:552–564` reconciles later settlements/cost; `:639` records actual execution identity and cost. Existing Engineering Lane/core execution paths allocate/revalidate through NRC before adapter execution. Failed required diversity cannot authorize extra work or downgrade into the implementation account/provider.

## Stabilization security review

The native ACL guard is unchanged. The test still captures marker existence before the first promise yield. Existing owner/private ACL, parent preservation, hard-link/junction and fail-closed tool assertions remain. A stale marker never substitutes for a current ACL check. The underlying historical startup failure remains unexplained.

The E2E harness observes owned OS process exit before profile reuse/removal, attempts all closes despite errors, retains profiles on incomplete cleanup and preserves diagnostics. It does not claim every detached descendant is universally detected.

The callback correction preserves host/method/path/state validation and reserves the first outcome before draining. Only HTTP finish permits publication. An aborted response publishes no authorized outcome; existing cancellation/lifetime bounds remain. A separate reviewer found no actionable security defect in this change. Attribution of the prior intermittent Plan failure remains unproven.

## Invariants retained

The focused canonical-store check found no actionable proof of a late progress write restoring a terminal turn to running. `packages/sessions/src/store.ts:511` serializes the complete read–transition–write operation per session and rereads authoritative state inside that boundary. Task updates at `transitions.ts:272` preserve current turn state and require an open turn; completion at453 accepts running only and clears the active-turn reference. Operating progress at `packages/operating/src/service.ts:654` broadcasts without rewriting stored state. Earlier queued task writes settle before completion; later ones reread terminal state and are rejected. These paths remain unchanged. This narrows the SOW investigation; it does not establish its historical cause.

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

Latest standalone B′ source06e55f36 completed all16 required Windows stages and its serial WSL full suite. B′actual counts are runtime9, Plan9 and Gateway31, versus C′12/10/34 at its previously tested source. The new harness corpus has4 cases. Source/packaged B′Desktop each passed29/29. The four Windows pending Bubblewrap cases passed on B′WSL; live-provider tests remained skipped. The propagated diagnostic changes affect only test infrastructure and documentation; no new production authority, routing, credential, session, memory or isolation behavior was introduced. Final C′acceptance remains pending.

**INDEPENDENT_OWNER_REVIEW_PENDING.** Root-cause and platform gates remain separate from source-review findings.
