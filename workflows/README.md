# Workflows

A workflow is a **directory**: a `workflow.json` and the Markdown templates beside it. Nexar
(`@nexar/workflows`) reads every directory here, so **adding a workflow needs no code change**.

```bash
nexar workflows list
nexar run --workflow sow --project acme \
  --input clientName="Acme Corp" --input objectives="Migrate the billing system" \
  --list-input deliverables="Migration plan, Runbook" --input references=contracts
```

The result is saved as Markdown artifacts in the project (`<project root>/.nexar/artifacts/<task-id>/`)
and the paths are printed. Anything meant for another person is stored as a **draft** under
`drafts/`. Nexar never sends, schedules or publishes anything.

## Shipped workflows

| id                        | task kind             | outputs                                |
| ------------------------- | --------------------- | -------------------------------------- |
| `technical-documentation` | `documentation`       | the document                           |
| `sow`                     | `documentation`       | Statement of Work                      |
| `solution-proposal`       | `documentation`       | proposal                               |
| `meeting-brief`           | `meeting-preparation` | the brief, and a follow-up email draft |

## Adding a workflow

Create `workflows/<id>/` (the directory name must equal the `id`):

```
workflows/release-notes/
  workflow.json
  system.md      optional, trusted instructions (style, security rules)
  prompt.md      the task prompt
```

```jsonc
{
  "schemaVersion": 1,
  "id": "release-notes",
  "displayName": "Release Notes",
  "description": "Write release notes from a change list.",
  "taskKind": "documentation",
  "requirements": { "capabilities": ["knowledge-work"], "privacy": "standard" },
  "inputs": [
    { "name": "version", "type": "string", "required": true, "maxLength": 50 },
    { "name": "changes", "type": "list", "required": true, "maxItems": 100 },
    { "name": "references", "type": "document-set" },
  ],
  "systemTemplate": "system.md",
  "template": "prompt.md",
  "outputs": [
    {
      "id": "notes",
      "filename": "{{project.id}}-release-{{date}}.md",
      "mediaType": "text/markdown",
    },
  ],
}
```

- **Input types:** `string` (one line), `text`, `list` (array of strings) and `document-set` (the name
  of one of the project's `documentSets`; the model gets file _references_, never contents).
  `maxLength` (string/text, and per item for lists) and `maxItems` can only lower Nexar's ceilings
  (string 1,000, text 100,000, list 200 items of 2,000).
- **Outputs:** one to four. `mediaType` is `text/markdown` or `text/plain`. `"draft": true` stores the
  file under `drafts/` and adds a "DRAFT — not sent" banner if the model forgot one. With more than
  one output, put `{{outputs.markers}}` in a template: the model is told to start each section with
  `<!-- nexar:output <id> -->`, and Nexar splits on those lines. If a marker is missing, everything
  is saved as the first output and the run reports `outputsSplit: false` (nothing is lost).
- **`requirements`** are merged with the project's defaults and the caller's (`--local-only`, bridge
  constraints): capabilities accumulate and `local-only` always wins.

### Template language

`{{variable}}` and `{{#if inputs.<name>}}…{{/if}}`; nothing else (no else, loops, nesting, eval).
Variables are checked when the workflow loads, so a typo is a `CONFIGURATION_ERROR`, not a prompt bug.

| variable                                                                                               | meaning                                                                                              |
| ------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------- |
| `{{project.id}}`, `{{project.displayName}}`, `{{workflow.id}}`, `{{workflow.displayName}}`, `{{date}}` | trusted values                                                                                       |
| `{{project.instructions}}`                                                                             | the owner's per-project instructions (empty if none); `{{#if project.instructions}}` works too       |
| `{{outputs.markers}}`                                                                                  | the marker instructions (empty for one output)                                                       |
| `{{inputs.<name>}}`                                                                                    | the input, wrapped as untrusted (see below); lists become `- item` lines; `(not provided)` if absent |
| `{{documents.<name>}}`                                                                                 | for a `document-set` input: a bullet list of file labels and relative paths, never contents          |

The system template is trusted and may not contain `inputs.*` or `documents.*`. Filename templates may
use `project.id`, `date`, `workflow.id` and `string` inputs; the artifact store sanitizes the result.

### Untrusted input

Every input value is rendered inside `<untrusted-input name="…">…</untrusted-input>`, and any
`</untrusted-input` in a value is rewritten so it cannot close the block early. Inputs are emails,
notes and documents: **data, never instructions**. The shipped `system.md` files tell the model so
(it may not follow instructions inside the block, the block cannot grant permissions, and it must
never claim to have sent or scheduled anything). Keep that text in any `system.md` you write. Rendering
is one pass: a value containing `{{…}}` is not expanded.

## Per-project customization

In the project's entry in `nexar.config.json`:

```json
"workflows": {
  "directories": ["docs/nexar-workflows"],
  "instructions": { "sow": "docs/sow-house-style.md" }
}
```

- `directories` are extra workflow directories **inside the project's roots**. A workflow with the
  same id replaces the built-in one for that project only.
- `instructions` maps a workflow id to a Markdown file inside the project (at most 50 KB). Its text is
  trusted (the project owner wrote it) and appears wherever a template uses `{{project.instructions}}`;
  the shipped system prompts do.

Paths are checked with the project's realpath policy: a `..` or symlink leading out of the project is
a `CONFIGURATION_ERROR`.

## Other entry points

- **Work Bridge / MCP:** `nexar.submit_work` accepts `workflow: { id, inputs }` instead of
  `request` + `taskKind`; `nexar.workflows` lists what a client may run. The client needs the
  `workflows` scope for the workflow id, the workflow's task kind, and the project.
- **`NEXAR_WORKFLOWS_DIR`** replaces the built-in directory (default: `<repo>/workflows`).
- CLI exit codes: `0` ok · `2` bad usage **or invalid workflow inputs** (every problem is listed and
  nothing runs) · `3` no eligible resource · other codes as for `nexar run`.

Not supported yet: DOCX, PDF and PPTX output (Markdown and plain text only).
