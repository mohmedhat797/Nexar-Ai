# NXR-070D′ implementation readiness package

**Status: ready to start from the verified baseline. Nothing here is implemented.** Authorities: [ADR-029](../adr/029-connection-scoped-resources-and-canonical-continuity.md), the [reconciled blueprint](../architecture/nxr-070/NXR070_Implementation_Blueprint_Reconciled.md) §070D′, the [execution plan](../architecture/nxr-070/NXR070_Execution_Plan_Reconciled.md) and the [owner decisions](../architecture/nxr-070/NXR070_Owner_Decisions_2026-10-17.md) OD-4b, OD-7, OD-8 and OD-15.

Component names marked "new" are proposals. The implementer confirms them against the code.

## A. Objective

Let the owner use more than one Codex account in Nexar, each as its own connection with its own private `CODEX_HOME`.

The NRC can then select between them, reviews can treat them as distinct, and usage is attributed to the correct connection. A connection never changes account, and Nexar never reads Codex credential files.

## B. Approved scope

From the blueprint (requirements REQ-08, 09, 14, 17, 18, 19, 38; size M):

- Create a home at `<appData>/Nexar/runtime-homes/<connectionId>/codex` on Desktop, or a plane-local equivalent, with 0700 or ACL protection and a marker file.
- Check that a resource's home equals its connection's home.
- Define inventory per connection.
- Provide an owner-initiated login, with a same-account assertion for existing connections.
- Provide Delete-home.
- Guard against lifecycle actions while a process is active.

## C. Exclusions

- Concurrent ChatGPT plan accounts: gated by E-1. Sequential Replace (OD-15) already exists.
- Multiple Claude subscription accounts: gated by E-2.
- Providers UI v2: belongs to H′.
- Cross-host credential sharing or routing: prohibited by OD-9.
- New NRC policies, `context@3` and new credential types.
- Changes to built-in `openai.subscription` or to the vendor default home.
- Reading, parsing or copying `auth.json` or any other Codex credential file.

## D. Architecture

```text
Owner action → bridge channel (zod) → ConnectionManager → definition + tombstone rules
                                            │
                     Codex home store (new) ── fixed root, marker, ACL, consistency, delete
                                            │
ConnectionRuntime.descriptors() → Resource Registry → NRC selects by normal filters
                                            │
Execution admission → lease on connection → home resolved in main → CODEX_HOME in child env
                                            │
                      official codex CLI → settlement and telemetry with connection id
```

How each question from the assignment is answered:

| Question                    | Design                                                                                                                                               |
| --------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| Reusable from B′            | `ConnectionManager` leases and lifecycle, tombstones, private-state helpers, `ConnectionRuntime`, assurance levels, review identity, inventory guard |
| Contract changes            | Add an owner Codex id form. `native-home` with `home: 'private'` already exists in `ConnectionCredentialScope`, and no path enters the contract      |
| Home ownership              | Path derived in main from the immutable connection id; the marker id is kept in the private record; the renderer never sees or supplies a path       |
| CLI receives its home       | `CODEX_HOME` set through the existing allowlisted `buildCodexEnv`; in the sandbox, the existing bind to `/home/agent/.codex`                         |
| NRC selection               | Each connection publishes its own resource. The NRC is unchanged and existing eligibility rules apply                                                |
| Immutable resource identity | Resource id bound to connection id, following the API-key pattern; lost ids are tombstoned                                                           |
| Process binding             | Execution, inventory and probe hold a connection lease for the life of the process                                                                   |
| Owner-initiated login       | Only an explicit bridge action starts `codex login`; refresh and probe paths cannot reach it                                                         |
| Leak prevention             | Env allowlist with no API-key variables; ids and hashes only in logs; no credential reads                                                            |
| Protected deletion          | Fixed root, recorded marker, `lstat` at every level with no symlink or reparse point, refused while active                                           |
| Windows and WSL paths       | Canonical path checked against the host's fixed root. Plane homes stay on the Linux filesystem; `/mnt` and UNC paths are refused                     |
| Reusable fixtures           | Fake Codex runtime in `integrations/codex`, `connection-runtime` harness, `private-state` tests, E2E process-lifecycle helper                        |
| New tests                   | TST-09(c), 14, 17, 18, 19; Codex parts of TST-08 and 42                                                                                              |
| H′ work                     | Account list, add and re-login screens, home status, attribution display                                                                             |

## E. Component changes

| Area                                  | Expected change                                                                                                   |
| ------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `packages/contracts`                  | Owner Codex connection id form and validation                                                                     |
| `integrations/codex`                  | Home consistency check, `CONFIGURATION_ERROR` before spawn; connection metadata on resources; login status helper |
| `packages/host`                       | Per-connection Codex resource and inventory definitions                                                           |
| `apps/desktop/src/main`               | Home store (new); `connection-state`, `connection-manager` and `connection-runtime` extended                      |
| `apps/desktop/src/shared` and preload | Login, re-login and Delete-home channels with strict schemas                                                      |
| `apps/cli` plane code                 | Plane-local home store on the same contract                                                                       |
| `packages/resource-registry`          | No change expected                                                                                                |
| `packages/resource-controller`        | No change expected. A required change here stops work for review                                                  |

## F. Security boundaries

