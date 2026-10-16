# NXR-SEC-01 — Cowork isolation threat model

**Date:** 2026-10-13. **Owner:** Claude Opus 5.5 (architect/reviewer). This complements, and does
not replace, [security-threat-model.md](security-threat-model.md) (T1–T15). Design:
[NXR_SEC01_Architecture_Design.md](NXR_SEC01_Architecture_Design.md).

## Principals and trust

| Principal                               | Trust                  | Why                                                                                                               |
| --------------------------------------- | ---------------------- | ----------------------------------------------------------------------------------------------------------------- |
| Desktop main process (owner identity)   | **Trusted**            | Holds NRC, credentials, sessions, Project Memory, broker, approvals, artifact store                               |
| Control-gateway child, bridge endpoint  | Trusted (Nexar code)   | Hold no provider keys; authenticate every request by turn grant                                                   |
| DSH Cowork process and its dependencies | **Untrusted**          | Driven by a model that can be prompt-injected by turn text, documents and delegated outputs; third-party npm tree |
| Model provider                          | Untrusted for content  | Receives what the turn sends; NRC chooses which provider                                                          |
| Other local processes of the same user  | Trusted host (assumed) | Same-user compromise is out of scope (as in FCR-01)                                                               |

## Assets

Owner files outside the project, other projects' files, credential stores (Nexar
`desktop-key-store`, browser and cloud CLIs, SSH keys), Nexar session store and Project Memory of
other projects, grant tokens, provider allowance, network egress, the integrity of artifacts.

## Threats, current control and target control

The "Today" column holds application-level controls only, unless stated otherwise. "Target" is the
NXR-SEC-01 design, which is **not yet implemented or verified**.

| #   | Threat                                                | Today                                                                                    | Target (OS-enforced unless noted)                                                                                                        | Residual after target                                                     |
| --- | ----------------------------------------------------- | ---------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| I1  | Read of owner files outside scratch                   | **None**: read tools are enabled; a real DSH synthetic outside read succeeds (FCR-01-09) | AppContainer: no grant, so access is denied by the kernel's access check                                                                 | Files granted to `ALL APPLICATION PACKAGES` (public OS files) unless LPAC |
| I2  | Write outside scratch                                 | Read-only start, per-call broker, physical checks, owner approval                        | Same broker, plus OS denial outside the scratch/home grants                                                                              | None beyond the grants                                                    |
| I3  | Cross-project access                                  | Context assembly is project-scoped; files are not protected                              | Per-turn SID; only that turn's folders are granted                                                                                       | None                                                                      |
| I4  | Credential access (Nexar key store, user credentials) | Keys never in the DSH environment; files readable by OS identity                         | No grant on the user profile or Nexar state; AppContainer credential isolation                                                           | The grant token in the DSH environment (turn-scoped, revoked at end)      |
| I5  | Child processes / process escape                      | Shell, jobs and plugins disabled in the profile; the bridge relay child is allowed       | Job `ActiveProcessLimit = 1`, `KILL_ON_JOB_CLOSE`, no breakaway; the relay moves host-side                                               | Pending gate: deterministic denial behaviour                              |
| I6  | Network exfiltration                                  | Web rows disabled in the profile; OS network open                                        | No network capability: internet and host loopback blocked; only two brokered pipes                                                       | Data sent to the selected model provider via the gateway (by design)      |
| I7  | Untrusted document instructions                       | Tool catalog reduction, broker, approvals                                                | Unchanged policy; the OS boundary limits what a hijacked loop can reach                                                                  | The model can still misuse permitted scratch writes and the bridge        |
| I8  | Symlink / junction escape                             | Lexical and physical checks, link and hard-link denial                                   | Access is checked on the target object; the spike showed a denied junction escape                                                        | None outside the grants                                                   |
| I9  | Hard links                                            | Multi-link files denied by the broker                                                    | Creating a hard link needs write access to the target, and outside targets have no grant                                                 | None outside the grants                                                   |
| I10 | Filesystem TOCTOU (post-grant swap)                   | Re-checks; race remains (FCR-01-10)                                                      | A swap can only point inside granted folders; anything outside is denied by the OS                                                       | A race within scratch only                                                |
| I11 | IPC misuse (pipes, ACP)                               | Gateway/bridge token checks; pipe has the default DACL                                   | Per-turn pipe names, DACL = owner + turn SID, Low label; first-instance creation (no squatting); broker forwards only to one destination | Same-user host processes (trusted host)                                   |
| I12 | Gateway token misuse                                  | Token is turn-scoped and bound to one control resource, TTL, revoked at turn end         | Unchanged, and only reachable through the turn's pipe                                                                                    | Within-turn misuse by the turn's own DSH (bounded by the grant)           |
| I13 | Dependency-level filesystem access                    | Same as I1                                                                               | Same as I1: dependencies share the container token                                                                                       | As I1                                                                     |
| I14 | Launch failure → unrestricted execution               | N/A (always host-local)                                                                  | Fail-closed contract: token verification before the first ACP byte; no fallback path in code                                             | Must be proven by negative tests (D5, D6)                                 |
| I15 | Residual profiles, permissions or files               | Per-turn homes and scratch removed                                                       | Per-turn profile deletion, startup sweep, grants only on per-turn folders that are deleted                                               | Crash between create and delete is swept at the next start                |
| I16 | Concurrent turns reading each other's data            | Separate folders, same OS identity                                                       | Distinct per-turn SIDs                                                                                                                   | None                                                                      |

## Out of scope / assumptions

- A compromised host identity, a malicious same-user process, or the kernel itself.
- Screen reading by low-integrity processes. Window messages are limited by UIPI; GDI screen reads
  are not claimed to be blocked.
- Coding mode: separate WSL2 + bubblewrap boundary (verified separately).
- The model provider's handling of data the owner chose to send.

## Status

No target control in this table is verified for Cowork today. The OS-level claims rest on the
FCR-02 spike (a Node probe, not DSH) and on Microsoft's documented semantics. Until the
feasibility gate and the D6 regression suite pass, Cowork's effective boundary is the owner's OS
identity, with application controls only (`COWORK_OS_ISOLATION_INCOMPLETE`).
