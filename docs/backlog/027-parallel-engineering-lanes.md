# NXR-027: Parallel engineering lanes with a merge step

**Milestone:** v0.4 · **Labels:** engineering · **Depends on:** [NXR-024](024-os-level-sandbox-for-agent-runtimes.md)

## Summary

Let one engineering task run independent lanes concurrently, each in its own worktree, and combine
their patches through a Nexar-owned merge and conflict policy.

## Problem

[ADR-019](../adr/019-engineering-lanes-and-resources.md) section 2 runs lanes **sequentially in one
task worktree**; parallel lanes were deferred because they need a merge and conflict policy. Sequential
lanes prove the multi-resource flow but cannot use several subscriptions at once or split independent
work (for example implementation and tests for separate modules).

## Objective

A lane plan can declare lanes without dependencies on each other; Nexar runs them concurrently in
separate private clones, harvests each patch, and merges them deterministically before the gates.

## Scope

- Plan schema: explicit lane dependencies already exist; add a concurrency limit and a merge strategy.
- One worktree per concurrent lane (same private-clone rules as today), each with its own sandbox and egress proxy.
- A merge step that applies validated patches to a fresh clone in a fixed order and fails the task on conflict, producing a conflict report as an artifact (no automatic semantic merging).
- Gates, review and the single owner approval run once on the combined patch; the approval fingerprint covers the combined patch hash.
- Per-lane telemetry and record entries (ids, counts, hashes only).

## Out of scope

- Free-form LLM decomposition of the goal into lanes.
- Agents resolving merge conflicts themselves (a later lane may be added by plan, not implicitly).
- Quota-aware scheduling of concurrent lanes (v0.4 resource intelligence).

## Technical notes

- Each patch still passes the patch policy before it is applied anywhere; the combined patch is validated again.
- Resource selection per lane stays with the NRC; review diversity applies to all implementing resources.
- Cancellation must stop every lane's process group.

## Acceptance criteria

- [ ] Two independent lanes run concurrently in separate sandboxes and worktrees.
- [ ] Non-overlapping patches merge; overlapping patches fail with a conflict artifact and no branch.
- [ ] The approval is bound to the combined patch hash.
- [ ] Cancelling the task stops all lanes.

## Testing expectations

Fake adapters under a fake launcher, plus the real-sandbox integration test where bwrap exists. No paid calls.

## Security considerations

Concurrent lanes multiply egress and credential-mount surface; each lane gets its own allowlist and
mounts, and nothing is shared between worktrees. Amend ADR-019 before implementing.
