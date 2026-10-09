# NXR-066: standalone delegation argument correction

This is an offline remediation based on `455985746c51ff381dd0b1a24fdbb40129088119`.
It does not establish successful live delegation or merge readiness.

## Historical cause

Classification: **MODEL_ARGUMENT_GENERATION**. Pinned OpenWorker 0.3.1
(`andrewyng/openworker`, commit `b9b35036668dfb1653f3aa35bafb9aeea6d47c3c`) audit
records preserve the proposed arguments before permission resolution and MCP execution:

| Upstream acceptance turn | Unit | Supplied reviewOf | Audit proposed row |
| --- | --- | --- | --- |
| `turn_3766547e736c1162d0d78396fe59c296` | `nxr066-review` | `nxr066-review` | 547 |
| `turn_c37dab4fe8e6af075122ebd98e19c059` | `nxr066-analysis` | `nxr055-analysis` | 559 |

The first reference is self-referential; the second was never admitted in that
grant. Both were correctly rejected before NRC allocation or worker execution.
The raw provider wire response was not retained, but the selected argument values
are available in upstream audit rows. No invented reconstruction is used. Audit
`finished / ok` denotes transport completion, not successful Bridge admission.

Only these two turns' submit metadata was queried with SQLite read-only access.
Prompts, generated content, credentials and unrelated sessions were not extracted.
The earlier operational observer missed upstream fields because it inspected the
envelope rather than nested `data`; its Bridge observation recorded presence only.

## Argument path and reproduction

The real relay `tools/list` advertises `reviewOf` as an optional string, without a
default. OpenWorker `mcp/tools.py::_openai_schema`, `build_callables`,
`providers/openai_provider.py::_parse_tool_calls`, `tools/registry.py::execute`
and `mcp/client.py::call` preserve supplied arguments. Nexar's Model Turn port
preserves tool parameters and returned argument objects. The actual pi-ai 0.99.2
account path preserves optionality and omits the strict flag; it adds no arguments.
The fake Responses fixture does not establish remote service behavior.

`normalizeReviewOf` intentionally converts null, empty/whitespace strings and
case-insensitive `none`/`null` sentinels to absence on the existing default
contract. Real IDs remain unchanged. The endpoint builds lineage from the trusted
grant and omits normalized absence. Bridge validation requires a distinct earlier
admitted unit in the same grant, before admission counting, job creation or NRC.

Offline fixtures exercise seven argument cases, pinned upstream source functions,
the actual advertised MCP schema, the real relay/endpoint/Bridge and a fake worker.
A separate real account Model Turn port uses fake Responses, never owner credentials.
Missing and normalized sentinel references succeed as independent work; an unknown
reference rejects before allocation; a genuine earlier-unit review still works in
a separate multi-unit grant. These are offline results, not live acceptance.

## Minimal correction

For a trusted turn maximum of one, no earlier-unit review can exist. Desktop
therefore supplies `NEXAR_BRIDGE_STANDALONE_ONLY=1` in its private MCP registration,
derived from the existing host-only `DelegationUnitLimit`. The relay advertises
the same submit tool with a strict standalone schema that omits `reviewOf`.
Its handler validates that same schema: supplied references, including sentinels,
are explicit `VALIDATION_ERROR`s before endpoint contact. Nothing is silently stripped.

Absent setting preserves the existing multi-unit contract. Malformed settings fail
closed before serving. No new tool names, DTO versions, provider behavior, grant
limits, NRC rules or Bridge reference-validation exceptions are introduced. The
private invocation setting cannot increase the host's enforced unit limit.

The schema is an invocation constraint, not a guarantee that a probabilistic
Control model will always submit valid arguments. Invalid extra fields still
fail closed. Successful live worker and parent completion must be established
after matching deployment and renewed authorization.

## Regression and security coverage

- Actual MCP discovery omits the field only for the restricted invocation.
- Historical invalid references reject locally without forwarding or allocation.
- One valid standalone unit completes with fake execution; a second is denied.
- Default sentinel normalization and genuine multi-unit review remain supported.
- Stdio startup accepts only absent/`1` setting; malformed variants fail closed.
- Desktop binds the setting to trusted one-unit scope on direct delegation,
  gateway setup fallback and whole-loop Control restart.
- Existing read-only tests retain denials for writes, shell, network and foreign MCP;
  capability alias validation and shared monotonic admission tests remain required.

Detailed receipts, full validation results, publication SHA, exact-head CI and the
deployment stop gate are recorded in
`.nexar/nxr066-remediation/NXR-066_Delegation_Argument_Root_Cause_Report.md`.
Prior acceptance failures remain failures. No deployment, paid inference or merge
is part of this correction.
