# NXR-017: Document export formats (DOCX, PDF, PPTX)

**Milestone:** unscheduled · **Labels:** personal-work, core · **Depends on:** NXR-016

## Summary

Convert the Markdown artifacts that workflows produce into DOCX, PDF and PPTX files, so a SOW or proposal
can be handed to a client without manual reformatting.

## Problem

v0.2 workflows ([NXR-012](012-documentation-workflows.md)) store Markdown, plain text, JSON and CSV only
([ADR-013](../adr/013-artifact-store.md)). Owners who write SOWs and proposals usually deliver Word, PDF
or slide files. The store refuses other extensions so a model cannot produce an active document.

## Objective

An opt-in export step that turns a finished artifact into a binary document stored next to it, keeping
the artifact store's guarantees.

## Scope

- An `ArtifactExporter` port with one implementation per format, run on an existing artifact, never on
  model output directly.
- Extend the artifact store with binary media types for the exporters' output only (allowlisted, extension
  forced to match), keeping `O_EXCL`, containment and size limits.
- CLI `nexar artifacts export` and, later, an MCP/Work Bridge option, both scoped and audited like other work.
- An ADR choosing the conversion approach (library or local tool) and its dependency policy.

## Out of scope

- Uploading, emailing or publishing the exported file (outward actions need an executor and an ADR, see
  [ADR-016](../adr/016-human-approvals.md)).

## Technical notes

- Converters parse untrusted Markdown and write complex formats; a fixed, exact-pinned dependency (or a
  local tool launched with an explicit minimal environment) behind an adapter, per
  [ADR-008](../adr/008-upstream-isolation.md).
- Output stays inside the project and is marked `draft` when the source was a draft.

## Acceptance criteria

- [ ] An export is created from a stored Markdown artifact and returned as an `ArtifactRef` with SHA-256.
- [ ] The source is unchanged, an existing export is never overwritten, and draft sources give draft exports.
- [ ] No macros, scripts or auto-loading external references appear in any output format.
- [ ] Draft sources produce draft exports.
- [ ] Oversized input fails with `VALIDATION_ERROR`.

## Testing expectations

Offline tests with golden structure checks (opening the output with a parser, not byte comparison),
traversal and symlink cases reused from the artifact store, and a static check that no active-content
constructs are emitted. No live tests.

## Security considerations

Binary formats are parsed by other people's software: a hostile document is an attack on the reader. Keep
output minimal and inert, never follow links or fetch resources during conversion, and do not add this
before a dependency review. Not planned before a security review.
