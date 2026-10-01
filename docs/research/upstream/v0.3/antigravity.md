# Upstream research: Google Antigravity CLI (`agy`)

| Field | Value |
| --- | --- |
| Source | Official: https://antigravity.google (docs, `/cli/install.sh`, `/terms`); GitHub (docs/changelog/issues only, no source): https://github.com/google-antigravity/antigravity-cli |
| Version inspected | `agy 1.2.14` (installed from the official installer manifest; closed-source Go binary, ELF x86-64 dynamic glibc, 220 MB) |
| Repo SHA | `eaf9e06660d2ca8f20f1474ed03f10e3dbfd35e5` (2026-09-30; README, CHANGELOG, examples only) |
| Delegate Skills | `skills/agy-delegate` v0.5.0 @ `6826b363085dcc80875372315fe7d208c4bf733f` (relay.mjs 822 lines) |
| Inspected | 2026-10-01 |
| Scratch | `agy-inst/` (installer + binary), `agy-home/` (throwaway `HOME`), `agy-repo/` |
| Method | Official installer run with `HOME` redirected to scratch; `agy --help`, `agy changelog`, `agy models`; official docs via WebFetch; Delegate Skills relay source; web search. **No login completed, no model call made.** |
| Honesty note | Running `agy -p ...` unauthenticated (to see output) triggered agy's own "interactive OAuth" attempt (log: `Print mode: triggering interactive OAuth`; browser open failed, `xdg-open` absent) and hung until my 30 s `timeout` killed it. No credentials were created. A Nexar probe must therefore never call `agy -p` unauthenticated. |

## 1. Findings

### 1.1 Distribution and platforms
- Canonical: Google-hosted installer `curl -fsSL https://antigravity.google/cli/install.sh | bash` (also
  `.ps1`, `.cmd`). I read the script (242 lines): fetches a per-platform manifest from
  `https://antigravity-cli-auto-updater-974169037036.us-central1.run.app/manifests/<platform>.json`
  (version, URL, SHA512), verifies SHA512, installs to `~/.local/bin/agy` (or `--dir`), stages in
  `~/.cache/antigravity/staging`, then runs `agy install` (shell/PATH setup). Linux glibc + musl,
  x86_64/arm64, macOS, Android/Termux. The installer accepts `--dir`, so a pinned, checksummed install
  into a Nexar-owned dir is possible. No npm package is the canonical route (UNVERIFIED that none
  exists).
- Platforms per docs: macOS, Linux, Windows. WSL2 not mentioned in official docs (it is Linux; Delegate
  Skills' SKILL.md lists "Git Bash/WSL on Windows" as compatible). WSL2 viability for the sandbox is
  UNVERIFIED.
- The repo `google-antigravity/antigravity-cli` is a docs/changelog/issue tracker; binary is closed
  source, so adapter contract tests must be fixture-based.

### 1.2 Headless mode (official docs: antigravity.google/docs/cli/headless/ + `agy --help`)
- `agy -p|--print|--prompt "<text>"` runs once and exits. Prompt is a CLI **argument** (visible in `ps`;
  ~128 KB cap — relay.mjs L760-765). Alternative with no argv exposure: `--input-format stream-json`
  (prompts as NDJSON on stdin; requires `--output-format stream-json`; one turn per message; closing
  stdin ends session, exit 0).
- `--output-format text|json|stream-json`.
  - `json` envelope: `conversation_id`, `status`
    (SUCCESS/ERROR/CANCELED/INTERRUPTED/INVALID/WAITING/RUNNING), `response`, `error`,
    `duration_seconds`, `num_turns` (cumulative), `structured_output` (with `--json-schema`),
    `usage:{input_tokens, output_tokens, thinking_tokens, cache_read_tokens, total_tokens}`.
  - `stream-json` events: `init{conversation_id, cwd, tools[], permission_mode}`,
    `step_update{step_index, state ACTIVE|DONE, step_type user_input|agent_response|tool|checkpoint,
    text_delta, duration_seconds, usage, tool_info{name,parameters,output}, subagent_info}`, final
    `result` (= json envelope).
  - This is richer than what Delegate Skills' agy relay uses (it uses plain text stdout and parses the
    log for ids; no tokens in its `result.json`).
- `--json-schema <string|file>` (root must be `type: object`; invalid => exit 1). `--model`, `--effort
  low|medium|high|max`, `--agent`, `--add-dir` (absolute, repeatable), `--project/--new-project`,
  `--continue`, `--conversation <id>`, `--print-timeout` (default now unlimited per changelog 1.1.x;
  docs table still says 5m — conflict), `--log-file`, `--mode accept-edits|plan` (honored in `-p` since
  changelog entry "Fixed `--mode` being ignored in headless `-p` runs"), `--disable-slash-commands`.
