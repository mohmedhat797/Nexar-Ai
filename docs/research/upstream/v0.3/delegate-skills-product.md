# Upstream research: Delegate Skills for product-time lanes

| Field | Value |
| --- | --- |
| Source | https://github.com/amElnagdy/delegate-skills (MIT; a Skills-CLI package of `*-delegate` skills + `delegate-setup`) |
| SHA | `6826b363085dcc80875372315fe7d208c4bf733f` (master, 2026-09-20 "Merge pull request #131 ... docs/agy-permission-denial"). `git pull` reported "Already up to date"; `git fetch` showed master == origin/master, so HEAD is unchanged from the earlier snapshot. |
| Inspected | 2026-10-01 (local clone `scratchpad/delegate-skills`) |
| Files read | `AGENTS.md`, `README.md`, `skills/delegate-setup/{SKILL.md,references/schema.md,scripts/lane.mjs,discover.mjs}`, headers + argv/result code of `skills/{claude,codex,agy,pi}-delegate/scripts/relay.mjs` (1295 / 764 / 822 / 816 lines), `skills/agy-delegate/SKILL.md` + `references/dispatch-and-poll.md`, `skills/codex-delegate/references/dispatch-and-poll.md` (grep) |
| Not done | No relay was executed (no authenticated CLIs here). Behaviour below is from source. Pi relay read at header/result level only. |
| Prior art | The Nexar repo already holds a v0.1 snapshot `docs/research/upstream/delegate-skills.md` (seen only via grep during a path slip; not relied on). This note supersedes it for v0.3 lane questions. |

## 1. Findings

### 1.1 What a relay is
- A "relay" is a dependency-free Node script (`skills/<x>-delegate/scripts/relay.mjs`) that: validates a
  brief (file or stdin), spawns the CLI directly (no shell on POSIX) in `--cd <dir>`, captures output,
  kills the process group on a watchdog, computes `touchedFiles` from `git status --porcelain`, and
  writes `<out-dir>/result.json` (schema string `delegate-relay.result.v1`) plus artifacts (`brief.txt`,
  `events.jsonl`, `final.txt`, `stderr.txt`, claude also `profile.json`). The relay itself never commits
  and "makes no network calls, reads or writes no credentials".
- Exit codes: 2 usage error (no result.json), 127 CLI missing (`status: <tool>_unavailable`), otherwise
  mirrors the CLI (128+signal on kill; forced non-zero on timeout / terminal error / agy
  permission-denial no-op).
- Binary discovery: `spawn("claude"|"codex"|"agy"|"pi", ...)` straight from `PATH` (only `commandcode`
  has a `COMMANDCODE_BIN` override; `discover.mjs` probes PATH and, for zcode, an app bundle). **No
  generic binary-path override**; Nexar controls it by setting `PATH` for the relay process.
