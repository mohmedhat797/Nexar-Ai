# NXR-070B′ Runtime Integration Verification

**Date:** 2026-10-18

**Implementation:** `96f8b6a16562e308cc0502d7fc577b563fcb4153`

**Acceptance:** Windows Full Local CI PASS; hosted execution/owner acceptance outstanding

## Production path

```text
Providers / preload IPC
  → ConnectionManager (canonical Desktop writer, serialized authority)
  → validated SettingsStore record + DesktopKeyStore transaction
  → ConnectionRuntime catalog discovery
  → accepted catalogResourceId materializer
  → EngineHost extraResources / Resource Registry
  → existing NRC filters and selection
  → shared execution admission
  → validated connection credential reference
  → Pi model transport
  → normal result/accounting and lease cleanup
```

| Boundary               | Production source                                                                                | Executed evidence                                                                                                   |
| ---------------------- | ------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------- |
| Owner creation         | `connection-channels.ts`, `preload.ts`, shared `connections.ts`                                  | Real bridge Add A/B in runtime tests; actual UI Add in Desktop tests                                                |
| Persistence/restart    | `connection-manager.ts`, `settings-store.ts`, `desktop-key-store.ts`                             | Separate manager/store reconstruction; actual Desktop close/relaunch                                                |
| Discovery              | `connection-runtime.ts:descriptors`                                                              | Starts only from persisted definitions; no manufactured owner descriptors in the normal publication test            |
| Identity               | `integrations/pi/src/catalog-discovery.ts`, Registry `catalogResourceId`                         | Same provider/model, distinct A/B IDs, stable after Rotate/re-entry/restart                                         |
| Publication            | `main.ts` → `createEngineHost` → `extraResources`                                                | Real EngineHost snapshots and renderer resource listing                                                             |
| Selection              | Existing NRC / Gateway `selectControl`; normal direct/delegated allocator                        | Pinned selection still passes existing filters; no replacement controller or routing policy                         |
| Control admission      | `ControlModelGateway` admission promise and decision lifetime                                    | Lease held across multiple requests, Disable drain, no new admission, release after terminal cleanup                |
| Direct/delegated work  | Host `guardInventoryAdapter`, EngineHost, `engineAllocator`, `boundedCoworkExecutor`             | Real direct task and IntelligenceBridge delegated unit hold transport while mutation is attempted                   |
| Native activity        | Guarded adapter probe; SubscriptionService admission; ProviderInventoryService fetch             | Native process/probe/login and refresh leases held until actual operation settles                                   |
| Credential resolution  | `ConnectionManager.resourceRecord/validateResource/acquireResource`; existing `readPiCredential` | A observes Key A, B observes Key B, rotated B observes new B; cross-scope/provider/host/generation forgery rejected |
| Lifecycle invalidation | Main onChange, publisher generation checks, inventory invalidation/rebind                        | Disabled/removed/forgotten resources unavailable; late refresh discarded; pins fail explicitly                      |
| Plan binding           | `chatgpt-plan.ts` private verification/binding authority                                         | Fake OAuth/PKCE/callback/signature verification, retained subject comparison, replacement and restart               |
| Accounting             | Existing Gateway/Engine telemetry and result path                                                | Normal synthetic results flow through the actual host; secret sentinel absence asserted                             |

## Mandatory synthetic scenario

`apps/desktop/src/main/connection-runtime.test.ts` creates both accounts through the real bridge, persists them, obtains their descriptors from the production publisher, and executes through real Registry/NRC/Gateway/Pi composition with an injected provider transport. It observes A then B; disables A while B remains usable; rotates B without changing its resource ID; verifies B's new key; forgets/re-enters B; removes/restores A; and reconstructs stored connections and IDs after restart.

Separate tests hold an actual Control request, a direct Desktop task, and a delegated IntelligenceBridge unit. Rotate, Forget and Remove reject active work. Disable stops new admission but lets authorized work settle. Error, cancellation, timeout and end-before-settlement release paths are covered. No manual counter increment is used as the runtime integration proof.

Negative execution cases reject A referencing B, a built-in scope, no scope, an invalid scope, wrong provider, stale generation or wrong host. Disabled/tombstoned/missing-credential cases are exercised through the lifecycle scenario. No account substitution or environment-secret fallback is added.

## Availability coherence regression found during acceptance

A captured Providers turn failed with `INTEGRATION_UNAVAILABLE` in 102 ms after the credential was forgotten; its UI test then waited 60 seconds for a result. The diagnostic bundle is `apps/desktop/.nexar/e2e-diagnostics/providers-2026-10-17T22-32-17-092Z`. This occurrence was an availability/coherence failure, not evidence of a slow provider request.

