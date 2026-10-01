# Upstream research: OpenAI Codex CLI (`@openai/codex`)

| Field | Value |
| --- | --- |
| Source | https://github.com/openai/codex (canonical); npm `@openai/codex` (+ platform pkg `@openai/codex-linux-x64`) |
| Version inspected | `@openai/codex@0.159.3` (npm `latest`; `alpha` = 0.161.0-alpha.8). `codex --version` => `codex-cli 0.159.3` |
| Source SHA | `444da310e108da16aaeb18fd790b0ac464f08aca` (main, 2026-10-01 07:08Z, shallow clone) |
| Inspected | 2026-10-01, Linux x86_64 container, running as uid 0 |
| Scratch | `codex-inst/` (npm install, 425 MB incl. native musl binary + bundled `bwrap`), `codex-src/` (clone), `codex-home/` (empty throwaway `CODEX_HOME`) |
| Method | `--help` of `codex`, `exec`, `login`, `sandbox`, `mcp`, `app-server`; Rust source (`codex-rs/exec`, `linux-sandbox`, `login`); empirical sandbox + nesting tests; official docs (learn.chatgpt.com, formerly developers.openai.com/codex). No login, no paid call (one unauthenticated `exec` produced 401s from `api.openai.com`, nothing billed). |

## 1. Findings

### 1.1 Headless invocation
- `codex exec [OPTIONS] [PROMPT]` (alias `codex e`). Prompt = positional arg; if omitted or `-`, read
  from **stdin**; if both, stdin is appended as a `<stdin>…</stdin>` block (`codex-rs/exec/src/lib.rs`
  `resolve_prompt`, `read_prompt_from_stdin`; `exec/src/cli.rs` doc-comment on `prompt`).
  Gotcha: with a non-TTY stdin and a positional prompt it prints "Reading additional input from
stdin..." and waits for EOF. Nexar must either pipe the whole prompt via stdin (`codex exec -`) and
close it, or close stdin explicitly. Observed locally.
- `--json` (alias `--experimental-json`): JSONL events on **stdout**; human progress/log lines go to
  stderr. Without `--json`, only the final agent message goes to stdout (docs).
- `-o/--output-last-message <FILE>`: writes final assistant message to a file. `--output-schema <FILE>`:
  JSON Schema for the final response.
- `-m/--model <MODEL>`; reasoning effort etc. via `-c model_reasoning_effort="high"` (TS SDK
  `sdk/typescript/src/exec.ts` does exactly this). `-c key=value` is a TOML dotted-path override
  (repeatable).
- `-C/--cd <DIR>` working root; `--add-dir <DIR>` extra writable dirs; `--skip-git-repo-check` (not
  needed with `--dangerously-bypass-approvals-and-sandbox`, which implies it: `lib.rs` ~L994);
  `--ephemeral` (no session files); `--ignore-user-config` (skips `$CODEX_HOME/config.toml`, auth still
  from `CODEX_HOME`); `--ignore-rules` (skips execpolicy `.rules`); `--strict-config`; `--color never`.
- `exec` has **no `-a/--ask-for-approval` flag** (only the top-level interactive `codex` does; `-a`
  values there: `on-request`, `never`). Headless exec hard-codes `approval_policy = Never` (`lib.rs`
  ~L578: "Default to never ask for approvals in headless mode"). Override only via `-c
  approval_policy=...` (TS SDK does this). `--approve-for-me` routes approvals to automatic review.
- Sessions: `codex exec resume <ID|--last>`, `codex exec fork <ID>`; `thread.started.thread_id` is the
  resume id.
- Exit codes: `0` success; `1` for any error seen in stream (`lib.rs` ~L1375 `if error_seen { exit(1)
  }`), bad `-c`, config/rules/login-restriction failures, missing git repo, empty stdin. No
  finer-grained codes found. Unauthenticated run: emits `thread.started`, `turn.started`, repeated
  `{"type":"error","message":"Reconnecting... N/5 ..."}`, exits 1 (observed).

