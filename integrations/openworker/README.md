# @nexar/integration-openworker

The **Work Bridge**: the transport-agnostic contract through which OpenWorker (and later the
control plane or mobile) submits work to Nexar. OpenWorker stays the productivity engine
([ADR-004](../../docs/adr/004-openworker-productivity-engine.md)); Nexar decides which AI resource
does the heavy reasoning or execution.

The bridge is a versioned request/response schema plus a validating handler that runs requests as
async jobs. It has no transport and makes no calls into OpenWorker. The stdio MCP server in
[`@nexar/integration-mcp`](../mcp) is its first transport
([setup guide](../../docs/integration/openworker-mcp.md)).

```ts
import { createWorkBridge } from '@nexar/integration-openworker';

const bridge = createWorkBridge({
  engine: nexar, // the real Nexar class; built with workingDirectoryPolicy 'project-only'
  projects, // the same ProjectRegistry the engine uses
  artifacts, // an ArtifactStore (e.g. LocalArtifactStore)
  allowedSources: ['openworker'], // default
  maxRequestChars: 100_000, // default
  timeoutMs: 30 * 60_000, // per-run execution timeout
});

const response = await bridge.submit(untrustedInput, {
  clientId: 'openworker', // idempotency + status ownership
  waitMs: 90_000, // default 90 s, max 100 s
  signal, // lifetime signal: jobs outlive the call that started them
  authorize: (request) => {
    /* throw a NexarError to refuse */
  },
});
const later = bridge.status('ow-42', { clientId: 'openworker' });
```

`submit` and `status` never throw. Input is validated with a strict zod schema (unknown keys are
rejected). Request and system-prompt text is never logged; only ids, source, task kind and lengths are.

## v2 request

`{ version: 2, requestId, source, project, taskKind, request, systemPrompt?, constraints?,
workingDirectory?, documentSets?, output?, requestedBy? }`

- `project` is **required** and must be registered; unknown ids are `rejected` (`POLICY_REJECTED`).
- `workingDirectory` is relative to the project's first working directory, or absolute. The bridge
  does no path checks itself: the engine resolves the path with `realpath` (symlinks and `..`
  included) and rejects anything outside the project's working directories with `POLICY_REJECTED`
  before any adapter runs.
- `documentSets` (at most 8) are resolved by `ProjectRegistry.resolveDocumentSet` into file-reference
  attachments (never contents).
- `constraints.maxCostUsd` becomes the task's cost requirement.
- `output: { filename, mediaType?: 'text/markdown' | 'text/plain' }` stores the result text as an
  artifact in the project (and records it in telemetry); the refs come back in `artifacts`. If storing
  fails the text is still returned, with an `error` describing the storage failure.

## Processing order

validate → source check → `authorize` hook → idempotency check → project lookup → document sets →
`engine.createTask` → `engine.run` in the background → wait up to `waitMs`.

| Status      | Meaning                                                                                                                                    |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `completed` | The task ran; `output`, `route`, `usage` (and `artifacts`) are present.                                                                    |
| `running`   | Still executing after `waitMs`; `taskId` is present. Poll `status(requestId)` or resubmit the same `requestId`.                            |
| `rejected`  | Invalid or unauthorized input (`VALIDATION_ERROR`, `POLICY_REJECTED`, or the hook's code). Nothing ran.                                    |
| `failed`    | The task was routed or ran, and failed; `error.code` is a `NexarErrorCode`. Unknown errors become `INTERNAL_ERROR` with a generic message. |

`route` is `{ resourceId, policy, reasonCodes, explanation }`; for `NO_ELIGIBLE_RESOURCE` it carries the
rejection reasons and no `resourceId`.

## Jobs, idempotency and ownership

- Jobs live in memory (newest 200; the oldest _finished_ one is evicted; when all 200 are running, new
  work is refused with retryable `RESOURCE_UNAVAILABLE`).
- Re-submitting an existing `requestId` returns the current state of the first job and starts nothing.
  This only works for the client (`clientId`) that submitted it; any other client gets `rejected` +
  `POLICY_REJECTED`, and the same goes for `status`.
- `status` of an unknown request is `rejected` + `VALIDATION_ERROR` ("Unknown request").

## Example

Request:

```json
{
  "version": 2,
  "requestId": "ow:2026-09-30:0042",
  "source": "openworker",
  "project": "quarterly-report",
  "taskKind": "analysis",
  "request": "Summarize the attached findings in five bullets.",
  "documentSets": ["findings"],
  "output": { "filename": "summary" },
  "constraints": { "capabilities": ["reasoning"], "privacy": "standard", "maxCostUsd": 0.5 },
  "requestedBy": "alice"
}
```

Completed response:

```json
{
  "version": 2,
  "requestId": "ow:2026-09-30:0042",
  "status": "completed",
  "taskId": "task_8f3c…",
  "output": { "text": "…" },
  "route": {
    "resourceId": "local-echo",
    "policy": "deterministic",
    "reasonCodes": ["default.match"],
    "explanation": "Selected resource: local-echo (score …)\nReasons:\n  + default.match: …"
  },
  "usage": {
    "inputTokens": { "status": "measured", "value": 120 },
    "outputTokens": { "status": "measured", "value": 240 },
    "costUsd": { "status": "unavailable", "reason": "not reported" }
  },
  "artifacts": [
    {
      "uri": "file:///…/.nexar/artifacts/task_8f3c…/summary.md",
      "mediaType": "text/markdown",
      "draft": false
    }
  ]
}
```

Rejected response:

```json
{
  "version": 2,
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
