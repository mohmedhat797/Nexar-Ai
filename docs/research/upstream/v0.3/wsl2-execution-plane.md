# WSL2 as the Nexar Engineering Execution Plane host

| Field | Value |
| --- | --- |
| Inspected | 2026-10-01 |
| Question | Can Windows host -> WSL2 Ubuntu -> bubblewrap (bwrap) be a fail-closed home for write-capable coding agents? |
| Primary sources | Microsoft Learn WSL docs (wsl-config, filesystems, file-permissions, case-sensitivity, networking, compare-versions, basic-commands, faq, tutorials/wsl-git); microsoft/WSL2-Linux-Kernel (`config-wsl`, tags, branches); wsl.dev interop page; Claude Code sandbox docs; Ubuntu/AppArmor docs |
| Method | Docs fetched and quoted; kernel configs downloaded and grepped; mechanics that do not depend on WSL were run in a Linux container (see `bubblewrap-sandbox.md`). **No Windows/WSL machine was available: every WSL-runtime behaviour below is documented, not observed, and marked UNVERIFIED where docs are silent.** |
| Companion notes | `bubblewrap-sandbox.md`, `worktrees-and-acp.md` |

## 1. Findings

### 1.1 Architecture and kernel
- WSL2 runs "an actual Linux kernel inside a managed VM", "distributions as isolated containers inside the managed VM" (compare-versions). All distros share one VM and one kernel. WSL2 is **not** a security boundary between the Linux side and the Windows user's files; the bwrap layer is what creates the boundary.
- Kernel is built by Microsoft and serviced via updates (compare-versions). `git ls-remote` of microsoft/WSL2-Linux-Kernel (2026-10-01): newest tag `linux-msft-wsl-6.18.40.1`; branches `linux-msft-wsl-6.18.y` and `linux-msft-wsl-6.6.y` exist. Which one a given Windows box boots by default: UNVERIFIED (secondary sources say 6.18 is current, 6.6 was the 2024-26 default). The Microsoft kernel-release-notes page is stale (last entry 5.15.57.1). Action: `uname -r` in the doctor check, do not hard-code.
- `config-wsl` for **both** 6.6.y and 6.18.y (downloaded): `CONFIG_USER_NS=y`, `PID_NS`, `NET_NS`, `UTS_NS`, `IPC_NS`, `CGROUPS=y`, `SECCOMP_FILTER=y`, `OVERLAY_FS=y`, `9P_FS=y`, `BINFMT_MISC=y`, `SECURITY_APPARMOR=y`, `SECURITY_YAMA=y`, `LSM="landlock,lockdown,yama,loadpin,safesetid,integrity,selinux,apparmor,tomoyo"`. So everything bwrap needs is compiled in, and Landlock is available as a second layer (the DeepSeek Harness sandbox falls back "bwrap then Landlock").
- 5.15.57.1 release notes: "Enable the Landlock Linux Security Module"; 5.10.102.1: "Disable unprivileged BPF by default".

### 1.2 Unprivileged user namespaces and Ubuntu AppArmor
- bwrap needs unprivileged userns (bubblewrap README: uses them "to build the sandbox, allowing any user to use the tool"; newer bwrap refuses setuid). Claude Code docs: sandbox "runs on macOS, Linux, and WSL2"; WSL1 unsupported "because bubblewrap requires kernel features only available in WSL2".
- Ubuntu 24.04+: `kernel.apparmor_restrict_unprivileged_userns=1` makes unconfined processes unable to use userns unless confined by a profile with `userns,` (Ubuntu blog/discourse spec SE045; discourse "Understanding AppArmor User Namespace Restriction"). The sysctl is part of Ubuntu's kernel/AppArmor integration. WSL boots Microsoft's kernel, not Ubuntu's, so the key probably does not exist there: Claude Code docs tell users to run `sysctl kernel.apparmor_restrict_unprivileged_userns` "including inside WSL2" and skip the fix when it returns `0` or "No such file or directory". Whether it exists on a specific WSL kernel: UNVERIFIED (not observed).
- Safe handling (never set the sysctl to 0 globally; Ubuntu docs call that out as removing a protection): add a **bwrap-scoped** profile. Verbatim from Claude Code docs (`/etc/apparmor.d/bwrap`):
  `abi <abi/4.0>, include <tunables/global> profile bwrap /usr/bin/bwrap flags=(unconfined) { userns, include if exists <local/bwrap> }` then `systemctl reload apparmor`. "The profile applies only to `bwrap` itself, not to the commands it runs inside the sandbox." Ubuntu also ships an experimental `bwrap-userns-restrict` profile pair (apparmor-profiles package, `/usr/share/apparmor/extra-profiles/`) that stacks a capability-denying profile on children: stronger, UNVERIFIED on WSL (secondary source only).
