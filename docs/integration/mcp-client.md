# Using Nexar from an MCP client (stdio)

Nexar exposes a generic inbound MCP server that any MCP client launches as a child process: `nexar mcp serve`.
Every call is authenticated with a Nexar client token, authorized against that client's scopes, and audited
([ADR-015](../adr/015-client-identity-and-audit.md)). The server and its Work Bridge (`@nexar/work-bridge`) are not tied to any
agent product; OpenWorker, which this seam was first built for, is no longer a Nexar runtime ([ADR-030](../adr/030-unified-dsh-first-agent-runtime.md)).
The sections below are written from that first integration and still describe the protocol accurately.

Research basis: [OpenWorker re-check](../research/upstream/openworker.md) (tool timeout, env passing,
tool-name mangling) and [MCP SDK](../research/upstream/mcp-sdk.md). Design: [ADR-014](../adr/014-mcp-transport-and-work-bridge-v2.md).

**Verified live** against OpenWorker `v0.3.0` (`e892350`): OpenWorker's own MCP client
(`coworker.mcp.MCPManager`) launched `nexar mcp serve` and drove it through Claude Code to stored
artifacts, for a raw request, the `sow` workflow and `meeting-brief` (including a prompt-injection
attempt that produced only drafts). Re-check before relying on it with a newer tag.

## 1. Create a client

A client is a named identity with explicit scopes: which tools, task kinds, projects and (optionally)
workflows it may use. There are no defaults: `--tools`, `--task-kinds` and `--projects` are required,
and a client with no `--workflows` may not run any workflow (`*` means any).

```bash
nexar clients add openworker \
  --tools nexar.submit_work,nexar.work_status,nexar.route,nexar.resources,nexar.workflows \
  --task-kinds documentation,meeting-preparation \
  --projects <project-id> \
  [--workflows sow,meeting-brief] \
  [--max-cost 0.50]
```

The token (`nxr_…`) is printed **once**, on stdout; the warning goes to stderr. Nexar keeps only its
SHA-256 in `.nexar/clients.json` (mode 0600, git-ignored). Capture it without echoing it:

```bash
export NEXAR_CLIENT_TOKEN="$(nexar clients add openworker --tools ... --task-kinds ... --projects ...)"
```

`nexar clients list [--json]` shows scopes and the last four token characters, never hashes.
`nexar clients revoke <id>` takes effect on the very next tool call; the server re-reads the file on
every call, so no restart is needed. `--max-cost` is a ceiling in USD: a request can lower it, never
raise it.

The projects a client may use must exist in the Nexar config (`projects` in `nexar.config.json`).
State (`clients.json`, `audit.jsonl`) lives in `.nexar/` next to the config file, or in the working
directory when the built-in default config is used. Artifacts live under the project's first root.

## 2. Register the server in OpenWorker

Add this to `~/.config/coworker/mcp.json` (Windows: `%APPDATA%\coworker\mcp.json`), or POST it to
`/v1/mcp`. Use absolute paths; OpenWorker gives the child a minimal `PATH`.

```json
{
  "mcpServers": {
    "nexar": {
      "command": "node",
      "args": [
        "/abs/path/to/nexar/apps/cli/dist/main.js",
        "--config",
        "/abs/path/to/nexar.config.json",
        "mcp",
        "serve"
      ],
      "env": { "NEXAR_CLIENT_TOKEN": "${NEXAR_CLIENT_TOKEN}" },
      "cwd": "/abs/path/to/nexar",
      "requires_approval": true
    }
  }
}
```

- `"command"` should be an absolute path to `node` (>= 22.19) if it is not on OpenWorker's minimal
  `PATH`. Build first: `pnpm build`.
- `${NEXAR_CLIENT_TOKEN}` is expanded by OpenWorker from its own environment (or from
  `~/.config/coworker/.env`), so `mcp.json` holds a reference, not the secret. OpenWorker passes the
  child only `HOME, LOGNAME, PATH, SHELL, TERM, USER` plus the keys listed in `env`, so the token is
  the only Nexar-specific value the server sees.
- An unexpanded `${NEXAR_CLIENT_TOKEN}` reaches the server as that literal text. Nexar rejects it like
  any other malformed token (`AUTH_REQUIRED`).
- Keep `"requires_approval": true`. OpenWorker classifies every custom MCP tool as external work
  regardless, including Nexar's read-only tools.
- Scheduled OpenWorker automations may not load MCP tools (upstream behaviour, unverified). Use an
  interactive session.

## 3. Tools

OpenWorker names tools `mcp__<server>__<tool>` with every character outside `[A-Za-z0-9_-]` replaced
by `_`, so the model sees:

