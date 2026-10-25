# B′/C′ final security and integration verification

Execution period: 25–26 October 2026 (Africa/Cairo); raw timestamps are UTC. This report covers the startup investigation and the combined connection-management/review-diversity implementation. It is an engineering verification record, not independent owner acceptance.

## Security conclusion

The startup changes preserve the existing security authorities. No account, credential, routing, permission, session or memory contract was replaced. The historical packaged startup timeout remains unresolved and blocks a claim of complete engineering remediation. Current platform results are recorded separately in `NXR070_BC_Final_Windows_Acceptance.md`.

## Execution authority

The production path remains Desktop IPC → ConnectionManager → validated persistent connection → connection-aware inventory → Resource Registry → NRC eligibility/selection → execution admission/lease → host credential resolution → model execution → accounting/cleanup. The connection-runtime integration corpus creates persisted owner connections through the bridge and observes their distinct synthetic credentials at the injected transport. It does not manufacture publication by manually injecting owner descriptors.

ConnectionManager remains the admission and mutation authority. Disable stops new admissions while an admitted execution may drain; Rotate, Forget, Remove and Replace retain their active-work restrictions. Credential scope is derived or validated against the authoritative immutable connection, without environment-credential fallback. A stale generation or wrong provider, host or scope is rejected. Tombstones and permanent Plan retirement do not redirect historical pins. Account subjects remain inside the trusted Plan service.

The startup assignment did not alter these production implementations. Original B′ acceptance and this assignment's current regression results must retain separate source identities; the presence of passing historical reports does not retrospectively accept newer source.

## Review allocation

C′ retains explicit resource, connection and provider dimensions with preferred or required enforcement. Required constraints narrow the existing eligible candidate set; they do not authorize work or widen a permission grant. Unknown identity cannot establish required independence. Connection comparison uses the immutable host-qualified key; provider comparison uses canonical provider metadata. Host remains attribution, not a diversity dimension.

Plan allocation, dynamic allocation and execution-time revalidation preserve the reviewed allocation's retained identity. If a planned reviewer becomes unavailable, a same-connection or same-provider fallback cannot satisfy the corresponding required dimension. The explicit failure remains `strategy.diversity.<dimension>.unavailable` and no review execution is authorized by that failure.

The Intelligence Bridge settlement correction reconciles pending allocation work with the latest ledger so an unrelated pending operation cannot overwrite the actual settled fallback resource or cost. The deterministic race tests and legacy routing/strategy fixtures remain part of the regression suite. No new scheduler, controller, default routing policy or delegation allowance was added.

## Windows private state and diagnostics

The native guard still completes synchronously before asynchronous Desktop startup continues. The 15-second bound, owner/ACL validation, parent ACL preservation, symlink/junction containment, hard-link checks and fail-closed exit remain intact. Trace records contain only approved process identifiers, timestamps, fixed phases and bounded outcomes. They exclude arguments, encoded scripts, environment, private paths, credentials, account subjects, prompts, responses, sessions and Project Memory.

E2E teardown now distinguishes the shell launcher from the actual Electron main process and refuses profile reuse until the owned main process is absent. PID liveness does not confer authority to terminate an arbitrary process. Reused or ambiguous identities fail cleanup and preserve evidence. Universal descendant cleanup is not claimed.

## Runtime, persistence and isolation preservation

- DSH remains exactly `@deepseek-ai/dsh@0.2.0-rc.2`; no floating dependency or lockfile upgrade was introduced.
- The accepted WSL2/Bubblewrap Cowork and Coding boundaries remain authoritative; no unrestricted host fallback or Windows/WSL security-policy change was added.
- FileSessionStore remains the canonical session writer; ProjectMemoryStore remains the confirmed-fact authority.
- SettingsStore, DesktopKeyStore, connection recovery metadata and Plan binding were not redesigned by the startup work.
- Test profiles and synthetic credentials are disposable. The owner's installed profile, real credentials and provider accounts were not used.

## Review and limitations

Current execution evidence: C′ `315a029e` passed all 16 required Windows gates in one clean/stable Full run, including 4,570 offline passes, DSH context 3/3, Windows-to-WSL 8/8 plus nested kernel 15/15, source Desktop 33/33 and packaged Desktop 33/33. Full WSL runs passed B′ 4,654/30 skipped and C′ 4,713/30 skipped, with zero failed or pending assertions and unchanged source. The 15 nested Linux assertions are additional to the Windows report's rolled-up 4,647 passes; they are not silently added to that parser's total. B′'s latest standalone Windows aggregate failed at installation and is not promoted to PASS by this evidence.

The separate reviewer verified these source anchors on the corrective baseline:

| Invariant                                                                                | Source anchor                                               |
| ---------------------------------------------------------------------------------------- | ----------------------------------------------------------- |
| Guard completes before first await                                                       | `apps/desktop/src/main/private-state.ts:422–429`            |
| Absolute PowerShell, explicit environment, shell disabled, 15 seconds and bounded output | `apps/desktop/src/main/private-state.ts:430–442`            |
| Synchronous native child launch                                                          | `apps/desktop/src/main/private-state-process.ts:180`        |
| Bounded phase/PID/timestamp parser                                                       | `apps/desktop/src/main/private-state-process.ts:105–143`    |
| Trace gate and two-record retention                                                      | `apps/desktop/src/main/main.ts:112–129`                     |
| Connection scope and serialized execution lease                                          | `apps/desktop/src/main/connection-manager.ts:668–746`       |
| Admission cleanup                                                                        | `packages/host/src/inventory-guard.ts:45–66`                |
| Required review comparison and unavailable result                                        | `packages/resource-controller/src/strategy.ts:339`, `:456`  |
| Retained review context at revalidation                                                  | `packages/resource-controller/src/strategy.ts:579`          |
| Pending allocation reconciliation and actual settlement identity/cost                    | `packages/engine-gateway/src/bridge.ts:532–565`, `:639–678` |

The reviewer compared protected production blobs against the previously published B′/C′ baselines and found ConnectionManager, SettingsStore, KeyStore, Plan service, WSL backend, FileSessionStore, FileProjectMemoryStore, the DSH manifest and runtime package lock identical. Line numbers identify that reviewed baseline; later documentation-only commits do not imply new production behavior.

A separate read-only review agent examined the corrective source and identified the PID attribution, cleanup/admission and fixture-restoration gaps addressed in this work. This is separate source review, **not independent owner acceptance**. No reviewer has approved a merge.

The original startup delay, earlier private-state ACL attribution, historical Plan setup observation and earlier SOW stall have not acquired a proven common cause. They are not labelled fixed. Successful restart observations and current tests cannot substitute for a correlated failing observation. Hosted CI and clean-machine installation coverage must be assessed using their own evidence.

Independent acceptance status: `INDEPENDENT_OWNER_REVIEW_PENDING`.
