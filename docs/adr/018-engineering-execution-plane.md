# ADR-018: Engineering Execution Plane (Windows host → WSL2 → bubblewrap)

**Status:** Accepted (2026-10-01) · Issue: #17 (NXR-024)
Evidence (all under [`docs/research/upstream/v0.3/`](../research/upstream/v0.3/)):

- [`wsl2-execution-plane.md`](../research/upstream/v0.3/wsl2-execution-plane.md)
- [`bubblewrap-sandbox.md`](../research/upstream/v0.3/bubblewrap-sandbox.md) (with lab scripts in `lab/`)
- [`worktrees-and-acp.md`](../research/upstream/v0.3/worktrees-and-acp.md)
- the runtime notes in the same directory

## Context

v0.3 runs **write-capable** coding agents: Claude Code, Codex, Antigravity, and DeepSeek Harness.
The owner works on **Windows + PowerShell**. Running write-capable agents natively on Windows offers
no practical, fail-closed OS boundary.

Verified research findings:

1. **Agent sandboxes are not a trustworthy boundary for Nexar's guarantees.**
   - Claude Code's sandbox _allows_ writes to the main `.git` of a linked worktree.
   - Claude Code's deny rules are string matches.
   - Claude's sandbox runtime fails inside an outer bwrap ("Can't mount proc").
   - Codex's own sandbox nests only under specific conditions.
2. **A git worktree of the owner's repository exposes the owner's `.git`.** In a lab, an agent could
   read other branches and secret blobs and move `main`.
3. **The host must never run git inside an agent-controlled `.git`.** A planted `core.fsmonitor`
   executed on the host.
4. **The verified bwrap profile gives the isolation Nexar needs.** It uses explicit namespaces,
   `--remount-ro /`, a writable worktree only, and `--unshare-net`. A Nexar allowlisting CONNECT
   proxy, reachable only through a bind-mounted unix socket bridged by `socat`, gives vendor-only
   egress. Process trees die with the parent.
5. **WSL2 + bwrap needs specific setup.** Linux files belong on the WSL ext4 filesystem: `/mnt/c`
   (drvfs) has weak permission, symlink and metadata semantics and is slow. A dedicated distro
   should disable automount and Windows interop.

## Decision

1. **Plane location.** Engineering execution runs in a dedicated WSL2 Ubuntu distro (default name
   `nexar-plane`). The engineering engine (`nexar` CLI) runs **inside** WSL. On Windows, a thin
   PowerShell shim (`nexar.ps1`) forwards to `wsl.exe -d nexar-plane --exec nexar …` over stdio. No
   TCP listener is exposed, and networking is NAT.
2. **Hardened distro** (`/etc/wsl.conf`):
   - `[automount] enabled=false`, `mountFsTab=false`
   - `[interop] enabled=false`, `appendWindowsPath=false`
   - `[boot] systemd=true`
   - `[user] default=nexar`
   - `[gpu] enabled=false`

   `nexar doctor` checks this file and warns on drift. On Ubuntu 24.04+, if
   `kernel.apparmor_restrict_unprivileged_userns` is present and blocks bwrap, Nexar ships a
   bwrap-scoped AppArmor profile. It never sets the sysctl to 0 globally.

3. **Worktrees live on ext4**, at `~/.local/share/nexar/worktrees/<project>/<task>/`, never on
   `/mnt/c`. Each worktree is a **private clone** made with `git clone --no-local --single-branch
--no-tags` from the owner's repository. Then `origin` is removed and `core.hooksPath=/dev/null` is
   set. The owner's `.git` is never mounted into a sandbox. Windows may _read_ worktrees through
   `\\wsl.localhost\nexar-plane\…`.
4. **Sandbox is fail-closed, single boundary.** Every write-capable lane runs under the Nexar bwrap
   profile:
   - **Namespaces:** user, ipc, pid, net, uts and cgroup, each named explicitly (never
     `--unshare-all`).
   - **Process control:** `--die-with-parent`, `--new-session`, `--cap-drop ALL`.
   - **Filesystem:**
     - read-only system dirs and toolchain
     - `--tmpfs /tmp`
     - a tmpfs `$HOME`
     - the worktree bound read-write
     - the worktree's `.git` re-bound **read-only** (including a bind over `.git` itself, so
       `mv .git` cannot defeat it)
     - `--remount-ro /`
   - **Environment:** `--clearenv`, then an explicit allowlist.

   If bwrap or user namespaces are unavailable, write lanes **refuse to run**. There is no
   unsandboxed fallback.

