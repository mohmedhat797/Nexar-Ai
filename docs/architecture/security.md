# Nexar security model and threat assumptions

Nexar will handle source code, client documents, email, calendars, OAuth sessions, API keys, and
subscription logins. Security is an architectural requirement, not a later feature.

## Assets

| Asset                                                 | Where it lives                                   | Nexar's rule                                                                                              |
| ----------------------------------------------------- | ------------------------------------------------ | --------------------------------------------------------------------------------------------------------- |
| Provider API keys                                     | Owner's environment (`.env`, shell, OS keychain) | Referenced by env var _name_ in config; injected only into the runtime that needs it                      |
| Subscription / OAuth sessions (Claude Code, Codex, …) | Each runtime's own credential store              | Never read, copied, or extracted by Nexar; used only through the runtime's supported CLI/SDK              |
| Source code, documents                                | Owner's filesystem                               | Passed to a resource only when the task requires it; `local-only` tasks never reach third-party resources |
| Telemetry, sessions                                   | `.nexar/` (git-ignored), file mode 0600          | Contains prompts' metadata, never credentials                                                             |

## Trust boundaries

1. **Nexar process ↔ external runtimes** (dsh, claude, future codex/agy): separate processes,
   launched with a scrubbed, explicit environment and an isolated state directory. Runtime output is
   untrusted input to Nexar.
2. **Nexar ↔ model providers**: third-party data processors. Routing respects
   `requirements.privacy = 'local-only'` by rejecting resources whose `dataLocality` is
   `third-party`.
3. **OpenWorker ↔ Nexar** (v0.2): OpenWorker is a separate application that launches `nexar mcp serve`
   over stdio. Every tool call is authenticated with a client token, authorized against that client's
   scopes, audited, and treated as untrusted task input (ADR-014, ADR-015).
4. **Repository ↔ local machine**: nothing machine-specific (tokens, session DBs, `.nexar/`, `.env`)
   is ever committed. CI scans for secrets.

## Threat assumptions

- The owner's machine and OS account are trusted. Nexar does not defend against a compromised host.
- Model output and agent actions are **not** trusted: agents can be prompt-injected by repository
  content, documents, or email. Mitigations: least-privilege tool surfaces per adapter, read-only
  modes where available, human approval for outward actions (none can run in v0.2), and audit records.
  Prompt injection is mitigated, not prevented: see the v0.2 controls and known gaps below.