Three deterministic regression cases failed before correction (`.nexar/ci/control-availability-red.log`): withdrawn control retained cached Cowork readiness in both execution placements, and pinned preview disagreed with actual admission. The correction caches verified runtime discovery separately from live NRC eligibility, filters control candidates against current connection authority, and validates pins consistently in preview and admission. Live registry descriptors also protect legacy built-in pins whose IDs remain unchanged. Withdrawal, restoration and newly available control resources are tested within the runtime cache window.

Production isolated Cowork still enters its blocking lane when unavailable; no host fallback was introduced. Existing admitted execution is not cancelled by status changes. The corrected actual Providers scenario completed both turns, across restart and Forget, and verified secret absence and exact confirmed-action IPC (`.nexar/ci/remediation-desktop-control-final.log`). This does not establish that every older intermittent Providers observation had the same cause.

## Desktop and real runtime evidence

Windows Full Local CI returned `NEXAR_WINDOWS_FULL_PASS` on clean source `96f8b6a16562e308cc0502d7fc577b563fcb4153`, tree `cbd4d26018133bc6426f9cc7cd979cd5b3feed7c`, with 16/16 required stages passing in 1749.94s. The optional native Linux stage was BLOCKED on Windows and is not counted as passed. Raw report: `.nexar/ci/reports/report-2026-10-18T02-57-15-465Z.json`; SHA-256 `3df3cf845036b3607a61b01717074390d9c5f7076b0c38a3042bbdb9d6451c24`. Start/end source identity was stable and clean.

Windows offline tests: **4,467 passed, 167 skipped, four pending, zero failed** (4,638 total; 245 files). Real DSH context: **3/3**; isolated Cowork Windows/WSL bridge acceptance: **8/8**; source Desktop: **27/27**; packaged Desktop: **27/27**. Skipped/pending cases are not counted as passes. The four pending Windows assertions are actual Linux Bubblewrap cases covered by the WSL run.

The separate WSL checkout at `9dc1909619e41c6b3632179934abe0d696ea665d`, tree `b9c3203e6292b26b4bd06c9216a03157839ad139`, passed **4,609 tests, 29 skipped, zero failed** (4,638 total). Its production and test source is identical to the Windows revision: the only intervening change is `.gitleaks.toml`. Raw WSL report: `/home/nexar/src/nxr070b-remediation-20261018/.nexar/ci/remediation-wsl-control-final-tests.json`, SHA-256 `a924579dc50241a6c5f52c4a667b3435b82ccfd1e6326478de226e7e5e723693`. The real kernel gate also passed 15/15 assertions.

The earlier Windows run at `9dc1909` retained a FAIL result because Gitleaks detected seven synthetic test fixtures. Their literal source values were inspected; exact path-and-value exceptions were added while retaining default rules and full-history scanning. The clean rerun above passed Gitleaks. Historical failed/incomplete runs remain evidence and are not relabelled PASS.

Hosted CI is separate: the pre-publication run at `b6ffde9` failed before steps due to account billing/spending restrictions. Final remote identity and post-push hosted status are recorded in the publication receipt and PR description. No live vendor login, real key or paid inference was used.

`apps/desktop/e2e/connections.e2e.ts` exercises actual management and owner-resource publication. `chatgpt-plan.e2e.ts` uses the existing fake IdP and Responses metadata server with the real callback child; after Replace, a future explicit sign-in binds a new identity and publishes different resource IDs. Probing/listing does not perform inference.

The pinned real DSH context and WSL isolation gates establish runtime/security preservation. The A/B credential-routing test deliberately injects synthetic transport instead of making paid vendor requests. These are distinct proofs.

## Identity and history

No migration rewrites historical resource IDs, session records, Project Memory, pins or account associations. A removed pin becomes unavailable instead of redirecting to a new account. Ordinary Restore keeps the old identity; permanent Plan replacement cannot Restore or reuse its old ID. New Plan sign-in/refresh cannot repopulate a permanently retired scope.

Saved current Cowork/Coding preferences and control/default references are inspected by the host for sensitive-action consequences. Unresolved opaque saved references are conservatively identified and retained. The UI does not claim exhaustive enumeration of every historical session reference.

## Verification scope

No live provider identity, production quota, real vendor key acceptance or external revocation was tested. The accepted runtime pin and sandbox configuration were not upgraded or relaxed. Native multi-account homes and later review/routing milestones remain deferred.
