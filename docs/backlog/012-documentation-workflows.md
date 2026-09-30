# NXR-012: Documentation workflows (technical docs, SOW, proposals)

**Milestone:** v0.2 — Personal Work · **Labels:** personal-work · **Depends on:** NXR-016

## Summary

Add repeatable workflows for technical documentation, statements of work and proposals, defined as task
kinds plus prompt templates that produce a document artifact.

## Problem

The roadmap lists technical documentation, SOW and proposal workflows for v0.2, but Nexar has only
generic task kinds (`documentation`, `analysis`, …) and no template mechanism. Owners re-type the same
structure each time, and output quality and format vary between runs.

## Objective

`nexar run --workflow sow --project acme` (name illustrative) gathers inputs, renders a template into a
prompt, routes it through the NRC and saves the result as a Markdown artifact in the project.

## Scope

- A workflow definition format: id, task kind, required capabilities, input fields, prompt template, output artifact spec.
- Shipped templates: technical document, SOW, proposal (concise, editable by the owner).
- Template variables from CLI flags or a project's document set ([NXR-015](015-project-context.md)).
- Output written as an `ArtifactRef` via artifact storage ([NXR-016](016-artifact-storage.md)).
- Usable from the CLI and from the Work Bridge (`taskType` mapping).

## Out of scope

- docx/pptx/xlsx generation (research: depth in OpenWorker is unverified); Markdown first.
- Sending or publishing documents ([NXR-014](014-human-approval-framework.md)).
- Memory or retrieval over past documents (v0.6).

## Technical notes

- Task kinds are data, not code ([ADR-005](../adr/005-resource-controller-ownership.md)): add kind-to-capability rules
  (for example `documentation` needs `knowledge-work`) through config, not new enum members. `TaskKind`
  is an open string in `@nexar/contracts`.
- Templates live in a Nexar-owned directory (for example `config/workflows/` or per project); prompts
  stay in files, not code, so they can be reviewed and versioned.
- Missing required fields raise `VALIDATION_ERROR` before any resource is called.
- `TaskRequirements.privacy` may be set per workflow (client documents often need `local-only`).
- Pick the engine per NRC policy; OpenWorker can take the work later via the Work Bridge, not as a hard dependency.

## Acceptance criteria

- [ ] Three shipped workflows (technical doc, SOW, proposal) run offline against the echo adapter.
- [ ] Workflow definitions are validated with clear errors for missing/unknown fields.
- [ ] Output is saved as an artifact and the path is printed.
- [ ] Workflows can declare `privacy: local-only`, and routing honors it.
- [ ] Documentation explains how to add a new workflow without code changes.

## Testing expectations

Offline tests for template loading, variable substitution, validation errors, routing inputs and artifact
output using the echo adapter. Quality of real model output is checked manually (opt-in live).

## Security considerations

Templates and inputs may contain client data: do not log rendered prompts at info+. Treat
document sets as untrusted (prompt-injection risk); never auto-send or publish output.
