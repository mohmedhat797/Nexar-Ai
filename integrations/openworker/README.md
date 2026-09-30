# @nexar/integration-openworker

The **Work Bridge**: the transport-agnostic contract through which OpenWorker (and later the
control plane or mobile) submits work to Nexar. OpenWorker stays the productivity engine
([ADR-004](../../docs/adr/004-openworker-productivity-engine.md)); Nexar decides which AI resource
does the heavy reasoning or execution.

v0.1 is a versioned request/response schema plus a validating handler. It has no transport and
makes no calls into OpenWorker.

```ts
import { createWorkBridge } from '@nexar/integration-openworker';

const bridge = createWorkBridge({
  engine: nexar, // anything with createTask() / run(); the real Nexar class fits
  allowedSources: ['openworker'], // default
  maxRequestChars: 100_000, // default
  timeoutMs: 120_000,
});

const response = await bridge.submit(untrustedInput, { signal });
```

`submit` never throws. Input is validated with a strict zod schema (unknown keys are rejected).
Request and system-prompt text is never logged; only ids, source, task kind and lengths are.

| Status      | Meaning                                                                                                                                   |
| ----------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `completed` | The task ran; `output`, `route` and `usage` are present.                                                                                  |
| `rejected`  | Invalid or unauthorized input (`VALIDATION_ERROR`, `POLICY_REJECTED`). Nothing ran.                                                       |
| `failed`    | The task was routed or ran and failed; `error.code` is a `NexarErrorCode`. Unknown errors become `INTERNAL_ERROR` with a generic message. |

`project` must name a project registered with the engine (`@nexar/projects`); unknown ids are
`rejected`. `workingDirectory` must be absolute and is accepted **only together with `project`**. The
bridge does no path checks itself: the engine resolves the path with `realpath` (symlinks and `..`
included) and rejects anything outside the project's working directories with `POLICY_REJECTED`
before any adapter runs. The engine must use the default `workingDirectoryPolicy: 'project-only'`.

## v0.2 plan

A Nexar MCP server will expose a tool whose input schema is `workRequestJsonSchema()` and whose
handler calls `bridge.submit`. OpenWorker consumes that server as an ordinary MCP tool, so the
seam needs no OpenWorker-specific code in Nexar. Any HTTP control plane will wrap the same bridge.
Authentication tokens arrive with the transport in v0.2.

## Examples

Request:

```json
{
  "version": 1,
  "requestId": "ow:2026-09-30:0042",
  "source": "openworker",
  "taskKind": "analysis",
  "project": "quarterly-report",
  "request": "Summarize the attached findings in five bullets.",
  "constraints": { "capabilities": ["reasoning"], "privacy": "standard" },
  "requestedBy": "alice"
}
```

Completed response:

```json
{
  "version": 1,
  "requestId": "ow:2026-09-30:0042",
  "status": "completed",
  "taskId": "task_8f3c…",
  "output": { "text": "…" },
  "route": {
    "resourceId": "local-echo",
    "policy": "deterministic",
    "reasons": [{ "code": "default.match", "effect": "supports", "message": "…" }]
  },
  "usage": {
    "inputTokens": { "status": "measured", "value": 120 },
    "outputTokens": { "status": "measured", "value": 240 },
    "costUsd": { "status": "unavailable", "reason": "not reported" }
  }
}
```

Rejected response:

```json
{
  "version": 1,
  "requestId": "ow:2026-09-30:0042",
  "status": "rejected",
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "Invalid work request",
    "retryable": false,
    "issues": [
      { "path": "request", "message": "Too small: expected string to have >=1 characters" }
    ]
  }
}
```
