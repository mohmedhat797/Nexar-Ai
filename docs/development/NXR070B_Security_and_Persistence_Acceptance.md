# NXR-070B′ Security and Persistence Acceptance

**Date:** 2026-10-18

**Implementation:** `96f8b6a16562e308cc0502d7fc577b563fcb4153`

**Acceptance:** Windows Full Local CI PASS; hosted execution/owner acceptance outstanding

## Security authority and account isolation

The actual Desktop main process supplies one ConnectionManager, gated by the existing FileSessionStore writer lease. A second instance cannot mutate credentials or admit credential-bearing work behind the first. The manager serializes complete mutations and admissions. SettingsStore's own write queue and KeyStore's file queue remain lower-level protections.

Persisted records are validated as an aggregate: map key/ID/family/provider, canonical built-ins, host, exact credential ownership, generation, timestamps, lifecycle/enabled/tombstone agreement, assurance evidence and permanent retirement. Invalid records and unreadable authority are not repaired or deleted automatically.

Execution validates the selected descriptor against that authoritative record. Owner catalog IDs use the existing host-qualified connection materializer. The descriptor cannot borrow another connection's or built-in credential. The existing Pi resolver uses the specified source without environment fallback. Admission rejects disabled, removed, forgotten and stale resources.

## Assurance and private Plan identity

API creation starts at IDENTITY_UNKNOWN. Rotation/re-entry requires `sameAccount: true` and records a timestamped owner assertion without email, subject or key. Owner assertion is not provider verification.

Built-ins do not fabricate verified or asserted identity. Plan verification and decoded binding validation remain inside `chatgpt-plan.ts`; other modules receive only boolean assurance evidence or opaque encrypted-store payloads. The private verified subject is compared there against the retained binding. Forget/ordinary Remove retain binding. Different/invalid identity is rejected. A legacy token's previously verified private subject is used when a separate binding has not yet been written.

Replace requires a confirmed target, idle execution/authentication state and one recoverable transaction. It permanently retires the old ID, deletes old tokens/binding, and allocates a new opaque ID. Future owner sign-in binds the new ID. At most one non-tombstoned Plan connection exists. Ordinary removed/disabled Plan credential re-entry can verify the same account without enabling execution or bypassing explicit Restore.

## Credential/settings transaction protocol

1. Validate current state and idle/consent restrictions inside the shared queue.
2. Build validated target records and exact base/target digests.
3. Encrypt and atomically persist credential changes plus the reference-only redo journal in the existing guarded KeyStore file.
4. Persist settings through the existing atomic writer, requiring a valid-primary backup when applicable.
5. Remove the journal, publish the new generation and notify composition/inventory.

The journal contains no key, token or subject. Recovery accepts only the expected base or committed target, validates the resulting target, completes settings and removes the journal. Repeated replay is idempotent. Failed or unprovable reconciliation blocks admission. A rejected operation may have committed durable state before losing acknowledgement; the caller is not told it succeeded, and the next operation reconciles before proceeding.

## Executed fault and concurrency coverage

| Fault / race                                                     | Required result                                                     | Regression                                  |
| ---------------------------------------------------------------- | ------------------------------------------------------------------- | ------------------------------------------- |
| Matching RNG Add/Add; Add/Remove                                 | No duplicate identity, lost record or orphan credential             | Authority deterministic barriers            |
| Rotate/Rotate; Rotate/Forget; Remove/Rotate                      | Serialized, exact final generation/state                            | Authority barriers                          |
| Remove/Restore; Restore/admission; Disable/admission             | One legal ordering, no tombstone bypass                             | Authority and actual runtime tests          |
| Refresh/Remove; refresh completes after Disable                  | Active mutation refused; stale publication discarded                | Runtime publisher tests                     |
| Before/during credential preparation; encryption failure         | Old complete stores retained                                        | Authority + KeyStore tests                  |
| After credential commit / lost acknowledgement                   | Journal reconciles before admission                                 | Authority restart/fault tests               |
| Before/during settings temp write; before rename                 | Old primary retained, temp cleaned                                  | Settings recovery + atomic writer tests     |
| After rename acknowledgement loss                                | Re-read committed disk, not stale cache                             | Settings recovery tests                     |
| Required backup failure                                          | Primary update refused                                              | Settings recovery tests                     |
| Corrupt primary/backup or unexpected valid recovery base         | Evidence retained; no automatic credential/state rollback           | Settings recovery and digest mismatch tests |
| Token deletion / replacement settings failure                    | No false success; deterministic recovery, permanent retirement      | Plan binding and authority tests            |
| Native probe/login and active direct/delegated/Control execution | Lease retained until actual settlement; prohibited mutation refused | Guard, subscriptions and runtime tests      |