- Exit codes: 0 success; 1 parse/auth/unknown-model errors; 2 unsupported stream command; **3** when a
  headless run streamed part of a response then ended on model/agent error (stderr line `AGY_ERROR:
  {...}` JSON with status, code, retryable) — changelog 1.2.10. Per changelog, tool permission denials
  and benign tool errors do NOT produce non-zero exit.
- Permissions in headless: tools needing approval are **soft-denied** (run continues, exit 0, stderr
  notice). Workspace file reads/writes are auto-allowed; shell commands default to Ask => denied
  headless. Allow-rules in `~/.gemini/antigravity-cli/settings.json` (`permissions.allow:
  ["command(git)", "command(regex:...)", "write_file(src/)"]`; Deny > Ask > Allow).
  `--dangerously-skip-permissions` approves everything. Delegate Skills documents Windows/macOS quirks
  where rules live in `~/.gemini/config/config.json` instead and where rule matching differs by version
  (agy-delegate SKILL.md "Permission model").
- No dedicated read-only/plan headless mode that works: Delegate Skills found `--mode plan` auto-denies
  the first tool and returns nothing; its `--read-only` = `--sandbox --dangerously-skip-permissions`
  (writes overlaid and discarded). Relay forces exit 1 on exit-0 permission denials.
- Never commits by design; the sandbox mounts `.git` read-only (changelog: "granting read-only rather
  than writable access to a Git repository's `.git` directory"; earlier: `.git` added to dangerous
  paths). Without `--sandbox` nothing structural prevents `git commit`.

### 1.3 Sandbox
- Opt-in (`--sandbox` or `enableTerminalSandbox` in settings; `toolPermission: "proceed-in-sandbox"`
  auto-approves sandboxed commands). Linux = "kernel namespaces" (filesystem, process hiding, no
  network); macOS = Seatbelt. Network is off unless domains granted via `read_url(domain)` rules
  (compiled into an allowlist/proxy; issue #984 reports sandboxed curl vs api.github.com friction).
  Binary strings reference an internal `exebox` package with seccomp filter loading and tmpfs mounts,
  i.e. user/mount namespaces + seccomp (inference from `strings`; docs do not say). Docs omit
  nested-sandbox behavior, user-namespace requirements and WSL2 prerequisites.
- Nesting inside Nexar's bubblewrap: UNVERIFIED (cannot exercise the sandbox without an authenticated
  agent turn). Expect the same constraint as Codex: needs unprivileged userns inside the outer sandbox,
  else the agent's shell commands fail or "ask to bypass".
- The sandbox covers terminal commands only; agy's own file tools and network (model API) run outside
  it.

### 1.4 Auth and storage
- Google Sign-In: browser locally; on SSH, prints a URL and takes back a code (manual loop).
  Unauthenticated `-p` tries interactive OAuth then blocks (observed). Credentials in the OS keyring
  (Secret Service/D-Bus); changelog: keyring is bypassed with no D-Bus session (headless
  hosts/containers/likely WSL2 without D-Bus) and a file store is used — file name not documented,
  UNVERIFIED (not found in my fresh home; no login performed). `/logout` purges.
- State under `~/.gemini/antigravity-cli/` (observed after first runs: `cli.log`, `log/`,
  `conversations/`, `conversation_summaries.db`, `brain/`, `cache/`, `installation_id`,
  `jetski_state.pbtxt`, `settings.json`) and `~/.gemini/config/` (`config.json`, `mcp_config.json`,
  `hooks.json`, `plugins/`, `skills/`). Transcript JSONL:
  `~/.gemini/antigravity-cli/brain/<conv>/.system_generated/logs/transcript.jsonl` (forum answer). Both
  dirs are shared with the credentials location only when the file fallback is used; HOME-redirect works
  to isolate (what I did).
- Alternative non-subscription route: `modelProvider:"gemini"` + `GEMINI_API_KEY` (not wanted by the
  owner).
- `agy models` unauthenticated prints "Please sign in to view available models" (exit 0) — free probe
  for "installed vs authenticated" (note it prints the error on stderr/stdout, parse text).

### 1.5 Subscription tiers
Free/Standard (weekly quota), Google AI Pro (5-hourly refresh to weekly cap), Google AI Ultra (highest;
third-party models). CLI and IDE share quota; AI credits for overage (docs/plans). Models seen: Gemini
3.1 Pro, Gemini 3.8 Flash. Exact labels from `agy models` (auth required) — not obtained.

### 1.6 Network domains (strings from binary + docs; incomplete)
`cloudcode-pa.googleapis.com` (model/code-assist backend), `oauth2.googleapis.com`,
`accounts.google.com`, `www.googleapis.com`, `iamcredentials.googleapis.com`, `sts.googleapis.com`,
`generativelanguage.googleapis.com` (API-key route), `antigravity.google` (+ the updater `*.run.app`
host above). Telemetry endpoints exist (`/exa.analytics_pb.AnalyticsService/...`, UNVERIFIED host).
Local language-server process on loopback ports (log `port.go`), so outer sandbox must allow loopback.