### 1.2 JSONL event schema (`codex-rs/exec/src/exec_events.rs`, authoritative `#[serde(tag="type")]`)
- Events: `thread.started{thread_id}` · `turn.started{}` · `turn.completed{usage}` ·
  `turn.failed{error:{message}}` · `item.started|item.updated|item.completed{item}` · `error{message}`.
- `usage` (on `turn.completed`; cumulative thread totals, `usage_from_last_total` in
  `event_processor_with_jsonl_output.rs`): `input_tokens`, `cached_input_tokens`,
  `cache_write_input_tokens` (defaults 0), `output_tokens`, `reasoning_output_tokens`. **No cost field
  and no model name** in events. If usage unavailable the processor emits `Usage::default()` (zeros) —
  Nexar must NOT treat that as measured 0 (`Measured<T>` = unknown).
- `item = {id:"item_N", type: ...}` with `type` in: `agent_message{text}` (final answer, or JSON string
  with `--output-schema`), `reasoning{text}`, `command_execution{command, aggregated_output,
  exit_code|null, status: in_progress|completed|failed|declined}`, `file_change{changes:[{path, kind:
  add|delete|update}], status}`, `mcp_tool_call{server,tool,arguments,result,error,status}`,
  `collab_tool_call{...}`, `web_search{id,query,action,results?}`,
  `todo_list{items:[{text,completed}]}`, `error{message}` (non-fatal).
- Touched files = union of `file_change.changes[].path` (paths as reported; Nexar must still run them
  through `resolveContainedPath`) — but shell-command edits (`sed -i`, build output) do NOT appear as
  `file_change`; use `git status`/`git diff` in the worktree as ground truth.
- Final message = last `agent_message` item (or `-o` file).
- TS SDK `@openai/codex-sdk` (in repo `sdk/typescript`, version `0.0.0-dev`) is a thin wrapper that
  spawns `codex exec --experimental-json` and passes env explicitly; confirms this surface is the
  intended programmatic API.

