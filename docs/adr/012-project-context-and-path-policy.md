# ADR-012: Project context and realpath path policy

**Status:** Accepted (2026-09-30) · Issue: #11 (NXR-015)

## Context

v0.2 accepts work from outside the owner's terminal (OpenWorker over MCP). Agent runtimes (Claude
Code, DeepSeek Harness) use `task.input.workingDirectory` as their `cwd`, so an unchecked directory is
a filesystem escape. The v0.1 Work Bridge used a lexical containment check, which a symlink such as
`allowed/link -> /outside/private` defeats.

## Decision

- **Projects are first-class** (`@nexar/projects`). A project has an id, a display name, real root
  directories, allowed working directories, named document sets, default task requirements, and
  metadata. It is declared in `nexar.config.json`, with paths relative to the config file.
- **One path primitive, `resolveContainedPath`.** It resolves against a base, runs `fs.realpath`
  (following every symlink and `..`), and fails closed on any error. It then requires the real path
  to be inside a canonical root. Rejections are `POLICY_REJECTED` with a stable reason code and
  **never contain the path**. Every Nexar component that touches the filesystem for untrusted input
  uses it (projects, artifacts, workflows).
- **The engine enforces workspace policy before routing** (`Nexar.run`), so no adapter ever receives
  an unchecked working directory. The canonical path flows onward, never the original input. The
  default policy is `project-only`. The CLI alone uses `project-or-unscoped`, because the owner at
  their own terminal may run unscoped. The Work Bridge rejects any `workingDirectory` without a
  `project`.
- **Default merging** (task values win, except where safety requires otherwise):

  | Field                | Rule                                                                      |
  | -------------------- | ------------------------------------------------------------------------- |
  | capabilities         | union                                                                     |
  | privacy              | stricter wins: an explicit `standard` cannot relax a `local-only` project |
  | preferredResourceIds | explicit if given, else the project's                                     |
  | excludedResourceIds  | union (exclusions accumulate)                                             |
  | minContextTokens     | explicit, else the project's                                              |
  | maxCostUsd           | minimum of the defined values                                             |

- **Document sets resolve to references, never content** (`file://` `ArtifactRef`s). Directories are
  expanded with every file re-checked, symlinks out of the root are rejected, and each set is capped
  at 500 files.

## Rationale

Realpath comparison is the only check that matches what the OS will actually open. Enforcing it in
the engine, the one choke point every execution passes through, means a new adapter cannot forget
it. Stricter-wins merging makes sure request data can never weaken a project's policy.

## Alternatives considered

- Per-adapter checks: rejected; they are easy to forget and duplicate code.
- `O_NOFOLLOW`-style open-time checks only: insufficient for a directory handed to another process
  as its `cwd`.
- An OS sandbox: needed for defense in depth, tracked in #17 (NXR-024, v0.3).

## Consequences

- External requests must name a registered project.
- A project whose roots do not exist fails config loading. The system fails closed, not silently.

## Risks

- There is a check-then-use (TOCTOU) window: a symlink swapped inside the project after the check
  and before the runtime uses it is not detected. This is mitigated by passing the canonical path,
  and fully addressed only by OS-level sandboxing (#17).

## Follow-up work

Per-project workflow directories and instructions (ADR-017); artifact locations (ADR-013).
