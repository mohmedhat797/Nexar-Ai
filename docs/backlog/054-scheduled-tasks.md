# NXR-054: Scheduled tasks

**Milestone:** v0.5 — Nexar Desktop · **Labels:** desktop, automation · **Depends on:** NXR-050

## Summary

Implement ADR-023: schedules created in the app, run by the desktop main process while the app is open or in the tray.

## Problem

The owner wants recurring work (meeting briefs, weekly reports, health checks) without starting it by hand.

## Objective

Schedules can be created, paused, resumed, run now and deleted; runs respect budgets and approvals.

## Scope

- Pure recurrence calculator; schedule store; scheduler loop with an injected clock; missed-run and concurrency rules.
- Tray icon when schedules exist.
- `TaskOrigin.source = 'schedule'`.

## Out of scope

- Free-form cron; an always-on service with the app closed (needs its own ADR).

## Technical notes

- Required per-run budget; approvals wait or skip, never auto-approve; results are drafts or uncommitted changes.

## Acceptance criteria

- [ ] Fake-clock tests cover every recurrence, daylight-saving transitions, missed runs and concurrency.
- [ ] A scheduled run appears in history with its outcome and cost.

## Testing expectations

Fake-clock unit tests; E2E test creating a schedule and triggering run-now with the echo resource.

## Security considerations

No auto-approval path exists; schedules file has owner-only permissions.
