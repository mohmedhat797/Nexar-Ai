# bubblewrap fail-closed profile + allowlisting proxy bridge (verified locally)

| Field | Value |
| --- | --- |
| Inspected | 2026-10-01 |
| Question | What bwrap profile gives "worktree rw, nothing else, no network, only an allowlisting proxy via unix socket", and does it really hold? |
| Sources | bubblewrap `bwrap.xml` man page, README.md, SECURITY.md (repo `containers/bubblewrap` @ `0f8073dd`, shallow clone); Claude Code sandboxing docs; anthropic-experimental/sandbox-runtime README; kernel/AppArmor refs in `wsl2-execution-plane.md` |
| Test host | Linux 6.18.44 container, `bubblewrap 0.9.0`, `socat 1.8.0.0`, Node 22.22.2, git 2.43.0. Tests ran as an **unprivileged user** (`useradd nxtest`, uid 1001) to match WSL (`nexar` user), not as root. |
| Evidence files | `lab/bwrap-profile.sh` (profile), `lab/proxy.mjs`, `lab/server.mjs`, `lab/tests-*.sh`, `lab/final-results.txt`, `lab/mkseccomp.py`, `lab/parent.mjs` |
| Not verified | Real WSL2 kernel, Ubuntu AppArmor behaviour, interop sockets (see `wsl2-execution-plane.md`) |

## 1. Is the Claude Code design really "unshare-net + proxy outside + unix socket + socat"?
Yes, with the vendor's own wording. Claude Code docs: "the sandbox relies on two packages: `bubblewrap` ... filesystem isolation; `socat` ... the relay used to route network traffic through the sandbox proxy"; "Network access is controlled through a proxy server running outside the sandbox"; WSL2 "uses bubblewrap, same as Linux". The open-source runtime README (`sandbox-runtime`): "The network namespace of the sandboxed process is removed entirely, so all network traffic must go through the proxies running on the host (listening on Unix sockets that are bind-mounted into the sandbox)"; "socket bridging provided by socat"; an HTTP proxy validates domains and a SOCKS5 proxy handles other TCP; a seccomp filter "blocks creation of AF_UNIX sockets" for the command; clients are steered by `HTTP_PROXY/HTTPS_PROXY/ALL_PROXY`, "may be ignored by programs that don't respect these variables, leading to them being unable to connect" (= fail closed). Documented weaknesses we inherit: allow decision uses the client-supplied hostname, "does not terminate or inspect TLS", so "domain fronting or similar techniques" may reach non-allowlisted hosts; broad domains such as `github.com` are exfiltration paths. `enableWeakerNestedSandbox` exists for containers where a fresh `/proc` cannot be mounted: "considerably weakens security".

