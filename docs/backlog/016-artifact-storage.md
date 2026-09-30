# NXR-016: Artifact storage (`ArtifactRef` → project files)

**Milestone:** v0.2 — Personal Work · **Labels:** core · **Depends on:** NXR-015

## Summary

Persist outputs that adapters or workflows produce as files under the project, and return them as
`ArtifactRef`s in results, telemetry and Work Bridge responses.

## Problem

`ArtifactRef` (`uri`, `mediaType`, `label`) and `ExecutionResult.artifacts` exist in
[`@nexar/contracts`](../../packages/contracts/src/artifacts.ts), but nothing writes artifacts: results carry
only `text`. Documentation workflows ([NXR-012](012-documentation-workflows.md)) and meeting briefs
([NXR-013](013-meeting-brief-and-communication-drafts.md)) need durable, findable outputs.

## Objective

An artifact store that writes a result or attached blob to a deterministic location inside the project
and returns an `ArtifactRef` that points at it.

## Scope

- `ArtifactStore` port in `@nexar/core` with a local-filesystem implementation.
- Layout under the project, for example `<project>/.nexar-artifacts/<taskId>/<name>` (layout to be confirmed in the PR).
- Safe naming: sanitized file names, no overwrite without an explicit policy (suffix or fail).
- `file:` URIs in `ArtifactRef`; media type from extension or caller; label from the workflow.
- Engine wiring: save `ExecutionResult.text` as an artifact when a workflow asks for it; record refs in `ExecutionRecord`.
- CLI prints artifact paths; `nexar artifacts list --task <id>`.

## Out of scope

- Remote/cloud storage, sync or encryption at rest.
- Format conversion (docx/pptx/pdf).
- Retrieval and indexing (v0.6).

## Technical notes

- Only `ArtifactRef` types are shared; storage logic stays in `@nexar/core` and does not belong in contracts.
- Writes must stay inside the project's allowed directories ([NXR-015](015-project-context.md)); reject path traversal in names.
- Use an injected clock and id generator so paths are deterministic in tests.
- Telemetry references artifacts by `ArtifactRef`; it never embeds content.
- Files are written with restrictive permissions (0600 by default, since contents may be sensitive); confirm
  the default during review.
- If an adapter later produces artifacts itself (for example a runtime's own files), the store imports by
  reference; define that behavior as part of this item or a follow-up.

## Acceptance criteria

- [ ] Saving a result creates a file in the project and returns a valid `ArtifactRef`.
- [ ] A name containing `..`, separators or control characters cannot escape the artifact directory.
- [ ] Existing files are never silently overwritten.
- [ ] Artifact refs appear in the `ExecutionRecord` and the CLI output.
- [ ] Artifact listing for a task works.

## Testing expectations

Offline tests on temp directories: happy path, traversal attempts, collisions, permissions, deterministic
paths with injected clock/ids. No live tests.

## Security considerations

Path traversal and symlink escapes are the main risks: canonicalize and check against the project root.
Artifacts can contain client data, so use restrictive permissions and keep the directory out of git by default.
