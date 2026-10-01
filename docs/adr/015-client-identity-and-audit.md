# ADR-015: Client identity, scoped credentials, and request audit

**Status:** Accepted (2026-09-30) · Issue: #7 (NXR-011)

## Context

The Nexar MCP server (ADR-014) is spawned by OpenWorker over stdio. stdio has no per-request headers.
OpenWorker passes only explicitly configured `env` keys to the server process (see the research
re-check in `docs/research/upstream/openworker.md`). Every external request must be attributable,
authorized, and audited without leaking content.

## Decision

- **Client identities** live in `@nexar/access` and are stored in `.nexar/clients.json` (0600).
- **Tokens:** a token is `nxr_` followed by 256 random bits, shown once and stored only as SHA-256.
  A fast hash is appropriate because the token is a uniformly random secret, not a password.
- **Verification:** constant-time comparison against every stored hash, with no early exit. Every
  failure raises the same `AUTH_REQUIRED: Authentication failed` with no details, so a caller cannot
  tell whether a client exists or has been revoked.
- **Revocation** takes effect on the next request, because the server reloads the registry on every
  tool call.
- **Authentication is per connection** from `NEXAR_CLIENT_TOKEN` in the server's environment and is
  re-verified on every call.
- **Authorization is per call**, over scopes: tools, task kinds, projects, workflows, and a cost cap.
  The cost cap is applied as `min(request, client)` into task requirements.
- **Audit:**
  - Every MCP tool call produces exactly one JSON line in `.nexar/audit.jsonl` (0600), including
    authentication and validation failures.
  - Records are an explicit field allowlist: ids, tool, project, task kind, workflow, auth and policy
    outcome, resource, task, outcome, error code, and artifact count. Ids are sanitized. There are no
    prompts, paths, document content, or tokens.
  - A failed audit write is surfaced, not swallowed.
  - Audit is kept separate from execution telemetry.

## Rationale

Connection-level authentication matches how stdio MCP servers are launched, and per-call
re-verification keeps revocation immediate. An allowlisted audit schema makes content leakage
impossible by construction rather than by redaction.

## Alternatives considered

- Password KDF (scrypt/argon2): unnecessary for 256-bit random tokens.
- OS keychain: platform-specific; deferred.
- mTLS / OAuth: no network transport exists in v0.2.

## Consequences

The owner provisions a client once with `nexar clients add openworker …` and puts the token into
OpenWorker's MCP env.

## Risks

- Concurrent writers to `clients.json` (CLI and server) are serialized per process only.
- Tokens are held in the OpenWorker process environment and its `.env` file.

## Follow-up work

Token rotation UX, rate limiting failed authentication, and keychain storage (v0.5 control plane).