## 2. Flag reference (man page, bwrap.xml)
| Flag | Documented behaviour | Note for Nexar |
| --- | --- | --- |
| `--unshare-all` | "Currently equivalent with: `--unshare-user-try --unshare-ipc --unshare-pid --unshare-net --unshare-uts --unshare-cgroup-try`" | The `-try` forms **skip silently**; spell out `--unshare-user ... --unshare-cgroup` so a missing namespace aborts (fail closed). Mount ns is always new. Verified explicit form works on 0.9.0. |
| `--unshare-net` | "Create a new network namespace" (README: "only a loopback device"); `--share-net` would override | Verified: only `lo` exists and is UP (`network.c: loopback_setup`), so `socat` can bind `127.0.0.1`. |
| `--die-with-parent` | "Kills (SIGKILL) all bwrap sandbox processes in sequence ... when bwrap or bwrap's parent dies" (prctl PDEATHSIG) | See section 6 caveat. |
| `--new-session` | `setsid()`; prevents TIOCSTI keystroke injection; "if you don't use --new-session ... use seccomp to disallow TIOCSTI" (CVE-2017-5226) | Always on. |
| `--cap-drop ALL` | "Drop the specified capability when running as privileged user" | No-op for unprivileged: measured `CapEff=0 CapBnd=0 NoNewPrivs=1` with and without it. Keep as belt-and-braces. |
| `--ro-bind/--bind/--tmpfs/--proc/--dev` | Applied in order; `--dev` mounts devtmpfs | Measured `/dev` = `core fd full null ptmx pts random shm stderr stdin stdout tty urandom zero` only. |
| `--clearenv --setenv` | `--clearenv` unsets all except `PWD` and later `--setenv` | Hides `WSL_INTEROP`, `SSH_AUTH_SOCK`, tokens. |
| `--remount-ro DEST` | "works only on the specified mount point" | **Needed**: the sandbox root is a writable tmpfs. Without it `touch /x`, `touch /etc/x` succeed (ephemeral, invisible to host but confusing and a tmpfs-fill DoS). With `--remount-ro /` both fail with EROFS, while `/work` and `/tmp` (own mounts) stay writable. HOME must be its own `--tmpfs`. |
| `--disable-userns` | Sets `user.max_user_namespaces=1` and enters a nested ns; requires `--unshare-user` | Verified: nested `unshare -Ur` and nested `bwrap` then fail with ENOSPC. See section 5. |
| `--seccomp FD` | Compiled cBPF from `seccomp_export_bpf`; last `--seccomp` wins, `--add-seccomp-fd` stacks | Verified with a hand-assembled filter (`lab/mkseccomp.py`, 232 bytes, x86_64 only) passed on fd 9: `Seccomp: 2`, `unshare`, `setns`, `io_uring_*`, `ptrace`, `keyctl`, `mount`, `clone(CLONE_NEWUSER)` -> EPERM; everything else (git, curl, proxy bridge) unaffected. Production filter must come from libseccomp (not installed here) and must handle `clone3` (flags are in a struct, cannot be inspected: return `ENOSYS`). |
| SECURITY.md | "bubblewrap is not a complete, ready-made sandbox... the level of protection ... is entirely determined by the arguments"; "Everything mounted into the sandbox can potentially be used to escalate" | The profile is Nexar's responsibility; mount only what is listed below. |

## 3. The verified profile (abbreviated; full in `lab/bwrap-profile.sh`)
```
bwrap --unshare-user --unshare-ipc --unshare-pid --unshare-net --unshare-uts --unshare-cgroup \
  --die-with-parent --new-session --cap-drop ALL \
  --ro-bind /usr /usr --symlink usr/bin /bin --symlink usr/lib /lib --symlink usr/lib64 /lib64 --symlink usr/sbin /sbin \
  --ro-bind /opt/node22 /opt/node22 --ro-bind /etc/ld.so.cache /etc/ld.so.cache \
  --ro-bind /etc/ssl /etc/ssl --ro-bind /etc/alternatives /etc/alternatives \
  --proc /proc --dev /dev --tmpfs /tmp --tmpfs /home/agent \
  --bind "$WORKTREE" /work  --ro-bind "$RUN_SOCK_DIR" /run/nexar \
  --remount-ro /  --chdir /work  --clearenv \
  --setenv PATH ... --setenv HOME /home/agent --setenv TMPDIR /tmp --setenv GIT_CONFIG_NOSYSTEM 1 --setenv GIT_CONFIG_GLOBAL /dev/null \
  --setenv HTTPS_PROXY http://127.0.0.1:3128 --setenv HTTP_PROXY http://127.0.0.1:3128 --setenv NODE_USE_ENV_PROXY 1 \
  -- /bin/bash -c 'socat TCP-LISTEN:3128,bind=127.0.0.1,fork,reuseaddr UNIX-CONNECT:/run/nexar/proxy.sock & exec "$@"' bash AGENT_CMD...
```
Host side: `proxy.mjs` listens **only on a unix socket** (`/tmp/nxlab/run/proxy.sock`, mode 0600, no TCP listener), implements `server.on('connect')`, allowlist `allowed.example:443`, everything else `403`. The socket lives in a per-run dir that is `--ro-bind`-mounted (connect() works on a read-only mount: verified).

