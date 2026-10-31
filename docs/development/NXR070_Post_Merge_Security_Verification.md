# NXR-070 post-merge security verification

**Result: no security defect was found in `c97136b`.** This is a focused regression check using the project's own tests and scans, not an independent penetration test.

One owner action stays open: earlier in this work, a DeepSeek key was exposed in an agent transcript and terminal through a suggested command. It is not in the repository, and Gitleaks finds nothing. The owner should revoke that key if that has not been done.

| Area                       | Evidence on `c97136b`                                                                                                                                                                                  | Result |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------ |
| Credential isolation       | Real managed DSH with persisted A/B keys, with an ambient key and a foreign home present                                                                                                               | Pass   |
| Immutable account identity | TST-42 on connection and provider through Forget and re-entry; `plan-binding` 10 of 10                                                                                                                 | Pass   |
| Native DSH precedence      | Real runtime test: a saved upstream credential cannot replace Nexar's; the overlay still disables `credentials`, `authorization`, `session-log-deepseek`, `tool-working-directory`, `web-deepseek-api` | Pass   |
| Execution leases           | Lease held through a real turn; Disable drains; Rotate and Remove refused while bound                                                                                                                  | Pass   |
| Private-state ACL          | `private-state` 21 passed on Windows, `private-state-process` 11 of 11 on both                                                                                                                         | Pass   |
| IPC                        | Desktop `bridge.test` 108 of 110 on Windows (2 not run) and 110 of 110 on WSL; preload 11 of 11                                                                                                        | Pass   |
| Permission Broker          | `gateway.test` 28 of 28; real denial of ordinary and escalating writes                                                                                                                                 | Pass   |
| WSL and bubblewrap         | Launcher 12 of 12; kernel-level hiding of host files, drives, IPC and interop; isolated network                                                                                                        | Pass   |
| Canonical sessions         | `packages/sessions` store, lease race and transitions; `sessions` 44 of 44                                                                                                                             | Pass   |
| Project Memory             | Store 26 of 26, Desktop 16 of 16; model output never promoted                                                                                                                                          | Pass   |
| Dependency overrides       | Locked versions confirmed; `npm audit` on the runtime lock: 0 advisories                                                                                                                               | Pass   |
| Runtime provenance         | Artifact 19 of 19, install 19 of 19; packaged tree hash equals sealed hash                                                                                                                             | Pass   |
| Secret exposure            | Gitleaks 8.28.0 full history: no leaks; WSL and Windows runs used synthetic keys only                                                                                                                  | Pass   |
| Child-process lifecycle    | E2E exits unforced; real cancel leaves no process; shutdown and child tests pass                                                                                                                       | Pass   |

## Dependency overrides

| Package                        | Without override | Locked | Corrects                                        |
| ------------------------------ | ---------------- | ------ | ----------------------------------------------- |
| `zod`                          | 4.4.3            | 4.6.7  | GHSA-mrhx-c7xc-m3w5                             |
| `undici`                       | 8.11.2           | 8.12.3 | Advisories listed in the ADR-030 rc.5 amendment |
| `fflate`                       | 0.8.2            | 0.8.3  | GHSA-px8p-9vwx-vf98                             |
| `@modelcontextprotocol/client` | 2.2.0            | 2.3.1  | GHSA-6prh-2h8m-c8cw                             |

Rationale is in [the amendment](../adr/030-dependency-security-amendment-dsh-021-rc5.md). No override was changed. The audit reflects advisory data as of 31 October 2026.

## Limits of this verification

- Key isolation stops at a local fake provider. Real vendor isolation is owner scenario L3.
- Tests run in disposable profiles, not on a clean machine.
- The installer is unsigned.
- The overlay works by disabling upstream features, so a future DSH version could reintroduce credential substitution. The real test for this must pass on every DSH change.
- The WSL wall clock jumps by about 2 s every 32 s. No security decision was found to be affected, but code in the Plane that measures elapsed time with `Date.now` can be off by that much. See G-06 in the gap register.

No security setting was changed to accommodate a test.
