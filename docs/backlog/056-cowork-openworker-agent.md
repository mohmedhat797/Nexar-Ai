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

- [ ] A Cowork task runs on OpenWorker and produces a draft in the project.
- [ ] Without OpenWorker installed, Cowork falls back to other resources and says so.

## Testing expectations

Fake OpenWorker server contract tests; opt-in live test.

## Security considerations

OpenWorker runs with its own state and an explicit environment; Nexar never reads its auth token.