## 4. Verification results (all from `lab/final-results.txt`, unprivileged, kernel 6.18)
**(a) filesystem.** `write /work` OK; `/usr`, `/etc`, `/`, `/run/nexar`: "Read-only file system"; `/tmp` OK (tmpfs). `ls /work/..` = `bin dev etc home lib lib64 opt proc run sbin tmp usr work` (no host dirs). Host `/tmp/outside-tmp.txt` -> No such file.
**(b) home/secrets.** Planted canaries `~nxtest/.ssh/id_rsa`, `~nxtest/outside.txt`: `cat` -> "No such file or directory"; `/root`, `/etc/shadow`, `/etc/passwd`, `/tmp/nxlab` all absent; `find / -xdev -name 'id_rsa*'` -> empty. (No `/etc/passwd` inside is fine for git/node/python; tools needing a user name must get a synthetic file via `--ro-bind-data`.)
**(c) no network.** `/proc/net/dev` lists only `lo`. `curl --noproxy '*' https://1.1.1.1` -> `(7) Failed to connect ... Couldn't connect to server`; node `net.connect(1.1.1.1:443)` -> `ENETUNREACH`; connecting to the **host's** `127.0.0.1:9443` -> refused (host loopback is not shared); a host **abstract** unix socket (`\0nexar-abs-test`) -> `ECONNREFUSED` (abstract sockets are per-netns); DNS: `getent hosts example.com` -> nothing.
**(d) proxy bridge.** `curl -x http://127.0.0.1:3128 --cacert ... https://allowed.example/` -> `hello from allowed upstream` (full TLS through CONNECT to a local TLS server); `https://evil.example/` and `https://1.1.1.1/` -> `CONNECT tunnel failed, response 403`. Proxy log: `CONNECT allowed.example:443 -> ALLOW`, `evil.example:443 -> DENY`, `1.1.1.1:443 -> DENY`. Node 22.22.2 `fetch` honours `HTTPS_PROXY` only with `NODE_USE_ENV_PROXY=1` (emits `[UNDICI-EHPA] Warning: EnvHttpProxyAgent is experimental`); without it fetch ignores the proxy and fails closed with `EAI_AGAIN` (no DNS). `git push https://example.com/x.git` -> `CONNECT tunnel failed, response 403` (git uses the env proxy too).
**(e) git.** `git status/add/commit/log/diff` all work on the rw worktree; the commit is visible on the host (same files). Nothing leaves: remote ops hit the 403 proxy.

