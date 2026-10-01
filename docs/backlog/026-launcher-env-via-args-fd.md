# NXR-026: Pass launcher environment via `--args <fd>`

**Milestone:** v0.3.x · **Labels:** security, sandbox · **Depends on:** [NXR-024](024-os-level-sandbox-for-agent-runtimes.md)

## Summary

Stop putting environment values in bubblewrap's command line. Hand them to `bwrap` through a file
descriptor so they are not readable from `/proc/<pid>/cmdline`.

## Problem

`buildBwrapArgs` in `packages/sandbox/src/profile.ts` emits one `--setenv <key> <value>` per
environment entry. Those values become part of bwrap's argv on the host, so any process of the same OS
user can read them through `/proc`. Some values are secrets, for example a DeepSeek API key passed to a
DSH lane. The [security model](../architecture/security.md) lists this as a known gap.

## Objective

No environment value reaches bwrap's argv. Values travel through an inherited pipe or memfd that only
the launched bwrap reads.

## Scope

- Build the `--setenv` (and, if cheap, other value-bearing) arguments into a NUL-separated argument stream and pass it with bubblewrap's `--args <fd>` option (verify the exact format against the installed bwrap manual).
- Make `PreparedLaunch` carry the extra file descriptor and the adapters' spawn paths pass it through (`stdio` array) without exposing it to the agent process.
- Keep `buildBwrapArgs` deterministic and unit-testable; the fd plumbing lives in the launcher.
- Remove the corresponding gap from the security model once shipped.

## Out of scope

- Hiding the agent's own environment from itself (the agent legitimately receives its allowlisted env).
- The Antigravity prompt, which is a command-line argument by design of `agy` (tracked in [NXR-029](029-antigravity-live-validation.md)).

## Technical notes

- The descriptor must be closed in the parent after spawn and must not leak into the child's process tree.
- Adapters keep their own spawn and process-group kill logic ([ADR-019](../adr/019-engineering-lanes-and-resources.md) section 5); only the contract for what `prepare` returns grows.
- A fake launcher used in adapter tests needs the same shape.

## Acceptance criteria

- [ ] With a sentinel secret in the launch env, `/proc/<bwrap pid>/cmdline` does not contain it.
- [ ] The sandboxed process still sees the full, exact environment.
- [ ] Argument-stream encoding handles empty values, `=` and newlines in values.
- [ ] The descriptor is not inherited by the agent process.

## Testing expectations

Unit tests for the encoder; a real-bwrap integration test reads the host-side cmdline (skips when bwrap
is unavailable). No paid calls.

## Security considerations

Do not log the stream or the descriptor path. Telemetry and records already exclude env values; keep it
that way.
