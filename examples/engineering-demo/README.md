# Engineering demo

A tiny Node library (`template/`) and a Nexar config for running one sandboxed engineering task
against it. Nexar edits a private worktree inside a bubblewrap sandbox, runs the project gate
(`node --test`) on a fresh clone, has a different resource review the patch, asks you to approve,
and then makes a commit on a `nexar/<task>` branch. It never pushes.

Requirements: the engineering plane from `docs/integration/wsl2-engineering-plane.md` (bubblewrap
0.8+, `socat`, Node under `/opt/node22`), plus signed-in `claude` and `codex` CLIs in the same
environment.

## 1. Create the demo repository and config

```sh
examples/engineering-demo/setup.sh /tmp/nexar-demo
```

This copies `template/` into a fresh git repository at `/tmp/nexar-demo/repo` (branch `main`) and
writes `/tmp/nexar-demo/nexar.config.json`, with the repository path substituted into
`nexar.config.template.json`. Nexar keeps its local state (`.nexar/`) next to that config file.

The config's `engineering.toolchainPaths` is `["/opt/node22"]`: change it if your Node lives
elsewhere. The sandbox binds toolchain directories read-only at the same path. (JSON has no
comments, so the explanations for the config live here.)

## 2. Add credential mounts

Agents inside the sandbox cannot see your home directory. A runtime that needs its login directory
gets it bound in, narrowly. In `/tmp/nexar-demo/nexar.config.json`, edit
`runtime.options.sandbox.mounts` of the `claude-code` resource. It is empty in the template on
purpose, because the right paths depend on your machine. Each entry has this shape:

```json
{
  "hostPath": "<absolute host directory>",
  "sandboxPath": "<where the agent expects it>",
  "access": "read-write"
}
```

Mount only the runtime's own credential directory, never your whole home. Nexar never reads these
files; it only hands the mount to the sandbox. The `codex` adapter binds its own `CODEX_HOME`
itself; set `runtime.options.codexHome` (an absolute path) on that resource if yours is not the
default.

## 3. Check the sandbox

```sh
nexar --config /tmp/nexar-demo/nexar.config.json doctor
nexar --config /tmp/nexar-demo/nexar.config.json sandbox selftest
```

`selftest` runs real processes in the sandbox: workspace writable, root read-only, `.git`
protected, host files hidden, loopback-only network, and the proxy denies non-allowlisted hosts.
Every check must pass (exit code 0). Exit code 7 means bubblewrap is unavailable.

## 4. Run a task

```sh
nexar --config /tmp/nexar-demo/nexar.config.json engineer run \
  --project engineering-demo "Make slugify keep digits and collapse repeated dashes"
```

Progress goes to stderr (lanes, gates, review). The goal text is never printed. When the gates pass
and the reviewer approves, it prints `awaiting owner approval` and waits.

## 5. Approve

In a second terminal:

```sh
nexar --config /tmp/nexar-demo/nexar.config.json approvals list
nexar --config /tmp/nexar-demo/nexar.config.json approvals approve <id>
```

Check that the branch, file count and patch hash match what `engineer run` printed. The request
expires after `engineering.approvalTtlMs` (30 minutes by default). A denied or expired request ends
the task as `not-accepted` (exit code 6).

## 6. Inspect the result

```sh
nexar --config /tmp/nexar-demo/nexar.config.json engineer list
nexar --config /tmp/nexar-demo/nexar.config.json engineer show <task-id>
git -C /tmp/nexar-demo/repo log --stat main..nexar/<task-id>
git -C /tmp/nexar-demo/repo diff main...nexar/<task-id>
```

Merging or deleting the branch is up to you. `nexar engineer cleanup <task-id>` removes the task's
worktree; it never touches branches in your repository.

Exit codes of `engineer run`: 0 committed, 6 not accepted (review, gates or owner said no), 130
interrupted, otherwise the usual error codes (1 failure, 3 no eligible resource, 4 auth required,
5 timeout, 7 sandbox unavailable).
