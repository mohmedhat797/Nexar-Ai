# NXR-070B′ Remediation Closure Report

**Date:** 2026-10-18  
**Engineer:** OpenAI Codex  
**Scope:** PR #44, `feat/nxr-070b-multi-api-connections`  
**Implementation revision:** FINAL_IMPL_PENDING  
**Platform result:** FINAL_CI_PENDING

## Baseline and evidence

The audited remote HEAD was `b6ffde924cd3c6546b9cddbe835c5285f6625c08`, tree `7ede253dd585d5d85f539df8b1d366f1fb3b5d90`. Main and the merge base were `41b918bf3c32cfd47301f7551a7280368fc3c8ec`. The remote had not moved at the publication precheck.

The independent audit remains frozen at `D:/Nexar-Ai-main/.nexar/nxr070b-audit/docs/development/audits`. Its four documents were read in full. Their original defect observations remain historical evidence; corrected tests assert the required behavior instead of preserving defect assertions.

| Original document                         | SHA-256                                                          |
| ----------------------------------------- | ---------------------------------------------------------------- |
| Independent Security and Functional Audit | b9433817ebb522a3f4bb28f345b50ff64fc0638758bd6b0fc5ef7deecad45100 |
| Independent Findings Register             | 9f81ca3511236102e6073d8bc5faf4c26bc5229856ef3c2dba5fb2b8fdd44cf3 |
| Audit Requirements Traceability           | 79508648d57db59a167fb6602c239146cab8b3451947ac277a12764280aedf12 |
| Independent Remediation Plan              | 6fce1ba444c3a13c4ee38d0d5f322b59f52d8933f45d58fd6974faf7319bda41 |

## Completed work packages

| Package | Production correction                                                                                                                                                                                                         | Regression evidence                                                                               |
| ------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| WP-1    | One serialized mutation/admission authority; aggregate validation; collision-safe allocation; explicit legal lifecycle; canonical Desktop writer lease gates mutations and admissions across instances                        | `connection-authority.test.ts`, `connection-manager.test.ts`                                      |
| WP-2    | Guarded atomic credential batch plus encrypted reference-only redo journal; base/target state digests; fail-closed replay; required backup failure propagation; lost acknowledgement cache invalidation                       | `connection-authority.test.ts`, `settings-recovery.test.ts`, existing KeyStore/atomic-write tests |
| WP-3    | Real Control decision leases across requests; direct/delegated adapter leases; native probe/login leases; inventory fetch leases; idempotent terminal cleanup                                                                 | `connection-runtime.test.ts`, `inventory-guard.test.ts`, `subscriptions.test.ts`                  |
| WP-4    | Honest assurance; explicit API continuity assertion; private retained Plan binding; verified subject comparison; permanent sequential replacement; recoverable expiry/deletion; removed-account re-entry without reactivation | `plan-binding.test.ts`, `chatgpt-plan.test.ts`, consent and Desktop tests                         |
| WP-5    | Persisted owner connections feed real Desktop composition, canonical catalog IDs, Registry, normal NRC selection and connection-bound credential resolution                                                                   | `connection-runtime.test.ts`, `multi-connection.test.ts`                                          |
| WP-6    | Minimum Providers management UI; target-bound, expiring host confirmations; named Forget; assertion checkbox; safe cancellation; corrected reports                                                                            | `connection-consent.test.ts`, `connections.e2e.ts`, updated Providers/Plan E2E                    |

The detailed F01–F13 result is in [the closure matrix](NXR070B_Findings_Closure_Matrix.md). No finding severity was reduced.

## Acceptance evidence and limits

FINAL_ACCEPTANCE_SUMMARY

The raw evidence lives in this worktree's `.nexar/ci`, with source identity recorded in the final local-CI report. [Runtime verification](NXR070B_Runtime_Integration_Verification.md) and [security/persistence acceptance](NXR070B_Security_and_Persistence_Acceptance.md) identify the exercised boundaries.

The initial fresh WSL run lacked built workspace `dist` outputs and failed bundle-based tests. Its raw report is preserved as `remediation-wsl-tests.json`. Building the workspace corrected that preparation error. An earlier Full CI at `0ce0f64` passed its first 12 gates and was stopped before completing Desktop acceptance to move private binding validation into the Plan module. That run is incomplete, not a Full CI PASS.

New regressions are paired with the immutable audit's counterexamples. The entire new suite was not transplanted onto the old API surface, so this report does not claim every new test was separately executed red on the historical tree.

## Preserved authorities

ADR-029/030 remain Accepted without status edits. DSH remains exactly `@deepseek-ai/dsh@0.2.0-rc.2`; both dependency lockfiles are unchanged. NRC remains the selector; Permission Broker remains authoritative. FileSessionStore and ProjectMemoryStore implementations and persisted session/memory contracts are unchanged. WSL2/Bubblewrap remains the production Cowork boundary; Coding isolation is unchanged. UI-01 remains passive. No C′ or later milestone, second harness, T3 integration, or upstream updater was implemented.

## Remaining operational limits

- Real vendor credentials, sign-ins and paid inference were not used. Synthetic model transport and a cryptographically verified fake IdP are the account/credential execution evidence.
- Corrupted primary authority fails closed; a `.bak` file is not automatic recovery. Reconciliation must preserve current credentials, generations and retired identities.
- Supported code rollback must retain the hardened connection authority and current credential/settings state. A pre-remediation binary cannot enforce new retirement/binding rules and must not open an upgraded writable profile. No arbitrary old-binary downgrade or universal power-loss durability is claimed.
- Native-home multi-account management, review diversity and future routing policy remain outside B′.
- Earlier Gateway/Providers observations are not universally explained. The newly captured stale-readiness failure is corrected with deterministic and Desktop evidence described in the runtime report; existing diagnostics remain.
- Upstream dependency debt is not declared resolved or vulnerability-free.

FINAL_VERDICTS
