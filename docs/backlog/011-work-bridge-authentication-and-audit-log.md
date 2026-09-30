# NXR-011: Work Bridge authentication and request audit log

**Milestone:** v0.2 — Personal Work · **Labels:** openworker, security · **Depends on:** NXR-010

## Summary

Authenticate callers of the Work Bridge and write an append-only audit record for every request.

## Problem

The [security model](../architecture/security.md) says requests arriving over the Work Bridge are
"authenticated and treated as untrusted task input", and lists "no authenticated local API yet" as a
known gap. Once [NXR-010](010-nexar-mcp-server.md) exists, any local process that can start or reach the
server can submit work that spends money and touches files.

## Objective

Only callers holding a valid, revocable Nexar-issued credential can submit work, and every accepted or
rejected request is recorded for later review.

## Scope

- A caller identity model: named clients (for example `openworker`) with a scoped secret.
- Verification on every bridge request; reject with `POLICY_REJECTED` or `AUTH_REQUIRED` as appropriate.
- Per-client scopes (which tools, allowed task kinds, optional `maxCostUsd` ceiling).
- Audit log: request id, client, tool, task kind, origin, outcome, `NexarError` code, timestamps, selected resource.
- CLI commands to create, list and revoke client credentials.

## Out of scope

- Remote/network transports and device pairing ([NXR-040](040-control-plane-adr-and-daemon-skeleton.md)).
- Human approval of actions ([NXR-014](014-human-approval-framework.md)).
- Encryption at rest of `.nexar/` (separate known gap).

## Technical notes

- Packages: `@nexar/integration-openworker` (request handling), `@nexar/core` (config), `@nexar/telemetry`
  (sink for audit), `@nexar/cli` (credential commands), `@nexar/contracts` for types and `NexarError` codes.
- Config holds only references (`{ source: 'env', name }`); generated client secrets are stored hashed, in
  `.nexar/` with file mode 0600, never in config or git.
- Audit is a separate JSONL (for example `.nexar/audit.jsonl`, mode 0600) from `ExecutionRecord` telemetry;
  it records metadata only, never prompt text or attachments.
- For stdio MCP the secret can arrive via the launching environment (a variable named in `mcp.json`);
  verify how OpenWorker passes env to MCP servers (see the [research note](../research/upstream/openworker.md)).
- Use injected clock and ids for determinism; use constant-time comparison for secrets.

## Acceptance criteria

- [ ] Requests without a valid credential are rejected and audited.
- [ ] Revoked credentials stop working without a restart.
- [ ] Scopes are enforced (disallowed tool or task kind → `POLICY_REJECTED`).
- [ ] Every request yields exactly one audit record with no prompt content or secrets.
- [ ] Audit and credential files are created with mode 0600 and are git-ignored.

## Testing expectations

Offline unit and integration tests: valid/invalid/revoked credential, scope enforcement, audit shape,
file permissions, redaction. No network or live tests required.

## Security considerations

Secrets are shown once at creation, stored only hashed, compared in constant time, and never logged
(key-based redaction applies). Audit files must not contain prompts or document content. Failed auth
attempts must not reveal whether a client name exists.
