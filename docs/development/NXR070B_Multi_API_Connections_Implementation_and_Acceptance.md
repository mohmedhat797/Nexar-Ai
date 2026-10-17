# NXR-070B′ Multi-API Connections Implementation and Acceptance

**Date:** 2026-10-18  
**Implementation:** FINAL_IMPL_PENDING  
**Acceptance:** FINAL_CI_PENDING

This corrected report supersedes the original B′ implementation acceptance claims. Historical `pnpm check` success did not establish production wiring, execution admission, identity assurance, Windows packaging or complete lifecycle safety. The independent audit established those gaps; the remediation adds the missing production behavior and regression evidence.

## Production implementation

ConnectionManager is the shared connection mutation/admission authority, gated by Desktop's existing canonical writer lease. SettingsStore validates aggregate identity/lifecycle ownership. DesktopKeyStore retains its encryption, identity, ACL/link and atomic replacement protections while adding credential+journal batching.

ConnectionRuntime consumes persistent owner definitions in actual Desktop composition. It uses the accepted `catalogResourceId` helper, publishes through the existing Registry, and preserves NRC filters, default policy and selection explanations. Each credential-bearing execution validates its selected resource's authoritative provider, host, scope and generation. No account/environment substitution is added.

Control leases span the whole decision across model requests. Direct, delegated, native probe/login and inventory operations hold their actual operation lifetimes. Disable refuses new admissions while existing authorized work drains. Rotate, Forget, Remove and Replace refuse prohibited bound work. Late inventory results cannot republish disabled/retired/rotated authority.

API continuity is owner-asserted explicitly; it is never presented as provider-verified. Plan subjects stay inside the Plan module and encrypted private store. Ordinary Forget/Remove retain binding. Replace permanently retires the old identity, forgets its tokens/binding and allocates one new identity. Old resource IDs and sessions are never redirected.

The minimum Providers UI implements Add/List/Rotate/Disable/Enable/Remove/Restore/Forget/Plan Replace. Sensitive confirmations are enforced by main-process tickets, not renderer state alone. API keys remain transient password input.

## Requirements traceability

The requirement wording below is abbreviated from the accepted reconciled blueprint; later-milestone portions are explicitly distinguished.

| Requirement / acceptance | B′ implementation and evidence                                                                                                                     | Limit                                                                                                                                  |
| ------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| REQ-04 / TST-04          | Accepted materializer, same-model A/B IDs, stability through rotation/refresh/restart; catalog and runtime tests, existing A′ goldens              | Legacy IDs preserved                                                                                                                   |
| REQ-08 / TST-08          | Real Engine/NRC/Gateway/Pi transport receives only selected A/B credential; forged scope rejection                                                 | Native multi-home extension belongs to D′                                                                                              |
| REQ-09, REQ-38 / TST-09  | Control/direct/delegated/refresh/native activity lease tests; deterministic mutation/admission barriers                                            | External vendor processes outside Nexar cannot be assumed immutable                                                                    |
| REQ-10 / TST-10          | Fake IdP verifies same/different/invalid identity; binding stays private                                                                           | No live provider login                                                                                                                 |
| REQ-11 / TST-11          | Disable drain, refused new admission, stale-refresh discard and explicit pin failure                                                               | Disable is not cancellation                                                                                                            |
| REQ-12 / TST-12          | Active Remove refused; idle tombstone retains credentials; Restore retains identity                                                                | Permanent replacement cannot Restore                                                                                                   |
| REQ-13 / TST-13          | Active Forget refused; only selected credential deleted; assertion/private comparison on re-entry                                                  | Local deletion is not provider revocation                                                                                              |
| REQ-15 / TST-15          | Strict existing-ID IPC, fixed errors, host-bound confirmations, fuzz/path/scope/subject/oversize/replay tests                                      | Existing trusted-window restriction retained                                                                                           |
| REQ-16 / TST-16          | Additive settings, strict semantic validation, backup/fault tests, corruption preserved and authority blocked                                      | Stricter whole-authority refusal for unreadable primary; no automatic backup restoration or pre-remediation writable-profile downgrade |
| REQ-36 / TST-41          | Honest default/native unknown; explicit owner assertion; private verified Plan binding evidence                                                    | Credential presence does not imply authentication/reachability                                                                         |
| REQ-37 / TST-41,42,57    | Immutable identity and same-account re-entry; new key on Replace; history/pins retained                                                            | Review-dimension execution in C′/F′ is not implemented here                                                                            |
| REQ-39 / TST-43          | Serialized matching-RNG Add/Add, restart, tombstones, Restore and permanent retirement                                                             | Retired identities are not garbage-collected or reused                                                                                 |
| REQ-46 / TST-58          | Encrypted private binding retained across Forget/ordinary Remove; deleted only by Replace                                                          | No subject in DTO/settings/session/telemetry                                                                                           |
| REQ-47 / TST-57          | Confirmed sequential replacement, active/sign-in/refresh refusal, deletion/settings fault recovery, new opaque ID, old retirement, one active Plan | Concurrent multi-Plan remains deferred                                                                                                 |