5. **Network is denied by default.** Agent lanes get egress only through Nexar's CONNECT proxy, with
   a per-resource domain allowlist:
   - Claude Code: `api.anthropic.com`, `claude.ai`, `platform.claude.com`
   - Codex: OpenAI/ChatGPT endpoints from `codex.md`

   IP literals and other hosts get 403, and `git push` fails. **Gate runs (tests/lint/build) get no
   network at all.**

6. **Inner agent sandboxes are disabled** under the Nexar sandbox, because it is the boundary.
   - Codex: `--dangerously-bypass-approvals-and-sandbox`, only inside the Nexar sandbox.
   - Claude Code: its sandbox is turned off.
   - Antigravity: `--dangerously-skip-permissions`.

   Adapters may enable these flags **only** when they receive a sandboxed process launcher. Without
   one, they refuse write mode.

7. **Credentials.** Each resource declares narrowly scoped _credential mounts_ in owner-controlled
   config: specific paths under the runtime's own config dir, read-only unless a token refresh needs
   a writable copy, and never the whole home directory. Nexar bind-mounts them but never reads,
   parses or copies them. `.ssh`, Docker sockets, other repositories and general credential stores
   are never mounted. API-key env vars (e.g. `ANTHROPIC_API_KEY`) are scrubbed so subscription auth
   is used.
8. **Harvest.** Nexar never runs git on the host inside an agent's `.git`.
   - The diff is produced by git running in a **second sandbox**: read-only worktree, no network,
     hooks and fsmonitor disabled.
   - Only a patch file leaves it.
   - Nexar validates every patch path with its own path policy. It denies anything under `.git/`,
     `..`, absolute paths, and `.gitmodules`; projects may extend the deny list.
   - Nexar then applies the patch to a new branch in the owner's repository and commits there
     (ADR-019).
9. **This cloud development container is a stand-in plane.** It is Linux with bwrap 0.9 and the
   same mechanics, and it is used for development and CI-style tests. WSL-specific acceptance
   checks (`wsl.conf`, interop unreachable, AppArmor) are owner-run steps documented in
   `docs/integration/wsl2-engineering-plane.md`.

## Rationale

A single Nexar-owned boundary is testable and does not depend on each vendor's sandbox. Verified
nesting failures and the linked-worktree `.git` hole show vendor sandboxes cannot carry Nexar's
no-commit or containment guarantees. Private clones plus sandboxed harvest close both the
`.git`-exposure and the `fsmonitor` code-execution paths.

## Alternatives considered

- **Native Windows execution** (AppContainer / Windows Sandbox): rejected for v0.3. There is no
  maintained fail-closed equivalent to bwrap for these CLIs, and it would split the security model
  by OS.
- **Docker / containers:** heavier and needs a daemon, whose socket would be a privileged escape
  surface. Deferred.
- **git worktree of the owner's repo:** rejected; it exposes the owner's `.git`.
- **`git clone --local`:** rejected; it hardlinks and copies every object.
- **Trusting agent-internal sandboxes:** rejected (see Context).

## Consequences

- The owner must provision the WSL2 distro once (runbook) and install and authenticate each agent
  CLI inside it with the vendor's own login.
- Engineering runs are Linux-only. Personal-work features (v0.2) are unaffected.

## Risks

- WSL kernel and AppArmor differences are unverified until the owner runs the plane acceptance
  checks.
- The credential-mount approach for each runtime is unverified for token refresh. Mounts may need to
  be writable copies, which is still narrow.
- A check-then-use (TOCTOU) window remains inside the sandbox; it is bounded by the mount namespace.
- Domain allowlists can drift as vendors change endpoints. When that happens, the sandbox fails
  closed, which is visible.

## Follow-up work

Seccomp denylist (block nested user namespaces where an agent does not need them), Landlock as a
second layer, a macOS plane (out of scope), and per-gate network exceptions behind approval.
