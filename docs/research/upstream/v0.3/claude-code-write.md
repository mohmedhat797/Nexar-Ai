# Upstream research: Claude Code CLI in WRITE mode (engineering lanes)

| Field | Value |
| --- | --- |
| Source | Claude Code CLI (closed distribution, `/opt/claude-code/bin/claude`); official docs https://code.claude.com/docs/en/* ; sandbox library `@anthropic-ai/sandbox-runtime` |
| Version inspected | `claude 2.1.286` (local, `claude --version` and `claude --help`); `@anthropic-ai/sandbox-runtime@0.0.78` (npm, scratch `srt-inst/`) |
| Inspected | 2026-10-01, Linux x86_64 container, uid 0, bubblewrap 0.9.0, socat present |
| Method | Local `--help`; docs pages sandboxing, permission-modes, headless, authentication, network-config, env-vars, settings-reference, agent-sdk/typescript (fetched; summarizer-model output, spot-checked against saved raw text for sandboxing and permission-modes); empirical nesting tests with `srt` (the library Claude Code's sandbox is built on). **No `claude -p` model call was made.** |
| Caveat | `claude -p` here is not exercised, so flag interplay below is from docs + `--help`, not from a live run. Tests with `srt` approximate, but are not identical to, Claude Code's internal use of the library. |

## 1. Findings

### 1.1 Headless write flags (`claude --help` 2.1.286 + docs/headless)
- `-p/--print` non-interactive; prompt from argument or **stdin** (stdin capped at 10 MB).
  `--input-format text|stream-json`, `--output-format text|json|stream-json` (stream-json needs
  `--verbose`; `--include-partial-messages` for deltas), `--json-schema`, `--model <alias|name>`,
  `--effort low|medium|high|xhigh|max`, `--fallback-model`, `--max-budget-usd` (API-priced; meaningless
  for subscription), `--no-session-persistence` (print mode only), `--session-id <uuid>`, `-r/--resume`,
  `-c`, `--add-dir`, `--settings <file|json>`, `--setting-sources user,project,local`,
  `--strict-mcp-config`, `--mcp-config`, `--disable-slash-commands`, `--safe-mode`, `--restricted`,
  `-w/--worktree` (Claude making its own worktree — not wanted; Nexar owns worktrees).
- `--permission-mode` choices: `acceptEdits | auto | bypassPermissions | manual | dontAsk | plan`.
  `--permission-prompts host|none` (2.1.259+): `none` = anything that would prompt is denied and Claude
  is told not to retry.
- `--tools <list>` restricts the built-in tool set (`"Read,Edit,Write,Glob,Grep,Bash"`);
  `--allowedTools` = pre-approve rules (`"Bash(pnpm test *)"`, prefix match with ` *`);
  `--disallowedTools` = deny rules, which "block in every mode, including `bypassPermissions`"
  (permission-modes doc).
- `--dangerously-skip-permissions` == `--permission-mode bypassPermissions`. Refuses to start as
  root/sudo on Linux/macOS ("cannot be used with root/sudo privileges"); "skipped automatically inside a
  recognized sandbox". The binary contains env names `IS_SANDBOX` and `CLAUDE_CODE_BUBBLEWRAP`,
  plausibly the recognition hooks — semantics UNVERIFIED. The owner's WSL user is presumably non-root,
  so likely moot.
- `acceptEdits`: auto-approves reads, file edits/writes in the working dir (+`--add-dir`), and `mkdir
  touch rm rmdir mv cp sed` on in-scope paths; **all other Bash prompts**, and in `-p` with no host a
  prompt = denial. So write lanes need either (a) `--allowedTools "Bash(<cmd> *)"` allowlist, (b) the
  Bash sandbox with `autoAllowBashIfSandboxed` (default true when sandbox enabled), or (c)
  `bypassPermissions`.
- Protected paths (writes never auto-approved except in bypass): `.git`, `.config/git`, `.vscode`,
  `.idea`, `.husky`, `.cargo`, `.devcontainer`, `.yarn`, `.mvn`, `.claude` (not `.claude/worktrees`);
  files `.gitconfig .gitmodules .bashrc .zshrc .envrc .npmrc .mcp.json .claude.json` etc. Applies to
  Edit/Write tools, not to Bash-run git.
- `--bare` (recommended by docs for scripts) **never reads OAuth/keychain**: "Anthropic auth is strictly
  ANTHROPIC_API_KEY or apiKeyHelper". It is therefore NOT usable for subscription-backed lanes. Use
  `--setting-sources`, `--strict-mcp-config`, `--disable-slash-commands`, env
  `CLAUDE_CODE_DISABLE_AUTO_MEMORY=1`, `CLAUDE_CODE_DISABLE_GIT_INSTRUCTIONS=1`,
  `ENABLE_CLAUDEAI_MCP_SERVERS=false` instead. Note without `--bare`, `-p` runs hooks and `.mcp.json`
  servers from the worktree's `.claude/settings.json` (docs: "even in a folder you've never trusted") —
  a prompt-injection / untrusted-repo vector Nexar must neutralise (`--setting-sources user` +
  `--strict-mcp-config`, or `--safe-mode`).
- Output (`--output-format json` / final stream-json `result` line; `agent-sdk/typescript`
  SDKResultMessage): `type:"result"`, `subtype`, `is_error`, `session_id`, `num_turns`, `result`,
  `stop_reason`, `duration_ms`, `duration_api_ms`, `total_cost_usd` (client-side estimate; for
  subscription it is notional), `usage` (input/output/cache tokens), `modelUsage{model:...}`,
  `permission_denials[]`, `structured_output`, `terminal_reason`. `system/init` event: model, tools,
  mcp_servers, plugins, `capabilities[]`. `system/api_retry` events carry error category
  (`authentication_failed`, `rate_limit`, `billing_error`, `account_on_hold`, ...). Missing auth is
  printed "as the result on stdout"; exit 0 on success, non-zero on failure; SIGTERM => exit 143.
  Touched files: not reported; use `git status`.
- Git behavior: Claude Code CAN commit (it ships commit/PR instructions and attribution trailer).
  Controls: `CLAUDE_CODE_DISABLE_GIT_INSTRUCTIONS=1` / `includeGitInstructions:false` (removes
  instructions only), `--disallowedTools "Bash(git commit *)" "Bash(git push *)" "Bash(git add *)"`
  (string rules; bypassable via `git -c ... commit`, `sh -c`, aliases), and structural ro `.git` (outer
  sandbox). Don't rely on prompts.

### 1.2 Claude Code's own sandbox (docs/sandboxing)
- Built-in Bash/PowerShell/Monitor sandbox: macOS Seatbelt; Linux and **WSL2** via `bubblewrap` +
  `socat` (apt `bubblewrap socat`); optional seccomp filter (`npm i -g @anthropic-ai/sandbox-runtime`)
  adds Unix-socket blocking. Native Windows and WSL1 unsupported. Ubuntu 24.04+: AppArmor
  `kernel.apparmor_restrict_unprivileged_userns=1` blocks bwrap userns — doc gives an AppArmor profile
  for `/usr/bin/bwrap`; check with `sysctl kernel.apparmor_restrict_unprivileged_userns` (docs say also
  inside WSL2).
- Settings (any settings file or `--settings`): `sandbox.enabled`, `failIfUnavailable` (default: **warn
  and run unsandboxed** if bwrap/socat missing!), `autoAllowBashIfSandboxed`, `allowUnsandboxedCommands`
  (set false to remove the `dangerouslyDisableSandbox` retry escape hatch), `excludedCommands`,
  `enableWeakerNestedSandbox`, `filesystem.{allowWrite,denyWrite,denyRead,allowRead,disabled}`,
  `network.{allowedDomains,deniedDomains,strictAllowlist (user/managed/--settings scope
  only),tlsTerminate,allowUnixSockets}`, `credentials{files,envVars}` deny/mask (no built-in credential
  deny list; default read access is the whole machine except a few paths).
- Defaults: writes allowed to cwd, per-user temp dir, `--add-dir`; reads allowed everywhere except
  denied; network via a domain-allowlist proxy (HTTP/SOCKS proxy reached over socat unix-socket bridge),
  **prompt on unknown domain unless `strictAllowlist`** (in `-p`, prompts => denied). Always protected
  inside cwd: shell startup files, `.gitconfig`, `.vscode`, `.idea`, `.git/hooks`, `.git/config`.
- **Linked git worktrees: the sandbox allows writes to the main repo's shared `.git` directory "so
  commands such as `git commit` can update refs and the index"; only `hooks/` and `config` stay
  denied.** => Claude's sandbox is NOT a never-commit boundary; in a Nexar-managed worktree it
  explicitly enables committing. Contrast Codex (ro `.git`) and agy (ro `.git`).
- Sandbox covers Bash children only; Claude's own file tools and its API/OAuth traffic run outside it
  (file tools governed by permission rules).
- Domain-allowlist caveat from docs: allow decisions use the client-supplied hostname without TLS
  inspection (domain fronting possible).

### 1.3 Nesting inside Nexar's outer bubblewrap — empirical (srt 0.0.78, uid 0)
- Direct `srt`: works (ro `/etc`, writable ws).
- Inside outer `bwrap --ro-bind / / --tmpfs /tmp --bind ws ws --dev /dev --proc /proc --unshare-user
  --unshare-pid`: **inner fails** with `bwrap: Can't mount proc on /newroot/proc: Operation not
  permitted` (matches the docs' troubleshooting entry for unprivileged containers). Same with outer
  `--unshare-net`.
- With `"enableWeakerNestedSandbox": true`: **inner works** (ro `/etc`, ws writable). Docs: the setting
  makes the inner sandbox bind-mount the existing `/proc` and "considerably weakens security"; use only
  when outer isolation exists.
- Outer without `--unshare-pid` and no `--proc` failed in the outer bwrap itself (`setting up uid map:
  Read-only file system`, an artifact of my outer flags) — inconclusive.
- Network filtering of the inner proxy was inconclusive here: both allowed and denied domains returned
  000 even for direct `srt` (container egress is itself via an agent proxy with custom CA). With outer
  `--unshare-net` the inner proxy at `localhost:3128` was unreachable. So "inner domain allowlist inside
  an outer netns" is UNVERIFIED.
- Not tested: non-root in WSL2; real Claude Code process.

### 1.4 Auth and state
- Subscription login stores `~/.claude/.credentials.json` (mode 0600) on Linux/WSL (file name only;
  never read); macOS Keychain with file fallback. `CLAUDE_CONFIG_DIR` relocates everything incl.
  `.credentials.json` (docs/auth; "multiple accounts" pattern) and must be set in the launching
  environment (ignored from settings `env`). Same dir holds settings.json, sessions/transcripts
  (`projects/`), `debug/`, `shell-snapshots/`, `.last-cleanup`; global config in `~/.claude.json` (a
  sibling file of the dir, relocated into it when `CLAUDE_CONFIG_DIR` is set — UNVERIFIED).
- Auth precedence: cloud provider vars > `ANTHROPIC_AUTH_TOKEN` > `ANTHROPIC_API_KEY` > apiKeyHelper >
  **`CLAUDE_CODE_OAUTH_TOKEN`** (1-year token from `claude setup-token`, subscription-backed, model
  requests only) > profiles > `/login` credentials. DANGER: if `ANTHROPIC_API_KEY` is in the child env,
  `-p` uses it silently (billing!) — Nexar must scrub it (and `ANTHROPIC_AUTH_TOKEN`, cloud flags).
- Free probe: `claude auth status` prints JSON (`loggedIn`, `authMethod`, `apiProvider`, ...) without a
  model call (verified locally: works, exit 0). `claude doctor` also exists.
- Providing creds to a sandbox: (a) bind-mount the owner's config dir read-write (token refresh writes
  `.credentials.json`; also exposes history/settings/other projects' transcripts) — widest; (b) bind a
  Nexar-created `CLAUDE_CONFIG_DIR` and only the credentials file read-only: refresh would then fail
  once the access token expires (UNVERIFIED how long a run survives; the refresh token lives in the same
  file); (c) `CLAUDE_CODE_OAUTH_TOKEN` env from owner's secret store via a Nexar `{source:'env'}`
  reference — never read by Nexar code, but it is a long-lived bearer in the child env (a
  prompt-injected agent can `printenv` it unless `CLAUDE_CODE_SUBPROCESS_ENV_SCRUB` / sandbox
  `credentials.envVars` deny are set). Option (c) + env scrub appears the narrowest; needs a spike. Do
  not use `--bare`.

### 1.5 Network (docs/network-config)
Required: `api.anthropic.com` (API + telemetry flags), `claude.ai`, `platform.claude.com` (OAuth token
exchange/refresh/revocation), `claude.com` (login only). Optional/avoidable: `mcp-proxy.anthropic.com`
(claude.ai connectors; disable with `ENABLE_CLAUDEAI_MCP_SERVERS=false`), `downloads.claude.ai`,
`storage.googleapis.com`, `registry.npmjs.org`, `github.com`, `raw.githubusercontent.com`,
`http-intake.logs.us5.datadoghq.com`, `browser-intake-us5-datadoghq.com` (telemetry/errors),
`*.frame.claudeusercontent.com` (artifacts), `code.claude.com`.
`CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1` disables updates/telemetry/error reporting/feature-flag
fetch (note: also makes Remote Control and flagged features unavailable). Proxy support via
`HTTPS_PROXY` (no SOCKS).

## 2. Implications for Nexar v0.3
1. Recommended invocation (inside the outer sandbox, prompt on stdin, minimal env):
   `claude -p --output-format stream-json --verbose --model <m> --permission-mode acceptEdits
--permission-prompts none --tools "Read,Edit,Write,Glob,Grep,Bash" --allowedTools "Bash(pnpm *)"
"Bash(node *)" "Bash(git status *)" "Bash(git diff *)" --disallowedTools "Bash(git commit *)" "Bash(git
push *)" "Bash(git add *)" "Bash(git checkout *)" "Bash(git reset *)" --setting-sources user
--strict-mcp-config --disable-slash-commands --settings <nexar-generated.json> --add-dir <worktree>`
with cwd = the worktree. Alternative inside a trusted outer sandbox: `--permission-mode
bypassPermissions` (non-root) plus the same deny rules.
2. Sandbox decision: **make Nexar's outer bubblewrap the boundary and disable Claude's inner sandbox**
   (`sandbox.enabled:false`) — fewer layers, avoids the nested `/proc` failure and the "silently runs
   unsandboxed if deps missing" default. If an inner layer is wanted (e.g., for its per-domain Bash
   network allowlist), set `enableWeakerNestedSandbox:true`, `failIfUnavailable:true`,
   `allowUnsandboxedCommands:false`, `network.strictAllowlist:true`, and give the outer sandbox `--proc
   /proc` with a pid namespace; spike required for network.
3. Never-commit: structural only. Outer sandbox must bind the worktree's git admin dir
   (`<main>/.git/worktrees/<name>`) and the main `.git` read-only (note: Claude's sandbox would
   otherwise grant write there). Nexar stages/commits from outside after gates. Keep deny rules and
   `CLAUDE_CODE_DISABLE_GIT_INSTRUCTIONS=1` as hints only.
4. Env hygiene: scrub `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, `CLAUDE_CODE_USE_*`,
   `GH_TOKEN/GITHUB_TOKEN`; set `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1`,
   `CLAUDE_CODE_DISABLE_AUTO_MEMORY=1`, `DISABLE_AUTOUPDATER`-equivalent (UNVERIFIED name),
   `CLAUDE_CONFIG_DIR=<nexar-managed>`. Egress allowlist minimal: `api.anthropic.com`,
   `platform.claude.com`, `claude.ai`.
5. Telemetry mapping: `usage` tokens -> `Measured`; `total_cost_usd` is notional under subscription
   (label as estimate, not spend); `permission_denials` and `is_error`/`terminal_reason` drive run
   status; exit code 143 = Nexar's SIGTERM.
6. Resource-registry probe: `claude --version` + `claude auth status` (free). Claude Code is also the
   orchestrator in this project; the engineering lane spawns a separate process, so session
   ids/credentials of the parent must not leak (ADR-009 note on `--session`).

## 3. Open questions
- Does a read-only credentials bind survive a run (access-token TTL vs run length)? What does Claude
  Code do when `.credentials.json` is unwritable?
- Exact semantics of `IS_SANDBOX` / `CLAUDE_CODE_BUBBLEWRAP` for the root bypass check and whether they
  alter sandbox behaviour.
- Does `--setting-sources user` (or empty) fully prevent worktree-supplied `.claude/settings.json`
  hooks/MCP from running under `-p`? Is `--safe-mode` sufficient and does it keep auth working?
- Live validation of acceptEdits + `--permission-prompts none` for Bash allow-rules in headless runs,
  and rule-matching robustness against `git -c`/`sh -c` bypass.
- Real Claude Code nested run (not srt) in the owner's WSL2 (AppArmor userns sysctl, systemd/socat
  presence).
- Whether `CLAUDE_CODE_OAUTH_TOKEN` use by a third-party wrapper is within Anthropic's consumer terms
  for fleet use (docs describe it for CI/scripts; not checked against current usage policy).

## 4. Sources
- https://code.claude.com/docs/en/{sandboxing, permission-modes, headless, authentication,
  network-config, env-vars, settings-reference, agent-sdk/typescript}
- Local: `claude --help`, `claude --version`, `claude auth status`, `strings` on the binary (env names)
- `@anthropic-ai/sandbox-runtime@0.0.78` README (`enableWeakerNestedSandbox`) and empirical runs under
  `runtimes/srt-inst`
