# ADR-017: Data-driven workflows with an untrusted-input boundary

**Status:** Accepted (2026-09-30) · Issues: NXR-012, NXR-013

## Context

v0.2 needs repeatable owner-facing work: technical documentation, statements of work, proposals and
meeting briefs. Task kinds are already data (ADR-005). Inputs to these tasks are emails, notes and
documents written by third parties, which makes every input a prompt-injection vector, and the results
(emails, invitations) must never be sent automatically (ADR-016).

## Decision

- A workflow is a directory under `workflows/` (or a project-configured directory): `workflow.json`
  validated with zod, plus Markdown templates. Adding one needs no TypeScript change.
- `@nexar/workflows` owns the catalog, a tiny template renderer (`{{var}}` and `{{#if}}` only, variables
  checked at load, single-pass, no library, no eval) and the runner. It depends on contracts, core,
  projects and artifacts only. It has no mail, calendar or HTTP client and never calls
  `performOutwardAction`; a static test enforces this.
- **Untrusted-data boundary:** every input is rendered inside `<untrusted-input name="…">`, with a
  closing tag in the value neutralized. The trusted system template cannot contain input values. The
  shipped system prompts state that such content is data, cannot grant permissions, and that nothing is
  ever claimed as sent. Inputs never choose the project, working directory, requirements or scopes: the
  task is built from the workflow and the project only.
- Document sets reach the model as file references (labels and relative paths), never as content.
- Inputs are validated before any resource is involved (`VALIDATION_ERROR`, `details.issues`).
- Outputs are stored through the artifact store; a `draft` output goes under `drafts/` and is bannered
  "DRAFT — not sent". Multi-output workflows split on `<!-- nexar:output <id> -->` marker lines; missing
  markers put everything in the first output and report `outputsSplit: false`.
- Per-project customization lives in project config (`workflows.directories`, `workflows.instructions`),
  validated with the realpath policy. Project instructions are owner-controlled and trusted.
- The Work Bridge accepts `workflow: { id, inputs }` as an alternative to `request` + `taskKind`;
  authorization checks the client's `workflows` scope, the workflow's task kind and the project; audit
  records carry the workflow id and artifact count. MCP gains `nexar.workflows`.

## Rationale

Data-driven definitions keep prompts reviewable and versioned, and let owners add content without
code. A fixed wrapper plus a trusted/untrusted split is the cheapest defence that holds for every
model; it does not make injection impossible, so the real guarantee is structural: the workflow
layer cannot act outward, and everything it produces is a local file.

## Alternatives considered

- A template library (Handlebars and similar): evaluation surface and dependency for little gain.
- Letting clients send a system prompt with a workflow: would defeat the trusted/untrusted split.
- Inlining document contents: larger injection surface and context cost; the agent can read files with
  its own tools.

## Consequences

- Models are told the boundary, not forced by it: output still needs human review.
- Project instructions live in the project tree, so anything with write access to it can change them.
- DOCX/PDF/PPTX output is future work.

## Follow-up work

Live quality checks per workflow (opt-in); per-workflow input schema in the MCP tool definition.
