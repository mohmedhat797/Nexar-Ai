# NXR-070B′ Final Owner Handover

**Date:** 2026-10-18  
**Engineer:** OpenAI Codex  
**Target:** Draft [PR #44](https://github.com/mohmedhat797/Nexar-Ai/pull/44)  
**Implementation:** FINAL_IMPL_PENDING  
**Current acceptance:** FINAL_CI_PENDING

This report supersedes the original implementation handover's unsupported completeness, production integration and Full CI claims. The independent audit and original history remain unchanged.

## A. Executive summary

All six remediation work packages are implemented locally. Owner connections now reach the real Desktop composition, Registry, NRC and model execution. One connection authority serializes mutations and execution admission; actual Control/direct/delegated/native/refresh activity holds leases. Credential/settings changes use a guarded encrypted redo transaction. Plan identity is retained privately, and sequential replacement permanently retires the old identity. Minimum Desktop management and host-enforced confirmations are implemented.

FINAL_ACCEPTANCE_SUMMARY

The original 13 findings retain their original severities. See [the findings closure matrix](NXR070B_Findings_Closure_Matrix.md) for each root cause, fix, regression and status. No merge is authorized by this report.

## B. Repository state

| Field                            | Value                                              |
| -------------------------------- | -------------------------------------------------- |
| Worktree                         | `D:/Nexar-Ai-main/.nexar/nxr070b`                  |
| Branch                           | `feat/nxr-070b-multi-api-connections`              |
| Main / merge base                | `41b918bf3c32cfd47301f7551a7280368fc3c8ec`         |
| Initial PR HEAD                  | `b6ffde924cd3c6546b9cddbe835c5285f6625c08`         |
| Initial implementation tree      | `7ede253dd585d5d85f539df8b1d366f1fb3b5d90`         |
| Final tested implementation SHA  | FINAL_IMPL_PENDING                                 |
| Final tested implementation tree | FINAL_TREE_PENDING                                 |
| Published PR HEAD                | FINAL_PUBLICATION_PENDING                          |
| PR status                        | Draft; not merged                                  |
| Audit worktree                   | `D:/Nexar-Ai-main/.nexar/nxr070b-audit`, unchanged |

The implementation SHA identifies production code tested by platform acceptance. A later evidence-only commit may change documentation/tree identity without changing production source. The post-push publication receipt records the final remote SHA; a Git document cannot embed the SHA of its own containing commit.

## C. Findings closure

F01–F04 remain P1, F05–F12 remain P2, and F13 remains P3. No severity was reduced. FINDINGS_SUMMARY_PENDING

The [closure matrix](NXR070B_Findings_Closure_Matrix.md) is authoritative for individual status and links to executable regression sources. Original audit counterexamples are preserved separately; this report does not relabel their defect-observation assertions as compliant tests.

## D. Work packages

| Package | Delivered                                                                                                                                     |
| ------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| WP-1    | Single serialized authority, canonical writer lease, aggregate semantic validation, atomic collision checks and legal lifecycle               |
| WP-2    | Existing KeyStore batch, encrypted reference-only redo journal, state digests, restart reconciliation, backup/rename/acknowledgement failures |
| WP-3    | Real Control decision, direct adapter, delegated unit, native probe/login and inventory refresh leases                                        |
| WP-4    | Explicit API assertion, honest assurance, private retained Plan binding, sequential recoverable replacement and permanent retirement          |
| WP-5    | Actual persisted owner discovery/publication, accepted canonical IDs, normal NRC filtering/selection and connection-bound credentials         |
| WP-6    | Existing Providers UI extended with minimum management, cancellation and host-bound confirmations; documentation corrected                    |

## E. Runtime integration

The actual path is Providers/preload → validated main-process IPC → ConnectionManager/SettingsStore/KeyStore → ConnectionRuntime → canonical catalog materialization → EngineHost/Registry → NRC → execution admission → validated connection scope → Pi model transport → normal accounting/result and cleanup.

`connection-runtime.test.ts` demonstrates two bridge-created same-provider/same-model accounts observing their own synthetic keys at transport, plus restart, Disable, Rotate, Forget, re-entry, Remove, Restore and stable identity. Other cases exercise actual direct Desktop execution and IntelligenceBridge delegation. The normal publication test never hand-injects owner resource descriptors.

See [runtime integration verification](NXR070B_Runtime_Integration_Verification.md).

## F. Credential and identity security

Unknown identity stays unknown. API rotation requires explicit same-account assertion and records non-secret provenance. Plan subject verification/comparison and decoded binding validation remain inside the trusted Plan module. The renderer receives neither subject nor private credential scope.

Forget retains account binding; ordinary Remove is reversible only as the same account. Same-account credential re-entry does not activate a tombstone. Replace rejects active work/sign-in/refresh, deletes old tokens and binding transactionally, permanently retires the old ID and creates one new opaque Plan identity for future explicit sign-in. It provides no concurrent multi-Plan capability.

No real provider credential, login or paid model request was used. Fake IdP signature verification is not a claim of live OpenAI account acceptance.

## G. Persistence and recovery

Complete mutations share one queue with admission. Guarded credential changes and an encrypted metadata-only redo journal commit in the same existing KeyStore file. Settings then commit with required valid-primary backup; journal cleanup precedes normal publication. The journal's base/target digests prevent replay against unexpected authority.

Fault tests cover preparation/encryption, split commit, lost acknowledgement, settings temp/rename, backup, deletion and replay/restart failure. Recovery either proves a coherent state or blocks admission. Corrupt primary bytes are preserved; backup existence does not imply automatic restoration.

Optional assertion/retirement fields preserve valid historical settings under hardened readers. Unrelated appearance writes and restart retain the new fields. Canonical session and Project Memory implementations/schemas were not changed.

Rollback must retain the hardened authority and current credential/settings state. Pre-remediation binaries must not open an upgraded writable profile; arbitrary old-binary downgrade and universal power-loss durability are not claimed.

See [security and persistence acceptance](NXR070B_Security_and_Persistence_Acceptance.md).

## H. Tests

FINAL_TEST_TABLE

Raw logs and JSON are retained in `.nexar/ci`. Reports distinguish passed, skipped and pending assertions. The first fresh WSL run failed because the checkout had no built `dist` outputs; after `pnpm exec tsc -b`, the suite passed. An earlier Full CI was deliberately stopped after 12 passing gates for the private-binding boundary change; it is not represented as full acceptance.

Meaningful corrected tests replace defect-preserving observations, without deleting the immutable audit evidence or weakening existing assertions to accept defects.

## I. Windows / WSL acceptance

FINAL_PLATFORM_TABLE

Windows acceptance uses disposable Desktop profiles, synthetic keys and fixture services. Packaged acceptance uses the packaged executable and its bundled DSH, with external DSH-entry overrides removed by the supported harness. Installer identity and helper/runtime association are recorded by the package verification stage. Installing/uninstalling on the owner's real profile is not claimed.

WSL runs use a separate checkout pinned to the tested revision, not the historical `/home/nexar/src/Nexar-Ai` checkout. No mount policy, security identity or sandbox permission was changed. Native Ubuntu Full CI is not substituted by WSL testing.

## J. GitHub

PUBLICATION_SUMMARY_PENDING

The correction commits remain on the existing PR branch. No force-push, main push, merge, ADR-status change or Ready-for-Review transition is authorized or performed. Hosted jobs are evaluated separately from executed local tests; an infrastructure-blocked run is neither a code failure nor a pass.

## K. Remaining risks

- Live vendor authentication, actual key validity, paid inference, account quota and external revocation remain untested by authorization.
- Pre-remediation binary downgrade on an upgraded writable profile is unsupported; preserve hardened authority and current state.
- Corrupt authority requiring unprovable manual reconciliation remains unavailable, intentionally.
- Historical intermittent Gateway child exit and Providers timeout were not root-caused here; diagnostic coverage remains.
- Pinned upstream dependency debt remains tracked; no vulnerability-free claim or dependency upgrade is made.
- Later native-home/account management, review diversity, routing changes and upstream update execution remain outside B′.

The next owner action is independent acceptance of the Draft PR and its raw evidence. This handover does not start C′ or authorize a merge.

## L. Final verdicts

FINAL_VERDICTS
