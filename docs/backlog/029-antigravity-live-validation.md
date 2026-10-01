# NXR-029: Antigravity live validation and ADR-020

**Milestone:** v0.3.x · **Labels:** integration, antigravity · **Depends on:** [NXR-022](022-antigravity-agy-adapter.md)

## Summary

Validate the experimental `agy` adapter end to end on the owner's machine, obtain the terms sign-off,
and then decide in ADR-020 whether to promote it or drop it.

## Problem

`@nexar/integration-antigravity` shipped in v0.3 as **experimental and opt-in**: it refuses to run until
`runtime.options.acknowledgeExperimental` is `true`, and the example config does not declare it. It is
verified only against a fake `agy` binary. Authenticated behaviour, nesting under the Nexar sandbox and
WSL2 are unverified (see the
[Antigravity research](../research/upstream/v0.3/antigravity.md)). Its Additional Terms (§6) forbid
third-party access with Antigravity OAuth tokens, so use must stay with the unmodified official binary.
The prompt is also passed in argv, visible in the host process list.

## Objective

Owner-run evidence that an Antigravity lane can implement a task in the sandbox, plus a recorded terms
decision, ending in ADR-020.

## Scope

- Owner signs in with `agy` inside the engineering plane and runs the `engineering-demo` with an Antigravity implement lane (and, separately, as reviewer).
- Record: sandbox nesting result, credential-mount needs, egress hosts actually used (debug egress log), token-refresh behaviour, exit codes and `AUTH_REQUIRED` handling.
- Owner reviews the terms and records a sign-off or a decision not to use it.
- ADR-020 promotes the adapter (drops the acknowledgement, adds it to the example config) or removes it.
- Add evidence under `docs/devlog/evidence/`.

## Out of scope

- Reading, parsing or copying Google credentials; any non-official client.
- Fixing the argv prompt exposure, unless `agy` gains another input path.

## Technical notes

- The live test is `integrations/antigravity/src/antigravity.live.test.ts` (opt-in with `NEXAR_LIVE_TESTS=1`); extend it only for behaviour observed live.
- Never run it in CI.

## Acceptance criteria

- [ ] A live Antigravity lane produces a patch that passes the gates in the sandbox, or the failure is documented.
- [ ] Egress hosts used are recorded; the allowlist matches them.
- [ ] A written terms decision exists.
- [ ] ADR-020 is accepted (promote or drop) and docs are updated accordingly.

## Testing expectations

Owner-run only; the offline contract tests stay unchanged. No paid calls in CI.

## Security considerations

Do not widen the egress allowlist to make a run pass without recording why. Credential mounts stay
narrow and owner-declared.
