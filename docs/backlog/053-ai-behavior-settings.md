# NXR-053: AI behavior settings per mode

**Milestone:** v0.5 — Nexar Desktop · **Labels:** desktop, integration · **Depends on:** NXR-050

## Summary

Wire the Settings → AI behavior tab to the runtimes: default agent, model, reasoning effort, permission mode and agent network, separately for Cowork and Code.

## Problem

The mockup's settings must change real runtime behaviour, mapped onto options each runtime documents.

## Objective

Each setting has a documented, tested mapping to Claude Code, Codex, DSH and pi-ai options, and the locked safety rules cannot be changed.

## Scope

- Mode profiles stored in desktop settings and applied as task requirements, owner preferences and adapter options.
- Permission modes: Cowork read only / drafts only / ask before every write; Code plan / ask / auto-edit in sandbox / full auto in sandbox.
- Reasoning effort and model per agent where the runtime supports them.

## Out of scope

- New runtimes.
- Relaxing any sandbox, review, commit or outward-action rule.

## Technical notes

- Full auto still runs only inside the sandbox with an exact-host allowlist.
- Unsupported combinations are rejected with a clear reason, never silently ignored.

## Acceptance criteria

- [ ] Changing a setting changes the arguments or options the adapter sends (verified with fake runtimes).
- [ ] Locked rules are displayed and cannot be altered through the bridge.

## Testing expectations

Adapter contract tests per setting; bridge validation tests.

## Security considerations

Settings can only narrow permissions relative to the sandbox and approval rules.