- Upstream runtimes are fast-moving pre-1.0 projects (DeepSeek Harness declares "no security
  audit"). Mitigations: exact version pins, isolation via subprocesses, contract tests, deliberate
  upgrades.
- Third-party telemetry in upstream runtimes is disabled where documented (e.g. DSH
  `session-log-deepseek` upload).

## Mandatory rules

- No credential, token, cookie, or session database is committed. `.env.example` only.
- Config schema rejects inline secrets: credentials are `{ source: 'env', name }` or
  `{ source: 'runtime-managed' }`.
- Logs pass through key-based redaction (`api_key`, `token`, `secret`, `password`,
  `authorization`, `cookie`, `credential`).
- Adapters must not log prompts at `info` level or above (prompts may contain client data).
- Probes are side-effect free and never make paid calls.
- Live/paid tests are opt-in (`NEXAR_LIVE_TESTS=1`) and never run in CI.
- Destructive or outward-facing actions (sending email, pushing code, deleting files) require an
  executor and explicit, action-bound human approval (ADR-016). v0.2 registers no executors, so Nexar
  performs none.
- Any path derived from a request, workflow input or model output is checked with `resolveContainedPath`
  and only the canonical result is used; rejected paths are never echoed (ADR-012).
- Artifacts are written only through `LocalArtifactStore` (ADR-013).
- The MCP server is stdio-only; it must never be exposed over a network (ADR-014).

## v0.2 controls

Eight hard gates. Each is enforced in code and proven by offline tests (`pnpm test`).

| #   | Gate                                                   | Enforced in                                                                                                                                                                                                                            | Proven by                                                                                                                                                                                                                                                 |
| --- | ------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Realpath containment (symlinks and `..` cannot escape) | `packages/projects/src/path-policy.ts` (`resolveContainedPath`, `isWithin`); `packages/core/src/engine.ts` (`enforceWorkspace`, before routing); `packages/artifacts/src/store.ts` (per-level realpath)                                | `packages/projects/src/path-policy.test.ts`; `packages/core/src/projects.test.ts` (symlink attack never reaches the adapter); `packages/artifacts/src/store.test.ts`; `integrations/openworker/src/bridge.test.ts`; `integrations/mcp/src/server.test.ts` |
| 2   | Invalid project paths fail closed                      | `packages/projects/src/path-policy.ts` (`canonicalRoots`) and `registry.ts`: a missing or non-directory root or working directory is `CONFIGURATION_ERROR`; engine `project-only` default                                              | `packages/projects/src/path-policy.test.ts` (`canonicalRoots`); `packages/projects/src/registry.test.ts`; `packages/core/src/projects.test.ts` (unresolvable path, `project-only` default)                                                                |
| 3   | Work Bridge authentication                             | `packages/access/src/registry.ts`, `credentials.ts`, `scopes.ts` (256-bit token, SHA-256 at rest, constant-time, revocable, scopes); `integrations/mcp/src/server.ts` (authenticates on every call)                                    | `packages/access/src/registry.test.ts`; `integrations/mcp/src/server.test.ts` (missing, wrong, revoked tokens; scope rejections); `integrations/mcp/src/stdio-process.test.ts` (real transport, no token)                                                 |
| 4   | Every request is audited, exactly once                 | `packages/access/src/audit.ts` (`withAudit`, `startAudit`, `JsonlAuditLog`, 0600); `integrations/mcp/src/server.ts`                                                                                                                    | `packages/access/src/audit.test.ts`; `integrations/mcp/src/server.test.ts` (one record per call including failures; write failure is surfaced)                                                                                                            |
| 5   | No secrets in audit or telemetry                       | `packages/access/src/audit.ts` (explicit field allowlist, sanitized ids); `packages/telemetry/src/redact.ts`; `packages/core/src/engine.ts` (`artifacts.stored` carries refs only)                                                     | `packages/access/src/audit.test.ts` (allowlisted keys only); `packages/access/src/registry.test.ts` (only the hash is stored); `packages/telemetry/src/telemetry.test.ts`; `packages/core/src/artifacts.test.ts`; `integrations/mcp/src/server.test.ts`   |
| 6   | MCP stdout is protocol-only                            | `integrations/mcp/src/stdio.ts` (`redirectConsoleToStderr`; logs and notice go to stderr)                                                                                                                                              | `integrations/mcp/src/stdio-process.test.ts` (raw stdout bytes are JSON-RPC only); `integrations/mcp/src/server.test.ts` (`redirectConsoleToStderr`)                                                                                                      |
| 7   | Outward actions fail closed without approval           | `packages/approvals/src/outward.ts` (`performOutwardAction`: executor required first, then approval, consume, execute; `V0_2_OUTWARD_EXECUTORS` is empty); `gate.ts` (deny-all default); `packages/workflows` has no outward code path | `packages/approvals/src/approvals.test.ts` (no executors; deny by default; binding; single use; restart recovery); `packages/workflows/src/static.test.ts` (no mail, HTTP or approvals import); `packages/workflows/src/runner.test.ts` (drafts only)     |
| 8   | Request input cannot grant filesystem permissions      | `integrations/openworker/src/schema.ts` (strict schema; no scope, path-policy or permission fields); `integrations/mcp/src/server.ts` (client cost cap, scopes from the token); `packages/projects/src/merge.ts` (stricter wins)       | `integrations/mcp/src/server.test.ts` (request fields do not widen scopes); `packages/projects/src/merge.test.ts`; `packages/workflows/src/runner.test.ts` (inputs cannot choose project or directory)                                                    |

Supporting controls: artifact names are sanitized with a forced extension and written with `O_EXCL`
(`packages/artifacts/src/sanitize.ts`, `store.ts`); workflow inputs are wrapped as untrusted and never
enter the trusted system prompt (`packages/workflows/src/runner.ts`, `runner.test.ts`); the DeepSeek
Harness adapter kills its whole process group on stop (`integrations/deepseek-harness/src/process-tree.test.ts`).

## Known gaps (tracked in the backlog)

- **No OS-level sandbox** around agent runtimes: they run as the owner's user and rely on each
  runtime's own permission model ([#17](../backlog/024-os-level-sandbox-for-agent-runtimes.md)).
- **TOCTOU window:** a symlink swapped inside a project between the realpath check and the runtime's
  use is not detected. Mitigated by passing the canonical path and per-level checks; closed only by #17.
- **Approver identity is not authenticated:** `decide()` trusts its caller (the local CLI). The v0.5
  control plane must authenticate approvers.
- **`clients.json` cross-process race:** writes are serialized within one process only, so the CLI and
  a running server writing at once can lose an update.
- **Prompt injection is mitigated, not prevented:** untrusted-input wrapping and the system prompts
  reduce it, but models can still follow injected text. The real guarantee is structural: workflows
  and the engine have no outward code path, so the worst case is a misleading local draft. Every
  output needs human review.
- **OpenWorker MCP tools may not be available in scheduled automations** (upstream behaviour,
  unverified; see the [OpenWorker research](../research/upstream/openworker.md)).
- No encryption at rest for `.nexar/` state, telemetry, audit or artifacts (owner-only file modes only).
- No rate limiting of failed authentication.
