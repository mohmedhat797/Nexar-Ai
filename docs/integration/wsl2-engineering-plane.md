# Owner runbook: the WSL2 engineering plane

This runbook sets up the Nexar engineering execution plane on a Windows machine (ADR-018). It
creates a dedicated WSL2 distro in which Nexar runs coding agents inside a bubblewrap sandbox.
Steps marked **Acceptance** must pass before you trust the plane with write-capable lanes.

Nexar never edits Windows-wide settings. You run every step below yourself.

## Isolated Cowork (NXR-SEC-02)

Production Cowork now requires this existing hardened distro as well as Coding. It uses the Cowork
DSH profile, not the engineering workflow. There is no unrestricted Windows Cowork fallback.
Install/build the matching Nexar CLI in an owner-controlled Linux checkout; its executable must
support `nexar cowork serve --stdio` and include the bundled `dist/bridge-relay.cjs` beside the CLI.
Keep Node 22 and the pinned DSH `0.2.0-rc.2` under managed `/opt` paths. The helper defaults to
`/opt/dsh/lib/node_modules/@deepseek-ai/dsh/lib/bin.js`. It must run as the non-root distro user.

Desktop reuses the owner-edited `codePlane.distro` and `codePlane.command` in `desktop-settings.json`.
Point `command` at the updated Linux CLI executable. The same command must retain its existing
`plane`/Coding commands. An older CLI without `cowork serve` makes Cowork unavailable; the Windows
installer does not upgrade Linux automatically. No Windows DSH override can remove this requirement.
Refresh the Cowork banner after setup. Missing helper, pin, bubblewrap, socat or hardened config
must leave Cowork unavailable; do not weaken distro security to make a check pass.

Approved project inputs are the explicit `documentSets.cowork` entries in `nexar.config.json`, for
example `"documentSets": { "cowork": ["D:/approved-project/brief.md"] }` on that project's record.
Choose files deliberately: their content is copied to `/inputs/cowork` and may reach the selected
model. The project itself, Windows drives, credentials and memory stores are not mounted.
The same session's most recent successful draft artifacts are staged for revisions. Only bounded
flat files are transferred (32 files, 2 MiB each, 4 MiB total); draft outputs support Markdown, text,
JSON and CSV. Read-only/ask-before-write policy remains enforced by Nexar.

Run the additional Windows acceptance gate with matching `NEXAR_SEC02_WSL_COMMAND` and
`NEXAR_SEC02_WSL_REPO`; see
[NXR-SEC-02 acceptance](../development/NXR_SEC02_Windows_WSL_Acceptance.md).
Do not treat an old host-local E2E PASS or the bundled Windows runtime as isolated Cowork acceptance.

## 1. Prerequisites

- Windows 11 (the `[boot]` section of `wsl.conf` needs Windows 11 or Server 2022) with WSL2:
  `wsl --version`.
- About 10 GB free disk space for the distro's virtual disk.

## 2. Create a dedicated distro

Use a separate distro, not your everyday Ubuntu, so automount and interop can be switched off
without affecting your other work.

```powershell
wsl --install -d Ubuntu-24.04 --name nexar-plane   # or: wsl --import nexar-plane <dir> <rootfs.tar>
wsl -d nexar-plane -u root -- bash -lc "useradd -m -s /bin/bash nexar"
```

Do not give the `nexar` user `sudo`.

Inside the distro, as root:

```bash
apt-get update && apt-get install -y bubblewrap socat git ca-certificates curl
# Node >= 22.19 and pnpm 10, from your preferred source (for example nodesource, or a tarball under /opt)
```

## 3. Harden `/etc/wsl.conf`

```ini
[boot]
systemd=true
[automount]
enabled=false
mountFsTab=false
[interop]
enabled=false
appendWindowsPath=false
[user]
default=nexar
[gpu]
enabled=false
```

Apply the changes with `wsl --terminate nexar-plane` and wait about 8 seconds before starting the
distro again.

Keep the machine-wide `%UserProfile%\.wslconfig` on NAT networking (`networkingMode=nat`, the
default) with `firewall=true`. Mirrored networking widens exposure and gives Nexar nothing.

## 4. User namespaces and AppArmor

```bash
sysctl kernel.apparmor_restrict_unprivileged_userns
```

- **"No such file or directory" or `0`:** nothing to do.
- **`1`:** add a profile scoped to bwrap. **Never** set the sysctl to 0 globally.

  ```bash
  sudo tee /etc/apparmor.d/bwrap <<'EOF'
  abi <abi/4.0>,
  include <tunables/global>
  profile bwrap /usr/bin/bwrap flags=(unconfined) {
    userns,
    include if exists <local/bwrap>
  }
  EOF
  sudo systemctl reload apparmor
  ```