- Environment: claude/agy relays pass `{...process.env}` (claude strips only `CLAUDECODE`; keeps
  `CLAUDE_CODE_CHILD_SESSION` and credential vars). codex relay has opt-in `--clean-env` (keeps only
  PATH, HOME, USER, LOGNAME, SHELL, LANG, LC_*, TERM, TMPDIR, `CODEX_HOME`, + `--keep-env NAME`) and
  `--ignore-user-config`. No relay uses a minimal env by default (conflicts with Nexar's "explicit,
  minimal env" rule).

### 1.2 Invocation per relay (what Nexar would be calling)
| Relay | CLI argv built | Prompt | Write profile (default) | Read-only |
| --- | --- | --- | --- | --- |
| claude | `claude -p --output-format stream-json --verbose --tools Read,Glob,Grep,Edit,Write,Bash --strict-mcp-config --disallowedTools mcp__* --disable-slash-commands --settings <profile.json> --permission-mode acceptEdits [--model --effort --max-turns --max-budget-usd --autocompact] [--continue \| --resume <id>]` | stdin | `acceptEdits`; profile.json: `disableClaudeAiConnectors`, deny `Bash(git commit *)`, `git * commit *`, `git push *`, `claude *`, `*claude-delegate*`; **`sandbox:{enabled:true, failIfUnavailable:true, autoAllowBashIfSandboxed:true, allowUnsandboxedCommands:false}`** (Linux/macOS/WSL2). `--dangerously-skip-permissions` opt-in (sandbox profile still applied). | `--permission-mode plan`, tools `Read,Glob,Grep`, git tripwire `readOnlyViolation` |
| codex | `codex exec [--ignore-user-config] --json -o <final.txt> -s workspace-write [-m <m>] [-c model_reasoning_effort=<e>] [--skip-git-repo-check] -` (resume: `exec -s <mode> resume <id\|--last> ...`) | stdin (`-`) | `-s workspace-write` default; `--sandbox danger-full-access` selectable; no `--ephemeral`, no approval flag (exec is already `never`) | `-s read-only` |
| agy | `agy --new-project\|--project\|--conversation\|--continue --add-dir <cd> [--model --effort --sandbox --dangerously-skip-permissions --print-timeout] --log-file <p> --print=<brief>` | **argv** (visible in `ps`; ~128 KB cap) | agy's own permission policy; headless soft-denies tool prompts, relay detects it and exits 1 | `--sandbox --dangerously-skip-permissions` (sandbox overlay discards writes) |
| pi | `pi --mode json ... --no-approve` (brief on stdin) | stdin | "no sandbox and no permission modes"; full local tools | tools restricted to `read,grep,find,ls` |

### 1.3 `result.json` per relay (all `schema: "delegate-relay.result.v1"`)
- Common: `schema, lane, laneSource, workdir, model, effort, status
  (completed|failed|timeout|aborted|<tool>_unavailable), exitCode, signal, startedAt, finishedAt,
  finalMessage, touchedFiles (git porcelain lines; null when git cannot report), briefPath, finalPath,
  stderrPath, stderrTail, error`.
- claude (rich): `tool, claudeVersion, sessionId, resultSubtype, numTurns, usage (raw), totalCostUsd,
  maxTurns, maxBudgetUsd, permissionMode, toolSurface[], shellSandbox
  (strict|not-applicable|unsupported-on-native-windows), dangerouslySkipPermissions, resumed, readOnly,
  readOnlyViolation (true|false|null), eventsPath, settingsPath`.
- codex (thin): `codexVersion, threadId, sandbox, session, resumeLast, cleanEnv, ignoreUserConfig,
  keepEnv, eventsPath`. **No tokens, cost, turns, model actually used** in result.json (they are in
  `events.jsonl` `turn.completed.usage`; see codex.md). Touched files = git porcelain only.
- agy: `tool:"agy", agyVersion, projectId, conversationId, sandbox, readOnly,
  dangerouslySkipPermissions, resumed, readOnlyViolation, logPath`. No tokens/cost/turns even though
  `--output-format json` would provide them (relay uses text stdout and parses the log).
- pi: `piVersion, sessionId, requested/actual provider+model, usage (raw), readOnly, projectTrusted`.
- Cost/tokens/turns/touchedFiles/session availability: claude all five; codex session+touchedFiles only;
  agy conversation id + touchedFiles only; pi session + usage + touchedFiles. Cost is a client-side
  estimate only for claude.

### 1.4 Fleet / lane config (`delegate-fleet.v1`)
- File: global `$XDG_CONFIG_HOME/delegate-skills/config.json` (or
  `~/.config/delegate-skills/config.json`), project `<git-root>/.delegate/config.json` (whole-lane
  overlay; project lanes only apply if content hash approved via `config.mjs write --scope project`,
  stored in git metadata).
- `lanes.<name> = { implementer: <key>, ...dials }` where **`implementer` is required** and dials are
  per-implementer (claude: model, effort, timeout, readOnly; codex: model, effort, sandbox, timeout,
  readOnly; agy: model, effort, timeout, readOnly; pi: provider, model, timeout, readOnly; ...). So a
  lane is a fixed binding "kind of work -> one implementer + dials". It is NOT capability-based and
  there is no fallback/selection logic. `lane.mjs resolve --cwd --lane --implementer` returns
  relay-native dials; relays call it for `--lane` and fail loud on mismatch.
- Selecting implementer + model per invocation without lanes: choose the relay
  (`skills/<implementer>-delegate/scripts/relay.mjs`) and pass `--model/--effort/--sandbox/--timeout`
  flags; explicit flags always win over lane dials. Nexar can therefore skip lanes completely and keep
  routing in NRC (no dependency on user fleet files, which are mutable, outside the repo and outside
  Nexar's trust model).
- `discover.mjs` reports `{key, binary, version, path, authenticated: true|false|null, supports,
  models}` — a possible probe source, but note "Probed CLIs may contact their own services" (it may run
  commands that hit the network, e.g. model lists); Nexar's probes must stay free (ADR rule), so Nexar
  should implement its own probes (`--version`, `claude auth status`, `codex login status`).

### 1.5 Worktrees
Relays do **not** create worktrees. They operate in whatever `--cd` they get and report `git status
--porcelain`; docs only advise "dispatch against a clean or isolated worktree" (copilot/aider SKILL.md,
README). Nexar must create/own the worktree (and `touchedFiles` is only meaningful for a clean one).
Linked-worktree handling appears only in git fingerprint helpers (agy `gitWorktreeFingerprint`,
tripwire) and one Windows/grok note. Nothing in relays protects the main repo's `.git` from the child.

### 1.6 Sandbox/permission posture vs an outer bubblewrap
- claude relay: always requires Claude's own shell sandbox with `failIfUnavailable:true` and has no flag
  for `enableWeakerNestedSandbox`. My empirical test (claude-code-write.md §1.3) shows the sandbox
  library fails inside an outer bwrap with `Can't mount proc` unless `enableWeakerNestedSandbox:true`.
  => **relay would hard-fail nested** (fail-closed by design). Possible workaround: merged user/managed
  settings in a Nexar-owned `CLAUDE_CONFIG_DIR` supplying `sandbox.enableWeakerNestedSandbox:true` (docs
  say settings merge) — UNVERIFIED. Also claude's sandbox allows writes to the main `.git` of a linked
  worktree; relay's only anti-commit control is string deny rules ("speed bumps" per its own header).
- codex relay: nested workspace-write worked in my test when outer `/tmp` is writable; or pick
  `--sandbox danger-full-access` to disable the inner layer. Inner layer gives ro `.git`.
- agy relay: `--sandbox` optional; nesting UNVERIFIED; bypass flag opt-in.
- pi relay: no sandbox at all => entirely dependent on Nexar's outer sandbox.
- None of the relays set a network allowlist; all call their CLI's cloud endpoints directly.

### 1.7 Decomposition helpers
`references/writing-the-brief.md` (goal, current state, change, untouched, real gate commands, report
contract, "you will not commit", one task per brief), `multi-task-queues.md` (sequential queue, carry
constraints, coherence check), `review-and-land.md` (re-run gates, read diff, rework by resume with
delta brief). These are prompts for the orchestrating agent, not code. Useful as templates for Nexar
workflows data (ADR-017: workflows are data) but must be re-authored (license MIT; attribution if
copied).

## 2. Implications for Nexar v0.3
Recommended design ("Nexar routes; Delegate Skills executes where it fits"):
1. **Routing stays in NRC.** Nexar's registry lists resources (`claude`, `codex`, `agy`, `pi`) with
   capability tags, probes (free) and per-run `RouteDecision` (resource + model + effort + sandbox
   profile). Do not use fleet lanes/`delegate-setup` (user-global mutable config, fixed-implementer
   semantics, config approval flow); pass explicit flags only (explicit flags beat lanes anyway).
2. **One adapter package `integrations/delegate-skills`** (ADR-008: only place that knows relay paths,
   flags, `delegate-relay.result.v1`): `ExecutionBackend` for `{resource -> relay}`: builds argv, writes
   the brief file outside the repo, creates `--out-dir` under `.nexar/runtimes/<run>/`, runs the relay
   as a child (inside the Nexar outer bubblewrap, relay and CLI together), reads `result.json` +
   `events.jsonl`, maps to `Measured` (claude: tokens/turns/cost-estimate; codex: tokens from
   events.jsonl via Nexar's own Codex parser; agy: none from relay -> unknown; pi: usage). Contract
   tests use a fake relay (as with other adapters) and captured fixtures of each result.json. Pin the
   Delegate Skills SHA; vendor relays under `integrations/delegate-skills/vendor/` (MIT, with LICENSE +
   SHA) rather than relying on an owner-installed `~/.claude/skills` path — the relays are single files
   with no dependencies, so vendoring is cheap and makes behaviour deterministic.
3. **Override the relay's posture where it conflicts with the outer sandbox:** codex `--sandbox
   danger-full-access --clean-env --ignore-user-config --keep-env CODEX_HOME` (outer bwrap is the
   boundary; add ro `.git` there); claude requires an upstream patch or a Nexar-owned patched copy to
   add `--no-shell-sandbox`/`--nested-sandbox` (flag does not exist) — otherwise use a Nexar-native
   Claude adapter (claude-code-write.md invocation). agy: spike-only (antigravity.md); stdin prompt not
   available in relay (argv). pi: only with a strict outer sandbox + egress policy.
4. **Treat relay output as untrusted/hearsay.** Nexar recomputes the diff itself in the worktree (`git
   diff`, name-status) and runs gates; `touchedFiles` and `finalMessage` are informational. Nexar
   commits, never the relay or CLI; mount worktree git admin dir read-only.
5. **Hybrid roadmap:** Phase A (v0.3.0): relay-backed codex lane (works nested, thin) + Nexar-native
   claude lane; Phase B: agy spike behind a flag; Phase C: replace relays with native adapters wherever
   tokens/telemetry or sandbox control matter (codex JSONL parser is trivial since relay only forwards
   `--json` events to `events.jsonl`). Use Delegate Skills' brief/queue references as inputs for Nexar
   workflow templates, and its relay source as a regression oracle for CLI quirks (e.g.,
   `--print=<brief>` form for agy, claude `--tools` surface, Windows shims).
6. Contribute upstream if desired: `--no-shell-sandbox` for claude-delegate, `--output-format json` for
   agy relay, usage fields in codex result.json. Avoid forking long-term.

## 3. Open questions
- Is a vendored relay acceptable under ADR-008 wording ("integration code lives in
  integrations/<name>")? Needs an ADR note on vendoring vs invoking an installed skill.
- Does merged `CLAUDE_CONFIG_DIR/settings.json` with `enableWeakerNestedSandbox` satisfy the claude
  relay's `failIfUnavailable` under an outer bwrap in the owner's WSL2?
- Pi: which providers/auth does `pi` use in the owner's setup (subscription vs API keys)? Pi was not
  covered by the subscription-only constraint; UNVERIFIED relevance for v0.3.
- Relay stability: single maintainer-style repo, frequent releases (17 skills); acceptable to pin and
  vendor?
- Does codex relay's lack of `--ephemeral` leave session sqlite/rollouts in `CODEX_HOME` that Nexar must
  clean or isolate per run?
- agy relay exit-code semantics versus agy's own exit 3 / `AGY_ERROR` (relay predates? it mirrors exit
  codes; verify).

## 4. Sources
- https://github.com/amElnagdy/delegate-skills @ 6826b363: `README.md`, `AGENTS.md`,
  `skills/delegate-setup/references/schema.md`,
  `skills/delegate-setup/scripts/{lane,discover,implementers,config}.mjs`,
  `skills/{claude,codex,agy,pi}-delegate/scripts/relay.mjs`,
  `skills/agy-delegate/{SKILL.md,references/dispatch-and-poll.md}`,
  `skills/codex-delegate/references/dispatch-and-poll.md`, `skills/claude-delegate/references/`
- Cross-references: `codex.md`, `antigravity.md`, `claude-code-write.md` in this directory (nesting
  tests, event schemas).
