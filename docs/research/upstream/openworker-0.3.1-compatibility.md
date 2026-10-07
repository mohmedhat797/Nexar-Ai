# OpenWorker 0.3.1 compatibility (2026-10-07)

## Provenance and decision

Inspected official [release v0.3.1](https://github.com/andrewyng/openworker/releases/tag/v0.3.1),
published **2026-10-05 21:12:52 UTC**, annotated tag object
`08c1f8e9e8a9b89c36154fef261ce35fbbe2116b`, resolved commit
`b9b35036668dfb1653f3aa35bafb9aeea6d47c3c`. Baseline v0.3.0 resolves to
`e8923509a9e91d2825313f8418f6129a00b1603e`. Verified with GitHub release API and
`git ls-remote`; a detached official source checkout supplied the
[tag comparison](https://github.com/andrewyng/openworker/compare/v0.3.0...v0.3.1).
`git rev-list --count v0.3.0..v0.3.1` gives **53 commits**; diff: 93 files,
9,185 insertions / 195 deletions. No upstream code was executed during research.

**Source compatibility passes for Nexar's existing seam; no protocol migration.** Adopt the
runtime security/maintenance floor **`>=0.3.1 <0.4.0`**, preferred acceptance target **0.3.1**,
and strengthen the existing offline fixtures. This note precedes implementation edits. Patch-range
acceptance is a version policy, not proof that every future patch has been inspected. Keep bounded
startup, private state, per-launch token, approval policy and explicit fallback intact.

## HTTP, WebSocket and provider contract

Inspected both tagged versions of `coworker/server/app.py`, `manager.py`, `run.py`,
`coworker/providers/__init__.py`, provider descriptors and MCP configuration code, against Nexar's
`integrations/openworker/src/{supervisor,client,session,providers,policy,bridge,schema}.ts`.
The relevant route handlers and authentication functions remain compatible; additions to ready
metadata, attendance, sites and dangerous modes do not require a second client.

| Surface                               | Verified v0.3.1 behavior / Nexar consequence                                                                                                                                                                                                                                                         |
| ------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /v1/health`                      | JSON `status: ok`; unauthenticated health remains public with reduced fields. Nexar sends its token but health alone does **not** prove authentication. Preserve auth tests on protected mutations and WS.                                                                                           |
| HTTP authentication                   | `X-OpenWorker-Token`, constant-time comparison with `COWORKER_API_TOKEN`; protected routes return 401 on mismatch. No query-string token.                                                                                                                                                            |
| `POST /v1/providers`                  | `{name, fields}`; required fields validated, profile merged, empty optional `base_url` clears it, provider client rebuilt. `{ok:false}` can be HTTP 200. Nexar already checks the semantic result.                                                                                                   |
| `DELETE /v1/providers/{name}`         | Whole provider profile removed; unknown provider returns `{ok:false}`. Nexar checks semantic success, not only HTTP status.                                                                                                                                                                          |
| `POST /v1/mcp`                        | `{name, config}` with stdio `command`, `args`, `env`, `requires_approval`; invalid entry can return HTTP 200 `{ok:false}`. Keep the turn-scoped relay and secret env private.                                                                                                                        |
| `DELETE /v1/mcp/{name}`               | `{ok: boolean}`; absent entry returns false. Existing fake's 404 was stricter than upstream. Align fixture and reject semantic refusal with fixed errors.                                                                                                                                            |
| `POST /v1/sessions/{sessionId}/roots` | `{path, writable}`; directory/base containment checked upstream, refusal can be HTTP 200 `{ok:false}`. Nexar attaches project read-only before opening WS. Reject refusal before sending a turn.                                                                                                     |
| `WS /ws/session/{sessionId}`          | `workspace` and optional `agent` query fields; token supplied alongside `openworker` in `Sec-WebSocket-Protocol`; server selects `openworker`. Wrong token/origin closes with policy violation before acceptance.                                                                                    |
| Ready / turn                          | Server `{type, data:{...}}`; ready now includes `sandbox` metadata. Nexar reads payload from `data`, ignores extra fields, then sends flat `set_mode` interactive/discuss and `user_message` text/model. Assistant events, `turn_done`, `approval` allow/deny and `interrupt` retain their meanings. |

Source references pinned to the inspected commit:
[app.py](https://github.com/andrewyng/openworker/blob/b9b35036668dfb1653f3aa35bafb9aeea6d47c3c/coworker/server/app.py),
[manager.py](https://github.com/andrewyng/openworker/blob/b9b35036668dfb1653f3aa35bafb9aeea6d47c3c/coworker/server/manager.py).
Provider setup configures the Nexar loopback gateway, not upstream subscription login.
No provider verification endpoint, login, catalog listing or model call was used.

## Security and robustness review

Verified in tagged source/diff and corresponding upstream test sources; these are upstream fixes,
not copied implementations or claims of a complete security audit:

- `coworker/personas/loading.py` validates HTTPS before cache/clone, disables other Git transports
  and terminates option parsing. Tests reject executable transports and option-leading URLs.
  Nexar does not expose persona installation in this update.
- `coworker/server/manager.py` applies protected approval ownership/channel binding beyond Slack
  to other messaging transports; `tests/test_telegram_approval_bypass.py` covers Telegram replies,
  buttons and cross-transport resolution. Nexar's private server has no configured connectors.
- `coworker/permissions.py`, `web/tool.py`, `sandbox/workspace.py`, `tools/network.py` enforce
  configured sandbox sites for web/search destinations and add `request_network_access`, with
  session/persistent grants. Nexar's existing policy denies web, shell and network-access requests;
  do not enable auto attendance, site grants or dangerous mode. The upstream site wall is conditional
  on sandbox configuration and is not a replacement for Nexar policy.
- `coworker/secrets.py` adds per-file reentrant thread/process locking (Windows byte locks / Unix
  flock); `providers/codex_auth.py` and `cloud.py` re-read under the lock to avoid duplicate refresh.
  **Limitation:** after the lock deadline the store proceeds without the advisory lock; it is not
  an unconditional concurrency guarantee. Nexar still uses fresh private state and never harvests
  upstream stored credentials.
- `coworker/sandbox/runner/executor.py` replaces undecodable shell output bytes in foreground and
  background readers; `tests/test_shell_non_utf8_output.py` covers it. Nexar still denies shell.
- `coworker/headless/runner.py` adds bounded transient model retries, permanent-error exclusions
  and cancellable waits (2, 5, 10, 30, 60, 120, 240, 300, 300 seconds). These belong to **headless
  run**, not a new Nexar retry/replay policy. Do not replay a failed active control loop.

## Windows runtime and discovery

Release API lists Windows x64 EXE/MSI assets and an updater `.sig`; Windows availability is verified,
not a claim that the GUI installs a CLI on PATH. Inspected `packaging/build_windows.ps1`,
`packaging/openworker-server.spec`, `surfaces/gui/src-tauri/tauri.conf.json`, GUI Rust launcher,
`README.md`, `pyproject.toml`. The Windows build stages an onedir bundle under
**`<install>/sidecar/openworker-server.exe` plus `_internal/`**. Tauri's resource map preserves
that directory. NSIS is per-user; the GUI/server entry point is distinct from Python's
**`openworker` version CLI**. The build script describes unsigned Authenticode output; an updater
signature or API digest must not be represented as verified Authenticode.

Nexar keeps separate server/version executable overrides and its version guard. Prefer an isolated
Python 3.13 runtime installed from the exact v0.3.1 commit for acceptance; it supplies both entry
points without borrowing GUI state. Preserve the existing 0.3.0 environment, use a separate 0.3.1
directory, and verify `openworker version`, server help and Nexar-supervised private health after
the new head's full CI. No released binary asset is needed on this route. Dependency resolution is
recorded locally; the upstream source SHA alone does not pin every Python transitive dependency.

Automatic GUI sidecar discovery is **deferred** to
[NXR-069](../../backlog/069-openworker-runtime-discovery.md), including version provenance,
ownership and update/signature checks; no broad scan or version-guard bypass here.

## Headless and OpenShell — deferred

Read `docs/headless.md`, `coworker/cli.py`, `coworker/headless/{runner,terminal,trajectory,pricing}.py`.
`openworker run` executes one task and exits, unlike persistent `up`/`join`. Default run consumes
this machine's settings and may renew sign-in; `--isolated` needs explicit model/output and can
consume environment keys. Neither mode was executed. Approval/attendance switches can change
permissions substantially; do not substitute them for Nexar's single-use approvals.

Evaluate only under **NXR-054 / v0.8 Automation** after NXR-066 acceptance: bounded scheduled
execution, evaluation trajectories and machine-readable exit/outcome evidence. Potential outputs:
`trajectory.json` (ATIF-v1.7), `summary.json`, `events.jsonl`, `messages.json`, `model_calls.jsonl`,
`answers.json`, `audit.db` (also provider error logs / spilled tool output). They can contain prompts,
content, paths and actions; never copy raw records into Nexar telemetry, public PRs or committed
evidence. Future evaluation needs consent, retention/redaction, sandbox, cancellation and allowance
policy; estimated upstream prices are not vendor-reported cost.

Inspected `coworker/sandbox/providers/openshell.py`, `openshell_policy.py`, `openshell_wire.py`,
`docs/openshell.md`, `docs/openshell-inside.md`: upstream pins **OpenShell 0.1.2**, incompatible with
its former 0.0.x protocol, and restricts the offered network profile. **Defer adoption**: Nexar's
WSL2/bubblewrap engineering plane and current Cowork private-server architecture stay intact.

## Acceptance impact / adoption ledger

Adopt: 0.3.1 floor, canonical version validation, upstream-aligned offline contract fixtures,
semantic refusal tests, revised Windows/owner preparation instructions. Defer: runtime discovery,
headless scheduling/evaluation and OpenShell migration. Not relevant to this seam: GUI gallery,
messaging transport setup, unattended/dangerous modes, persona cloning and global upstream logins.

NXR-068 remains offline implemented; NXR-066b remains **owner live acceptance pending**. Run pinned
local gates and full exact new-head CI, then prepare matching Desktop/plane builds and isolated
runtime/UI smoke. **Stop before existing-profile Desktop launch** (automatic ChatGPT inventory
refresh), provider auth/refresh, native SDK metadata initialization, SOW/Code or inference. The
final handoff records actual new-head CI and environment results without a self-referential commit.