### 1.7 Terms of use
- Antigravity Additional Terms §6 (fetched 2026-10-01; no effective date shown): "Using third party
  software, tools, or services to access the Service (e.g. using OpenClaw with Antigravity OAuth) is a
  breach of this Agreement." Press coverage: Feb 2026 suspensions of subscribers who used OAuth tokens
  in third-party tools (OpenClaw).
- Google AI Developers Forum thread (2026-09-15, reply by pseudonymous "Engineer760", staff status
  UNVERIFIED): launching the official `agy` binary as a child process in headless mode "is a supported
  workflow" consuming the same entitlements; extracting OAuth tokens, reusing credentials in custom
  clients, or calling backend endpoints is unsupported.
- Reading: driving the unmodified official binary is allowed; reading/copying tokens or custom HTTP
  clients is the bannable path. This aligns with the Nexar rule "never read runtime credentials".
  Residual risk: §6 wording is broad; an automated multi-lane fleet might be judged abusive (rate/quota)
  — UNVERIFIED, no written policy on concurrency.

### 1.8 Delegate Skills `agy-delegate` cross-check
Confirms: `agy --print=<brief>` (the `=` form, to survive briefs like `--help`), `--new-project`
default, `--add-dir <abs cd>`, optional `--model/--effort/--sandbox/--dangerously-skip-permissions`,
`--log-file`; spawns with `stdio: [ignore,pipe,pipe]`, env = full `process.env` (not minimal),
process-group kill on timeout, parses log for project/conversation ids, `touchedFiles` from `git status
--porcelain`, `readOnlyViolation` fingerprints, version from `agy changelog`. Result carries no
tokens/cost/turns. Needs `agy` on PATH (exit 127 otherwise).

## 2. Implications for Nexar v0.3
- Verdict: **spike-only for v0.3 first-class lane; viable as an experimental adapter behind a flag.**
  Reasons: (a) could not verify authenticated behavior, sandbox nesting, or WSL2 here; (b) the
  permission model is soft-deny in headless, which makes unattended writes depend on
  `--dangerously-skip-permissions` (acceptable only inside Nexar's outer sandbox); (c) ToS §6 ambiguity
  and enforcement history warrant owner sign-off; (d) closed binary, fast release cadence (1.0 -> 1.2.14
  quickly) means exact-pinning and fixtures. Documented JSON/stream-json with tokens and conversation
  ids makes a clean adapter feasible later.
- If built: `agy --output-format stream-json --input-format stream-json --dangerously-skip-permissions
  --add-dir <worktree> --model <label>` with prompt via stdin (avoids `ps` leak), spawned inside Nexar's
  outer bwrap (do NOT also rely on `--sandbox`; or test both), minimal env + isolated `HOME`/state dir
  only if auth can be provisioned without Nexar reading it. Outer sandbox must make worktree `.git`
  read-only (agy has no structural no-commit guarantee without its own sandbox).
- Map `usage` (input/output/thinking/cache_read/total) to `Measured`; cost unknown (subscription quota);
  detect `status != SUCCESS` and exit 3 / `AGY_ERROR`.
- Resource-registry probe: `command -v agy` + version (`agy --version`, free) and `agy models` for auth
  (free, but must have stdin closed and a timeout, and never `-p` unauthenticated). Treat "auth state
  unknown" as degraded.
- Add a concurrency cap per runtime (1-2 lanes) to stay clearly within "ordinary use".

## 3. Open questions
- Does `--sandbox` work nested inside bubblewrap (and in WSL2 Ubuntu), and what happens when userns is
  blocked?
- Where do credentials live in file-fallback mode (no D-Bus in WSL2), and is a bind-mounted read-only
  credential dir workable given token refresh writes?
- Exact `stream-json` `result` fields when a tool is soft-denied; is there a machine-readable denial
  signal (Delegate Skills scrapes stderr)?
- Are the forum answer and §6 sufficient for fleet-style use? Ask the owner / Google for a written
  statement.
- Model labels per plan; `--effort max` support per model.
- Official domain allowlist (not published); verify with a proxy log on the owner machine.

## 4. Sources
- Official: https://antigravity.google/docs/cli/overview, /docs/cli/headless/, /docs/sandbox/,
  /docs/permissions/, /docs/cli/install/, /docs/plans, https://antigravity.google/terms (§6),
  https://antigravity.google/cli/install.sh
- https://github.com/google-antigravity/antigravity-cli (README, CHANGELOG.md, issues #614, #984)
- Forum:
  https://discuss.ai.google.dev/t/is-external-orchestration-of-antigravity-cli-headless-mode-supported-with-account-based-usage/183051
- Press on OAuth suspensions (secondary): vpncentral.com, mlq.ai (search results)
- https://github.com/amElnagdy/delegate-skills
  `skills/agy-delegate/{SKILL.md,scripts/relay.mjs,references/dispatch-and-poll.md}`
- Local: `agy --help`, `agy changelog`, `agy models`, `strings agy`, installer script
