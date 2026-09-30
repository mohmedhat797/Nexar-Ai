# Upstream research: Delegate Skills

| Field | Value |
| --- | --- |
| Repository | https://github.com/amElnagdy/delegate-skills (author Ahmed Mohammed / amElnagdy) |
| Inspected commit | `6826b363085dcc80875372315fe7d208c4bf733f` (master, 2026-09-20, merge of PR #131) |
| Inspected on | 2026-09-30 |
| Skill version | `metadata.version: 0.5.0` on all 18 skills. Latest git tag is `v0.5.0` (2026-08-16) |
| License | MIT, Copyright (c) 2026 Ahmed Mohammed (amElnagdy) |
| Method | Read clone at the SHA above: README, CONTRIBUTING, AGENTS.md, `skills/*/SKILL.md`, `skills/claude-delegate/**`, `skills/delegate-setup/**`, `relay.mjs`. Tags and history via `git fetch --unshallow --tags` and `git ls-remote`. The GitHub MCP could not read this repo (not allowlisted), so no release-notes text was read. The installed `~/.claude/skills/claude-delegate` is byte-identical to the clone (`diff -r`). |

Important: the `0.5.0` label is not a release pin. HEAD is 99 commits past tag `v0.5.0`. The skill version string was not bumped, so the copy installed here is post-0.5.0 master. The only claude-delegate delta vs `v0.5.0` is `--autocompact` plus a stdio-drain fix (PR #126).

## 1. What it is

A Skills-CLI package (`npx skills add amElnagdy/delegate-skills`) of Markdown skills, each bundling a
single Node built-ins-only `scripts/relay.mjs`. The orchestrating agent writes a brief, runs the relay,
reads `result.json`, reviews the diff and commits. It is not an npm library, SDK, or daemon.

### Implementer skills and CLIs (17) plus one utility

| Skill | CLI binary | | Skill | CLI binary |
| --- | --- | --- | --- | --- |
| claude-delegate | `claude` | | qoder-delegate | `qodercli` |
| codex-delegate | `codex` | | vibe-delegate | `vibe` |
| agy-delegate | `agy` (Antigravity) | | cursor-delegate | `cursor-agent` |
| pi-delegate | `pi` | | aider-delegate | `aider` |
| omp-delegate | `omp` (Oh My Pi) | | copilot-delegate | `copilot` |
| opencode-delegate | `opencode` | | warp-delegate | `oz` |
| cline-delegate | `cline` | | zcode-delegate | `zcode` |
| grok-delegate | `grok` | | commandcode-delegate | `cmd` (`cmdc` on Windows) |
| kimi-delegate | `kimi` | | delegate-setup (utility) | none; writes lane config |

Every skill: `metadata.version: 0.5.0`. History: 390 commits, 2026-06-14 to 2026-09-20, tags v0.2.0 to v0.5.0.

## 2. claude-delegate behavior

- **Invocation**: `node <skill-dir>/scripts/relay.mjs --brief brief.txt --cd <repo>` (or brief on stdin).
  Internally `claude -p --output-format stream-json --verbose --tools Read,Glob,Grep,Edit,Write,Bash --strict-mcp-config --disallowedTools 'mcp__*' --disable-slash-commands --settings <profile.json> --permission-mode acceptEdits`, brief on stdin. Never `--bg`, never `--bare`.
- **Flags**: `--brief --cd --lane --out-dir --timeout --model --effort(low|medium|high|xhigh|max|ultracode) --max-turns --max-budget-usd --autocompact --resume-last --session --read-only --dangerously-skip-permissions`.
- **Permission profile**: `acceptEdits`; Bash sandbox on macOS/Linux/WSL2 with `failIfUnavailable`, `autoAllowBashIfSandboxed`, `allowUnsandboxedCommands:false`. MCP, connectors, skills, slash commands and the Agent tool are off for the child. Deny rules block `git commit`, `git push` (including `git -C x push`), `claude *`, and any command containing `claude-delegate`. The docs call these string rules a "speed bump" (aliases and scripts bypass them). CLAUDE.md, hooks, auth and merged user/managed settings still load.
- **Sandbox requirements**: SKILL.md only says "on Linux/WSL2, Claude's sandbox dependencies are installed". It does not name bubblewrap/socat. That requirement comes from Claude Code's own docs, not this repo, so it is unverified here. `bwrap` and `socat` are present in this container. Since `failIfUnavailable` is true, a missing dependency fails the run rather than running unsandboxed. The sandbox covers Bash and its children only, not Edit/Write or hooks. Native Windows has no sandbox.
- **Artifacts** (default dir `$TMPDIR/delegate-relay/<repo>-<ts>-<pid>/`, outside the repo): `brief.txt`, `events.jsonl`, `final.txt`, `stderr.txt`, `profile.json`, `result.json` (atomic write).
- **Exit codes**: usage error = 2 with no result file; `claude` missing = 127 with `status: claude_unavailable`; otherwise mirrors claude. Timeout or a terminal error result forces non-zero. A caught signal gives 128+n with `status: aborted`. A zero exit with no terminal `result` event becomes failed (exit 1).

### `result.json` (`delegate-relay.result.v1`, claude relay)

Identity and outcome:
- `schema`, `tool` (`"claude"`), `status` (`completed|failed|timeout|aborted|claude_unavailable`), `exitCode`, `signal`, `error` (when present), `stderrTail` (non-completed runs).
- `finalMessage`, `resultSubtype`, `sessionId`, `claudeVersion`.

Telemetry:
- `numTurns`, `usage` (raw object from claude's result event, passed through unmodified), `totalCostUsd`.
- `touchedFiles` (`git status --porcelain` lines of the whole final tree; `null` means git could not report, `[]` means clean). It is not attribution: pre-existing dirt is included and ignored files are invisible.
- `startedAt`, `finishedAt`.

Run configuration (echoed):
- `lane`, `laneSource`, `workdir`, `model`, `effort`, `maxTurns`, `maxBudgetUsd`, optional `autocompact`, `timeout`.
- `readOnly`, `resumed`, `resumeLast`, `permissionMode` (updated from `system/init`), `toolSurface[]`, `shellSandbox` (`strict|not-applicable|unsupported-on-native-windows`), `dangerouslySkipPermissions`.

Artifact paths: `briefPath`, `eventsPath`, `finalPath`, `stderrPath`, `settingsPath`.
- `readOnlyViolation`: present only with `--read-only`.

### Behavior details

- **Commit ownership**: the orchestrator commits. The relay never commits (a stated invariant in CONTRIBUTING and README) and the brief tells the implementer not to. Enforcement is only the deny-rule speed bump plus the review.
- **Worktrees**: the relay does not create, manage or detect worktrees (`grep worktree` finds only the out-dir note). `--cd` is just the child cwd. The docs advise sequential runs on a clean tree, and "parallel only for genuinely independent tasks in separate working trees", without providing them. A worktree per task is therefore the caller's job and is recommended for Nexar. Project-config approval is stored per worktree git-dir.
- **Resume**: `--resume-last` maps to `--continue` and `--session <id>` maps to `--resume <id>`. They are mutually exclusive, and the permission profile is re-passed on resume. Docs say to use them only for rework, with a delta brief.
- **Read-only**: `plan` mode, tools Read/Glob/Grep only. `readOnlyViolation` is `true` when git porcelain or fingerprints of already-dirty paths prove a change, `false` when coverage was complete and nothing changed, and `null` when coverage was incomplete (git missing, submodule, unreadable path). It is a tripwire, not a boundary: hooks can write, ignored paths and perfect restores are invisible, and concurrent changes are not attributable. Keep `--out-dir` outside the repo.
- **Model/effort**: `--model` (alias or full name, token-validated), `--effort`. Defaults are claude's own config and no version is pinned.
- **Timeout/budget**: `--timeout` (h/m/s, default off) kills the process tree and yields `status: timeout` (partial edits may remain). `--max-turns` and `--max-budget-usd` are passed through to claude; the relay does not interpret them; how a limit hit surfaces (presumably a non-success `resultSubtype`) is not documented or verified.
- **Review flow**: read `finalMessage` and `touchedFiles`, review test edits first, re-run the real gates, read `git diff`, `git diff --cached` and untracked files, sweep for fake success or scope creep, then the orchestrator commits. Rework is a delta brief, or a queue of sequential tasks with fresh sessions.

## 3. Fleet/lane config (`delegate-fleet.v1`)

- **Locations**: global `$XDG_CONFIG_HOME/delegate-skills/config.json` or `~/.config/delegate-skills/config.json`. Project `<git-root>/.delegate/config.json`. A project lane replaces a global lane of the same name wholesale.
- **Shape**: `{"version":"delegate-fleet.v1","lanes":{"<name>":{"implementer":"claude","effort":"high",...}}}`. `implementer` is required; other keys are dials.
- **Dials for `claude`**: `model, effort, timeout, readOnly`. Other implementers: codex (model, effort, sandbox, timeout, readOnly), agy (model, effort, timeout, readOnly), pi (provider, model, timeout, readOnly), omp (provider, model, effort, timeout, readOnly), opencode (model required as `provider/model`, variant, timeout, readOnly).
- **Approval binding**: a project lane works only if the sha256 of the config content matches `<git-dir>/delegate-skills/project-config.sha256`, which is written only by an approved `config.mjs write --scope project`. A cloned or edited project config fails closed. `--lane` needs `delegate-setup` installed beside the relay. The relay calls `lane.mjs resolve`, which fails on a missing lane, untrusted project config, or implementer mismatch. Explicit flags override lane dials. `result.json` records `lane` and `laneSource`.

## 4. Trust posture

- The relay makes no network calls of its own, reads or writes no credentials, has no telemetry and no dependencies. It spawns `claude` and `git` (plus `cmd.exe` and `taskkill` on Windows). The implementer CLI does its own auth and network use (Anthropic API), unchanged.
- The child inherits the full parent environment except `CLAUDECODE`. `CLAUDE_CODE_CHILD_SESSION` and credential variables are preserved (documented in dispatch-and-poll).
- `delegate-setup/discover.mjs` invokes installed CLIs with `--version`/model probes, which may contact their own services.
- Verification gaps (README): claude-delegate was live-verified on macOS with claude 2.1.220 (and 2.1.271 for `--autocompact` argument handling only). No Linux live run is recorded. Ubuntu CI uses a fake CLI, not a real `claude`. Native Windows is unverified. Local claude in this container is 2.1.286.

## 5. Development-time vs product-time use

### Development-time (orchestrator dispatches `claude-delegate` to a Sonnet `claude -p`)

- Use the skill as designed: brief, dispatch, review, orchestrator commits. Copy `AGENTS.md` constraints into the brief, because claude only loads `CLAUDE.md`.
- **Environment finding (verified by the orchestrator)**: in this cloud container the child `claude -p` inherits `CLAUDE_CODE_SESSION_ID`, so `result.json.sessionId` reports the parent's session id. The relay strips only `CLAUDECODE` (`childEnvironment`, relay.mjs L392). Therefore `--session <id>` and `--resume-last` must not be used here, as they could resume the orchestrator's own session. Rework is a fresh dispatch with a delta brief that restates the context. Do not store or trust the `sessionId` from this environment.
- Use `--model sonnet --effort <x> --max-turns N --max-budget-usd N --timeout 30m`, and keep `--out-dir` outside the repo. Re-run gates yourself and read untracked files. Run `--read-only` for investigations and treat `readOnlyViolation` as `true`/`null` = inspect the diff.
- Serial tasks on a clean tree, or one git worktree per parallel task (created by the orchestrator).

### Product-time (Nexar Engineering Machine using relays as a delegation layer)

- This is a different posture: a long-lived product executing relays for end users. The relays assume a human or agent orchestrator reviewing the diff. Nexar would be that orchestrator and must add its own review/approval gate before any commit.
- Session ids are meaningful only if the child does not inherit a parent session env. Nexar's runtime must scrub `CLAUDE_CODE_SESSION_ID` and related vars before calling the relay, or never resume.
- Treat the relay as an untrusted-ish subprocess with a sandbox that is partial (Bash only). For multi-tenant or untrusted briefs, use a container/VM, as upstream itself recommends.

## 6. Integration opportunities

- **Subprocess call**: yes. `node relay.mjs --brief f --cd dir --out-dir D` blocks, exits with a mapped code and writes `D/result.json` atomically. A consumer needs just `spawn`, then read JSON. Completion means process exit plus a terminal `status`. Exit 2 means no file.
- **Stable contract?** Partly. `schema`, `status`, `exitCode`, `signal`, `finalMessage`, `touchedFiles`, `sessionId`-like id exist across relays, and CONTRIBUTING makes them the merge bar. Everything else is per-relay (see mapping below). Nexar should validate per-`tool` with tolerant parsing.
- **Telemetry mapping (claude relay)**: cost = `totalCostUsd`; tokens = `usage` (claude's raw usage object, shape owned by the CLI); turns = `numTurns`; touched files = `touchedFiles` (porcelain lines, parse `XY path`, treat as whole-tree); outcome = `status` plus `resultSubtype` plus `exitCode`; duration = `finishedAt - startedAt`; model/effort = echoed request, not the resolved model.
- **Relay-to-resource map and field availability**:

| Nexar resource | Relay | Session field | Cost/tokens/turns in result.json |
| --- | --- | --- | --- |
| Claude Code | claude-delegate | `sessionId` | `totalCostUsd`, `usage`, `numTurns` |
| Codex | codex-delegate | `threadId` | none documented |
| Antigravity `agy` | agy-delegate | `conversationId`, `projectId` | none documented |
| Pi | pi-delegate | `sessionId` | `usage`, `actualProvider`, `actualModel`, `stopReason` |
| OpenCode | opencode-delegate | `sessionId` | `cost` only (USD, summed) |
| Oh My Pi (extra) | omp-delegate | `sessionId` | `usage`, `actualModel`, `stopReason` |

  Status enum differs by relay: `<tool>_unavailable`. Field names for cost and session differ (`totalCostUsd` vs `cost`, `sessionId` vs `threadId` vs `conversationId`). An adapter layer is required.
- **Lanes** (`delegate-fleet.v1`) are a ready vocabulary for Nexar routing policy, but they are a user-config concept. Nexar should keep its own routing config.
- **Read-only tripwire and `touchedFiles` semantics** are a reusable pattern for Nexar's own audit.

## 7. Integration risks

- **Schema versioning**: `delegate-relay.result.v1` has no semver discipline beyond "bump when the JSON shape breaks". No v2 has appeared in history (`git log -S` empty), but fields are added freely (lane/laneSource, autocompact, etc.). The schema is a per-relay superset, not a single typed contract, and no JSON Schema file is published.
- **Skill, not a library**: no npm package. Distribution is `npx skills add` by git ref. Pin with `@vX.Y.Z`. Main issue: the skill `metadata.version` does not track master, and the latest tag is 6 weeks and 99 commits behind HEAD. Vendor a pinned copy and record the commit SHA. Node 18+ needed (CI uses 22).
- **Cadence**: very fast and contributor-driven (about 390 commits in 3 months, many PR merges, single maintainer review, 7 tags). Expect churn, especially in agy, grok, and opencode relays.
- **Security**: partial sandbox, string deny rules, `failIfUnavailable` depends on host deps; Linux live-verification absent; inherited environment leaks (session id, credentials).
- **Coupling**: behavior depends on Claude CLI flags (`--autocompact` needs 2.1.221+, `--effort` values). The claude relay has documented fixes for orphan stdio hang (#126), so upgrade regularly.
- **License**: MIT, compatible. Keep copyright notice if vendored.
- **Semantic gaps**: `touchedFiles` is not attribution; `usage` shape is CLI-owned; relays never commit or branch, so Nexar must own git workflow.

## 8. Recommended Nexar boundary

1. Do not depend on delegate-skills at runtime for the core product. Define a Nexar-owned `DelegationResult` schema (status, exit, outcome, cost, tokens, turns, touched files, session ref, artifacts) and write thin adapters per relay.
2. If used, vendor a pinned SHA of `skills/<x>-delegate/scripts/relay.mjs` (+ `delegate-setup` only if lanes are needed) under a third-party dir with LICENSE, and invoke as a subprocess with a scrubbed env, per-task git worktree, out-dir outside the worktree, explicit `--timeout`, `--max-turns`, `--max-budget-usd`.
3. Validate `result.json` with a tolerant parser keyed on `schema` and `tool`; fail closed on unknown `status`; map `null` `touchedFiles` and `null` `readOnlyViolation` to "unknown".
4. Nexar owns review gates and commits; never expose `--dangerously-skip-permissions` to end users by default.
5. Contract-test adapters against fixtures captured from a pinned version; run the upstream `test/relay-smoke.mjs` when bumping.
6. Development-time use stays separate: installed skill, fresh-dispatch rework only (see section 5).

## 9. Open questions

- Does Nexar want relays for Codex, agy, Pi, OpenCode, or only claude? Cost/tokens are missing for codex and agy, so would Nexar parse `events.jsonl` itself?
- Is the sandbox dependency list (bubblewrap/socat) confirmed by Claude Code docs for the target deployment image? Not stated in this repo.
- Will upstream publish a JSON Schema or a v2 policy? Worth an issue or contact with the maintainer.
- Which Claude Code versions will Nexar support (`--autocompact` 2.1.221+; verified only on 2.1.220/2.1.271)?
- Which env vars must be scrubbed beyond `CLAUDE_CODE_SESSION_ID` to give the child a clean session identity?
- Is 99 commits past the last tag acceptable for a pin, or should Nexar pin master SHA and track it?

## 10. Sources (permalinks at `6826b363085dcc80875372315fe7d208c4bf733f`)

Base: `https://github.com/amElnagdy/delegate-skills/blob/6826b363085dcc80875372315fe7d208c4bf733f/`
- `README.md` (skill table, trust section, verification status)
- `CONTRIBUTING.md` (invariants, result.v1, releases)
- `AGENTS.md` (versioning and vocabulary)
- `LICENSE`
- `skills.sh.json`
- `skills/claude-delegate/SKILL.md` (permission profiles L117)
- `skills/claude-delegate/references/dispatch-and-poll.md` (result.json L150, permission reach L78)
- `skills/claude-delegate/references/review-and-land.md`
- `skills/claude-delegate/references/multi-task-queues.md`
- `skills/claude-delegate/scripts/relay.mjs` (`SCHEMA` L127, `applyFleetLane` L198, `childEnvironment` L392, `profileSettings` L510, `buildArgv` L582, `handleEvent` L627, `readOnlyVerdict` L892, `gitTouchedFiles` L904)
- `skills/delegate-setup/references/schema.md` (fleet schema)
- `skills/delegate-setup/scripts/config.mjs` (trust hash, L88-95 and L342-355)
- `skills/delegate-setup/scripts/lane.mjs`
- `skills/{codex,agy,pi,omp,opencode}-delegate/references/dispatch-and-poll.md` (per-relay result fields)
- `.github/workflows/relays.yml`
- Tags: `git ls-remote --tags origin` (v0.2.0 to v0.5.0; v0.5.0 is commit `3b0900706e4fba88c13f590ea8dd43014c6a3e55`, 2026-08-16).
