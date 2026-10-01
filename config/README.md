# Nexar configuration

`nexar.config.example.json` is a working starting point. Copy it to `nexar.config.json` (or point
`--config` / `NEXAR_CONFIG_PATH` at it) and edit.

## How config is resolved

First match wins:

1. `--config <path>`
2. `NEXAR_CONFIG_PATH`
3. `./nexar.config.json` in the current directory
4. The built-in default: a single offline `local-echo` resource (no network, no cost)

Relative paths inside a config file (e.g. `telemetry.jsonlPath`) resolve against the config file's
directory. With the built-in default, telemetry is written to `<cwd>/.nexar/telemetry.jsonl`. Check
which config is active with `nexar doctor`.

## Credentials are references, never values

A resource names _where_ its credential lives; the file must never contain the secret itself:

```json
{ "source": "env", "name": "ANTHROPIC_API_KEY" }
{ "source": "runtime-managed", "description": "Claude Code login (claude auth)" }
```

`env` reads the named environment variable at run time. `runtime-managed` means the upstream tool
keeps its own login (Nexar never reads or copies it). The schema has no field that could hold a
secret, and unknown keys are rejected.

## Projects

A project names where Nexar may work and what defaults apply. It is the filesystem trust boundary:
a task's working directory is accepted only if it resolves (through symlinks and `..`) inside the
project's `workingDirectories`, and the check runs in the engine before any adapter executes.

```json
{
  "id": "demo-project",
  "displayName": "Demo project",
  "roots": ["../examples/demo-project"],
  "workingDirectories": ["."],
  "documentSets": { "overview": ["README.md", "docs/overview.md"] },
  "workflows": { "instructions": { "sow": "docs/sow-instructions.md" } },
  "defaults": { "capabilities": ["knowledge-work"], "preferredResourceIds": ["claude-code"] }
}
```

Relative paths resolve as follows (absolute paths stay absolute):

| Field                                                                                                         | Relative to                 |
| ------------------------------------------------------------------------------------------------------------- | --------------------------- |
| `roots`, `telemetry.jsonlPath`                                                                                | the config file's directory |
| `workingDirectories`, `documentSets`, `workflows.directories`, `workflows.instructions`, `artifactsDirectory` | the project's first root    |

- `roots` (at least one) bound everything the project may touch. `workingDirectories` default to the
  roots and must each be inside a root. Roots and working directories must exist and be directories,
  otherwise Nexar fails with `CONFIGURATION_ERROR`.
- `documentSets` map a name to files or directories inside the roots. `nexar run --project <id>
--document-set <name>` attaches them as references (`file://` URIs), never as inlined content.
  Directories expand recursively to regular files (dot-entries skipped, symlinked directories not
  followed, at most 500 files). A symlink leading out of the roots is rejected.
- `defaults` may use `capabilities`, `privacy`, `preferredResourceIds`, `excludedResourceIds`,
  `minContextTokens` and `maxCostUsd`; resource ids must exist in `resources`.
- `workflows` (optional): `directories` (extra workflow directories inside the roots; a same-id workflow
  overrides the built-in for this project) and `instructions` (workflow id → Markdown file inside the
  project, rendered into prompts as trusted owner instructions). See [`workflows/README.md`](../workflows/README.md).
- Inspect with `nexar projects list [--json]`; use with `nexar route|run --project <id>`.

### Artifacts

Task outputs (SOWs, proposals, briefs, drafts) are stored by `@nexar/artifacts` inside the project:

```
<first root>/.nexar/artifacts/<task-id>/<file>          final outputs
<first root>/.nexar/artifacts/<task-id>/drafts/<file>   drafts that need review
```

`<task-id>` is the task id reduced to `[A-Za-z0-9._-]` (`:` becomes `-`). Set the optional
`artifactsDirectory` (relative to the first root, must stay inside it; `..` or an absolute path is a
`CONFIGURATION_ERROR`) to use `<artifactsDirectory>/<task-id>/…` instead. File names are
sanitized and their extension is forced to match the media type (`.md`, `.txt`, `.json`, `.csv`).
Files are never overwritten (a collision becomes `name-2.md`, `name-3.md`, …), symlinks are never
followed, directories are `0700` and files `0600`. When Nexar creates the default `.nexar`
directory it adds a `.nexar/.gitignore` containing `*` so artifacts are not committed by accident;
a custom `artifactsDirectory` gets no `.gitignore`, so add one yourself if needed.
List a task's artifacts with `nexar artifacts list --project <id> --task <task-id> [--json]`.

### Precedence: project defaults vs. explicit task values

| Field                  | Rule                                                                              |
| ---------------------- | --------------------------------------------------------------------------------- |
| `capabilities`         | union of project and explicit                                                     |
| `privacy`              | most restrictive wins; an explicit `standard` cannot relax a `local-only` project |
| `preferredResourceIds` | explicit if given (even empty = no preference), otherwise the project's           |
| `excludedResourceIds`  | union (exclusions accumulate)                                                     |
| `minContextTokens`     | explicit if set, otherwise the project's                                          |
| `maxCostUsd`           | the lower of the two                                                              |

