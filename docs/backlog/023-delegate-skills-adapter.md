# NXR-023: Product-time Delegate Skills adapter

**Milestone:** v0.3 — Engineering Machine · **Labels:** integration, delegate-skills · **Depends on:** NXR-014, NXR-015

## Summary

Add `@nexar/integration-delegate-skills`, which runs pinned Delegate Skills relays as subprocesses, maps
their `result.json` into Nexar results, isolates each task in its own git worktree and applies Nexar-owned review gates.

## Problem

[ADR-009](../adr/009-delegate-skills-development-workflow.md) separates development-time use (how Nexar
is built) from product-time use (v0.3, not implemented). The [research note](../research/upstream/delegate-skills.md)
shows the relays never commit, do not manage worktrees, differ in result fields per tool, and publish no JSON Schema.

## Objective

Nexar can delegate an implementation task to a relay (start with `claude-delegate`) in an isolated
worktree, then gate the outcome with Nexar's own checks before anything is accepted or committed.

## Scope

- New package `integrations/delegate-skills` (created now, not before; ADR-001).
- Nexar-owned `DelegationResult` mapping from `delegate-relay.result.v1` (status, exit, cost, tokens, turns, touched files, session ref).
- Worktree-per-task: create, run relay with `--cd`, `--out-dir` outside the worktree, `--timeout`, `--max-turns`, `--max-budget-usd`; clean up.
- Review gates owned by Nexar: run project checks, inspect diff and untracked files, approval ([NXR-014](014-human-approval-framework.md)) before any commit.
- Tolerant, per-`tool` result parsing; unknown `status` fails closed.

## Out of scope

- Other relays (Codex, agy, Pi, OpenCode) beyond a clear extension point; lane config (`delegate-fleet.v1`) support.
- Auto-commit or push; using relays as a runtime dependency of the Nexar core.
- Development-time workflow (unchanged).

## Technical notes

- Vendor a pinned commit SHA of the relay script with its MIT license, or require an installed pinned copy; record the SHA. The research note recommends one of these and warns skill version labels are not release pins.
- Invoke `node relay.mjs --brief <file> --cd <dir> --out-dir <dir>`; completion is process exit plus terminal `status`; exit 2 means no result file.
- Scrub `CLAUDE_CODE_SESSION_ID` and related variables (the child otherwise inherits them); never use `--resume-last`/`--session` with inherited ids.
- `touchedFiles` and `readOnlyViolation` can be `null` = unknown; treat as "inspect the diff", not success.
- Cost/tokens exist only for some relays (`claude`, `pi`, `opencode`); use `unavailable` elsewhere.

## Acceptance criteria

- [ ] Contract tests pass against `result.json` fixtures captured from the pinned relay version.
- [ ] Each task runs in its own worktree; the main tree is never modified by the relay.
- [ ] Unknown `status`, missing result file and `null` fields are handled fail-closed.
- [ ] No commit occurs without gates passing and an approval record.
- [ ] Session env variables are scrubbed before launching the relay.

## Testing expectations

Offline tests with a fake relay script emitting fixture results: success, failure, timeout, malformed, missing file, worktree cleanup. Live runs need an authenticated `claude`, are opt-in (`NEXAR_LIVE_TESTS=1`) and may cost money.

## Security considerations

The relay sandbox is partial (Bash only) and the child inherits the parent env; for untrusted briefs use a container or VM ([NXR-024](024-os-level-sandbox-for-agent-runtimes.md)). Never expose `--dangerously-skip-permissions` by default. Keep relay artifacts out of the repo.