## Backup and rollback limits

First run with no primary does not require inventing a backup. Existing valid primary settings are backed up before replacement; a required backup failure propagates. Invalid primary data cannot overwrite a known-good backup. A corrupt backup does not invalidate a valid primary. Corrupt primary authority fails closed even if ordinary appearance defaults remain usable.

No automatic backup restoration is claimed. Do not copy an older credential store over a newer committed generation. Preserve corrupted bytes, current encrypted credentials, journal and backups for controlled reconciliation.

The additive fields are optional for valid historical readers in the hardened implementation. A regression verifies legacy settings, new assertion/retirement metadata, unrelated appearance writes and restart reconstruction. Canonical session/memory schemas and writers are unchanged.

A rollback binary must retain this hardened authority and current state. Pre-remediation binaries do not understand permanent retirement and must not use an upgraded writable profile. Arbitrary old-binary downgrade, disk corruption recovery without evidence, and universal power-loss durability are not verified capabilities.

## IPC and UI

Sensitive actions use expiring single-use host-issued tickets bound to action, connection, generation/lifecycle and saved-reference consequences. Forget additionally requires the selected label. Wrong/unknown/path-like IDs, raw credential names, subjects, oversized inputs, stale/replayed tickets and missing assertions reject with fixed errors. Existing trusted-window IPC remains intact.

Renderer keys exist only in transient password-input state and are cleared before submission. They are not saved to renderer persistence. Confirmation cancellation makes no persistent mutation. The legacy raw Remove/Disconnect routes cannot bypass the production authority.

Existing KeyStore tests cover ciphertext, secret-free errors, unavailable encryption, symlinks/hardlinks, file identity, atomic replacement and actual Windows ACL protections. No real owner profile or credentials were changed.

## Platform and scan evidence

Current connection eligibility is applied before control selection/preview even while registry probes settle. Cowork runtime-version discovery can remain cached, while control availability is recomputed against NRC. Preview applies the same managed-pin checks as admission, including legacy built-ins. The isolated production lane continues to block rather than falling back to host execution; explicit regressions cover that distinction.

Windows Full Local CI returned `NEXAR_WINDOWS_FULL_PASS` on clean source `96f8b6a16562e308cc0502d7fc577b563fcb4153`, tree `cbd4d26018133bc6426f9cc7cd979cd5b3feed7c`, with 16/16 required stages passing in 1749.94s. The optional native Linux stage was BLOCKED on Windows and is not counted as passed. Raw report: `.nexar/ci/reports/report-2026-10-18T02-57-15-465Z.json`; SHA-256 `3df3cf845036b3607a61b01717074390d9c5f7076b0c38a3042bbdb9d6451c24`. Start/end source identity was stable and clean.

Windows offline tests: **4,467 passed, 167 skipped, four pending, zero failed** (4,638 total; 245 files). Real DSH context: **3/3**; isolated Cowork Windows/WSL bridge acceptance: **8/8**; source Desktop: **27/27**; packaged Desktop: **27/27**. Skipped/pending cases are not counted as passes. The four pending Windows assertions are actual Linux Bubblewrap cases covered by the WSL run.

The separate WSL checkout at `9dc1909619e41c6b3632179934abe0d696ea665d`, tree `b9c3203e6292b26b4bd06c9216a03157839ad139`, passed **4,609 tests, 29 skipped, zero failed** (4,638 total). Its production and test source is identical to the Windows revision: the only intervening change is `.gitleaks.toml`. Raw WSL report: `/home/nexar/src/nxr070b-remediation-20261018/.nexar/ci/remediation-wsl-control-final-tests.json`, SHA-256 `a924579dc50241a6c5f52c4a667b3435b82ccfd1e6326478de226e7e5e723693`. The real kernel gate also passed 15/15 assertions.

The earlier Windows run at `9dc1909` retained a FAIL result because Gitleaks detected seven synthetic test fixtures. Their literal source values were inspected; exact path-and-value exceptions were added while retaining default rules and full-history scanning. The clean rerun above passed Gitleaks. Historical failed/incomplete runs remain evidence and are not relabelled PASS.

Hosted CI is separate: the pre-publication run at `b6ffde9` failed before steps due to account billing/spending restrictions. Final remote identity and post-push hosted status are recorded in the publication receipt and PR description. No live vendor login, real key or paid inference was used.

WSL2/Bubblewrap and Coding protections remain unchanged. Existing accepted isolation tests run against synthetic fixtures; no AppContainer experiment, security identity change or sandbox permission change was performed. Live provider acceptance and external token revocation remain untested by design.
