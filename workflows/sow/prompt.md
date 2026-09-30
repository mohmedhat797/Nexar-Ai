Draft a Statement of Work (SOW) in Markdown for the project "{{project.displayName}}".

## Client

{{inputs.clientName}}

## Objectives

{{inputs.objectives}}
{{#if inputs.deliverables}}

## Deliverables provided by the owner

{{inputs.deliverables}}
{{/if}}
{{#if inputs.timeline}}

## Timeline provided by the owner

{{inputs.timeline}}
{{/if}}
{{#if inputs.assumptions}}

## Assumptions provided by the owner

{{inputs.assumptions}}
{{/if}}
{{#if inputs.references}}

## Reference documents

These files are in the project. Read the ones you need with your own tools; their content is not included here.

{{documents.references}}
{{/if}}

## Output requirements

Use exactly these sections, in this order:

1. **Purpose**: why this work exists, in a short paragraph.
2. **Scope**: what is in scope, stated so that it can be checked.
3. **Deliverables**: a table with name, description and acceptance criterion for each.
4. **Timeline**: milestones and dates or durations. Use only what was provided; otherwise propose a structure and mark the dates "TBD".
5. **Roles and responsibilities**: for the provider and for the client.
6. **Acceptance**: how and by whom each deliverable is reviewed and accepted, and how long a review takes.
7. **Assumptions**: the provided ones plus any you had to make, each marked clearly.
8. **Exclusions**: what is explicitly out of scope.
9. **Change control**: how changes to scope, timeline or price are requested, assessed and approved.

Rules: do not invent prices, dates, names, legal terms or commitments. Use "TBD" and list the gaps under a closing "Open items" list. This is a draft for the owner to review; it is not an offer and has not been sent.