- **Credentials:** Nexar never opens anything inside a home except its own marker. No key variables reach a child (REQ-18).
- **Process:** explicit minimal environment; write mode stays sandbox-only; no unsandboxed fallback.
- **Filesystem:** homes are created private before the CLI first runs. Vendor default and owner-declared homes are never deleted.
- **Identity:** one connection, one account. Re-login without an assertion is refused. Nexar cannot detect a login run outside Nexar (residual risk R-03).
- **IPC:** the renderer sends only an opaque connection id, and subject and path never cross. Errors stay fixed `{ code, message }`.
- **Lifecycle:** Rotate, Forget, Replace, Delete-home and re-login are refused with `connection.active` during execution, refresh or probe.

## G. Implementation sequence

Each slice is one commit that passes `pnpm check`.

1. Rollback control, per the decision in section L.
2. Contracts and persisted record: id form, private home record, corrupt-file behavior.
3. Home store: create, marker, ACL, consistency check, delete; no callers yet.
4. Adapter binding: resolved home, consistency refusal, environment tests.
5. Registry and inventory publication per connection.
6. Lifecycle guard: leases around native processes, refusal matrix.
7. Login action: owner-only start, same-account assertion, no path from refresh or probe.
8. Bridge channels and E2E with the fake CLI.
9. Plane-local variant and WSL tests.
10. Acceptance: Windows Full, WSL, then owner real-account scenario.

## H. Testing strategy

| Level           | Coverage                                                                                                                                   |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| Unit            | TST-14 path refusals, TST-17 mismatch, TST-18 environment, id and record validation                                                        |
| Integration     | TST-08 fake Codex echoing `CODEX_HOME`: each run sees only its home, no sentinel in logs. TST-09 refusal matrix. TST-19 login reachability |
| Review identity | TST-42: two Codex connections distinct under `connection`, identity kept across re-entry                                                   |
| Windows         | Real ACL assertions and reparse point refusal; packaged E2E                                                                                |
| WSL             | 0700 and symlink refusal; sandbox bind of the correct home; write mode refused outside the sandbox                                         |
| E2E             | Fake CLI through the bridge; quit during a running process; no leftover process                                                            |
| Live            | Opt-in, owner-run only (OD-12). Never in CI                                                                                                |

## I. Acceptance criteria

1. Two Codex connections run with different homes, each observing only its own (TST-08).
2. Lifecycle actions are refused with `connection.active` during activity; when idle, Rotate keeps the id and increments the generation (TST-09).
3. Symlinked root, missing marker, outside path and vendor default are all refused for deletion; a valid home is removed with nothing outside it touched, on Windows and Linux (TST-14).
4. A mismatched home gives `CONFIGURATION_ERROR` and no spawn (TST-17).
5. `OPENAI_API_KEY` and `CODEX_API_KEY` in the parent never reach a child (TST-18).
6. Refresh and probe never invoke login; login without the assertion is refused (TST-19).
7. Review diversity treats the two as distinct, and unknown identity earns no credit (TST-42).
8. Built-in `openai.subscription`, its home and existing pins behave the same. The `deterministic@1` tests pass unchanged.
9. Windows Full and WSL pass on the exact final commit; Gitleaks is clean.
10. The owner confirms two real accounts remain separate. Until then this stays "pending".

## J. Rollback

Turning the rollback control off hides owner Codex connections. Homes, tombstones and binding records are retained, and pins fail explicitly instead of attaching to another account. A code revert is also safe: the persisted definitions fail closed to built-ins, as B′ specifies. No rollback deletes a home or changes a session. Built-in Codex keeps working throughout.

## K. Risks

| Risk                                                                     | Handling                                                                                     |
| ------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------- |
| The CLI may not expose account identity without reading credential files | Assume owner assertion only; never "verified". Check the CLI's supported commands in slice 7 |
| The CLI may write outside `CODEX_HOME`                                   | Test with the pinned version and record it; a real leak blocks                               |
| Native tokens refresh on their own                                       | Authentication is treated as mutable (REQ-38); leases cover the process                      |
| Windows ACL must be set before the first CLI write                       | Home store creates and verifies before any spawn                                             |
| Long paths on Windows                                                    | Keep ids short; test at the real root                                                        |
| Login outside Nexar in a private home (R-03)                             | Accepted residual risk; documented in the UI text in H′                                      |
| Packaging is already at 92% of its limit                                 | D′ adds little size, but watch G-07 in the gap register                                      |
| Vendor CLI changes                                                       | Exact pin and contract tests                                                                 |

## L. Owner decisions

The owner decided both on 2026-10-31:

1. **Rollback control.** ADR-029 §6 says "feature flag off", but B′ shipped without a flag. **Decision:** add one owner-connections setting in slice 1, covering B′ and D′, which matches the accepted ADR. The ADR is not amended.
2. **Minimum UI in D′.** H′ owns the Providers UI, and it comes after D′. **Decision:** ship bridge channels and E2E only, then build H′ straight after. The owner cannot use multiple Codex accounts until H′ lands.

## M. Recommended Git strategy

- Branch `feat/nxr-070d-codex-homes` from the verified `main`, after the baseline PR's decision.
- Worktree at `.nexar/worktrees/nxr070d`; no new clone and no new top-level folder.
- One Conventional Commit per slice, then a Draft PR. Never push to `main`.
- Acceptance results are bound to the exact final commit and tree.