## End-to-end acceptance matrix

| Capability               | Implementation                                      | Runtime Integration                                  | Regression Tests                                                 | Status                    |
| ------------------------ | --------------------------------------------------- | ---------------------------------------------------- | ---------------------------------------------------------------- | ------------------------- |
| Multi API Connections    | Persistent validated owner records                  | Desktop publisher → Registry/NRC                     | Actual bridge A/B and Desktop restart                            | CAPABILITY_STATUS_PENDING |
| Credential Isolation     | Authoritative scope validation                      | Pi transport A/B/new B                               | Cross-scope/provider/host/generation negatives                   | CAPABILITY_STATUS_PENDING |
| Connection Identity      | Accepted ID allocator/materializer                  | Host-qualified descriptors                           | Collision, rotation, refresh, restart, golden IDs                | CAPABILITY_STATUS_PENDING |
| Account Assurance        | Explicit assertion/private Plan evidence            | Main/DTO/UI                                          | Same/different/invalid/missing binding                           | CAPABILITY_STATUS_PENDING |
| Serialized Mutations     | Whole transaction queue                             | Same admission authority                             | Deterministic concurrent barriers                                | CAPABILITY_STATUS_PENDING |
| Recoverable Transactions | Guarded KeyStore journal + settings                 | Restart before admission                             | Encryption/write/backup/rename/ack/deletion/replay faults        | CAPABILITY_STATUS_PENDING |
| Execution Leases         | Decision and actual operation lifetime              | Gateway, adapters, delegation, probes, auth, refresh | Held transport and cleanup cases                                 | CAPABILITY_STATUS_PENDING |
| Lifecycle Enforcement    | Legal state machine                                 | Publication, pins and admission                      | Remove→Disable→Enable, missing credentials, Restore, retired IDs | CAPABILITY_STATUS_PENDING |
| Plan Replacement         | Private binding and permanent sequential retirement | Real Plan service and callback fixtures              | Fake IdP, failure/restart, Desktop replacement                   | CAPABILITY_STATUS_PENDING |
| Resource Publication     | Persistent source definitions                       | Actual Desktop EngineHost                            | Runtime and Desktop A/B resource listing                         | CAPABILITY_STATUS_PENDING |
| NRC Selection            | Existing hard filters/policy preserved              | Actual selection / allocator                         | Control/direct/delegated execution                               | CAPABILITY_STATUS_PENDING |
| Model Execution          | Connection-bound reference resolution               | Actual Pi adapters/ports                             | Synthetic provider transport; real fixture DSH separately        | CAPABILITY_STATUS_PENDING |
| Desktop UI               | Existing Providers management                       | Actual preload/main/persistence                      | Source and packaged lifecycle/confirmation tests                 | CAPABILITY_STATUS_PENDING |
| Windows Acceptance       | Established Full Local CI                           | Real Windows build26300                              | Final source-bound CI report                                     | PLATFORM_STATUS_PENDING   |
| WSL2 Security            | Existing mandatory boundary retained                | Actual WSL transport and Bubblewrap                  | Real kernel and DSH fixtures                                     | PLATFORM_STATUS_PENDING   |
| Packaged Desktop E2E     | Supported packaged harness                          | Bundled DSH, no external entry                       | Final packaged suite                                             | PLATFORM_STATUS_PENDING   |

## Executed results

FINAL_ACCEPTANCE_SUMMARY

For commands, raw reports, environment, installer identity, exact source/tree and publication state, see [the owner handover](NXR070B_Final_Owner_Handover.md). See also the [finding matrix](NXR070B_Findings_Closure_Matrix.md), [runtime proof](NXR070B_Runtime_Integration_Verification.md) and [security/persistence report](NXR070B_Security_and_Persistence_Acceptance.md).

## Boundaries and remaining acceptance

DSH remains `@deepseek-ai/dsh@0.2.0-rc.2`; accepted ADRs and dependency pins are unchanged. No second controller/harness, future review policy, native multi-home support, T3 integration or active updater was introduced. Session/Project Memory writers and schemas are unchanged.

Synthetic tests establish transport/account isolation without real credentials or paid inference. They do not establish live provider readiness. Corrupt authority intentionally requires controlled reconciliation. Rollback must retain the hardened authority and current stores; an older unsafe binary must not open an upgraded writable profile.

FINAL_VERDICTS