## 5. Install Nexar and the agent CLIs (inside the distro, as `nexar`)

Clone your repositories **into the Linux filesystem**, for example `~/src/...`. Never use `/mnt/c`:
it is disabled anyway.

Install each agent CLI with its vendor's official installer and sign in with the vendor's own login
flow, **inside the distro**:

| Runtime     | Install / sign in                                                   | Notes                                                                                    |
| ----------- | ------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| Claude Code | official installer, then `claude` → `/login` (subscription)         | Unset `ANTHROPIC_API_KEY` so the subscription is used                                    |
| Codex       | official package, then `codex login` (ChatGPT sign-in, device flow) | No OpenAI API key needed                                                                 |
| Antigravity | official `agy` installer and Google sign-in                         | Experimental in v0.3. Nexar's probe never starts a sign-in                               |
| DSH         | `npm i -g @deepseek-ai/dsh@<pinned>`                                | Model runs need `DEEPSEEK_API_KEY` (opt-in). The ACP handshake works without credentials |

Nexar never reads, copies or parses these logins. Your config names each runtime's credential
directory as a _mount_, and the sandbox binds only that directory (ADR-018 section 7).

## 6. Use Nexar from Windows

Put a PowerShell shim on your `PATH`:

```powershell
# nexar.ps1
& wsl.exe -d nexar-plane --exec nexar @args
exit $LASTEXITCODE
```

Worktrees live under `~/.local/share/nexar/worktrees/`. Treat them as read-only from Windows, at
`\\wsl.localhost\nexar-plane\home\nexar\.local\share\nexar\worktrees`. Nexar creates result
branches in your repository inside the distro. Merging and pushing them is your decision.

## 7. Acceptance checks

Run these in the distro as `nexar`. Each must give the stated result.

| #   | Check                  | Command                                                                                                                                                                   | Expect                                       |
| --- | ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------- |
| A1  | Nexar plane doctor     | `nexar doctor`                                                                                                                                                            | sandbox: available; wsl.conf: hardened       |
| A2  | No Windows drives      | `ls /mnt/c`                                                                                                                                                               | No such file or directory                    |
| A3  | Interop off            | `cmd.exe /c ver`                                                                                                                                                          | command not found or exec format error       |
| A4  | bwrap works            | `bwrap --unshare-user --unshare-net --ro-bind /usr /usr --symlink usr/bin /bin --symlink usr/lib /lib --symlink usr/lib64 /lib64 --proc /proc --dev /dev true && echo ok` | `ok`                                         |
| A5  | Sandbox has no network | `nexar sandbox selftest`                                                                                                                                                  | all checks pass (no net, `.git` ro, no home) |
| A6  | Kernel recorded        | `uname -r`                                                                                                                                                                | note the version in your setup notes         |

If A4 or A5 fails, Nexar refuses to run write lanes. That is the intended fail-closed behaviour; fix
the plane rather than working around it.

## Status

**Owner acceptance (2026-10-03):** A1–A5 passed and A6 was recorded on the owner's Windows machine
(WSL 2.7.14, kernel `6.18.33.2-microsoft-standard-WSL2`, Ubuntu 24.04.5, bwrap 0.9.0), followed by a
real Desktop review, engineering change, approval and local commit. Evidence:
[`nxr-055-owner-validation.md`](../devlog/evidence/nxr-055-owner-validation.md).

Notes from that run:

- `wsl --install -d Ubuntu-24.04 --name nexar-plane --no-launch` creates the distro without the
  interactive first-user prompt; create `nexar` as root afterwards.
- The first boot creates empty `/mnt/c` (and other drive) mount points before hardening. After the
  hardened restart, check they are unmounted and empty and remove them (`rmdir`) so A2 reports "No
  such file or directory". Never mount them again.
- Desktop launches the plane with a fixed command and a minimal environment, so the owner-installed
  `/usr/local/bin/nexar` launcher should set `NEXAR_CONFIG_PATH` (if unset) to the plane config.
- A private repository can be brought in as a `git bundle` over `wsl.exe` stdin: no Git host
  credential enters the plane and the clone has no pushable remote.

The Linux sandbox mechanics were first verified with bwrap 0.9 in the v0.3 development container. The
owner deferred A1–A6 for the v0.3 release (2026-10-01); this run closes that deferral.
