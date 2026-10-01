Write technical documentation in Markdown for the project "{{project.displayName}}".

## Subject

{{inputs.subject}}

## Audience

Write for the audience described below. If none is given, assume an engineer who is new to this system.
{{#if inputs.audience}}

{{inputs.audience}}
{{/if}}

## Scope and key facts

{{inputs.scope}}
{{#if inputs.references}}

## Reference documents

These files are in the project. Read the ones you need with your own tools; their content is not included here.

{{documents.references}}
{{/if}}
{{#if inputs.sections}}

## Requested sections

Include these sections, in this order, and add others only where they are clearly needed:

{{inputs.sections}}
{{/if}}

## Output requirements

- Start with a title and a two-to-three sentence summary of what the subject is and who the document is for.
- Unless sections are requested above, cover: Overview, Architecture or structure, Key concepts, How it works, Configuration, Operations (run, monitor, troubleshoot), Security considerations, Known limitations, Further reading.
- Be precise and concise. Prefer short paragraphs, tables and lists to long prose. Use code blocks for commands and configuration.
- Mark anything you could not confirm from the inputs or the referenced files as "Assumption:" or list it under a final "Open questions" section. Do not invent details.
- Output only the document, in Markdown.
