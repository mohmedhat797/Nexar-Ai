# NXR-015: Project context (per-project settings, document sets, directory allowlists)

**Milestone:** v0.2 — Personal Work · **Labels:** core · **Depends on:** none

## Summary

Add a first-class "project" concept: per-project settings, named document sets and an allowlist of working
directories that tasks may use.

## Problem

`TaskOrigin.project` is only a string, and `TaskInput.workingDirectory` is an unchecked path
(both in [`@nexar/contracts`](../../packages/contracts/src/task.ts)). Nothing defines what a project is, which
files belong to it, or which directories a resource may touch. The roadmap (v0.2) requires per-project settings and document sets.

## Objective

A task that names a project picks up that project's defaults and documents, and any working directory
outside the project's allowlist is rejected before execution.

## Scope

- Project config schema in `@nexar/core` config: id, display name, root directories, allowed working
  directories, document sets (named lists of paths/globs), default task requirements (for example `privacy`), preferred resources.
- Resolution: merge project defaults into `NexarTask.requirements` (explicit task values win).
- Validation of `workingDirectory` against the allowlist after resolving symlinks and `..`.
- CLI: `nexar projects list` and `--project <id>` on `run`/`route`.
- Document sets become `attachments` (`ArtifactRef`s), not inlined content.

## Out of scope

- Retrieval, embeddings or memory over documents (v0.6).
- Artifact output location rules ([NXR-016](016-artifact-storage.md)).
- Multi-user or remote projects.

## Technical notes

- Config holds references and paths only; it must reject inline secrets (existing rule). Example config goes in `config/`.
- Path checks use real paths to defeat symlink escapes; deny if the path cannot be resolved.
- `workingDirectory` is what subprocess adapters use as `cwd` (see [ADR-002](../adr/002-deepseek-harness-execution-kernel.md)),
  so the check must run in the engine before `execute`, not inside one adapter.
- Violations return `POLICY_REJECTED` (or `VALIDATION_ERROR` for a malformed config).
- Project settings can carry `preferredResourceIds` and `excludedResourceIds`, already part of `TaskRequirements`.

## Acceptance criteria

- [ ] A project can be declared in config and listed by the CLI.
- [ ] Project defaults merge into task requirements with explicit values taking precedence.
- [ ] A working directory outside the allowlist (including via symlink or `..`) is rejected.
- [ ] Document sets resolve to attachments and missing files produce a clear error.
- [ ] Example config and documentation are updated.

## Testing expectations

Offline tests on temp directories: merge precedence, allowlist acceptance/rejection, symlink escape,
missing documents, config validation. No live tests.

## Security considerations

This is a filesystem trust boundary: canonicalize before comparing, fail closed, and never pass a
path outside the allowlist to a runtime. Do not log document contents or full paths at info+ if they reveal client names.
