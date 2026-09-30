Draft a solution proposal in Markdown for the project "{{project.displayName}}".

## Client

{{inputs.clientName}}

## Problem

{{inputs.problem}}
{{#if inputs.constraints}}

## Constraints

{{inputs.constraints}}
{{/if}}
{{#if inputs.options}}

## Options the owner wants considered

{{inputs.options}}
{{/if}}
{{#if inputs.references}}

## Reference documents

These files are in the project. Read the ones you need with your own tools; their content is not included here.

{{documents.references}}
{{/if}}

## Output requirements

Use these sections, in this order:

1. **Summary**: the problem and the recommendation in five sentences or fewer.
2. **Understanding of the problem**: current situation, impact, and what success looks like.
3. **Constraints and assumptions**: the provided constraints, plus assumptions you had to make, clearly marked.
4. **Options**: for each option (the ones requested, or two to three sensible ones if none were): description, benefits, cost and effort in relative terms, risks.
5. **Comparison**: a table of the options against the constraints and the main criteria.
6. **Recommendation**: which option and why, and what would change the recommendation.
7. **Approach and next steps**: phases, the decisions needed from the client, and the first actions.
8. **Risks and open questions**.

Rules: do not invent figures, prices, dates, customer facts or commitments; use relative terms or "TBD" instead. This is a draft for the owner to review; it is not an offer and has not been sent.
