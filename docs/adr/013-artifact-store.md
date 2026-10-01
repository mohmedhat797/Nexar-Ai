# ADR-013: Local artifact store

**Status:** Accepted (2026-09-30) · Issue: #12 (NXR-016)

## Context

Workflows and Work Bridge requests produce documents that must outlive a single tool call (OpenWorker
kills a call after 120 s). `ArtifactRef` already existed in `@nexar/contracts`, but nothing wrote
files. File names arrive from untrusted places: a request, a workflow input, or model output. Stored
documents can contain client data, and they must never land in source control by accident.

## Decision

- `@nexar/artifacts` provides `LocalArtifactStore` behind an `ArtifactStore` port
  (`store()` and `list()`).
- **Layout:** `<project first root>/.nexar/artifacts/<task id>/<file>`. Drafts go under
  `.../<task id>/drafts/` and carry `draft: true` in their `ArtifactRef`. A project may set a relative
  `artifactsDirectory`; it must stay inside the root.
- **Git hygiene:** the store writes `.nexar/.gitignore` containing `*` (created with `wx`, never
  overwritten), including when `.nexar/` already existed. A custom `artifactsDirectory` gets none.
- **Safe names:** `sanitizeFilename` keeps the last path segment, allows `[A-Za-z0-9._-]` only, strips
  control characters, avoids Windows reserved names, limits length to 100, and forces the extension
  to match the media type (`text/markdown`, `text/plain`, `application/json`, `text/csv`). A model
  cannot produce `.sh` or `.html`.
- **No overwrite:** files open with `O_EXCL` (`wx`, mode 0600). A collision gets `-2`, `-3`, … up to
  99, then `VALIDATION_ERROR`. `O_EXCL` also refuses an existing or dangling symlink.
- **Containment:** directories are created one level at a time (mode 0700) and canonicalized with
  `realpath` after each level, so a symlink swapped into any level is caught before anything is
  written beyond it (ADR-012). Rejections are `POLICY_REJECTED` and never contain the path. Listing
  reads only regular files, opened with `O_NOFOLLOW`.
- **Size limit:** 5 MiB by default; nothing is written above it.
- **Refs, not content:** an `ArtifactRef` holds `file:` URI, label (project-relative path), media type,
  size and SHA-256. The engine emits an `artifacts.stored` telemetry event with refs only.
- **Surfaces:** the Work Bridge `output` option, workflow outputs, and `nexar artifacts list --project
<id> --task <id>`.

## Rationale

Artifacts live with the project so the owner finds them next to their work, and so one containment
rule (the project roots) covers reads and writes. Per-level canonicalization plus `O_EXCL` is the
cheapest approach that holds against hostile names and pre-planted symlinks without a sandbox.
Restricting extensions to text types keeps every artifact inert.

## Alternatives considered

- A central store under the Nexar state directory: artifacts would be separated from their project and
  would need a second containment rule.
- Overwrite or version in place: loses earlier results silently; numeric suffixes are explicit.
- Accepting the caller's extension: lets a model choose an executable or HTML file type.
- Storing content in telemetry: telemetry stays metadata-only; content can be client data.

## Consequences

- Artifacts sit under a git-ignored `.nexar/` in the project by default, with owner-only permissions.
- Only the first project root holds artifacts.
- Binary formats (DOCX, PDF, PPTX) are not produced; see NXR-017.

## Risks

- A check-then-use (TOCTOU) window remains between canonicalizing a directory and opening the file in
  it. Mitigated by per-level checks and `O_EXCL`; closed only by OS-level sandboxing (#17).
- Nothing removes old artifacts; retention is the owner's job.
- A custom `artifactsDirectory` is not git-ignored automatically.

## Follow-up work

Retention and cleanup policy, document export formats (NXR-017), artifact import by reference for
runtimes that write their own files.
