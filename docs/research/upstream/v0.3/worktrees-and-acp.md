# Per-task git isolation and ACP permission mapping

| Field | Value |
| --- | --- |
| Inspected | 2026-10-01 |
| Question A | How should each agent task get a git working copy that the sandbox can write but that cannot reach the user's repo, remotes or credentials, and how does Nexar later get the result out safely? |
| Question B | What exactly does DeepSeek Harness (DSH) speak over ACP, what does a permission request look like, and how should it map to `@nexar/approvals`? |
| Sources | git docs (git-worktree, git-clone, git-config, git-apply behaviour tested), `deepseek-ai/deepseek-harness` @`639ed015` (`packages/acp/acp`, `packages/interaction/user-approval`, `packages/sandbox`), `agentclientprotocol/agent-client-protocol` @`7394ce2e` (`docs/protocol/v1`, `schema/v1`, `schema/v2`), npm `@agentclientprotocol/sdk`, `dsh` 0.2.0-rc.2 binary run locally |
| Method | Everything in section 1 was executed locally (git 2.43.0, bwrap profile from `bubblewrap-sandbox.md`, unprivileged user); scripts and output in `lab/git-lab*.sh`. ACP facts come from source/tests/schema plus a live handshake. |

## 1. Git isolation

### 1.1 Evidence from experiments
| # | Experiment | Result |
| --- | --- | --- |
| E1a | `git worktree add -b nexar/task1 ../wt1` from the user's repo; sandbox mounts **only** `wt1` | `wt1/.git` is a file: `gitdir: /abs/userrepo/.git/worktrees/wt1`. Inside: `fatal: not a git repository: .../.git/worktrees/wt1`. git-worktree docs confirm: linked worktree has "a private sub-directory in `$GIT_DIR/worktrees`", refs under `refs/` are shared. |
| E1b | same, plus `--bind userrepo/.git userrepo/.git` (same absolute path) so git works | Agent can `git branch -a` (sees every branch), `git show secret-branch:secret.env` -> `AKIA-FAKE-SECRET`, read `remote.origin.url`, list hooks, and `git update-ref refs/heads/main ...` **succeeds** (rewrite the user's `main`). Unacceptable. |
| E3a | `git clone --local` (default for a path) | object files have link count **2**: hardlinked into the user's repo. An agent that `chmod`s and edits an object file corrupts the user's repo (same inode). |
| E3b | `--no-hardlinks`, `--single-branch --branch main --no-tags` | link count 1, but **all objects were copied**: the blob of the secret on the other branch is present (`git cat-file -e` succeeds). `--single-branch` filters refs, not the local object copy. |
| E3c | `--shared` | `.git/objects/info/alternates` -> `/abs/userrepo/.git/objects`; clone owns 1 object file. Sandbox would need the user's whole object store (ro) -> full history incl. secrets. git-clone docs: "possibly dangerous ... objects may become unreferenced ... removed by normal Git operations" (gc in the source). |
| E3d | `git clone --no-local --single-branch --branch main --no-tags /path/userrepo c` (also `file://...`) | uses upload-pack: **3 object files, secret blob absent**, only `main` + `origin/main`. With `--depth 1`: one commit, `.git/shallow`. git-clone docs: `--depth` is ignored for plain local paths; `--no-local` "using the regular Git transport". |
| E3e | hooks: user's `.git/hooks/pre-commit` | not copied into any clone (only templates). `.git/config` of the clone has `remote.origin.url = /abs/userrepo` (must be removed) and `branch.main.remote`. |
| E4a | agent plants `core.fsmonitor = sh -c "id > /tmp/..."` in the clone's `.git/config`; the **host** then runs `git status` in that directory | **Host executed the attacker command** (`uid=1001(...)` written to the host file). Same class: `core.pager`, `diff.external`, `filter.*.clean/smudge`, textconv, `core.sshCommand`, hooks, aliases. Conclusion: never run host-side git with an agent-writable `.git` as GIT_DIR. `-c core.fsmonitor=` fixes one key only. |
| E4b | in sandbox: `--ro-bind .git/config` and `.git/hooks`/`.git/info` only | `git config` write -> "Device or resource busy"; hooks write -> EROFS. **But `mv /work/.git /work/.git.bak` succeeded** (mounts followed the renamed directory) and the agent could then create a fresh `.git` with its own config (host listing showed `.git.bak`). |
| E4c | same, **plus `--bind clone/.git /work/.git`** (make `.git` its own mount point) | `mv .git`, `rm -rf .git`, `mv .git/config`, config/hook/info writes all fail (EBUSY/EROFS); `git add/commit/log` still work; host view intact. `.git/config.worktree` stays writable but is read only when `extensions.worktreeConfig=true` (docs) which Nexar does not set. |
| E5a | harvest: throwaway sandbox (`--unshare-all`, no net) mounts the clone **read-only**, index and new objects on tmpfs (`GIT_INDEX_FILE=/tmp/idx`, `GIT_OBJECT_DIRECTORY=/tmp/objs`, `GIT_ALTERNATE_OBJECT_DIRECTORIES=/work/.git/objects`), runs `git add -A; git diff --cached --binary --full-index $BASE > /out/task.patch` | Planted fsmonitor **ran, but inside the harvest sandbox** (error `cannot create /tmp/nxlab/PWNED2: Directory nonexistent` proves it executed there and found no host path); host file never created. Patch includes untracked files with modes `100644`, `100755` and an **embedded repo as gitlink `160000`**. |
| E5b | host applies to a Nexar-owned detached worktree: `git apply --check --index` then `--index`, commit with `-c core.hooksPath=/dev/null --no-verify` | works. Hostile patches: `.git/hooks/post-commit`, `../escape.txt`, `sub/../../escape2.txt`, `.git/config`, `sub/.git/config` -> `error: invalid path` (rc 128). **`.gitmodules` was accepted** (rc 0): git's own checks are not a policy. |

### 1.2 Options compared
| Option | Sandbox sees user's `.git`? | Other-branch secrets reachable? | Corrupt/modify user's repo? | Verdict |
| --- | --- | --- | --- | --- |
| `git worktree add` from user repo | Yes (must mount `.git`, rw) | Yes | Yes (E1b, refs shared) | Reject |
| Worktree from a Nexar bare mirror | Mirror only | Mirror history (a copy) | Cross-task interference via shared refs/objects | Reject for v0.3 |
| `clone --local` (hardlinks) | No | Yes (all objects copied) | **Yes** via shared inodes | Reject |
| `clone --shared` / `--reference` | Alternates path must be mounted | Yes | gc/prune hazard; ro mount stops writes | Reject |
| **`clone --no-local` (upload-pack), single branch, no tags, optional `--depth`** | **No** | **No** (E3d) | No (separate inodes) | **Recommended** |
| Plain `git archive`/`checkout-index` export, no `.git` | No | No | No | Fallback for huge repos or read-only tasks (agents lose `git log/blame`) |

### 1.3 Recommendation (one approach)
**Per-task private clone, created by Nexar outside the sandbox from the user's repo at an explicit base commit, harvested by a second, no-network read-only sandbox, applied by Nexar as a patch.**
1. Create: `git clone --no-local --single-branch --branch <base> --no-tags [--depth N] <repo> <worktree>`; on ext4 (see `wsl2-execution-plane.md` 1.4). Pin `BASE=$(git rev-parse HEAD)`. Then `git remote remove origin`; `git config core.hooksPath /dev/null`; set `user.name/email` to a Nexar identity inside the clone only; no credential helper; `.git` mode 0700. Submodules: unsupported in v0.3 (docs: "support for submodules is incomplete"; gitlinks are rejected at harvest).
2. Run: sandbox mounts the clone at `/work`; `.git` is bound over itself and `config`, `hooks`, `info` are bound read-only (E4c). Agent may commit locally (harmless, private).
3. No-push guarantees, layered: no remote in config; no credentials/`SSH_AUTH_SOCK`/`GIT_ASKPASS` in env (`--clearenv`); sandbox network is only the allowlist proxy, which denies git hosts (verified: `git push` -> `CONNECT ... 403`); `file://` remotes point at paths that do not exist in the sandbox.
4. Harvest: new bwrap, clone mounted read-only, git run **inside** it (E5a), output only `task.patch` + a JSON manifest (`git diff --cached --raw`) written to a Nexar-owned out dir. The host never executes git against the agent's directory.
5. Validate on host before touching any repo (Nexar code, not git): size cap; reject modes `160000` (gitlink) and `120000` unless link target resolves inside the tree via `resolveContainedPath`; reject paths under `.git/`, any `.git*` name at any depth (`.gitmodules`, `.gitattributes`, `.gitignore` changes need approval), `.husky/`, `.github/workflows/`, and other agent-config/CI/hook locations; NUL/odd names; reject exec-bit flips; then `git apply --check --index`.
6. Apply on a Nexar-owned branch worktree (`nexar/<task>`) created from `BASE` in the user's repo with hooks disabled (`-c core.hooksPath=/dev/null`, `--no-verify`, `-c commit.gpgsign=false`), commit authored by Nexar with trailer metadata (task id, patch sha256). Pushing/PRs remain outward actions behind `@nexar/approvals` (ADR-016): v0.3 only creates the local branch/draft.
Reasons: smallest blast radius (E1b, E3a, E4a); no shared inodes or refs; no secret objects (E3d); only one data format (a patch) crosses the boundary, so every crossing is validated; it also works identically on WSL ext4. Costs: full copy of the reachable history per task (mitigate with `--depth`, or a reflink/`cp --reflink` of a Nexar-owned cache clone; the cache clone is itself created with `--no-local` and never exposed).

## 2. DeepSeek Harness ACP server (`@deepseek-ai/dsh-acp` 0.2.0-rc.2, SDK `@agentclientprotocol/sdk` pinned 1.4.0)

### 2.1 Methods actually implemented (`src/index.ts`, README "Protocol contract")
| Direction | Method | Behaviour |
| --- | --- | --- |
| client -> agent | `initialize` | Result seen live: `protocolVersion 1`, `agentInfo {deepseek-harness-acp, 0.0.1}`, `agentCapabilities {mcpCapabilities {http:true}, promptCapabilities {image:false,audio:false,embeddedContext:false}, sessionCapabilities {close,list,resume}}`, `authMethods []`. Image prompts only if the route/attachment store supports it. |
| | `authenticate` | immediate success (no auth). |
| | `session/new` | `{cwd (absolute), mcpServers[]}` -> `{sessionId (uuid), configOptions[model, reasoning_effort]}`; stdio MCP entries authorise their commands/env, HTTP entries their URLs. |
| | `session/list`, `session/resume`, `session/close` | persisted root sessions; resume verifies canonical cwd; close = quiescent cancel + flush. |
| | `session/set_config_option` | only `model` and `reasoning_effort`. |
| | `session/prompt` | text, `resource_link`, supported images; one in-flight prompt per session; stop reasons `end_turn`/`max_tokens`/`cancelled` (`codec.ts`; hook-aborted or errored turns report `end_turn`). |
| | `session/cancel` (notification) and `$/cancel_request` | cancels the active prompt, or autonomous work if none; unknown session id = no-op. |
| agent -> client | `session/update` notifications | `agent_message_chunk`, `agent_thought_chunk`, `tool_call`, `tool_call_update`, `usage_update`, config updates; serialised per session. |
| agent -> client | `session/request_permission` | see below. |
Not supported: `session/load`, delete, fork, additional directories, SSE/ACP-transport MCP, modes, commands, plans, terminals, client `fs/*`, elicitation. The server is "automation-only": the client is a trusted controller.

### 2.2 `session/request_permission` as DSH sends it (`src/index.ts` L152-172, `tests/approval.spec.ts`)
```json
{"method":"session/request_permission","params":{
  "sessionId":"<uuid>",
  "toolCall":{"toolCallId":"call-9"},
  "options":[{"optionId":"allow-once","name":"Allow once","kind":"allow_once"},
             {"optionId":"reject-once","name":"Reject","kind":"reject_once"}]}}
```
Response the client must send: `{"outcome":{"outcome":"selected","optionId":"allow-once"}}` or `{"outcome":{"outcome":"cancelled"}}`.
- **Only the `toolCallId` is in the request.** Tool name and arguments arrive in the *preceding* `tool_call` update, which DSH guarantees to flush first (`drainUpdates()`; test asserts the last update is `tool_call` with the same id): `{"sessionUpdate":"tool_call","toolCallId":"call-9","title":"<tool name>","kind":"other","status":"in_progress","rawInput":<parsed JSON arguments, or the raw string if invalid>}` (`updates.ts`). So Nexar must cache `toolCallId -> {title, kind, rawInput}` per session.
- DSH-side mapping of the answer: `cancelled` -> tool outcome `cancelled`; selected `allow-once` -> `allowed-once`; **any other optionId -> `rejected`**; a client error/disconnect -> `unavailable` (fail closed); no answerer -> `unavailable`. Policy `ask` (default) vs `never` (rejects without prompting). Requests need an open turn; without a call id or for a foreign agent the bridge delegates (-> `unavailable`).
- When it fires: tools-pipeline `ask` decisions and the sandboxed bash tool's **escalation** (retry with `sandbox_permissions` + `justification` after a read-only/workspace-write denial; escalation e2e test header). DSH confines subprocesses itself (`bwrap --ro-bind / / ...` then Landlock) — inside our outer sandbox this nests (tested); an approved "escalation" can therefore only widen what the **outer** profile already allows.

### 2.3 ACP spec facts (repo @`7394ce2e`)
- v1 (stable; `protocolVersion: 1`): `RequestPermissionRequest` required `sessionId`, `toolCall` (`ToolCallUpdate`, required only `toolCallId`; optional `title`, `kind` in {read, edit, delete, move, search, execute, think, fetch, switch_mode, other}, `status` in {pending, in_progress, completed, failed}, `content`, `locations`, `rawInput`, `rawOutput`), `options[]` (`optionId`, `name`, `kind` in {allow_once, allow_always, reject_once, reject_always}). Outcome: `cancelled` | `selected{optionId}`. Spec: "Clients MAY automatically allow or reject ... according to the user settings"; on `session/cancel` the client "MUST respond to all pending `session/request_permission` requests with the `cancelled` outcome" and the agent "MUST respond to the original `session/prompt` with the `cancelled` stop reason", may still send updates before that; `$/cancel_request` -> `-32800`.
- v2 is **alpha** (`schema-v2.0.0-alpha.7`, 2026-09-30) and changes the shape: `RequestPermissionRequest {sessionId, title, description?, subject, options}` with `subject` = `{type:"tool_call", toolCall}` | `{type:"command", command, cwd, toolCallId?, terminalId?}` | unknown/`_`-prefixed (preserve raw payload, "decline it according to policy"). v2 drops `session/load`, `fs/*`, `terminal/*` from the method tables. Adapter must switch on the negotiated `protocolVersion`.
- npm `@agentclientprotocol/sdk`: latest **1.5.1** (modified 2026-09-28); DSH pins 1.4.0. Pin the same exact version in the adapter (ADR-008) and test against DSH's fake.

### 2.4 Live handshake (no credentials)
`dsh --profile acp` with env `{PATH, HOME, DSH_HOME}` only (no API keys), cwd an empty dir, JSON-RPC over ndjson on stdio (`dsh-acp-probe/probe.mjs`): `initialize` OK; `session/new` OK (sessionId + configOptions listing `deepseek-official` models `deepseek-v4-flash` (current), `deepseek-flash`, `deepseek-v4-pro`, and `reasoning_effort` off/low/high/max); `session/list` -> `{"sessions":[]}` (the active in-process session is filtered out: source `listSessions` skips ids in `sessions`); `session/close` -> `{}`; **7.6 s on the first run** (materialises profile into `DSH_HOME`: ~68 KB, writes `.anonymous-user-id`, `sessions/<cwd-slug>/<uuid>`), 2.6 s on a later run with a fresh HOME (file cache warm). stdout carried only JSON-RPC, stderr empty. No prompt was sent, so model/credential paths were not exercised.
**Also ran inside the bwrap profile** (`probe-sbx.mjs`: `--unshare-net`, `/dsh` ro-bind of the 518 MB `node_modules`, HOME on tmpfs): identical results, 2.6 s, only stderr line was Node's `[UNDICI-EHPA] EnvHttpProxyAgent is experimental` warning from `NODE_USE_ENV_PROXY=1`. So the ACP server needs no network for handshake/session setup.

### 2.5 Mapping ACP permission -> `@nexar/approvals` (recommendation)
1. Nexar is the ACP **client**; per task one `session`, bound to the task id and the sandbox run id. Cache `tool_call`/`tool_call_update` per `toolCallId` (latest `title`, `kind`, `rawInput`, `locations`).
2. On `session/request_permission` build `ApprovalRequest{ taskId, adapter, acpSessionId, toolCallId, tool, args, kind, ttl }` where `tool` is **adapter-normalised** (DSH: `title` is the tool name; other agents put prose in `title`, so normalise per adapter or use v2 `subject`), `args` = `rawInput`. **Fingerprint = SHA-256 over canonical JSON `{adapter, tool, args, cwd-relative locations}`** (sorted keys, UTF-8, no whitespace); also record `sandboxRunId` and base commit. Single-use; bound to this `toolCallId`; TTL (suggest 10 min) shorter than the task deadline. Log fingerprint + tool name only, never `rawInput` (CLAUDE.md: no prompts/content at info+).
3. Missing cache entry (no preceding `tool_call`) or unparsable `rawInput` -> do not guess: answer reject.
4. Block while the approval is pending; keep the ACP request open (the agent turn is suspended), keep the plane deadline running.
5. Answer by option **kind**, not by hard-coded id: approved -> the option with `kind: allow_once`; denied -> `reject_once`. Never select `allow_always`/`reject_always` even if offered (no durable grants, mirrors DSH: "never infers a durable grant"). Unknown/missing option -> reject path below.
6. **Denied / expired / approvals store unavailable / fingerprint mismatch / unknown option kinds -> `selected` with the `reject_once` option** (DSH turns it into `rejected`, the model sees a rejected tool result and may continue). If no `reject_once` option exists, answer `{"outcome":"cancelled"}`. Reserve `cancelled` for the case the spec mandates: Nexar itself sent `session/cancel` (user abort, deadline, shutdown) -> respond `cancelled` to every pending request, then expect `stopReason: cancelled`. An expiry policy of "abort task" = send `session/cancel` first, then `cancelled`.
7. Auto-decisions (e.g. read-only tools) are policy, not approvals: allowed only for adapter-specific allowlisted tool names with args confined by `resolveContainedPath`; everything else asks. Sandbox "escalation" requests (network, writes outside `/work`) are rejected by default because the outer profile cannot grant them.
8. `approvals approve|deny` CLI/MCP flow is unchanged; add `origin: acp-inside-sandbox` so ADR-016's "outward action" gate is not conflated with in-sandbox tool permissions (needs an ADR amendment, see open questions).

## 3. Implications for Nexar v0.3
- New adapters: `integrations/git-workspace` (clone/harvest/apply, no upstream types leaked), `integrations/bwrap`, `integrations/dsh-acp` (ACP client over stdio, version-switched on `protocolVersion`), with contract tests against a fake ACP agent (DSH's `tests/harness.ts` is a model) and the lab scripts as integration tests (skipIf no bwrap).
- Domain: `WorkspaceLease` (clone path, base sha, state), `HarvestResult` (patch sha256, manifest), policy for sensitive paths.
- Telemetry: refs and hashes only (patch sha, base sha, fingerprint), never content/paths (ADR-013 style).

## 4. Open questions
- Reuse `@nexar/approvals` for in-sandbox tool permissions or add a separate "sandbox permission" kind? Needs an ADR amendment; ADR-016 currently speaks about outward actions.
- Large monorepos: depth/partial clone (`--filter=blob:none` needs a promisor remote, which conflicts with removing `origin`) vs reflink cache. Not tested.
- Does every target agent CLI (Claude, Codex, Gemini) behave with `.git` bind-mounted and `core.hooksPath=/dev/null`, and with commits made under a Nexar identity?
- Windows line endings: clone lives on ext4 and `core.autocrlf` stays unset in the clone; patches generated inside WSL are LF. Windows-side previews must not write back.
- DSH `provider/model` need credentials at prompt time; how Nexar passes one key per run without the key landing in the sandbox env beyond that run (`--setenv` in argv is visible in `/proc` of the host; prefer `--ro-bind-data` fd) not tested.
- Whether DSH sends `session/request_permission` for `workspace-write` first-use writes inside `/work` (needs a keyed run).

## 5. Sources
- https://git-scm.com/docs/git-worktree , /git-clone , /git-config (also verified by execution, `lab/git-lab*.sh`)
- https://github.com/deepseek-ai/deepseek-harness @639ed015: `packages/acp/acp/{README.md,src/index.ts,src/updates.ts,src/codec.ts,tests/approval.spec.ts}`, `packages/interaction/user-approval/README.md`, `packages/sandbox/README.md`, `packages/sandbox/sandbox-local/src/profiles.ts`, `apps/cli/tests/profiles/acp/tests/escalation.e2e.ts`
- https://github.com/agentclientprotocol/agent-client-protocol @7394ce2e: `docs/protocol/v1/{tool-calls,prompt-turn,cancellation}.mdx`, `schema/v1/schema.json`, `schema/v2/schema.json`, `schema/v2/CHANGELOG.md`; https://agentclientprotocol.com/protocol/tool-calls
- `npm view @agentclientprotocol/sdk` (1.5.1, 2026-09-28)
- `dsh` 0.2.0-rc.2 run locally (`dsh-acp-probe/`)
