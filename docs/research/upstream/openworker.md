# Upstream research: OpenWorker

Research note for Nexar's Personal Productivity & Operations Engine slot. Evidence is from a
shallow clone (depth 200 of 556 commits) of `main`. Claims I did not confirm in source are
marked UNVERIFIED. All `path:line` refs are at the inspected SHA (permalinks in Sources).

| Field | Value |
|---|---|
| Canonical repo | https://github.com/andrewyng/openworker |
| Inspected commit | `e8923509a9e91d2825313f8418f6129a00b1603e` (2026-09-30, "Merge pull request #706 from andrewyng/release-0.3.0") |
| Inspected on | 2026-09-30 |
| Version | `0.3.0` (`pyproject.toml`), tag `v0.3.0` dated 2026-09-30 |
| License | MIT (`LICENSE`, "Copyright (c) 2024 Andrew Ng") |
| Status | "Open beta" per `README.md` |
| First commit in this repo | 2026-07-21 ("OpenWorker: initial import"); history was carved out of the aisuite repo |
| Tags | 7 total: v0.1.6 (07-23), v0.1.7 (07-30), v0.2.0 (08-24), v0.2.1 (08-25), v0.3.0 (09-30) plus two older |

## 1. Canonical repo determination

- `andrewyng/openworker` is the parent repo, not a fork (WebFetch of the GitHub page: "Parent
  repository (not a fork)", 18.4k stars, 2.6k forks, default branch `main`).
- Evidence that it is the origin of the product: `README.md` links openworker.com as the
  download site and `pyproject.toml` `[project.urls]` sets `Source = https://github.com/andrewyng/openworker`.
  The auto-updater's GitHub fallback endpoint points at this repo (commit `4241f4a`, "updater: point the
  GitHub fallback endpoint at this repo"). The README credits aisuite (also `andrewyng`) as the
  engine library.
- Same-named repos such as `jsying1570/openworker` and `aashish254/openworker` are among the 2.6k
  forks/copies; I did not inspect them and treat them as non-canonical.
- Cadence: 163 commits since 2026-08-31 (30-day window to 2026-09-30), almost all by two maintainers.

## 2. Architecture and runtime

- **Backend: Python 3.10+**, package `coworker/` (FastAPI + uvicorn; `pyproject.toml` dependencies).
  Engine is built on `aisuite>=0.2.0` for tool metadata/toolkits. Key modules: `coworker/engine.py`
  (TurnEngine), `coworker/agent.py` (`build_engine`, line 219), `coworker/server/app.py` (3,423
  lines, routes), `coworker/server/manager.py` (8,233 lines, `SessionManager`).
- **Frontend: React 18 + Vite + Tailwind + TypeScript** in `surfaces/gui/` (`package.json`), i18next,
  `xlsx`, `pdfjs-dist`.
- **Desktop runtime: Tauri 2 (Rust)**, not Electron (`surfaces/gui/src-tauri/`). The Tauri shell starts
  the Python server as a managed sidecar on port 8765 (or a free port) and injects the address and a
  per-launch auth token (`surfaces/gui/src-tauri/src/lib.rs:1-14`; `tauri.conf.json` `"binaries/sidecar"`).
  The sidecar is packaged via PyInstaller (`packaging/openworker-server.spec`).
- **Browser/web interface: yes, in dev.** `npm run dev` serves the same SPA on a Vite port against a
  separately started `openworker-server` (README "Run from source"). No documented hosted/web
  product; the SPA also has a "cloud" mode (`GET /v1/capabilities` returns `{"mode": "desktop"}`).
- Other: `stt/` is a Rust speech-to-text sidecar; `coworker/tui/` is a Textual terminal UI (unlisted,
  `coworker/cli.py` docstring).
- Entry points (`pyproject.toml [project.scripts]`): `openworker` (CLI: `join`, `up`, `machine`,
  `version`, unlisted `tui`), `openworker-server`, `openworker-connectors`, `openworker-acceptor`, `ocw`.

## 3. Server/API boundaries (most important)

### 3.1 What exists

OpenWorker runs a local FastAPI server, default `127.0.0.1:8765` (`docs/config.example.toml`,
`coworker/server/run.py:main`). It is the control plane for every surface
(`coworker/server/app.py:1-7` docstring). There is no separate SDK, no OpenAPI doc in `docs/`, and
the FastAPI app declares `version="0.0.0"` (`app.py:~192`). The `/v1` prefix is not backed by a
published stability promise (UNVERIFIED: I found no API-stability statement in `README.md`/`docs/`).

Auth model (`app.py:193-250`, `run.py:128-136`):
- HTTP: header `X-OpenWorker-Token: <token>` on everything except `/v1/health`, OAuth callbacks
  and `/v1/board/*` (which uses its own bearer tokens).
- WebSocket: the token is sent as the `Sec-WebSocket-Protocol` value; the server accepts subprotocol
  `openworker`. Browser `Origin` is pinned to localhost/tauri origins; requests without an Origin
  header (server-to-server) pass (`app.py:~24-36`).
- Standalone `openworker-server` writes the token to `<state-dir>/sidecar-<port>.token`
  (mode 0600, `run.py:128-136`; state dir `~/.config/coworker` on Linux/macOS, `%APPDATA%\coworker`
  on Windows, `coworker/secrets.py:state_dir`). The **desktop app keeps the token in memory only**
  (`run.py:130` comment: "Tauri supplied an in-memory token; never persist it"). So an external
  process cannot call the desktop app's embedded sidecar; it must run its own `openworker-server`.
- A second engine on the same state dir only warns (`run.py:_warn_if_state_shared`,
  `coworker/statelock.py`; `COWORKER_STATE_LOCK=strict` makes it refuse).

### 3.2 Three ways an external process can submit a task

**A. Interactive session over WebSocket (closest to "run this task now").**
`WS /ws/session/{session_id}?agent=<persona>&workspace=<path>` (`app.py:2544`). Session IDs are
client-chosen; the session and engine are built on connect. Client frames (`app.py:3058-3250`):
`user_message` (`text`, optional `attachments[]` of `kind` image/pdf/text, `model`, `skill`),
`approval`, `question_response`, `plan_response`, `directory_response`, `connector_response`,
`tool_response`, `set_mode`, `set_model`, `interrupt`, `retry`. Server sends `ready`, then the
engine event stream (`coworker/events.py` `EventType`: `turn_start`, `assistant_delta`,
`assistant_message`, `tool_proposed`, `permission_required`, `tool_started`, `tool_finished`,
`iteration_end`, `turn_end`, `error`, ...) and `turn_done`. Limits: 16 MiB frame, 200k chars text,
30 messages per 10 s (`app.py:~40-47`). One running turn per session; a second `user_message`
returns `input_rejected`. Results are read from the stream and later via
`GET /v1/sessions/{id}/messages` (`app.py:758`) and `GET /v1/sessions/{id}/artifacts[/read]`
(`app.py:792-796`). Approvals arrive as `permission_required` and must be answered over the same
socket or via `POST /v1/inbox/{item_id}/resolve` (`app.py:330`).
Caveat: there is no `POST /v1/sessions` create-and-run endpoint; headless submission needs a
WebSocket client.

**B. One-shot automation (REST only, headless).** `POST /v1/automations` with
`{title, instructions, fire_at | cron, timezone?, permissions?[]}` (`manager.py:6974 create_automation`,
`app.py:2515`) creates a task with its own scratch workspace. The scheduler ticks every 30 s and
runs due tasks unattended (`automation/scheduler.py` `tick_seconds=30.0`; started in
`manager.py:5278`). Poll `GET /v1/automations/{task_id}` (`manager.py:6965`), which returns `runs[]`
with `status` (running|ok|error|skipped), `result_text`, `artifacts[]` (files newer than run
start), `error`, `session_id` (`automation/models.py:221 TaskRun`). `POST /v1/automations/{id}/run`
only "prepares a live manual run the GUI opens and drives" (`app.py:2535`), so it is not a headless
trigger. Latency floor is about 30 s; semantics are "scheduled task", not "job queue" (abuse risk:
task records accumulate and must be deleted via `DELETE /v1/automations/{id}`).

**C. Team board as an open surface (designed for external harnesses).** `/v1/board/*` REST with
per-actor bearer tokens `owb_...` (hash-stored, `coworker/teams/tokens.py`; role `worker`/`lead`),
plus CLI `ocw board ...` and a stdio MCP server `ocw board mcp --url ... --token ... --space ...`
(`coworker/teams/cli.py` docstring, `coworker/teams/mcp_server.py` tools `board_list`, `board_show`,
`board_claim`, `board_move`, `journal_append`, ...). Endpoints: `GET /v1/board/items|item|comments`,
`POST /v1/board/items` (create work item), `/items/transition|comment|assign|claim|attach`,
`GET /v1/board/pending`, `POST /v1/board/consume` (`app.py:895-1130`). This is the intended
"external agent joins OpenWorker's team" seam; the direction is external agents doing work FOR
OpenWorker's board, not OpenWorker being a job-submission API. Whether a board item filed by an
external client auto-wakes an in-app worker depends on the persona `team:` trait and lead
subscription (`manager.kick_team_tick()` at `app.py:~950`). UNVERIFIED end to end.

### 3.3 Other relevant endpoints
`GET /v1/health`, `GET /v1/agents`, `GET /v1/personas`, `GET /v1/sessions`, `GET /v1/inbox`,
`POST /v1/inbox/{id}/resolve`, `GET /v1/audit`, `GET/POST /v1/providers`, `GET/POST/PATCH/DELETE /v1/mcp`,
`GET /v1/connectors`, `GET/POST /v1/memory`, `POST /v1/workspaces/open`, `GET /ws/events` (app-wide
push such as `automation_run_started`). `POST /v1/chat/completions` (`app.py:1237`) is an
OpenAI-format proxy to the configured model provider (`manager.provider_complete`); it does NOT run
the agent loop, so it is not a task-submission endpoint.
A dev-only `POST /v1/_debug/inject_inbound` exists only if `COWORKER_DEBUG_INJECT=1` (`app.py:2485`).
Inbound messaging (Slack `@OpenWorker` mentions, Telegram) also starts sessions via the gateway
(`coworker/connectors/gateway.py`), an out-of-band trigger path.

## 4. Tools, MCP, connectors

- **Tools**: built-ins from aisuite toolkits plus `coworker/tools/`: `read_file`, `write_file`,
  `replace_in_file`, `apply_patch`, `apply_unified_diff`, `run_shell`, `shell_task_output/kill`,
  `grep`, `git_log`, `todo_write`, `ask_user`, `web_fetch`, `web_search`, subagents, plan mode, and
  scheduling tools `create/list/update/delete_scheduled_task` (`coworker/tools/*.py`,
  `coworker/automation/tools.py`). Writes, sends and shell are approval-gated by
  `coworker/permissions.py` (modes discuss/plan/interactive/auto/bypass-approvals/auto-approve).
- **MCP as client: yes.** stdio and streamable-HTTP/SSE, standard `mcpServers` JSON in
  `~/.config/coworker/mcp.json` (global) and `<ws>/.coworker/mcp.json` (workspace, only after trust),
  `${VAR}` resolution, per-server `include_tools`/`exclude_tools`, `requires_approval` default true,
  OAuth 2.1 + PKCE with dynamic client registration (`coworker/mcp/config.py:MCPServerDef`,
  `coworker/mcp/client.py`, `mcp/oauth.py`). Managed at runtime via `/v1/mcp` REST (`app.py:1246-1340`).
  Dependency `mcp>=1.28.1,<2`.
  Gap: MCP tools are prepared in the WebSocket session path (`ws_session` calls
  `manager.prepare_mcp_tools`, `app.py:~2880`); `_build_task_engine` (`manager.py:6026`) passes no
  MCP tools, so scheduled automations appear not to get MCP tools. UNVERIFIED by execution.
- **MCP as server: not for the agent.** The only `FastMCP` server is the team-board one
  (`coworker/teams/mcp_server.py`). OpenWorker's agent/runtime is not exposed as an MCP server.
- **Connectors** (`coworker/connectors/descriptors.py`): 25+ descriptors including slack, telegram,
  discord, whatsapp, email (IMAP/SMTP), gmail, google_calendar, google_drive, outlook, github,
  gitlab, jira, confluence, linear, notion, asana, hubspot, salesforce, dropbox, box, stripe,
  docusign, datadog, pagerduty, apollo, browser. Each has a descriptor with fields, OAuth or key
  auth, per-tool allow rules. Gmail and Google Calendar managed OAuth is flagged
  `managed_paused=True` ("Google OAuth verification (CASA) pending", `descriptors.py:~550,~575`),
  so one-click Google sign-in is off; users paste tokens. Managed OAuth brokering otherwise depends
  on an OpenWorker-operated cloud service (README "Privacy").
- No meeting/transcript connector found (`grep -i meeting` hits are unrelated to a recorder/notes
  integration). Meetings would need an MCP server or a Nexar-side source.

## 5. Files, workspace, automations, artifacts

- **Workspace model**: each session has a primary root (per-conversation scratch dir or a chosen
  project folder) plus extra read-only/read-write roots (`coworker/roots.py` `RootDir`).
  `POST /v1/workspaces/open|trust|temp`, `GET/POST/DELETE /v1/sessions/{id}/roots`.
  Repository-provided `.coworker/config.toml` command allowances and workspace MCP take effect only
  after the user trusts that workspace path (`coworker/workspace_trust.py`).
- **Automations**: `ScheduledTask` (cron or once, timezone, `always_allowed_tools` standing
  target-bound write grants, `notify_target`, `max_runs`; `automation/models.py:113-140`), SQLite
  `automation.db`. Each run is its own persisted, continuable session `__run__<run_id>`
  (`manager.py:6846 _run_scheduled_task`). Missed runs catch up once at server start.
- **Unattended / inbox / approvals**: `coworker/unattended.py` per-session flag; parked approvals,
  questions, plans and tool requests go to a cross-session Inbox (`GET /v1/inbox`,
  `POST /v1/inbox/{id}/resolve`), optionally mirrored to Slack/Telegram buttons. Unattended runs
  never self-approve (README "Governed by design"). Scheduled runs auto-allow only deliverable writes
  in the task workspace plus rule-matched tools; anything else suspends until the Inbox is answered
  (`manager.py:5986 _scheduled_approver`). Hard floors are not lowered by any mode.
- **Document/artifact generation**: documents, spreadsheets, reports and web pages are written as
  real files in the workspace (README "What it can do"); `list_artifacts`/`read_artifact`
  (`manager.py`) and `.xlsx/.pptx/.docx` MIME handling (`manager.py:3775-3907`) exist for listing and
  previewing. I found no dedicated docx/pptx/xlsx generation library in `pyproject.toml`; generation
  therefore happens by the agent writing files or running scripts via `run_shell`. The exact
  document toolchain and skills used for office formats are UNVERIFIED (built-in personas are
  security/devops oriented: `coworker/personas/builtin/`; `ops.md`).
- **Memory**: SQLite-backed memory with user rules (`coworker/memory/`, `GET/POST /v1/memory`).

## 6. Model/provider configuration

- Providers (`coworker/providers/registry.py`): `openai` (Responses API), `anthropic`, `gemini`,
  `bedrock`, `vertex`, `ollama`, `openai-codex` (ChatGPT subscription OAuth), and OpenAI-compatible
  vendors (BytePlus/Volcengine Ark, GLM, DeepSeek, Kimi, Qwen, MiniMax, Mistral, Grok, Together,
  Fireworks, Inkling) via `_openai_compat`.
- **Custom OpenAI-compatible endpoint: yes.** The `openai` provider has an optional `base_url`
  field ("Azure OpenAI, vLLM, or any OpenAI-compliant server"); when set it uses Chat Completions
  (`registry.py:123-130`, field at `registry.py:~348-356`; `providers/openai_provider.py:221-252`).
  Configure via `POST /v1/providers {"name":"openai","fields":{"api_key":"...","base_url":"http://127.0.0.1:<nexar>/v1"}}`
  (`app.py:2281`). Model strings use a `provider:model` prefix (`providers/router.py:49-78`);
  arbitrary unknown prefixes are not registered as new providers, so Nexar would have to appear as
  the `openai` provider with a model name (global default, not per-request named provider).
  Requirement: Nexar's endpoint must support tool/function calling in Chat Completions format,
  since the agent loop is tool-driven. Caveat: README says a curated list marks models verified for
  tool calling; "any model string works at your own risk".

## 7. Credentials, auth, sandbox

- **Credential storage**: `SecretStore` is a `0600` JSON file under the state dir with `${ENV}`
  references; Windows uses ACLs (`coworker/secrets.py` docstring: "v1 is a 0600 JSON file ... a
  Keychain / age-encrypted backend can swap in later"). Not encrypted at rest. Connector tokens
  and model keys live there. Board tokens are sha256-hashed (`teams/tokens.py`). The remote-machine
  feature uses an ed25519 machine identity (`cryptography` dependency).
- **Local API security**: loopback bind, token header, Origin pinning, WebSocket rate and frame
  caps, all as described in 3.1. The token file approach is sufficient for a same-user Nexar daemon.
- **Sandbox**: pluggable `sandbox_provider`: `direct` (default), `openshell` (NVIDIA OpenShell,
  one container per agent, allow-listed network, no keys inside; `docs/openshell.md`,
  `coworker/sandbox/providers/openshell.py`, optional extra `openshell = ["grpcio"]`), `seatbelt`
  (macOS), Windows hidden local account (`docs/windows-sandbox.md`). Machine-level setting; the
  project config cannot change it (`docs/config.example.toml`). Direct mode means shell/file tools run
  in-process as the user, gated only by approvals.

## 8. Update cadence and breaking-change risk

- 163 commits in the 30 days to 2026-09-30; 21 commits on 2026-09-29 alone. Releases: 0.1.6 (07-23),
  0.1.7 (07-30), 0.2.0 (08-24), 0.2.1 (08-25), 0.3.0 (09-30). The app auto-updates
  (`packaging/make_update_manifest.py`).
- Risk is high for any coupling to REST/WS shapes: pre-1.0, `server/app.py` and `manager.py` are
  very large single files in active churn, the app version in FastAPI is `0.0.0`, and no API
  contract/changelog exists in `docs/`. Safer, more stable surfaces are the ones with explicit
  external intent: the `mcpServers` config format, the OpenAI-compatible provider field, and the
  board/`ocw` surface (OPE-100). A contract test in Nexar pinned to a tested OpenWorker version is
  required.
- Tests exist (194 files in `tests/`; `tests/test_server.py` covers the WS/REST API) which gives
  upstream some regression protection, but it is an internal suite, not a compatibility promise.

## 9. Integration opportunities

1. **Nexar as MCP server consumed by OpenWorker** (best fit). Add a Nexar MCP endpoint (stdio or
   streamable-HTTP) to `mcp.json` (or `POST /v1/mcp`). Gives OpenWorker Nexar's memory, project
   context, and model-agnostic tools with per-tool approval gating, using a format that follows the
   MCP standard and that OpenWorker already treats as a first-class extension point.
2. **Nexar as model provider behind OpenWorker**: point the `openai` provider `base_url` at
   Nexar's OpenAI-compatible endpoint so Nexar routing, policy and logging sit under OpenWorker's
   agent loop.
3. **Nexar dispatches work to a locally run `openworker-server`** over WS session protocol (3.2A) for
   interactive/short tasks, or one-shot automations (3.2B) for headless, artifact-producing tasks
   that can tolerate 30 s latency. Results come back as `result_text` plus artifact file paths.
4. **Team board/`ocw` seam** (3.2C) if Nexar wants to act as an external worker on OpenWorker's
   board rather than the reverse.
5. **Reuse connectors without re-implementing**: Slack, Jira, Notion, Linear, GitHub, Outlook, and
   Drive exist already; Nexar can lean on them for operations work instead of rebuilding.
6. **Inbox as the approval bridge**: `GET /v1/inbox` + `POST /v1/inbox/{id}/resolve` let Nexar
   surface OpenWorker approvals in its own UI and apply Nexar policy.

## 10. Integration risks

- No stable headless "submit task, await result" REST endpoint; session driving requires a WS
  client, and headless submission via automations is a workaround with 30 s latency.
- The desktop app's token is in memory only, so Nexar cannot attach to a user's running desktop
  instance; it would run a second server, which shares the state dir and only warns
  (`statelock.py`), risking DB contention unless Nexar sets a separate `COWORKER_STATE_DIR`.
  Separate state means separate connectors, keys and memory, and duplicated OAuth set-up.
- Gmail/Calendar one-click OAuth is paused upstream (CASA pending); managed OAuth depends on an
  OpenWorker-operated cloud broker (contradicts a strict local-first story unless manual tokens used).
- Python runtime (3.10+, large dependency set) alongside Nexar's Node/TypeScript stack: separate
  process, packaging and supply-chain surface to manage.
- Default sandbox is `direct`; credentials are plain 0600 JSON; shell tools can act as the user.
- Rapid upstream churn and pre-1.0 versioning (see 8). Scheduled runs appear to lack MCP tools, so a
  Nexar MCP server may not be visible to headless automations (UNVERIFIED).
- Productivity focus is partly marketing: built-in personas lean to security/devops; meetings
  and document (docx/pptx) generation depth are not evident in source.
- Approval semantics: unattended runs park on anything beyond workspace writes; a Nexar bridge must
  handle inbox items or runs will stall in `running` state indefinitely.

## 11. Recommended Nexar boundary

Treat OpenWorker as an **out-of-process, optional engine behind an adapter** (`@nexar/adapter-openworker`),
never a fork and never imported as code. Order of seams:

1. Inbound to OpenWorker (capability): Nexar MCP server + Nexar OpenAI-compatible endpoint configured in
   OpenWorker. Config-only, version-tolerant.
2. Outbound from Nexar (control): adapter that launches and supervises its own `openworker-server`
   (isolated `COWORKER_STATE_DIR`, loopback port, token read from `sidecar-<port>.token`), speaks the WS
   session protocol for interactive tasks and the automations API for deferred tasks, and relays inbox
   approvals into Nexar's approval UI. Pin a tested upstream tag (start at `v0.3.0`), run a
   contract-test suite against the endpoints in section 3 on every upgrade, and keep the adapter
   the only code that knows OpenWorker's wire shapes.
3. Do not depend on: the desktop app's sidecar, `/v1/chat/completions` as an agent entry,
   `/v1/_debug/*`, internal module imports.

Nexar remains the source of truth for project, memory, policy and audit; OpenWorker executes and
returns artifacts.

### Sketch of bridge request contract (Nexar to adapter; not an upstream API)

```jsonc
{
  "contract": "nexar.engine-task/v1",
  "requestId": "uuid",                 // idempotency key, also used as OpenWorker session_id
  "source": "nexar.cli|nexar.ui|nexar.schedule|nexar.agent:<id>",
  "taskType": "doc.generate|meeting.summarize|calendar.triage|email.triage|file.organize|routine.run",
  "project": { "id": "...", "workspaceRoots": [{"path": "...", "writable": false}] },
  "request": { "text": "...", "attachments": [{"kind":"text|pdf|image","name":"...","ref":"..."}] },
  "persona": "cowork",                 // maps to ?agent=
  "model": { "via": "nexar-gateway" }, // OpenWorker provider base_url points at Nexar
  "policy": { "mode": "interactive|plan", "unattended": false,
              "allowedConnectors": ["google_calendar"], "allowedWrites": [] },
  "delivery": { "mode": "interactive|deferred", "fireAt": null, "deadlineSec": 900 },
  "output": { "artifactsDir": "...", "formats": ["md","docx","xlsx"] }
}
// Response events (adapter normalizes OpenWorker events):
// accepted | progress{tool,summary} | approval_required{inboxItemId,tool,argsPreview} |
// artifact{path,mime} | completed{resultText,artifacts[]} | failed{error}
```

Mapping: `interactive` delivery -> WS `user_message`; `deferred` -> `POST /v1/automations` (`fire_at`
soon, `max_runs: 1`) then poll `GET /v1/automations/{id}` and delete the task when done.
`approval_required` maps to `permission_required` events / `GET /v1/inbox`.

## 12. Open questions

1. Is any headless "run one task and return" endpoint planned? Ask upstream; today we need WS or
   automations (issues/PRs list not inspected; UNVERIFIED).
2. Does a board item filed via `POST /v1/board/items` auto-start an in-app worker, and under what
   persona/config? Needs a runtime test.
3. Do scheduled automation runs load MCP tools (`manager._build_task_engine` does not pass them)?
4. How does the agent produce docx/pptx/xlsx in practice (skills, bundled libs, scripts)? Needs a
   live run with a real model.
5. Stability policy for `/v1` REST/WS and event payload shapes; any changelog or deprecation process.
6. Can Nexar's gateway be used as `openai` provider with `base_url` while keeping per-request model
   routing (model-string form `openai:<name>`)? Needs a test with tool-calling streaming.

## Sources

Base: `https://github.com/andrewyng/openworker/blob/e8923509a9e91d2825313f8418f6129a00b1603e/`

- `README.md`, `LICENSE`, `pyproject.toml` (version, scripts, extras)
- `coworker/server/app.py` (auth `#L193-L250`, chat `#L1237`, mcp `#L1246`, providers `#L2277`,
  automations `#L2511-L2542`, `ws_session` `#L2544`, frames `#L3058-L3250`, `/ws/events` `#L3316`, board `#L873-L1180`)
- `coworker/server/run.py#L128-L160`; `coworker/server/manager.py` (`#L5278`, `#L5986`, `#L6026`, `#L6846`, `#L6965`, `#L6974`)
- `coworker/automation/{models,scheduler,tools}.py`; `coworker/events.py`; `coworker/agent.py#L219`
- `coworker/mcp/{config,client}.py`; `coworker/teams/{mcp_server,cli,tokens}.py`
- `coworker/connectors/descriptors.py`; `coworker/providers/{registry,router,openai_provider}.py`
- `coworker/{secrets,roots,workspace_trust,statelock,unattended}.py`
- `docs/openshell.md`, `docs/config.example.toml`, `surfaces/gui/src-tauri/src/lib.rs`, `surfaces/gui/package.json`
- Git: tags and 163 commits since 2026-08-31 from the shallow clone; web: https://github.com/andrewyng/openworker (non-fork, MIT)
- Local clone: `/tmp/claude-0/-home-user-Nexar-Ai/59a81680-491c-5deb-b80c-2faba7aec06a/scratchpad/upstream/openworker`