### Working-directory policy

The engine defaults to `project-only`: a working directory is accepted only with a project (and is
replaced by its canonical path). The CLI deliberately uses `project-or-unscoped` so the owner at
their own terminal can run `nexar run --cwd <dir>` without a project; the directory is then only
canonicalized. External clients such as the OpenWorker Work Bridge must always go through a project.

## What the example does

| Resource           | Adapter            | Notes                                                     |
| ------------------ | ------------------ | --------------------------------------------------------- |
| `claude-code`      | `claude-code`      | Native agent via the `claude` CLI, `permissionMode: plan` |
| `codex`            | `codex`            | Native agent via the `codex` CLI; declared, not preferred |
| `deepseek-harness` | `deepseek-harness` | DeepSeek `deepseek-v4-flash`, needs `DEEPSEEK_API_KEY`    |
| `anthropic-sonnet` | `pi`               | `claude-sonnet-4-5` by API, needs `ANTHROPIC_API_KEY`     |

Routing: `claude-code` is the default resource. Per task kind, preferences are `coding` →
claude-code, deepseek-harness; `review` → claude-code; `documentation` → anthropic-sonnet,
claude-code; `analysis` → anthropic-sonnet, deepseek-harness, claude-code. A `taskKinds` entry
replaces the built-in rule for that kind, so each one repeats its `requiredCapabilities`.

### Codex

The `codex` resource runs the OpenAI Codex CLI (`codex exec`) with your ChatGPT subscription. Install
Codex from its official source and sign in once with `codex login`; no OpenAI API key is used or
passed (`OPENAI_API_KEY`, `CODEX_API_KEY` and `CODEX_ACCESS_TOKEN` are never forwarded to Codex). The
example declares the resource but no routing rule prefers it, so it only runs when chosen explicitly
(or by capability once engineering lanes use it). Nexar never reads, parses or copies `CODEX_HOME`
(default `~/.codex`, where the login lives): it only passes the path on, or mounts it into the Nexar
sandbox for write-mode lanes. Optional `runtime.options`: `binary`, `model`,
`reasoningEffort` (`low`/`medium`/`high`), `timeoutMs`, `codexHome`, and `allowHosts` (sandbox egress
allowlist, default `chatgpt.com`, `auth.openai.com`, `api.openai.com`). Unknown options are rejected.

### Codex through a Delegate Skills relay (`delegate-skills`)

The `delegate-skills` adapter runs the Delegate Skills `codex` relay inside the Nexar sandbox, as an
alternative mechanism for a Codex resource. **Nexar still routes**: the Resource Controller picks the
resource; the relay is only how that resource executes (it never chooses a resource and never bypasses
the sandbox). It runs only in engineering workspaces, and only through the sandbox launcher.

You install Delegate Skills yourself and pin the exact relay file. Declare a resource such as
`delegateSkillsCodexResource()` (id `codex-relay`) with these `runtime.options`:

```json
"options": {
  "relay": "codex",
  "relayPath": "/home/you/.claude/skills/codex-delegate/scripts/relay.mjs",
  "relaySha256": "<sha256sum of that relay.mjs>"
}
```

`relaySha256` is required: Nexar hashes the file before every run and in the probe, and refuses on a
mismatch (`relay pin mismatch`). Re-pin after you deliberately update Delegate Skills (Nexar was
written against upstream `6826b363`). Only `relay: "codex"` is supported in v0.3; for Claude use the
native `claude-code` adapter, for Antigravity the experimental `antigravity` adapter. Optional:
`nodePath`, `model`, `effort` (`low`/`medium`/`high`), `timeout` (relay duration such as `30m`, the
default), `codexHome` and `allowHosts` (same meaning and defaults as for the native `codex` resource).
The brief goes to the relay on stdin, no parent environment is passed, and Nexar never reads
`CODEX_HOME`. The example config does not route to this resource.

### Antigravity (experimental, opt-in)

`antigravity` runs Google's official `agy` CLI headless for engineering lanes. It is **experimental and
not routed by default**: the example config does not declare it, and the adapter refuses to execute
until `runtime.options.acknowledgeExperimental` is `true`. Authenticated behaviour, sandbox nesting and
WSL2 are unverified (see `docs/research/upstream/v0.3/antigravity.md`). Terms note: Antigravity's
Additional Terms (§6) forbid third-party access to the service with Antigravity OAuth tokens; Nexar only
drives the unmodified official binary and never reads, parses or copies Google credentials. Sign in with
`agy` yourself first; an unauthenticated run fails with `AUTH_REQUIRED` and is never allowed to start an
interactive sign-in. It runs only in a sandboxed engineering workspace (otherwise `POLICY_REJECTED`),
one run at a time. The prompt is passed as a command-line argument, so it is visible in the host's
process list (capped at 100 000 bytes). Optional `runtime.options`: `binary`, `model`, `effort`
(`low`/`medium`/`high`/`max`), `timeoutMs` (default 30 min), `allowHosts` (default
`cloudcode-pa.googleapis.com`, `oauth2.googleapis.com`, `www.googleapis.com`), and
`sandbox.mounts` (narrow state/credential mounts you declare; Nexar never opens them). Unknown options
are rejected.

