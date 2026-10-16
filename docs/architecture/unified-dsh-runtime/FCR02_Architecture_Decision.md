# FCR-02 — Cowork OS isolation: architecture decision

**Date:** 2026-10-12 (Africa/Cairo). **Status:** decision recorded; production adoption deferred to owner review.
**Baseline:** FCR-01 verified head `7337aa00b667429834478c719532464b3a81b195` (PR [#41](https://github.com/mohmedhat797/Nexar-Ai/pull/41), unchanged).
**Branch:** `fcr02/opus-integration`. **ADR:** [ADR-030](../../adr/030-unified-dsh-first-agent-runtime.md) stays Proposed.
**Cowork security verdict:** `COWORK_SECURITY_REQUIRES_OWNER_DECISION` (FCR-01-09 remains open).

## Decision

1. **A Windows AppContainer is a viable candidate isolation boundary for Cowork.** A throwaway spike
   showed that Windows itself, not Nexar, enforces the filesystem and network restrictions Cowork
   needs.
2. **FCR-02 does not accept AppContainer as the production Cowork executor.** The execution model
   DSH needs inside the boundary has not been demonstrated. Starting a child process inside the
   container hung, and today DSH starts the Intelligence Bridge relay as a child process.
3. **Cowork stays as FCR-01 left it.** It runs host-local with the hardened application policy
   (read-only start, per-call write permission, fail-closed path checks, reduced tool catalog).
   FCR-01-09 (no OS read boundary) remains an open, owner-level blocker for untrusted use.
4. **Isolation is not weakened to make DSH work.** This includes broad filesystem capabilities,
   unrestricted network, relaxed grants and a silent fallback to host-local execution (see
   [Constraints that any solution must keep](#constraints-that-any-solution-must-keep)).
5. **Next step: an architecture proposal, not implementation.** Keep the bridge relay (and every
   other helper process) on the host. Run only the DSH workload in the container, talking to the
   host through narrowly brokered pipes. See [Proposed next architecture](#proposed-next-architecture).

## Options evaluated

| Criterion               | A. AppContainer (spiked)                                   | A′. Restricted token / low integrity / separate user                                                                                 | B. WSL2 + bubblewrap (as Coding)            | C. Windows Sandbox / Hyper-V VM                 |
| ----------------------- | ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------- | ----------------------------------------------- |
| Read isolation          | **OS-enforced** (spike: outside reads `EPERM`)             | Low integrity does not block reads; restricted SIDs still match the broad `Users`/`Authenticated Users` entries on non-system drives | OS-enforced (namespaces; proven for Coding) | OS-enforced (separate OS)                       |
| Write isolation         | **OS-enforced** (spike)                                    | Partial (low integrity blocks writes up)                                                                                             | OS-enforced                                 | OS-enforced                                     |
| Network isolation       | **OS-enforced** (no capability ⇒ no loopback, no internet) | None                                                                                                                                 | OS-enforced (net namespace + proxy)         | Configurable                                    |
| Clean-Windows (ADR-030) | Kept (in-box APIs; no admin, Python or WSL2)               | A separate user needs admin to create the account                                                                                    | **Violates** — needs WSL2 (ADR amendment)   | Needs Pro/Enterprise + optional feature (admin) |
| Required privileges     | None (standard user)                                       | Admin for a separate user                                                                                                            | WSL2 install                                | Admin, feature enablement                       |
| Packaging impact        | Small native launcher, built with the in-box `csc.exe`     | Small                                                                                                                                | Plane transport, path mapping               | Heavy; unsuitable per turn                      |
| Per-turn startup        | Low (process creation)                                     | Low                                                                                                                                  | Medium                                      | High (VM boot)                                  |
| Testability             | Good: negative tests run on any Windows 11 dev machine     | Good                                                                                                                                 | Linux-only tests                            | Poor in CI                                      |
| Open problems           | Child processes, DSH relay, Node path behavior (below)     | Does not meet the read objective                                                                                                     | Product requirement change                  | Cost/latency, privilege                         |

A′ is rejected because it cannot meet the read-isolation objective. B is a valid fallback, but
it needs an explicit ADR-030 amendment and owner approval, so it is not chosen silently. C is
rejected for per-turn Cowork. **A is the preferred candidate**, subject to the open problems below.

## Spike method

The spike ran on Windows 11 Pro 10.0.26300 x64, with .NET Framework 4.8.1 and the in-box
`csc.exe`, on 2026-10-11/12. It used a throwaway launcher that called documented Win32 APIs
directly:

- `CreateAppContainerProfile` / `DeriveAppContainerSidFromAppContainerName` — the container identity.
- `CreateProcessW` + `STARTUPINFOEX` with two attributes:
  - `PROC_THREAD_ATTRIBUTE_SECURITY_CAPABILITIES` — the AppContainer token, optionally with capabilities.
  - `PROC_THREAD_ATTRIBUTE_HANDLE_LIST` — only the three stdio handles are inherited.
- An explicit environment block. Nothing else is inherited.
- A job object with `KILL_ON_JOB_CLOSE`.
- Folder grants to the container SID on spike-owned folders only: read/execute on the runtime
  folder, modify on the working folder.
- A host-side broker: a named pipe whose DACL grants only the container SID and the owner, with a
  Low mandatory label. It relays bytes to a loopback TCP test server outside the container.

The workload inside the container was a copy of Node 22.23.3 running a probe script. The probe
recorded only result codes. Read and write cases targeted **synthetic fixture files** created for
the spike outside the granted folders: one under the user-profile temp area and one on `D:`. Two
listing attempts targeted real profile folders (the profile root and `~\.ssh`); both were denied
and returned only an error code. The probe
used raw Node `fs`/`net` calls with no Nexar code loaded. Every denial below therefore comes from
the operating system, independent of Nexar's permission broker.

**Not exercised in the spike:**

- real DSH 0.2.0-rc.2;
- Electron-as-Node (`ELECTRON_RUN_AS_NODE`);
- the bridge relay;
- the Control Model Gateway;
- ACP.

The spike proves the boundary's properties, not that DSH works inside it.

## Results

| Probe (inside the container)                                                       | Observed                                                 | Meaning                                                                      |
| ---------------------------------------------------------------------------------- | -------------------------------------------------------- | ---------------------------------------------------------------------------- |
| Read a file in the granted working folder                                          | allowed                                                  | Granted scope works                                                          |
| Write a file in the granted working folder                                         | allowed                                                  | Granted scope works                                                          |
| Read a synthetic file under the user profile, outside the grant                    | `EPERM`                                                  | **Filesystem read isolation PASS**                                           |
| Read a synthetic file on `D:`, outside the grant                                   | `EPERM`                                                  | Non-system drives also covered                                               |
| `stat` of the outside file; list the user-profile root; list `~\.ssh`              | `EPERM`                                                  | Metadata and listings also denied                                            |
| Write a synthetic file outside the grant                                           | `EPERM`; host confirmed the target absent                | **Write isolation PASS**                                                     |
| Read through a junction inside the granted folder that points outside              | `EPERM`                                                  | **Junction escape prevented** (access checked on target)                     |
| Read `C:\Windows\win.ini`                                                          | allowed                                                  | Residual: public OS files granted to `ALL APPLICATION PACKAGES` are readable |
| TCP connect to a host loopback server                                              | `ETIMEDOUT`                                              | **Host loopback blocked**                                                    |
| TCP connect to a public IP                                                         | `EACCES`                                                 | **Direct internet blocked**                                                  |
| Listen + connect on loopback within the same container                             | allowed                                                  | Intra-container loopback is not blocked                                      |
| HTTP request through the brokered pipe to the host loopback server                 | `200`, expected body                                     | **Brokered host communication works**                                        |
| `fs.realpathSync` / `fs.realpathSync.native` of the granted folder                 | `EPERM`                                                  | Path normalization unavailable (ancestors not readable)                      |
| Start Node without `--preserve-symlinks --preserve-symlinks-main`                  | fails: `EPERM` on `lstat 'C:\'`                          | **`--preserve-symlinks` required**                                           |
| Explicit environment without `LOCALAPPDATA`                                        | `CreateProcessW` → `ERROR_ENVVAR_NOT_FOUND` (203)        | **`LOCALAPPDATA` required** in the block                                     |
| `TEMP`/`TMP`                                                                       | OS redirects to `%LOCALAPPDATA%\Packages\<name>\AC\Temp` | Per-profile, persistent temp area                                            |
| Custom capability SIDs (e.g. `internetClient`, a custom name)                      | accepted                                                 | Capability-scoped grants are possible                                        |
| `isolatedWin32-volumeRootMinimal` / `-profilesRootMinimal` / `-userProfileMinimal` | `CreateProcessW` → `ERROR_INVALID_PARAMETER`             | **`isolatedWin32-*` capabilities rejected**                                  |
| Start a child process from inside the container (sync and async `spawn`)           | hung; outer timeout terminated the job                   | **Child process execution unresolved**                                       |

### Child-process hang (unresolved)

In the async variant the probe stopped producing output at the spawn step, and its own 8-second
timer never fired. This suggests the spawn call itself (`CreateProcessW` under libuv) blocked
rather than the child failing later. The root cause was not established. Possible causes not yet
tested:

- console or conhost attachment for a lowbox child;
- the inherited-handle list interacting with libuv's stdio pipes;
- job or token effects.

This is a blocking architecture issue, not a missing test.

### Ancestor ACL manipulation (rejected technique)

An attempt to grant read-attributes on the user-owned ancestor folders (`AppData`,
`AppData\Local`, …) showed two problems:

- `SetNamedSecurityInfo` re-walks the whole subtree to propagate inheritance: more than 40 minutes
  across `AppData`.
- Writing the DACL directly (`SetKernelObjectSecurity`) is fast, but it dropped the folder's
  auto-inherited flag (`SE_DACL_AUTO_INHERITED`). New subfolders then received non-canonical,
  explicitly copied ACLs.

The spike's own changes were reverted (see [Experiment hygiene](#experiment-hygiene)). **A
production design must not modify ACLs on ancestor or other user-owned folders.** Grants belong
only on folders Nexar creates and owns.

## What AppContainer proved

- **Real OS-enforced filesystem isolation for Cowork.** Reads, metadata, listings and writes
  outside the granted folders fail with OS access-denied, on both the system drive and other drives.
- **Denial independent of Nexar application logic.** The probe bypassed the permission broker
  entirely; the kernel's access check produced every denial.
- **Junction escape prevention.** A link inside the granted folder does not extend the grant; the
  target is checked. This also closes the FCR-01-10 post-grant replacement race for anything
  outside the granted folders.
- **Direct network and loopback isolation.** With no network capability, the container reaches
  neither host loopback services nor the internet.
- **Controlled host communication.** A host-owned named pipe with a container-specific DACL
  carries a working HTTP exchange to a host service. The host chooses the only reachable endpoint.

## What prevents production adoption today

1. **Unresolved child-process execution.** Spawning from inside the container hung.
2. **DSH relay dependency.** Cowork mounts the Intelligence Bridge as an ACP **stdio** MCP server
   (`relayFor`, [dsh-cowork.ts](../../../apps/desktop/src/main/dsh-cowork.ts)). DSH therefore
   spawns `bridge-relay.cjs` (Electron-as-Node) as its own child. That child connects to the host
   bridge pipe `\\.\pipe\nexar-bridge-*`, which Node creates with a default DACL that a container
   cannot open. Model calls go to the loopback Control Model Gateway, which the container cannot
   reach either.
3. **Windows capability limitations.** The `isolatedWin32-*` traversal capabilities are rejected
   for non-packaged processes. Inside the container, ancestors of user folders (`C:\`,
   `C:\Users`, the profile root) cannot be resolved.
4. **Node filesystem behavior.** Module loading needs `--preserve-symlinks
--preserve-symlinks-main`, and `realpath` (sync and native) fails. Whether DSH 0.2.0-rc.2 calls
   `realpath` on its working, home or plugin paths is unknown; that is a compatibility risk.
5. **Undesirable ancestor-ACL manipulation.** The only ways found to restore `realpath` modify
   user-owned ancestor ACLs, and that is rejected.

Also unverified:

- Electron-as-Node inside a container.
- Granting the packaged runtime: a one-time inheritable grant on the per-user install folder
  propagates across the DSH tree (538 packages).
- Concurrent turns sharing one container SID. Per-turn profiles or per-turn SIDs are needed for
  cross-turn and cross-project isolation, since `AC\Temp` persists per profile.

## Security conclusion

AppContainer remains a viable candidate isolation boundary for Cowork. FCR-02 cannot accept it
as the production Cowork executor until the DSH execution path works inside it without weakening
the boundary. Until then:

- Cowork's guarantees are application-level only (tool restrictions plus the permission broker).
  FCR-01-09 stands.
- No OS-isolation claim is made for Cowork.
- The `COWORK_OS_ISOLATION_VERIFIED` verdict is **not** issued.

## Constraints that any solution must keep

- No broad filesystem capabilities. Grants go only to Nexar-created folders: read/execute for the
  runtime, modify for per-turn scratch and home. No user-owned or ancestor ACL changes, and no
  `ALL APPLICATION PACKAGES`-style broadening of user data.
- No network capability on the container (`internetClient`, `privateNetworkClientServer`) and no
  loopback exemption. The host chooses every reachable endpoint through brokered pipes.
- No silent fallback to host-local execution. If isolation is unavailable, Cowork reports it and
  fails closed unless the owner explicitly decides otherwise.
- No new standing write authority. Nexar's broker stays authoritative for every write the runtime
  asks for. The OS boundary is defense in depth, not a replacement for policy (ADR-016/B3).
- Gateway and bridge tokens, grants and NRC accounting keep their current semantics. The broker
  relays bytes; it does not authenticate on the runtime's behalf.

## Proposed next architecture

**Goal:** only the DSH workload runs inside the AppContainer. Everything that needs host reach
stays on the host, behind pipes the host creates and scopes to the per-turn container SID.

```text
Desktop main (host, owner identity)
 ├─ ACP client  ── inherited stdio handles ──────────────►┐
 ├─ Control Model Gateway (loopback, unchanged)           │
 │     ▲ host-side broker: pipe(gateway, SID-scoped)  ◄───┤
 ├─ Bridge relay, host-side (MCP over HTTP → bridge pipe) │
 │     ▲ host-side broker: pipe(bridge, SID-scoped)   ◄───┤
 └─ launcher: per-turn AppContainer, job object,          │
              ActiveProcessLimit = 1                       │
                                                          ▼
        AppContainer (per-turn SID, no network capability)
          DSH (single process): cwd = scratch, DSH_HOME = per-turn home
          model HTTP + bridge HTTP-MCP → in-process redirect to the two brokered pipes
```

1. **Bridge relay moves host-side.** Pinned DSH advertises ACP `mcpCapabilities: { http: true }`
   (`@deepseek-ai/dsh-acp`). Nexar can therefore mount the bridge as an **HTTP** MCP server in
   `session/new`, with the grant token in a request header, instead of a stdio child. A host-side
   relay speaks MCP over HTTP and forwards to the existing bridge endpoint with the existing
   grant/token checks.
2. **No child processes inside the container.** The Cowork profile already disables shell, jobs,
   plugins, subagents and workflow. If DSH needs no child for the Cowork profile, a job object
   with `ActiveProcessLimit = 1` turns "Cowork cannot start processes" into an OS-enforced
   guarantee. The child-spawn hang then stops being a requirement; it still gets root-caused
   during the spike.
3. **Model and bridge HTTP reach the host only through brokered pipes.** A small Nexar preload,
   loaded with `--require`, redirects connections for exactly the two configured loopback origins
   to their pipes. This is a compatibility shim, not a security control: without it, those
   connections simply fail inside the container.
4. **Per-turn identity.** A fresh AppContainer profile per turn (deleted at turn end, swept at
   startup) gives cross-turn and cross-project separation and clears `AC\Temp`. Runtime read
   access is granted once to a Nexar **custom capability SID** on Nexar-owned runtime folders
   only. Scratch and home get modify rights for the per-turn SID only.
5. **NRC, gateway and memory are unchanged.** The gateway still pins the control decision per
   turn and accounts each call. Project memory still arrives only through the overlay and
   required context, written by the host into the per-turn home.

This keeps the boundary's demonstrated properties and adds an OS-level denial of process
creation. It reduces the container's needs to: start Node, read the runtime, use its two folders,
and talk over stdio and two pipes.

### Another spike before production implementation

**Recommended — yes**, time-boxed, with exit criteria. Production code should start only if
each item below passes or has an owner-approved answer:

1. Real DSH 0.2.0-rc.2 under Electron-as-Node starts in the container with
   `--preserve-symlinks --preserve-symlinks-main` and runs ACP over inherited stdio:
   `initialize`, `session/new`, model select, prompt, close.
2. With `ActiveProcessLimit = 1`, the Cowork profile completes a turn. Otherwise, it is
   identified exactly which DSH component needs a child.
3. Model calls flow through the brokered gateway pipe using the deterministic offline model
   fixture only (no paid inference).
4. An HTTP MCP bridge mount from `session/new` works through the brokered bridge pipe, with
   header authentication.
5. The child-process hang is root-caused (diagnostic only).
6. Startup latency and per-turn profile create/delete cost are measured. Leftover profiles are
   swept after a forced kill.
7. Negative checks, on synthetic fixtures only and recording result codes only:
   - outside read and write denied;
   - junction escape denied;
   - host loopback and internet denied;
   - process creation denied.
8. A supported-OS statement is made. The spike ran only on Windows 11 build 26300; Windows 10 is
   past end of support and untested.

## Experiment hygiene

The spike ran outside the repository, in a session scratch folder and
`%LOCALAPPDATA%\nexar-fcr02-spike2`, plus synthetic fixtures in the ignored worktree folder
`.nexar\fcr02-spike`. Cleanup and its verification are recorded below. Nothing in this document
relies on machine state that survives the cleanup.

Cleanup was done on 2026-10-12, then verified with a read-only script.

| Item                                                                                                                                           | Action                                                                                     | Verified result                                                                                                                                                                                                                                                                         |
| ---------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Four AppContainer profiles (`nexar.fcr02.spike`, three ephemeral `nexar.fcr02.t*`)                                                             | `DeleteAppContainerProfile` (all `S_OK`)                                                   | 0 registry mappings and 0 `Packages` folders named `nexar.fcr02*`                                                                                                                                                                                                                       |
| Read-attributes entry for the spike container SID on 7 ancestor folders (`AppData` … session `scratchpad`)                                     | `icacls /remove:g` of that SID only                                                        | SID absent from all 7                                                                                                                                                                                                                                                                   |
| Read-attributes entry for the spike's custom capability SID on `AppData`, `AppData\Local`                                                      | `icacls /remove:g` of that SID only                                                        | SID absent                                                                                                                                                                                                                                                                              |
| `SE_DACL_AUTO_INHERITED` dropped from `AppData` and `AppData\Local` by the spike's direct DACL write                                           | Restored by the same standard `icacls` write                                               | Both show `D:AI` again, matching their siblings `Roaming` and `LocalLow`. The only object created under them while the flag was missing was the spike's own folder, now removed.                                                                                                        |
| Unrelated entries                                                                                                                              | None changed                                                                               | 6 folders: entries exactly equal "backup minus experiment entries". `AppData`: the same entry set, but Windows' ACL write swapped the order of two pre-existing allow entries for one unrelated capability SID (`S-1-15-3-3557520199-…`). Both are allows, so the access is equivalent. |
| `%LOCALAPPDATA%\nexar-fcr02-spike2`, session `scratchpad\spike`, worktree `.nexar\fcr02-spike` (and the then-empty `.nexar` the spike created) | Junctions removed first (all pointed only to the spike's own fixture folder), then deleted | All absent                                                                                                                                                                                                                                                                              |

The pre-cleanup security descriptors were backed up to the session scratch folder before any
change. The worktree's only Git changes are the FCR-02 documents.