| Nexar tool          | OpenWorker name                 | Purpose                                                           |
| ------------------- | ------------------------------- | ----------------------------------------------------------------- |
| `nexar.submit_work` | `mcp__nexar__nexar_submit_work` | Run a task on the best resource; returns result + route + usage   |
| `nexar.work_status` | `mcp__nexar__nexar_work_status` | Poll a submitted job                                              |
| `nexar.route`       | `mcp__nexar__nexar_route`       | Explain which resource would run a task, without running it       |
| `nexar.resources`   | `mcp__nexar__nexar_resources`   | List resources (id, kind, capabilities, availability, auth state) |
| `nexar.workflows`   | `mcp__nexar__nexar_workflows`   | List the workflows this client may run, with their inputs         |

OpenWorker forwards only **text** content blocks, so every result is one text block containing JSON
(the same object is also in `structuredContent`). Failures (`rejected`, `failed`, invalid input,
authentication or scope errors) are `isError` results; OpenWorker renders them as `{"error": "<json>"}`.

`nexar.resources` never includes credentials, environment variable names, configuration, metadata or
probe details. `nexar.route` takes `project`, `taskKind`, optional `capabilities` and optional
`request` (never used to choose) and explains the decision without running anything.
`nexar.workflows` takes an optional `project` (its own workflows are included and override built-ins
of the same id) and lists only workflows the client's scopes allow.

### `nexar.submit_work`

Required: `requestId` (your idempotency key, `[A-Za-z0-9._:-]`, at most 128), `project`, and either
`taskKind` + `request` or `workflow` (not both). Optional: `systemPrompt`, `constraints` (`capabilities`, `privacy`, `maxCostUsd`,
`preferredResourceIds`, `excludedResourceIds`), `workingDirectory` (relative to the project's first
working directory, or absolute; must resolve inside the project), `documentSets` (up to 8 names
defined on the project, attached as file references), `output` (`{ filename, mediaType? }`: store the
result as a Markdown/plain-text artifact in the project), `requestedBy`, `waitSeconds` (0 to 100,
default 90).

Response `status` is `completed`, `running`, `failed` or `rejected`, with `taskId`, `output.text`,
`route` (`resourceId`, `policy`, `reasonCodes`, `explanation`), `usage`, `artifacts` and `error` as
applicable. When nothing is eligible the status is `failed`, `error.code` is `NO_ELIGIBLE_RESOURCE`
and `route.explanation` lists why each resource was rejected.

### Workflow requests

Instead of `taskKind` and `request`, send `workflow: { id, inputs }`. `id` is a workflow from
`nexar.workflows`; `inputs` maps each input name to a string or a list of strings (document-set inputs
name a set defined on the project). Inputs are untrusted text for the model: they never choose the
project, working directory or permissions, and invalid inputs are rejected with per-input issues before
anything runs. The client needs the `workflows` scope and the workflow's task kind. Results are saved as
artifacts (anything meant for another person as a draft under `drafts/`), listed in `artifacts`, and
the response carries `workflow: { id, outputsSplit }`; `outputsSplit: false` means the model omitted the
output markers and everything was stored in the first file.

```json
{
  "requestId": "sow-acme-1",
  "project": "demo-project",
  "workflow": {
    "id": "sow",
    "inputs": { "clientName": "Acme Corp", "objectives": "Migrate the billing system" }
  }
}
```

### The 120 second limit and polling

OpenWorker kills any tool call after **120 s** (hard limit, not configurable). `nexar.submit_work`
therefore waits at most `waitSeconds` (default 90, maximum 100) and otherwise returns
`status: "running"` with a `taskId` while the work continues in the background. Then:

1. Call `nexar.work_status` with the same `requestId` until `status` is `completed` or `failed`.
2. Or call `nexar.submit_work` again with the same `requestId`: it never starts a second task, it
   returns the current state (and waits again).

Only the client that submitted a `requestId` can read or resubmit it; other clients get
`POLICY_REJECTED`. Jobs are held in memory (the newest 200) and are lost when the server stops, which
happens when OpenWorker shuts down; a job is cut off after 30 minutes. Persist long results with
`output`, which writes the text to `<project root>/.nexar/artifacts/<task>/` before the job is
reported complete.

## 4. Audit

Each tool call appends exactly one line to `.nexar/audit.jsonl` (mode 0600): request id, client,
tool, project, task kind, workflow id, task id, resource, auth and policy outcome, error code,
artifact count, duration. Authentication and validation failures are recorded too. Prompts, document content, paths
and tokens are never written.

## 5. Security notes

- **stdio only.** There is no HTTP, SSE or socket transport, and none may be added to this server:
  authentication is one token per launching process, and anything that can reach a network listener
  could spend money and touch project files. Never proxy this server onto a network.
- The token is read from the environment only; never put it in `mcp.json`, config files, or
  command-line arguments (visible in `ps`).
- stdout carries only protocol frames; logs and the one-line startup notice go to stderr. OpenWorker
  shows the last 20 stderr lines when the server fails to start.
- Treat the request as untrusted input. Request fields cannot widen scopes, projects or paths: the
  working directory is canonicalized with `realpath` against the project and anything outside
  (including symlink escapes) is rejected before any resource runs.
- Revoke with `nexar clients revoke <id>` if a token may have leaked; rotate by revoking and adding.
