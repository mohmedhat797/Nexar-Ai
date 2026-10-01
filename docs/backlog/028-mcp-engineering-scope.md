# NXR-028: MCP engineering scope

**Milestone:** v0.5 · **Labels:** mcp, security, engineering · **Depends on:** [NXR-011](011-work-bridge-authentication-and-audit-log.md), [NXR-014](014-human-approval-framework.md)

## Summary

Allow an authenticated MCP client (for example OpenWorker) to start and observe engineering tasks,
through a new, explicit scope. Today engineering tasks are created only from the CLI.

## Problem

[ADR-019](../adr/019-engineering-lanes-and-resources.md) section 1 states that tasks are created from
the CLI in v0.3 and that the MCP Work Bridge gets no engineering scopes. Starting sandboxed
write-capable agents from a remote-ish client is a much larger authority than producing a draft, so it
needs its own design rather than reusing `submit_work`.

## Objective

An MCP tool surface to start, list and inspect engineering tasks, authorized by a dedicated token scope,
audited once per call, with approvals still decided by the owner outside the request.

## Scope

- A new scope (for example `engineering`) in `@nexar/access`, never implied by existing scopes.
- Tools such as `nexar.engineer_start`, `nexar.engineer_status`, `nexar.engineer_list` over the existing stdio server ([ADR-014](../adr/014-mcp-transport-and-work-bridge-v2.md)).
- Request fields choose only the project, plan and goal; they can never widen scopes, paths, resources' sandbox options, gates or the approval policy ([ADR-015](../adr/015-client-identity-and-audit.md)).
- Audit records stay an allowlist (task id, plan id, outcome); no goal text, diffs or paths.
- Approval of `engineering.commit` remains an owner action through `nexar approvals`; the MCP client cannot approve.

## Out of scope

- A network transport (separate ADR and security review, v0.5 control plane).
- Mobile approvals UI ([NXR-040](040-control-plane-adr-and-daemon-skeleton.md), [NXR-041](041-nexar-mobile-pwa-shell.md)).

## Technical notes

- Run the runner as a job like Work Bridge v2 async jobs, and never call `recoverAfterRestart` on behalf of the CLI's concurrent runs.
- Needs an ADR and a security review before any code (project rule for new MCP surface).

## Acceptance criteria

- [ ] A token without the engineering scope is rejected on every engineering tool, and audited once.
- [ ] Request fields cannot change gates, mounts, allowlists or approval policy.
- [ ] A client cannot approve its own task's commit.
- [ ] Audit records contain no prompts, paths or content.

## Testing expectations

Server tests with a fake runner (as for other tools), covering scopes and audit exactly-once. No paid calls.

## Security considerations

Prompt-injected clients are the threat: the worst case must remain a rejected local branch. The control
plane work in v0.5 decides the approver-identity question first.
