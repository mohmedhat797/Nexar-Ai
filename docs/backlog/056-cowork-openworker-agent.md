# NXR-056: Cowork through the OpenWorker agent

**Milestone:** v0.5 — Nexar Desktop · **Labels:** desktop, openworker · **Depends on:** NXR-050 · **ADR:** [ADR-026](../adr/026-cowork-lane-supervised-openworker.md)

## Summary

Implement the ADR-004 secondary seam so Cowork tasks run on a Nexar-supervised OpenWorker server by default.

## Problem

OpenWorker is the productivity engine (ADR-004), but today only OpenWorker calls Nexar, not the reverse.

## Objective

Cowork tasks run on OpenWorker with the model Nexar picks, and OpenWorker's approval requests appear in Nexar's Approvals.

## Scope

- `openworker` execution adapter: pinned version, own state directory, automations API, contract tests against a fake server.
- Map OpenWorker approvals to Nexar approvals (deny by default).
- Model provider for OpenWorker from Nexar's providers where OpenWorker supports it.

## Out of scope

- Forking OpenWorker; OpenWorker's cloud connectors broker without an owner decision.

## Technical notes

- No outward actions (sending email, calendar invites) without a future ADR; drafts only.

## Acceptance criteria

- [ ] A Cowork task runs on OpenWorker and produces a draft in the project (offline fake E2E passes;
      live run pending).
- [x] Without OpenWorker installed, Cowork falls back to other resources and says so.

## Testing expectations

Fake OpenWorker server contract tests; opt-in live test.

## Security considerations

OpenWorker runs with its own state and an explicit environment; Nexar never reads its auth token.

## Status (2026-10-03)

**Implementation complete, offline-tested (fake OpenWorker), live-unverified.** OpenWorker is not
installed on the owner machine, so no live OpenWorker turn has run.

| Criterion                                               | Implementation                                                              | Offline evidence                                                    | Live    |
| ------------------------------------------------------- | --------------------------------------------------------------------------- | ------------------------------------------------------------------- | ------- |
| Supervised private OpenWorker (pinned >= 0.3.0 < 0.4.0) | `integrations/openworker` supervisor (`4a2b13b`)                            | `supervisor.test.ts` (env allowlist, token, version, startup bound) | pending |
| Turn over the session protocol                          | `runCoworkTurn` (`{type,data}` envelope verified upstream at `074ad3f`)     | `session.test.ts`                                                   | pending |
| Approvals mapped to Nexar (deny by default)             | policy answers recorded via `recordPolicyDecision`                          | `policy.test.ts`, `cowork.test.ts`                                  | pending |
| NRC selects the model                                   | routing with non-usable resources excluded; owner opt-in per provider       | `cowork.test.ts`                                                    | pending |
| Draft in the project                                    | scratch → `LocalArtifactStore` drafts                                       | `cowork.test.ts`, `cowork.e2e.ts`                                   | pending |
| Visible fallback without OpenWorker                     | `openworker-unavailable` + banner reason                                    | `cowork.e2e.ts` scenario (b)                                        | n/a     |
| Recursion prevention                                    | no MCP servers in the private server (by construction); correlation depth 1 | `service.test.ts` (correlation)                                     | n/a     |
| Desktop state                                           | Cowork banner, lane line, Providers opt-in, Settings → Cowork (`221aca4`)   | `cowork.e2e.ts` (incl. relaunch)                                    | pending |

Follow-up: NXR-059 turn-scoped delegation so OpenWorker can call Nexar services during a Cowork turn.
Owner live check: install OpenWorker 0.3.x following upstream instructions, set
`cowork.executable`/`cowork.versionExecutable` in `desktop-settings.json` if they are not on `PATH`,
allow one provider for OpenWorker in Settings → Providers, and run one small Cowork turn.
