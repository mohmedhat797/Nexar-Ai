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
  "workingDirectories": ["../examples/demo-project"],
  "documentSets": {
    "overview": ["../examples/demo-project/README.md", "../examples/demo-project/docs"]
  },
  "defaults": { "capabilities": ["knowledge-work"], "preferredResourceIds": ["claude-code"] }
}
```

- `roots` (at least one) bound everything the project may touch. `workingDirectories` default to the
  roots and must each be inside a root. Relative paths resolve against the config file's directory;
  every path must exist and be a directory, otherwise Nexar fails with `CONFIGURATION_ERROR`.
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
| `deepseek-harness` | `deepseek-harness` | DeepSeek `deepseek-v4-flash`, needs `DEEPSEEK_API_KEY`    |
| `anthropic-sonnet` | `pi`               | `claude-sonnet-4-5` by API, needs `ANTHROPIC_API_KEY`     |

Routing: `claude-code` is the default resource. Per task kind, preferences are `coding` →
claude-code, deepseek-harness; `review` → claude-code; `documentation` → anthropic-sonnet,
claude-code; `analysis` → anthropic-sonnet, deepseek-harness, claude-code. A `taskKinds` entry
replaces the built-in rule for that kind, so each one repeats its `requiredCapabilities`.

**The example deliberately contains no `local-echo` test double.** In a real configuration an
always-eligible echo resource would silently "succeed" whenever the real resources are unavailable.
When nothing is eligible, Nexar reports `NO_ELIGIBLE_RESOURCE` with the reasons instead. The offline
echo resource exists only in the built-in default configuration (used when no config file is found).
