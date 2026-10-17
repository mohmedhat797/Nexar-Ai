# NXR-070B′ Runtime Integration Verification

**Date:** 2026-10-18  
**Implementation:** FINAL_IMPL_PENDING  
**Acceptance:** FINAL_CI_PENDING

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

## Desktop and real runtime evidence

FINAL_ACCEPTANCE_SUMMARY

`apps/desktop/e2e/connections.e2e.ts` exercises actual management and owner-resource publication. `chatgpt-plan.e2e.ts` uses the existing fake IdP and Responses metadata server with the real callback child; after Replace, a future explicit sign-in binds a new identity and publishes different resource IDs. Probing/listing does not perform inference.

The pinned real DSH context and WSL isolation gates establish runtime/security preservation. The A/B credential-routing test deliberately injects synthetic transport instead of making paid vendor requests. These are distinct proofs.

## Identity and history

No migration rewrites historical resource IDs, session records, Project Memory, pins or account associations. A removed pin becomes unavailable instead of redirecting to a new account. Ordinary Restore keeps the old identity; permanent Plan replacement cannot Restore or reuse its old ID. New Plan sign-in/refresh cannot repopulate a permanently retired scope.

Saved current Cowork/Coding preferences and control/default references are inspected by the host for sensitive-action consequences. Unresolved opaque saved references are conservatively identified and retained. The UI does not claim exhaustive enumeration of every historical session reference.

## Verification scope

No live provider identity, production quota, real vendor key acceptance or external revocation was tested. The accepted runtime pin and sandbox configuration were not upgraded or relaxed. Native multi-account homes and later review/routing milestones remain deferred.
