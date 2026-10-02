# NXR-055: Code mode through the WSL2 engineering plane

**Milestone:** v0.5 — Nexar Desktop · **Labels:** desktop, engineering · **Depends on:** NXR-050, NXR-051 · **ADR:** [ADR-025](../adr/025-code-lane-wsl-bridge.md)

## Summary

Run Code-mode sessions and engineering tasks from the Windows app on the WSL2 plane (ADR-018), with DSH as the default agent.

## Problem

The sandbox needs Linux; the app runs on Windows.

## Objective

From the Windows app the owner can start a coding session on a repository, see the agent's steps and changes, send them to review and gates, and approve a local commit.

## Scope

- A bridge from the desktop engine to a Nexar engine inside WSL2 (spawned over `wsl.exe`, stdio JSON, no network).
- Session view with plan, tool log and diff; Review & commit view.
- DSH via ACP as default; Claude Code and Codex as alternatives.

## Out of scope

- Native Windows sandboxing.
- Pushing.

## Technical notes

- All ADR-018/019 controls stay in force; the WSL2 checks A1–A6 must pass before this ships.

## Acceptance criteria

- [ ] An end-to-end engineering task from the Windows app ends in a `nexar/<task>` commit after approval.
- [ ] Without WSL2 the app explains what is missing.

## Testing expectations

Fake WSL bridge tests; owner-run end-to-end check.

## Security considerations

The bridge carries ids, codes and diffs for display only; no credentials cross it.