### Claude Code in engineering lanes (`runtime.options.sandbox`)

When a task runs in an engineering workspace, `claude` is launched through Nexar's sandbox with an
empty environment (no `ANTHROPIC_*`, no tokens). Two optional keys on the `claude-code` resource:

```json
"options": {
  "engineeringTimeoutMs": 1800000,
  "sandbox": {
    "allowHosts": ["api.anthropic.com", "claude.ai", "platform.claude.com"],
    "mounts": [
      {
        "hostPath": "/home/you/.claude/.credentials.json",
        "sandboxPath": "/home/agent/.claude/.credentials.json",
        "access": "read-write"
      }
    ]
  }
}
```

`allowHosts` is the egress allowlist (the values above are the default). `mounts` is how the login
reaches the sandbox: mount only the single credentials file, not the home or `~/.claude` directory.
Nexar never opens or reads a mount; it hands the declaration to the launcher, which validates it.
Write mode is refused unless the launcher is the Nexar sandbox.

**The example deliberately contains no `local-echo` test double.** In a real configuration an
always-eligible echo resource would silently "succeed" whenever the real resources are unavailable.
When nothing is eligible, Nexar reports `NO_ELIGIBLE_RESOURCE` with the reasons instead. The offline
echo resource exists only in the built-in default configuration (used when no config file is found).

## Resource intelligence (v0.4)

`routing.policy` selects the routing policy: `deterministic` (default, unchanged since v0.1) or
`resource-intelligence` ([ADR-020](../docs/adr/020-resource-intelligence-scheduler.md)). Every
setting below is optional; the values shown are the defaults. Changing any of them changes the
policy's `configId`, which is recorded with every decision.

```json
{
  "routing": {
    "policy": "resource-intelligence",
    "defaultResourceId": "claude-code",
    "resourceIntelligence": {
      "weights": {
        "default": 0.1,
        "availability": 0.1,
        "auth": 0.05,
        "quota": 0.2,
        "cost": 0.15,
        "latency": 0.1,
        "success": 0.2,
        "lane": 0.2
      },
      "preferences": "authoritative",
      "history": { "windowDays": 30, "minSamples": 5 },
      "quota": { "unknownScore": 0.5, "staleAfterMs": 900000, "exhaustedHoldMs": 3600000 },
      "cost": {
        "defaultOutputTokens": 4096,
        "unknownUnderLimit": "reject",
        "costScaleUsd": 0.1,
        "subscriptionScore": 0.9
      },
      "latencyScaleMs": 60000,
      "reservations": [],
      "allowances": []
    }
  }
}
```

- **`preferences`**: `authoritative` ranks explicit owner preferences (task `--prefer`, engineering
  `lanePreferences`, then `taskKinds.*.preferredResourceIds`) before any score. `weighted` turns them
  into the `default` factor so strong history can outrank a weak preference.
- **`allowances`** declare a budget you know about, which Nexar counts from its own telemetry (it
  needs `telemetry.jsonlPath`): `{ "resourceId": "codex", "unit": "requests", "limit": 200,
"window": "daily" }`. Units: `requests`, `tokens`, `usd`; windows: `daily`, `weekly`, `monthly` (UTC)
  or `{ "hours": 5 }` (rolling). Runs whose usage was not measured are counted as unaccounted, never as zero.
- **`reservations`** keep the last part of an allowance for named work: `{ "resourceId": "claude-code",
"reserveFraction": 0.3, "reservedFor": { "taskKinds": ["review"], "laneRoles": ["review"] } }`.
  Once known headroom is at or below 30%, other tasks are routed elsewhere (`quota.reserved`).
- **`cost.unknownUnderLimit`**: with `--max-cost` (`maxCostUsd`), a resource whose cost cannot be
  estimated is rejected (`reject`, default) or allowed (`allow`).
- Per task: `--max-cost <usd>` and `--require-known-quota` on `nexar route` and `nexar run`.

Quota is never read from vendor dashboards, private APIs or credential stores. With nothing declared
or observed, quota is `unknown`, which is neither unlimited nor zero.

### Discovery

```json
{
  "discovery": {
    "enabled": false,
    "refreshIntervalMs": 600000,
    "timeoutMs": 3000,
    "excludeIds": [],
    "sources": {
      "cli": { "enabled": true },
      "piCatalog": { "enabled": false, "providers": ["anthropic"], "maxModels": 50 },
      "localEndpoints": {
        "enabled": true,
        "endpoints": [{ "id": "ollama", "kind": "ollama", "baseUrl": "http://127.0.0.1:11434" }]
      }
    }
  }
}
```

`nexar resources --discovered` always shows what discovery finds and a per-source report;
discovered resources join routing only with `"enabled": true`. Configured resources win every id
collision. CLI detection only stats `claude`, `codex`, `agy` and `dsh` on `PATH` (with `PATHEXT` on
Windows); it never runs them. The pi catalog needs an explicit provider list. Endpoints are contacted
only if listed here, with no redirects and bounded responses. Discovered ids cannot be referenced
from routing rules; to prefer one, add it to `resources`.
