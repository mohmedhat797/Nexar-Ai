# DSH unified-runtime spike (Windows host-local ACP)

| Field | Value |
| --- | --- |
| Date | 2026-10-10 |
| Upstream state | `dsh-v0.2.1-alpha.2` = `d743267388641bc76f17c45ce8b4c231aed1d32c` (HEAD, 2026-10-09, npm `alpha`); npm `latest` = `next` = `0.2.0-rc.2` (`639ed015397290b3745d163aafe02ffee4aa3f84`) |
| Version exercised | `@deepseek-ai/dsh@0.2.0-rc.2` (npm, scratch install, `--version` → `0.2.0-rc.2`) |
| Host | Windows 11, Node 24.15.0, no WSL, no credentials, no paid call |
| Method | Nexar-written ACP client against `dsh --profile acp --patch <overlay>`; model route `nexar` (pi-ai `openai-completions`) to a fake Chat Completions server on loopback in the test process |

## Re-check of 0.2.1-alpha.2 docs (source at `d743267`)

- SDK protocol still has no cancel/close, no server→client requests ("dead capability"), no version
  negotiation; adds `session/wait` and working-directory get/set only.
- ACP README: `session/new|list|resume|close|prompt|cancel|set_config_option`,
  `session/request_permission` (one-shot allow/reject), per-session stdio/HTTP MCP, context usage.
- `system-prompt` config: `includeHarnessIdentity`, `includeRuntimeContext`, `personaPrefix`,
  `personaSuffix` (order 10200, re-assembled each step), `toolOrder`.
- `compaction-basic` condenses the oldest conversation span into a summary; the system prompt is
  not part of the condensed history.
- Base bundle on `win32`: `tool-pwsh` + `pwsh-sandbox` instead of `tool-bash` + `bash-sandbox`;
  `sandbox-policy.workspaceRoot = process.cwd()`; `approval: ask` unless `danger-full-access`;
  `session-telemetry-otel` exports to an upstream collector unless `DSH_TELEMETRY_DISABLED` is set.

## Observations (rc.2, Windows)

1. Install: 177 top-level / 288 `@deepseek-ai/*` packages, ~463 MiB on disk; native packages
   `node-addon-system`, `dsh-native-command`.
2. `initialize`: first launch ~19 s (profile materialization in a fresh `DSH_HOME`), warm ~3.4 s.
   Nexar's startup deadline must be ≥ 60 s.
3. Overlay disabling `llm-deepseek`, `llm-deepseek-account`, `web`, `web-fetch-http`,
   `web-search-deepseek`, `tool-web`, `tool-pwsh`, `tool-bash`, `tool-jobs`, `otel`,
   `session-telemetry-otel`, `session-log-deepseek` loads cleanly. The session's model catalog then
   contains only `["nexar","nexar-control"]`.
4. Model-facing tools with that overlay: `create_goal, edit, exit_plan_mode, get_goal, glob, grep,
   interrupt_agent, list_agents, read, read_image, send_message, skill, subagent, subagent_fork,
   todo_write, update_goal, workflow, write` — no shell, no web.
5. Every model request carried `Authorization: Bearer <NEXAR_CONTROL_TOKEN>` and
   `model: nexar-control`, `stream: true`.
6. `workspace-write`, write to `proposal.md`: no permission request; file created in the scratch
   `cwd`; prompt `stopReason: end_turn`; `session/close` → `{}`.
7. `read-only`, write to `../outside.md` without escalation: denied by DSH, no permission request,
   nothing written.
8. Write to `../outside.md` with `sandbox_permissions: danger-full-access`: DSH sent
   `session/request_permission` `{sessionId, toolCall:{toolCallId}, options:[allow-once/allow_once,
   reject-once/reject_once]}` after a `tool_call` update carrying `title: "write"` and `rawInput`.
   The spike client allowed it and the file **was written outside the workspace** — Nexar's Cowork
   policy must therefore deny every escalation whose target is not inside the turn scratch, and
   always deny `danger-full-access`.

## Consequences for ADR-030

- ACP + overlay is sufficient for a Windows-native Cowork profile; no upstream patch needed.
- The existing `PermissionBroker` request parsing matches rc.2's request shape.
- Host-local DSH file boundaries are path checks, not OS isolation; Cowork's tool surface (no
  shell, no web) and Nexar's deny-by-default broker are the effective boundary.