### 1.3 Sandbox modes and implementation
- `-s/--sandbox`: `read-only` (default for exec per docs), `workspace-write`, `danger-full-access`.
  `--dangerously-bypass-approvals-and-sandbox` = `danger-full-access` + skip git check ("intended solely
  for running in environments that are externally sandboxed"). `--full-auto` deprecated (docs).
- Permission profiles (newer): built-ins `:read-only`, `:workspace`, `:danger-full-access`
  (`protocol/src/models.rs` L409-415), usable via `codex sandbox -P`.
- **Linux implementation = bubblewrap + seccomp**, not Landlock by default (`linux-sandbox/README.md`):
  uses first `bwrap` on PATH, else bundled `codex-resources/bwrap`; `--ro-bind / /`, writable roots
  `--bind`, `--unshare-user`, `--unshare-pid`, fresh `/proc`, `--unshare-net` when network restricted,
  `PR_SET_NO_NEW_PRIVS` + seccomp network filter. Legacy Landlock is rejected for filesystem-restricted
  policies. WSL2 = normal bwrap path; **WSL1 unsupported**. Warns at startup if bwrap cannot create user
  namespaces.
- Protected paths inside writable roots re-mounted read-only: `.git` (and resolved `gitdir:` targets),
  `.codex`, `.agents` (README + docs). Verified empirically: inside `codex sandbox -P :workspace` both
  in a normal repo and in a `git worktree`, `git add`/`git commit` fail with "Unable to create ...
  index.lock: Read-only file system", while ordinary file writes in the workspace succeed. So **Codex
  cannot commit or even stage inside its workspace-write sandbox**; Nexar must stage/commit from
  outside.
- Default `workspace-write` network: tool commands have no network (curl failed DNS inside sandbox;
  verified). This restricts only commands the agent runs; the Codex process itself talks to OpenAI
  outside the sandbox.

### 1.4 Nesting inside an outer bubblewrap — empirical
Test (as uid 0, kernel 6.18, bwrap 0.9.0): outer `bwrap --ro-bind / / --tmpfs /tmp --ro-bind codex-inst
… --bind ws ws --bind codex-home … --dev /dev --proc /proc --unshare-user --unshare-pid [--unshare-net]
--new-session -- codex sandbox -P :workspace -C ws -- sh -c …`.
- Worked: inner sandbox ran, `/etc` read-only, workspace writable, also with outer `--unshare-net`.
- Failed first attempt because outer `/tmp` was read-only: Codex panics creating
  `/tmp/codex-bwrap-synthetic-mount-targets-<uid>/lock` (`linux_run_main.rs:1325`). **Outer sandbox must
  give a writable `/tmp`** if the inner sandbox is kept.
- Outer `--cap-drop ALL` together with `--unshare-user` failed in the OUTER bwrap itself (uid map) in
  this root test — inconclusive for nesting; UNVERIFIED for non-root.
- UNVERIFIED: non-root user inside WSL2 Ubuntu (could not test non-root; scratch path is root-only and
  rules forbid copying elsewhere). Known failure mode from upstream issues (#16211 and others): "bwrap:
  No permissions to create a new namespace" when the host/container blocks unprivileged user namespaces
  (Docker default seccomp/AppArmor; Ubuntu 24.04 `apparmor_restrict_unprivileged_userns`). Whether the
  owner's WSL2 kernel/AppArmor allows nested userns is unknown.
- Conclusion: nesting is feasible but fragile. Failure surfaces as shell commands failing while the run
  may still "succeed" (a downstream issue report notes silent success) — Nexar must detect
  `command_execution` failures with the bwrap signature.

### 1.5 Config dir and auth
- `CODEX_HOME` (default `~/.codex`). Auth stored in `$CODEX_HOME/auth.json` (file name only; per docs:
  "treat it like a password"), or OS keyring, per `cli_auth_credentials_store =
  file|keyring|auto|ephemeral`. Same dir also holds `config.toml`, sqlite state (`state_5.sqlite`,
  `logs_2.sqlite`, …), sessions, `skills/`, `shell_snapshots/` (observed on first run in an empty home).
  `installation_id` file is created.
- Because `CODEX_HOME` holds both credentials and mutable state (and Codex refreshes tokens in
  `auth.json`), a read-only bind of the whole dir breaks sqlite/session writes and token refresh.
  UNVERIFIED which paths are strictly needed read-write; a Nexar-owned `CODEX_HOME` per lane/run with
  only `auth.json` provisioned is not allowed by our "never read/copy credentials" rule, so options are:
  (a) bind the real `CODEX_HOME` read-write (token refresh, but exposes history/config), (b) use
  `--ephemeral` + `-c cli_auth_credentials_store=...`; needs spike.
- `codex login --help`: ChatGPT browser flow (default), `--device-auth` (device code, "beta"),
  `--with-api-key` (stdin), `--with-access-token` (stdin; docs: for CI with ChatGPT workspace access via
  `CODEX_ACCESS_TOKEN`), `codex login status` (prints "Not logged in", exit 0 observed), `codex logout`.
  Headless alternative per docs: copy `auth.json` to another host. Nexar should never do this; the owner
  logs in once on the host/WSL.
- `exec` with ChatGPT-subscription auth: documented as default behavior ("reuses saved CLI
  authentication"); API key (`CODEX_API_KEY`) is documented as the recommended CI path but not required.
  UNVERIFIED by live run (no login allowed).

### 1.6 Network endpoints (from source strings + observed)
`chatgpt.com` (`/backend-api/codex` = model traffic with ChatGPT auth,
`/backend-api/codex/analytics-events/events`), `auth.openai.com` (`/oauth/token`, login + refresh),
`api.openai.com` (`/v1/responses`, WebSocket `wss://`, used for API-key auth; observed in unauth test),
`registry.npmjs.org` (update check), `chatgpt.com/codex/install.sh`. Egress allowlist needs WebSocket
support. Telemetry/analytics can be disabled via config (UNVERIFIED key names).

### 1.7 Git behavior
Never commits by itself in exec; upstream system prompts say "Do not `git commit` your changes or create
new git branches unless explicitly requested" (`core/gpt_5_1_prompt.md` L157, `gpt_5_2_prompt.md` L131).
Prompt-level only; the `.git` ro-remount in its own sandbox is the hard control. With the sandbox
disabled, nothing structural prevents `git commit`.

### 1.8 Programmatic modes
`codex app-server` (experimental; `--listen stdio://|unix://|ws://`;
`generate-ts`/`generate-json-schema`), `codex exec-server`, `codex mcp` (= manage MCP servers Codex
consumes; no `serve` subcommand seen in 0.159.3 help), `codex agents`, `codex review`, `codex exec
review`.

## 2. Implications for Nexar v0.3
1. Adapter command: `codex exec --json --ephemeral -m <model> -C <worktree> -s workspace-write -o
   <outfile> -` with prompt on stdin (stdin closed after write), explicit minimal env. Map
   `turn.completed.usage` to `Measured` tokens; cost = unknown (subscription). Parse
   `item.completed`/`file_change`; verify via `git status`.
2. Sandbox choice (Nexar owns the boundary, ADR-009 style): preferred **disable Codex's own sandbox**
   (`--dangerously-bypass-approvals-and-sandbox`, or `-s danger-full-access` + `-c
   approval_policy="never"`) and rely on Nexar's outer bwrap; then Nexar must itself re-create what
   Codex gave for free: read-only `.git` / gitdir of the worktree, no network except allowlist, no
   `.codex` write. Optional defense-in-depth (keep inner `workspace-write`) only if the spike proves
   nested userns works in the owner's WSL2 and outer `/tmp` is writable.
3. Never-commit enforcement must be structural: mount worktree `.git` (file +
   `<main>/.git/worktrees/<name>`) read-only in the outer sandbox; Nexar runs `git add/commit` outside.
4. Egress allowlist: `chatgpt.com`, `auth.openai.com`, `api.openai.com` (+ npm registry only if update
   checks not disabled); needs WSS.
5. Credentials: treat `CODEX_HOME` as an opaque runtime dir; provision via bind-mount of the owner's dir
   only after a spike; Nexar never opens `auth.json`. Add `codex login status` as a probe (free, no
   network call observed in "Not logged in" case) in the resource registry.
6. Exit code 1 is overloaded; classify failures by last `turn.failed`/`error` event text and by empty
   `agent_message`.
7. Pin exact version (0.159.3) per ADR-008; event schema is generated with ts-rs so contract tests can
   use captured fixtures, and `codex app-server generate-json-schema` can produce a schema to diff on
   upgrade.

## 3. Open questions
- Does nested bwrap work as non-root in the owner's WSL2 Ubuntu (user-ns sysctls, AppArmor)? Needs a
  spike on the real machine.
- Minimal `CODEX_HOME` file set needed for ChatGPT-auth exec, and whether token refresh needs a writable
  `auth.json`; can the keyring/`ephemeral` store be driven without Nexar touching secrets?
- Live confirmation that `exec` runs fully with ChatGPT subscription auth on the owner's plan and which
  model names that plan allows (`-m` values; default model discovery via `model/list` in app-server).
- Which config keys disable analytics/update checks/telemetry for a tight egress list.
- Rate-limit/usage-limit error shapes for subscription auth (not found in event schema).
- Does `exec` honour a project-level `.codex/config.toml` from an untrusted worktree (project trust)?
  `--ignore-user-config` exists; project-layer behavior UNVERIFIED.

## 4. Sources
- Repo: https://github.com/openai/codex @ 444da310 —
  `codex-rs/exec/src/{cli.rs,lib.rs,exec_events.rs,event_processor_with_jsonl_output.rs}`,
  `codex-rs/linux-sandbox/README.md`, `codex-rs/linux-sandbox/src/linux_run_main.rs`,
  `codex-rs/protocol/src/models.rs`, `codex-rs/core/gpt_5_{1,2}_prompt.md`, `sdk/typescript/src/exec.ts`
- Docs: https://learn.chatgpt.com/docs/non-interactive-mode, /docs/auth, /docs/sandboxing (redirected
  from developers.openai.com/codex/*)
- Issue: https://github.com/openai/codex/issues/16211 (bwrap in Docker); other search results (zenn.dev
  Ubuntu 24.04 bubblewrap article)
- Local: `codex --help`, `codex exec --help`, `codex login --help`, `codex sandbox --help`, empirical
  tests under `runtimes/ws`, `runtimes/gt`
