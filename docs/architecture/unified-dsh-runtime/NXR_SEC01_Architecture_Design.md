# NXR-SEC-01 — Windows-native Cowork isolation: architecture design

**Date:** 2026-10-13 (Africa/Cairo). **Architect and reviewer:** Claude Opus 5.5.
**Baseline:** `fcr02/opus-integration` at `0187bda5cc3810713a57b73850dfc8e8997de1f6`. Production
code is identical to the Full-CI-tested `e2a82aeba3236b9e099100535c4ba1f9f87b3dda`. Ancestor: PR
[#41](https://github.com/mohmedhat797/Nexar-Ai/pull/41) head `7337aa0` (PR still Draft).
**Governance:** [ADR-030](../../adr/030-unified-dsh-first-agent-runtime.md) stays **Proposed**. The
amendment below awaits owner approval. NXR-070 is not started.
**Builds on:** [FCR02_Architecture_Decision.md](FCR02_Architecture_Decision.md). Its findings are
kept; the reconciliation is in §7.

## 1. Decision summary

| Item                   | Result                                                                                                                                                                      |
| ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Preferred isolation    | **Classic Windows AppContainer**, created per turn by a Nexar host launcher. DSH is the only process inside it. Host-side brokers handle the model and bridge traffic.      |
| Architecture verdict   | `WINDOWS_NATIVE_ISOLATION_ARCHITECTURE_REQUIRES_REVISION`: sound in principle, but it cannot be approved for production until the feasibility gate (§6) passes on real DSH. |
| Feasibility            | `WINDOWS_NATIVE_ISOLATION_UNVERIFIED`. Real DSH has never run inside the boundary, and the gate requires an authorized disposable Windows environment.                      |
| Cowork security        | `COWORK_OS_ISOLATION_INCOMPLETE`. Cowork still runs under the user's identity, with application-level controls only.                                                        |
| Production integration | **Not started.** The phase D gate (feasibility first) is not met. Nothing was delegated for implementation.                                                                 |
| WSL2 for Cowork        | Not adopted. It stays an owner-approval fallback (option C).                                                                                                                |

## 2. Phase A — current Cowork execution path and authority map

Traced from source at the baseline, in execution order:

| #   | Step                            | Code                                                                                                            | Authority DSH receives today                                                                                                                                                                                                                                                                     | Layer        |
| --- | ------------------------------- | --------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------ |
| 1   | Renderer request → IPC          | `apps/desktop/src/main/sessions.ts`, zod channels                                                               | None (renderer untrusted, validated in main)                                                                                                                                                                                                                                                     | App          |
| 2   | Operating Layer lane choice     | `apps/desktop/src/main/operating.ts` (`available()` non-blocking; else direct fallback)                         | None                                                                                                                                                                                                                                                                                             | App          |
| 3   | Cowork turn setup               | `apps/desktop/src/main/dsh-cowork.ts` `runTurn`                                                                 | Per-turn `scratch` (`mkdtemp` + `realpath`) and `homes/<turnId>` under the Desktop state directory                                                                                                                                                                                               | App          |
| 4   | NRC control selection + grant   | `openGateway` → `bridgeHost.mint` (turn-scoped grant with control decision, unit limit, TTL)                    | One bearer token, scoped to the turn and to one control resource                                                                                                                                                                                                                                 | App          |
| 5   | Launch                          | `integrations/deepseek-harness/src/acp/local.ts` `runLocalAcpSession` → `child_process.spawn`                   | **The full Windows user token**: same SID and integrity level, so everything the user can read or write. Environment = allowlist (`PATH`, `SystemRoot`, `TEMP`/`TMP` = the user's real temp, …) plus `HOME`/`USERPROFILE`/`DSH_HOME` = per-turn home and `NEXAR_CONTROL_TOKEN`. `cwd` = scratch. | **OS: none** |
| 6   | ACP initialize / session/new    | `local.ts` (stdio JSON-RPC; `fs`/`terminal` client capabilities false)                                          | The overlay file in home holds the profile and the required context (that project's memory only)                                                                                                                                                                                                 | App          |
| 7   | Permission requests             | `acp/permissions.ts` `PermissionBroker` → `decideCoworkPermission` + `isPhysicalScratchEscape` + owner approval | Per-call write/edit inside scratch only; deny by default; `*_always` never chosen                                                                                                                                                                                                                | App          |
| 8   | Model traffic                   | DSH → `http://127.0.0.1:<port>/v1` (control-gateway child) with the grant token                                 | Loopback TCP is reachable by any same-user process; the token is required                                                                                                                                                                                                                        | App (token)  |
| 9   | Delegation bridge               | DSH spawns `bridge-relay.cjs` (stdio MCP) → `\\.\pipe\nexar-bridge-*` with the grant token                      | **A child process** under the same user token; the pipe has the default DACL                                                                                                                                                                                                                     | App (token)  |
| 10  | Read tools, other DSH internals | DSH `read`/`glob`/`grep`, dependencies                                                                          | **Any path the user can read** — demonstrated by a real pinned-DSH synthetic outside read (FCR-01-09)                                                                                                                                                                                            | **OS: none** |
| 11  | Network                         | DSH process                                                                                                     | **Unrestricted at the OS level**; web, shell and plugin rows are disabled only in the profile                                                                                                                                                                                                    | App only     |
| 12  | Artifact import                 | `importDrafts` → `LocalArtifactStore` (host side, after the turn)                                               | None (the host reads scratch; safe names, no overwrite, contained writes)                                                                                                                                                                                                                        | App          |
| 13  | Session completion and cleanup  | `runTurn` `finally`: unit limit closed, grant revoked, scratch and home removed; `RuntimeProcess.stop()`        | None after the turn                                                                                                                                                                                                                                                                              | App          |

**Conclusion.** Every Cowork restriction today is **application policy**: the profile's tool rows,
the broker, path checks and owner approval. The **OS boundary is the user's own identity**, which
restricts nothing relative to that user's data. Rows 5, 9, 10 and 11 are where Windows hands DSH
authority that the threat model does not intend. See
[NXR_SEC01_Isolation_Threat_Model.md](NXR_SEC01_Isolation_Threat_Model.md).

## 3. Phase B — options

Sources: Microsoft Learn,
[AppContainer isolation](https://learn.microsoft.com/en-us/windows/win32/secauthz/appcontainer-isolation),
[Launch an AppContainer](https://learn.microsoft.com/en-us/windows/win32/secauthz/implementing-an-appcontainer),
[Win32 app isolation overview](https://learn.microsoft.com/windows/win32/secauthz/app-isolation-overview)
and the loopback/network-isolation guidance
([troubleshooting](https://learn.microsoft.com/en-us/windows/security/operating-system-security/network-security/windows-firewall/troubleshooting-uwp-firewall)).

Relevant documented facts:

- A desktop application may launch its own AppContainer with `CreateAppContainerProfile` and
  `PROC_THREAD_ATTRIBUTE_SECURITY_CAPABILITIES` (available since Windows 8).
- Access requires **both** the user/group SIDs **and** the AppContainer or capability SIDs to be
  granted in the object's DACL. The effective access is their intersection.
- The process runs at Low integrity. Without a network capability it cannot use the network.
- `TEMP`/`TMP`/`LOCALAPPDATA` are redirected into the profile.
- **LPAC** (opting out of `ALL APPLICATION PACKAGES`) narrows access further, including system
  files that regular AppContainers can read.
- **Win32 App Isolation is documented as preview.** It requires MSIX packaging and Windows 11 24H2
  or later.
- Loopback is blocked for AppContainers by network isolation. The documented `CheckNetIsolation`
  exemption is described as a testing facility.

| Criterion                    | A. AppContainer (+ LPAC variant), host launcher                                               | B1. Restricted token / Low IL / job only                                                                                          | B2. Dedicated local user account                                                | B3. Win32 App Isolation (MSIX)  | B4. Windows Sandbox / Hyper-V VM                  | C. WSL2 + bubblewrap (as Coding)      |
| ---------------------------- | --------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- | ------------------------------- | ------------------------------------------------- | ------------------------------------- |
| Windows-native, no WSL2      | Yes                                                                                           | Yes                                                                                                                               | Yes                                                                             | Yes                             | Yes                                               | **No** (product change)               |
| Read isolation               | **OS-enforced** (FCR-02 spike: outside reads denied)                                          | **No**: Low IL blocks write-up, not read; restricting SIDs still match broad `Users`/`Authenticated Users` entries on data drives | OS-enforced, but only as good as every ACL on every drive (broad entries again) | OS-enforced                     | OS-enforced                                       | OS-enforced (namespaces)              |
| Write isolation              | OS-enforced                                                                                   | Partial                                                                                                                           | ACL-dependent                                                                   | OS-enforced                     | OS-enforced                                       | OS-enforced                           |
| Network isolation            | OS-enforced by default (no capability)                                                        | None                                                                                                                              | None without firewall rules (admin)                                             | Capability-based                | Configurable                                      | OS-enforced + proxy                   |
| Privileges to deploy         | **None** (standard user)                                                                      | None                                                                                                                              | **Admin** (account, credential custody)                                         | MSIX re-packaging, preview      | **Admin** + optional feature, Pro/Enterprise only | WSL2 install                          |
| DSH / Electron compatibility | **Unproven** (Node needs `--preserve-symlinks`; child hang; relay; untested Electron-as-Node) | High                                                                                                                              | Medium (profile, credential prompts)                                            | Unproven, preview               | Low (per-turn VM boot)                            | Proven for Coding                     |
| ACP stdio                    | Inherited handles (planned)                                                                   | Yes                                                                                                                               | Yes                                                                             | Unknown                         | Needs transport                                   | Existing relays                       |
| Gateway / bridge             | Host-created, SID-scoped named pipes (spike: HTTP works)                                      | Unchanged                                                                                                                         | Unchanged                                                                       | Unknown                         | Network transport                                 | Existing socat relays                 |
| Per-turn lifecycle           | Per-turn profile + job object                                                                 | Job object                                                                                                                        | Shared account                                                                  | Package-level                   | Heavy                                             | Existing                              |
| Installer impact             | Small native launcher; grant on Nexar-owned runtime folder                                    | Small                                                                                                                             | Account provisioning                                                            | MSIX pipeline                   | None, but host prerequisite                       | WSL2 prerequisite                     |
| Testability on dev machines  | Good, once authorized                                                                         | Good                                                                                                                              | Poor                                                                            | Poor (preview)                  | Poor                                              | Linux only                            |
| Verdict                      | **Preferred, conditional on §6**                                                              | Rejected: fails read isolation                                                                                                    | Rejected: admin, weak on permissive drives                                      | Rejected for now: preview, MSIX | Rejected: privilege, latency, edition             | **Fallback, owner approval required** |

**LPAC variant.** LPAC would also deny the public OS files that a regular AppContainer can read
(the spike read `C:\Windows\win.ini`). It needs explicit capabilities for the registry and COM. It
is preferred **if** DSH and Electron-as-Node start under it; otherwise a regular AppContainer is
used and the system-file residual is documented. To be decided in the feasibility gate.

## 4. Target architecture (preferred, conditional)

```text
Desktop main (trusted; the owner's identity)
 ├─ Operating Layer → DshCoworkService.runTurn
 ├─ NRC grant + Control Model Gateway (loopback HTTP, unchanged)
 ├─ Host-side bridge relay: MCP over HTTP → existing bridge endpoint (grant-checked)
 ├─ Isolation launcher (native helper, Nexar-built)
 │    · per-turn AppContainer profile (unique SID), deleted at turn end, swept at startup
 │    · grants: RX on Nexar-owned runtime folders via a Nexar custom capability (set once);
 │      Modify on this turn's scratch + home for this turn's SID only
 │    · job object: KILL_ON_JOB_CLOSE, ActiveProcessLimit = 1, UI restrictions
 │    · inherited handles: stdin/stdout/stderr only (PROC_THREAD_ATTRIBUTE_HANDLE_LIST)
 │    · two host-created named pipes, DACL = owner + this turn's SID, Low label:
 │         model pipe → only the gateway's loopback port; bridge pipe → only the bridge relay
 │    · verifies the child token (IsAppContainer, expected SID, zero network capabilities)
 │      before any ACP traffic, else fail-closed
 └─ ACP client over the inherited stdio (unchanged protocol)
                     │
        ┌────────────▼──────────────── Windows OS boundary ──────────────┐
        │ AppContainer (Low IL, no network capability, no child processes)│
        │   DSH (Electron-as-Node, --preserve-symlinks --preserve-symlinks-main)
        │   cwd = scratch, DSH_HOME = per-turn home; TEMP → the profile's AC\Temp
        │   model HTTP + bridge HTTP-MCP → in-process redirect to the two pipes
        └────────────────────────────────────────────────────────────────┘
```

### Design rules

1. **Fail closed.** Any failure in profile creation, grants, pipe creation, token verification or
   job assignment means the turn is not started. Cowork reports a stable
   `isolation-unavailable` reason. There is **no** host-local fallback.
2. **Grants only to Nexar-owned folders.** Never on user folders or ancestors: FCR-02 showed that
   ancestor ACL edits re-walk whole profiles or break inheritance. The whole Nexar data directory
   is never granted, only this turn's scratch and home.
3. **No network capability and no loopback exemption.** The host decides each reachable endpoint
   through the two pipes. The brokers forward bytes to one fixed destination each. There is no
   general-purpose proxy.
4. **Credentials stay in Nexar.** The grant token reaches DSH in the environment block, never on a
   command line. Provider keys stay in main. The container cannot open the credential store.
5. **Bridge relay is host-side.** Pinned DSH advertises ACP `mcpCapabilities: { http: true }`, so
   the bridge is mounted as an HTTP MCP server with the token in a header. This removes the only
   child process DSH needs today (to be confirmed in the gate).
6. **Brokers are not authorities.** The gateway and bridge keep their existing grant
   authentication, control-decision pinning, unit limits and accounting.
7. **Artifacts.** DSH writes only to scratch, and only through the broker's per-call decisions.
   The host imports through `LocalArtifactStore`, unchanged.
8. **Project Memory.** Only this turn's required context is written into the per-turn home overlay.
   Session files and other projects' memory are never granted.

### Launcher contract (proposed `@nexar/contracts` addition; to be finalized after the gate)

`prepare(turn)` resolves to an isolation record:

- `isolation: 'appcontainer' | 'lpac'`;
- the container identity as a SID **hash** (not the SID string in logs);
- the grant list as ids and access levels (never paths in logs);
- the pipe ids;
- the result of token verification.

It rejects with `INTEGRATION_UNAVAILABLE` and a fixed reason for every failure. `dispose()` kills
the job, closes the pipes, revokes the grants, deletes the profile and reports a cleanup status.
Spawning is not proof: `prepare` must confirm the child's effective token before the first ACP byte.

## 5. Coding

Unchanged: WSL2 + bubblewrap through `PlaneLaneEngine`, with launcher checks before and after
`prepare` (FCR-01-05 verified). NXR-SEC-01 makes no Coding changes. The regression evidence is in
[NXR_SEC01_Windows_Acceptance.md](../../development/NXR_SEC01_Windows_Acceptance.md).

## 6. Phase C — feasibility gate: status `WINDOWS_NATIVE_ISOLATION_UNVERIFIED`

**Not executed in this session.** There are two reasons.

1. Two earlier attempts to run the AppContainer feasibility experiment in this environment were
   stopped by automated safety checks (FCR-02). Per directive §9.1, they are not retried by
   changing prompts, tools, agents or routes.
2. Directive §9.2 requires an **explicitly authorized, disposable Windows test environment**. Only
   the owner's everyday workstation is available here. FCR-02 also showed that experiments can
   leave security-descriptor side effects on user folders, which were repaired.

**What is already established** (FCR-02 spike, Node 22 probe, synthetic fixtures; evidence
recorded before cleanup in [FCR02_Architecture_Decision.md](FCR02_Architecture_Decision.md)):

- OS-denied reads and writes outside the grants;
- denied junction escape;
- blocked host loopback and internet;
- HTTP working over a SID-scoped brokered pipe;
- a `LOCALAPPDATA` requirement;
- a `--preserve-symlinks` requirement;
- `isolatedWin32-*` capabilities rejected;
- a child-process hang.

**Evidence still required**, from a separately authorized engineer in a disposable Windows 11
VM. A gate PASS needs all of the following:

1. Real DSH 0.2.0-rc.2 under the shipped Electron-as-Node starts in the container. ACP
   initialize, session/new, model select, prompt and close succeed over inherited stdio.
2. The child process's token is verified from the host: it is an AppContainer, with the expected
   SID and no network capabilities.
3. A complete Cowork turn runs with `ActiveProcessLimit = 1`, through the brokered model pipe
   (deterministic offline model) and the HTTP-MCP bridge pipe (header token).
4. The `realpath` dependencies inside DSH are identified (none blocking), or are handled without
   any ancestor ACL change.
5. Negative checks, on synthetic fixtures only, recording result codes only:
   - outside read and write denied;
   - junction and parent traversal denied;
   - host loopback and internet denied;
   - another turn's pipe denied;
   - a destroyed broker denied;
   - process creation denied.
6. The child-process hang is root-caused far enough to state the production behaviour. A spawn
   denial must be fast and deterministic.
7. Latency is measured for profile create/delete, startup, a turn and cleanup. No residual
   profiles, pipes or processes remain after a forced kill.
8. LPAC versus regular AppContainer is decided.
9. Windows build assumptions are stated (minimum build; Windows 10 is out of support).

If the gate passes, phase D proceeds as planned in §8. If it fails on DSH compatibility, the
fallbacks are an owner-approved option C, or an upstream DSH change (for example, its own
`realpath` use). Neither is adopted silently.

## 7. Reconciliation with FCR-02

The FCR-02 architecture decision stands unchanged:

- AppContainer remains a viable candidate;
- production adoption is blocked on the DSH execution path;
- the host-side relay proposal stays as written.

NXR-SEC-01 adds:

- the Microsoft documentation grounding;
- the explicit rejection of B1–B4;
- the LPAC evaluation;
- host-side token verification as part of the launcher contract;
- the per-turn SID requirement for cross-turn and cross-project separation;
- the authorized-environment precondition.

## 8. Phase D plan (held until §6 passes; Sonnet implements, Opus reviews)

| WP  | Scope                                                                                                                                        | Key acceptance tests                                                                                     |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| D1  | Native launcher helper (C# built from source with the in-box .NET Framework compiler at package time, or an equivalent reviewed toolchain)   | Token verification; fail-closed on each step; no residue after kill; handles limited to stdio            |
| D2  | Host brokers (model pipe → gateway port; bridge pipe → host relay), per-turn names, SID-scoped DACL                                          | Another SID denied; a destroyed broker denied; wrong or missing token rejected by the gateway and bridge |
| D3  | Host-side HTTP-MCP bridge relay; `session/new` mounts the bridge as HTTP MCP                                                                 | Delegation limit, unit accounting and standalone-only rules unchanged (B2, B4)                           |
| D4  | `runLocalAcpSession` isolation mode: environment without `TEMP` passthrough, `--preserve-symlinks`, preload redirect for exactly two origins | Real-DSH turn PASS; model-route guard unchanged; no token in argv                                        |
| D5  | `DshCoworkService` status, probing and the fail-closed reason; renderer state                                                                | Isolation unavailable means the turn is never started host-local                                         |
| D6  | OS-level regression suite (real Windows enforcement, synthetic fixtures)                                                                     | The NXR-SEC-01 test matrix                                                                               |
| D7  | Packaging: build the helper, grant the runtime capability, sweep profiles on uninstall                                                       | Fresh installer, packaged E2E, uninstall leaves no profiles                                              |

## 9. Proposed ADR-030 amendment (for owner approval; not applied)

> **Decision 4, Cowork placement (amended).** Cowork runs one pinned DSH ACP process per engine
> turn inside a **per-turn Windows AppContainer** created by Desktop main's isolation launcher. It
> has no network capability, grants only on Nexar-owned runtime, scratch and home folders, a
> one-process job, and host-brokered named pipes for the Control Model Gateway and a host-side
> HTTP-MCP bridge relay. If isolation cannot be established and verified, Cowork is unavailable;
> there is no host-local fallback. Coding placement is unchanged. **Consequence:** the original
> host-local Cowork placement is superseded; FCR-01-09 is closed only by the passing OS-level
> regression suite.

## 10. Owner decisions required

1. Authorize a disposable Windows 11 test VM and an engineer to run the §6 gate, outside this
   assistant session if necessary.
2. Approve or reject the ADR-030 amendment (§9) after the gate.
3. If the gate fails, decide between option C (WSL2 for Cowork), an upstream DSH change, or
   keeping Cowork restricted or blocked.
4. Supported Windows baseline (for example, Windows 11 23H2+) for the isolation feature.