- Local evidence: unprivileged user, kernel 6.18, no AppArmor restriction: `bwrap --unshare-all` works; `CapEff=0`, `NoNewPrivs=1` inside even without `--cap-drop`.

### 1.3 systemd and cgroups
- `[boot] systemd=true` in `/etc/wsl.conf`, WSL2 only; `[boot]` section is "only available on Windows 11 and Server 2022"; `initTimeout` default 10000 ms (wsl-config). Needed for a user-level service manager and for AppArmor reload commands.
- `[automount] cgroups` default `v2`; `.wslconfig [wsl2] isolateDistroCgroup` default `true`, "requires cgroup v2". Per-run memory/pids limits via `systemd-run --user --scope -p MemoryMax=... -p TasksMax=...`: UNVERIFIED on WSL (needs cgroup delegation to the user manager). Fallback that needs nothing: `prlimit`/`ulimit` before `bwrap`, and a wall-clock kill by the plane.

### 1.4 Filesystems (what decides where worktrees live)
| Aspect | Linux ext4 (VHDX, `/home/...`) | `/mnt/c` (DrvFs, over Plan 9/9P) |
| --- | --- | --- |
| Microsoft guidance | "store your files in the WSL file system if you are working in a Linux command line", use `/home/<user>/Project`, "Not ... `/mnt/c/Users/...`" (filesystems) | same page: cross-OS work discouraged; WSL1 is faster here, WSL2 is not (compare-versions: "Performance across OS file systems" WSL2 = no) |
| Permissions | Normal Linux; umask, chmod, chown real (file-permissions) | metadata off by default: perms computed from the Windows ACL as one rwx triple for user/group/other; `chmod` only toggles the read-only attribute; with `metadata` it stores `$LXUID/$LXGID/$LXMOD` as NTFS EAs |
| Symlinks | Real symlinks (FAQ: "Symlinks created for non-admin users" is a Linux-root property) | Windows-controlled; reparse points; creation rights differ (UNVERIFIED details) |
| Case | Case-sensitive (case-sensitivity page) | Case-insensitive by default; per-dir flag via `fsutil.exe file setCaseSensitiveInfo`, needs elevation and an empty dir; `case=force` is WSL1-only |
| inotify | Works | Windows-side changes raise no inotify events in WSL2 (microsoft/WSL#4739, open); WSL-side changes do |
| Git | `core.filemode` meaningful | every file gets the same computed rwx triple (inferred: a Windows-readable file looks executable) -> spurious mode diffs. Local proof of the mechanism: tracked script `chmod 755`: `filemode=true` -> `M a.sh`; `filemode=false` -> clean. CRLF: Microsoft's git page says to set consistent line endings with `.gitattributes` when one folder is shared between Windows and WSL |
- Windows reaches Linux files at `\\wsl$\<distro>\...` (also `\\wsl.localhost\<distro>\...`, used in wsl-config's own example path). "Any Windows app accessing Linux files will have the same permissions as the default user"; files created from Windows get umask 022 (file-permissions). Tutorial warns that Windows Git and WSL Git keep separate config (`%UserProfile%\.gitconfig` vs the distro's).
- **Recommendation:** per-task clones and the artifact staging dir live on ext4: `~/.local/share/nexar/worktrees/<task-id>/` (0700). Never on `/mnt/c`, never a drvfs/virtiofs mount. Windows UI reads them via `\\wsl.localhost\...`, read-only by convention (Nexar's Windows client never writes there). Windows tools that open agent-written files should be treated as an execution path (open-with, indexers, IDE workspace-trust): UNVERIFIED risk, design rule only.

### 1.5 Interop and the `/mnt/c` exposure
- WSL registers a binfmt entry `WSLInterop` pointing at `/init`; `/init` finds an interop server through `$WSL_INTEROP`, else `/run/WSL/<pid>_interop` for its own pid and then up the parent chain (wsl.dev interop page). Claude Code docs: "WSL hands a launch of a Windows binary such as `cmd.exe`, `powershell.exe`, or anything under `/mnt/c/` to the Windows host over a Unix socket", so a sandbox can launch them unless unix sockets are blocked (their seccomp filter) or the socket path is not visible.
- Microsoft's wsl-config: `[interop] enabled=false` "will block the launch of Windows processes", `appendWindowsPath=false` stops adding Windows paths to `$PATH`; `[automount] enabled=false` stops the `/mnt/<drive>` DrvFs mounts. Runtime toggle `echo 0 > /proc/sys/fs/binfmt_misc/WSLInterop` is per-session only (filesystems page), so use wsl.conf.
- bwrap behaviour (observed in the Linux container, same mechanism on WSL): the sandbox root is a fresh tmpfs; only paths named by `--ro-bind/--bind` exist. `ls /run` -> only the mounted `nexar` dir; `/run/WSL` and `/init` do not exist; `/mnt` does not exist; `--clearenv` removes `WSL_INTEROP`. So `/mnt/c` and interop sockets are hidden by default as long as the profile is an allowlist (never `--ro-bind / /`). Real-WSL check that a PE binary cannot be launched from inside the sandbox: UNVERIFIED, must be a plane acceptance test.
- Caveat: DeepSeek Harness' own profile is `--ro-bind / / ...` (read-only, whole host visible, no netns). It must never be the outer sandbox; it only works nested (tested, see companion note).

### 1.6 Recommended `/etc/wsl.conf` for a dedicated distro (`nexar-eng`)
```ini
[boot]
systemd=true            # user manager, apparmor reload; WSL2 + Win11/Server2022 only
[automount]
enabled=false           # no /mnt/c, /mnt/d inside the distro
mountFsTab=false        # no surprise fstab mounts (SMB etc.)
[interop]
enabled=false           # Linux cannot launch Windows .exe
appendWindowsPath=false # no Windows dirs on PATH
[user]
default=nexar           # unprivileged; never root
[gpu]
enabled=false           # no /dev/dxg, no /usr/lib/wsl on PATH (wsl-config [gpu]); agents need no GPU
[network]
generateResolvConf=true # default; the sandbox has no DNS anyway, only the proxy resolves
```
Global `%UserProfile%\.wslconfig` (applies to all distros): `[wsl2] firewall=true` (default; Windows/Hyper-V firewall filters WSL traffic), `networkingMode=nat` (or `mirrored`, see 1.8), `[experimental] hostAddressLoopback=false` (default), `[general] instanceIdleTimeout` raised (default 15000 ms) if the plane runs long background jobs. `.wslconfig` is machine-wide and the user's, so Nexar should **document**, not write, it. Create the distro reproducibly with `wsl --import nexar-eng <dir> <rootfs.tar>` (basic-commands) rather than the Store launcher; for imported distros the default user must be set in `wsl.conf` `[user]` (basic-commands warning). Changes apply after `wsl --terminate nexar-eng` (the "8 second rule").
Also inside the distro: no `sudo` for `nexar`, `apt` pinned to `bubblewrap socat git ca-certificates`, `/etc/apparmor.d/bwrap` profile if the doctor finds the sysctl.

### 1.7 How Windows invokes the plane
- Documented forms: `wsl.exe --distribution <d> --user <u> --cd <dir> --exec <cmd...>` ("--exec: Execute the specified command without using the default Linux shell"; "--cd ... absolute Linux path"; "--user"; strings from microsoft/WSL `Resources.resw`). Docs: commands run via `wsl <command>` "are handled like any command run in WSL. ... piping, and file redirection work"; arguments are "forwarded ... without modification" (filesystems). Env crosses only via `WSLENV` (names listed, flags `/p /l /u /w`; case-sensitive) so pass a **minimal, explicit** list and never rely on it for secrets.
- Pitfalls: PowerShell pipelines re-encode text (community reports), so spawn `wsl.exe` from Node `child_process` with piped stdio rather than from a PowerShell pipeline; wsl.exe has its own failure exit codes (e.g. issue #6192 `--help` returns -1; #12132 asks for documented codes), and whether the Linux command's exit status is propagated 1:1 is UNVERIFIED here. Therefore the plane returns an explicit JSON result line (`{"exit":N,"signal":...}`) and the caller treats a missing result as `INTERNAL`.
- Lifetime: "If you have no open file handles to Windows processes, the WSL VM will automatically be shut down" (faq); keep a `wsl.exe` child open for the whole run. What happens to the Linux process tree if the Windows parent is killed: UNVERIFIED -> plane must own deadlines itself (see companion note, `--die-with-parent`).
- **Recommendation: run Nexar's execution-plane engine inside WSL; Windows keeps a thin shim.** Reasons: (1) bwrap, the CONNECT proxy, its unix socket and `socat` must share one kernel/mount namespace; (2) ADR-012 `resolveContainedPath` realpath semantics and 0600/0700 modes are only meaningful on ext4, not through `\\wsl$`; (3) signals, process groups and `--die-with-parent` are Linux semantics; (4) credentials references/tokens stay in WSL `~/.nexar` instead of crossing the 9P boundary. Wire: one long-lived `wsl.exe -d nexar-eng --user nexar --exec /usr/local/bin/nexar-plane serve --stdio` per Windows session, NDJSON frames on stdout only, logs on stderr (same discipline as the MCP bridge, ADR-014). The Windows host never opens TCP to the plane.

### 1.8 Networking (NAT vs mirrored)
- Default **NAT** (networking.md): Windows -> WSL via `localhost` works; WSL -> Windows needs the host gateway IP (`ip route show | grep default`); `localhostForwarding=true` makes "ports bound to wildcard or localhost in the WSL 2 VM ... connectable from the host via `localhost:port`" (wsl-config). So any TCP listener the plane opens on 127.0.0.1 *in the distro* is reachable from every Windows process. The sandbox's own netns is private, so the in-sandbox `socat` listener is not exposed; **but the plane must expose nothing on TCP**: proxy = unix socket only, control = stdio.
- **Mirrored** (Windows 11 22H2+): Windows and WSL reach each other through `127.0.0.1` (IPv6 `::1` unsupported), VPN/multicast improvements, LAN can reach WSL (Hyper-V firewall inbound rules). Larger exposure surface, no benefit for this design; stay on NAT unless a VPN forces mirrored. `autoProxy=true` makes WSL pick up the Windows HTTP proxy settings; `dnsTunneling` default on.
- Consequence for the allowlisting proxy: it resolves names itself; in NAT mode the Windows host is a reachable private IP, so the proxy must refuse any resolved address in loopback/RFC1918/link-local/CGNAT and the default-gateway IP (SSRF to Windows services). Corporate upstream proxy support (CONNECT chaining) may be needed under `autoProxy`: UNVERIFIED requirement.
- Domain-fronting caveat (Claude docs, Security limitations): hostname allowlists without TLS inspection "can potentially" be bypassed with fronting. Use exact hostnames only; never `*.googleapis.com` (it contains `storage.googleapis.com`).

## 2. Implications for Nexar v0.3
1. Ship a `nexar plane doctor` (runs inside WSL): `uname -r`, wsl.conf values, `sysctl kernel.apparmor_restrict_unprivileged_userns` (absent/0/1), functional probe `bwrap --unshare-all --ro-bind /usr /usr ... true`, `/mnt/c` absence, `WSL_INTEROP` absence inside the sandbox, `.exe` launch attempt must fail, Landlock ABI via syscall 444.
2. Dedicated distro `nexar-eng`, unprivileged `nexar` user, wsl.conf from 1.6; Nexar documents `.wslconfig`, never edits it.
3. Worktrees on ext4 only; Windows is a viewer. New ADR needed: "Execution Plane host = WSL2" (supersedes any implicit native-Windows assumption; Claude Code itself does not support native Windows sandboxing).
4. Engine-in-WSL with a stdio NDJSON shim; unix-socket proxy; zero TCP listeners.
5. Treat WSL as defense in depth only; the allowlist profile of `bubblewrap-sandbox.md` is the boundary.

## 3. Open questions
- Which kernel (6.6 vs 6.18) does the owner's WSL boot, and is `kernel.apparmor_restrict_unprivileged_userns` present there? (UNVERIFIED)
- Does `wsl.exe --exec` propagate the Linux exit status, and is the Linux tree killed when the Windows caller dies?
- Does `[interop] enabled=false` also remove the `WSLInterop` binfmt entry or only the listener? Test that `cmd.exe` fails both outside and inside bwrap.
- Does `[automount] enabled=false` leave `\\wsl.localhost\` browsing intact? (Expected yes: Windows-side 9P server; UNVERIFIED)
- Is Windows 11 22H2+ guaranteed on the owner's machine (mirrored/Hyper-V firewall/`[boot]` need it)?
- cgroup v2 delegation for per-run MemoryMax/TasksMax under WSL systemd user manager?
- Does a corporate proxy (autoProxy) force upstream CONNECT chaining in the Nexar proxy?

## 4. Sources
- https://learn.microsoft.com/en-us/windows/wsl/wsl-config , /filesystems , /file-permissions , /case-sensitivity , /networking , /compare-versions , /basic-commands , /faq , /tutorials/wsl-git , /kernel-release-notes
- https://github.com/microsoft/WSL2-Linux-Kernel (branches `linux-msft-wsl-6.6.y`, `6.18.y`, `arch/x86/configs/config-wsl`; tags via `git ls-remote`)
- https://github.com/microsoft/WSL/blob/master/localization/strings/en-US/Resources.resw (wsl.exe help text); https://github.com/microsoft/WSL/issues/4739 , /6192 , /12132
- https://wsl.dev/technical-documentation/interop/
- https://code.claude.com/docs/en/sandboxing , /network-config
- https://ubuntu.com/blog/ubuntu-23-10-restricted-unprivileged-user-namespaces ; https://discourse.ubuntu.com/t/understanding-apparmor-user-namespace-restriction/58007 ; https://discourse.ubuntu.com/t/spec-unprivileged-user-namespace-restrictions-via-apparmor-in-ubuntu-23-10/37626
- https://github.com/containers/bubblewrap (README.md, SECURITY.md) @0f8073dd
