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