## 5. Escape and nesting probes
- `/proc/1/root`: pid 1 is `bwrap` (comm), `ls /proc/1/root` = the sandbox root (same list as `/`), `/proc/1/root/../../home` = `agent`, `/proc/1/cwd` = `/work`. Only 6 pids visible. No host path reachable: **inside a pid namespace with a fresh `--proc`, `/proc/1/root` is the sandbox**. Without `--unshare-pid` the sandbox would see the caller's pid namespace through `/proc` (not tested here; follows from the man page: the pid namespace is what hides outside processes), so never drop it.
- `/proc/sys/kernel/hostname` write -> Permission denied; caps 0; `NoNewPrivs=1` (setuid helpers and `sudo` are inert).
- **Nested bwrap works** with the default profile (`bwrap --ro-bind /usr /usr ... --unshare-all -- true`; also DeepSeek Harness' exact profile `--ro-bind / / --dev /dev --unshare-pid --proc /proc --die-with-parent --tmpfs /tmp --bind /work /work` succeeded and honoured its read-only claim). Plain `unshare -Ur` also works. So an agent CLI's own sandbox (Claude Code, Codex, DSH `sandbox-local`) can nest.
- Trade-off: allowing nested userns **increases kernel attack surface** (userns is the classic route to kernel LPE bugs; Ubuntu restricts it for that reason). Options: (i) allow (default for v0.3, because vendor CLIs sandbox themselves via bwrap and Claude's docs describe `enableWeakerNestedSandbox` as the *weaker* fallback), (ii) `--disable-userns` + seccomp denylist (verified; the agent CLI's own bwrap then fails: `bwrap: No permissions to create new namespace`; DSH falls back to **Landlock**, ABI 7 available in the test kernel via `syscall(444, NULL, 0, LANDLOCK_CREATE_RULESET_VERSION)`; WSL kernel configs list `landlock` in `CONFIG_LSM`). Make this a per-profile switch (`nestedSandbox: allow|deny`) and configure the agent CLIs accordingly.
- `.git` handling and the worktree-vs-clone decision are in `worktrees-and-acp.md` (a rename trick defeats read-only file binds on `.git/config`; verified there).

## 6. Process-tree termination
Test (`lab/parent.mjs`): Node parent spawns the profile; inside run `setsid sleep 3001 &`, `(sleep 3002 &)`, `nohup sleep 3003 &`, `sleep 3004`, plus `socat`. `SIGKILL` the Node parent: **every** process died (3001 in its own session included); only reaped zombies of `bwrap` remained (container pid 1 does not reap; irrelevant on systemd/init). Mechanism: bwrap's pid-1 + pid namespace; when the namespace's init dies the kernel SIGKILLs all members. Caveats: (1) `PR_SET_PDEATHSIG` is tied to the **thread** that spawned the child; spawn from a thread that lives as long as the run (Node's main thread is fine; worker threads or a short-lived thread are not). (2) A `SIGTERM` on the plane should be turned into `SIGKILL` of the bwrap pid after a grace period; add a wall-clock deadline. (3) Whether a dying Windows `wsl.exe` kills the Linux process is UNVERIFIED; plane-side deadline covers it. (4) For a clean stop, signal the **bwrap child pid** (`--info-fd`/`--json-status-fd` gives `child-pid` and later `exit-code` as JSON lines).

## 7. Minimal profile for Node / Python / git toolchains
Needed read-only: `/usr` (+ `/bin /lib /lib64 /sbin` symlinks), `/etc/ld.so.cache`, `/etc/ssl/certs` (or a pinned bundle), `/etc/alternatives` (python, editor symlinks), toolchains outside `/usr` (here Node in `/opt/node22`; on WSL use distro Node or a pinned tarball), plus an `/etc/nsswitch`-free setup (no DNS in sandbox). Needed writable: worktree, `/tmp` tmpfs, tmpfs `$HOME` (set `npm_config_cache`, `PIP_CACHE_DIR`, `XDG_*` into it or into a per-task dir). Verified working: `node` (net + fetch), `python3`, `git`, `curl`, `socat`, `bash`. Package installs need registries: default deny; offer an explicit, logged "dependency" profile that adds exact hosts (e.g. `registry.npmjs.org`, `pypi.org`, `files.pythonhosted.org`: names from Claude's network table / common knowledge, hostnames for pip UNVERIFIED) or pre-bake dependencies into the clone. Agent credentials: pass only the one needed variable/file via `--setenv`/`--ro-bind-data` per run, never the runtime's home (CLAUDE.md rule: never copy a runtime's own login).

## 7b. Reproduction transcript (trimmed; run as `runuser -u nxtest -- ...`)
```
# host side, once:  node proxy.mjs /tmp/nxlab/run/proxy.sock &   node server.mjs &   (TLS server on 127.0.0.1:9443, CN allowed.example)
$ ./bwrap-profile.sh /tmp/nxlab/wt/final /tmp/nxlab/run -- bash -s < tests-c.sh
/proc/net/dev interfaces: lo:
curl direct https://1.1.1.1 : curl: (7) Failed to connect to 1.1.1.1 port 443 after 0 ms: Couldn't connect to server
node direct 1.1.1.1:443    : error: ENETUNREACH
curl -x http://127.0.0.1:3128 https://allowed.example/ : hello from allowed upstream
curl -x http://127.0.0.1:3128 https://evil.example/    : curl: (56) CONNECT tunnel failed, response 403
node fetch (NODE_USE_ENV_PROXY=1) allowed : "hello from allowed upstream\n"   evil : ERR Request was cancelled.
proxy log: [proxy] CONNECT allowed.example:443 -> ALLOW | evil.example:443 -> DENY | 1.1.1.1:443 -> DENY

$ NX_LATE="--remount-ro /" ... bash -s < tests-f.sh        # baseline vs hardening switches
(no --remount-ro) touch /x: OK(writable root tmpfs)   touch /etc/x: OK(writable)
(--remount-ro /)  touch /x: Read-only file system     write /work: OK   write /tmp: OK   write ~ (not own mount): Read-only
(+--unshare-user --disable-userns) unshare -Ur: "unshare failed: No space left on device"
                                   nested bwrap: "Creating new namespace failed: nesting depth or /proc/sys/user/max_*_namespaces exceeded (ENOSPC)"
(+--seccomp 9 deny.bpf) unshare -Ur: Operation not permitted; nested bwrap: "No permissions to create new namespace"; git/curl via proxy: fine; Seccomp: 2

$ bash -s < tests-i.sh   (nested, DSH-style profile)       # outer baseline
DSH-style nested bwrap: works      touch /usr/x: Read-only file system      landlock ABI via syscall 444: 7
$ (outer with --disable-userns + seccomp)
DSH-style nested bwrap: bwrap: No permissions to create new namespace ...     landlock ABI: 7   (Landlock still usable as fallback)

$ node parent.mjs   # spawns profile; inside: setsid sleep 3001 & (sleep 3002 &) ; nohup sleep 3003 & sleep 3004 ; plus socat
before kill : bwrap -> bwrap(pid1) -> bash -> {socat, sleep 3001 (own sid), 3002, 3003, 3004}
kill -9 <node parent>
after kill  : only two defunct [bwrap] entries (zombies awaiting container init); no sleep/socat/bash survivors
```
Argument-order notes: filesystem options are applied in the order given (man page), so put `--remount-ro /` after every `--dir/--symlink/--tmpfs` that creates entries on the root tmpfs (it only affects the `/` mount; other mounts such as `/work`, `/tmp`, `/home/agent` stay writable); `--chdir` after mounts; `--clearenv` before `--setenv`. A missing SRC for `--ro-bind` aborts (use `--ro-bind-try` only for optional toolchains, never for anything security-relevant).

## 8. Implications for Nexar v0.3
1. Profile = allowlist builder in `integrations/bwrap` (a new adapter; upstream isolation ADR-008 applies); the Engine passes a typed `SandboxSpec` {worktree, mounts[], env[], proxySocket, deadline, nestedSandbox}. Unit-test the argv builder and run the lab matrix as a (Linux-only, skipIf no bwrap) integration test.
2. Proxy in `packages/` or the adapter: unix socket per run (identity = socket), exact-host allowlist per agent (Anthropic: `api.anthropic.com`, plus `platform.claude.com`/`claude.ai` only for login flows we avoid; Claude's required-URL table also lists optional telemetry hosts that `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC` removes. OpenAI/Codex: `api.openai.com`, `chatgpt.com`, `auth.openai.com` from OpenAI docs search results; Google: `generativelanguage.googleapis.com`, `oauth2.googleapis.com`, `cloudcode-pa.googleapis.com`: UNVERIFIED, from search snippets). No wildcards, no IP literals, resolve then reject private/loopback/link-local, one concurrent-connection cap, byte and time limits, audit line per CONNECT (host hash, outcome; no payload).
3. SOCKS is not needed; Claude Code "does not support SOCKS proxies"; HTTP CONNECT covers vendor CLIs. Programs ignoring proxy env fail closed.
4. Because the proxy cannot see inside TLS, residual risk = exfiltration to an allowlisted vendor endpoint (the agent's own API key/account). Mitigate with short-lived, task-scoped credentials.

## 9. Open questions
- Production seccomp filter: build with libseccomp (or ship `sandbox-runtime`'s `apply-seccomp`); AF_UNIX denial conflicts with the socat bridge unless socat is started before the filter and the agent runs under it (two-stage launch).
- Does the agent CLI (Claude/Codex) work with `HTTPS_PROXY` over plain-HTTP proxy and `NODE_EXTRA_CA_CERTS` not needed (no TLS interception)? Claude docs: yes for env proxies. Codex/Gemini: UNVERIFIED end to end.
- Should the proxy refuse HTTP/1.0 absolute-URI forwarding (we only implement CONNECT)? Currently returns 405.
- WSL: AppArmor/userns restriction and interop checks are open in `wsl2-execution-plane.md`.

## 10. Sources
- https://github.com/containers/bubblewrap (`bwrap.xml`, `README.md`, `SECURITY.md`, `network.c`) @0f8073dd9b54
- https://code.claude.com/docs/en/sandboxing , https://code.claude.com/docs/en/network-config
- https://github.com/anthropic-experimental/sandbox-runtime (README, Linux network isolation)
- https://github.com/deepseek-ai/deepseek-harness `packages/sandbox/sandbox-local/src/profiles.ts` @639ed015
- Local experiment artefacts in `lab/`
- Note: the sandbox-runtime README and Claude docs were read through a summarising fetch tool for some passages; quoted fragments there may be paraphrased. Re-read the originals before citing in an ADR.
