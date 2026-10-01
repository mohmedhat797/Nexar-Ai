# ADR-023: Scheduled tasks

**Status:** Accepted (2026-10-01) · Builds on ADR-016 (approvals), ADR-017 (workflows), ADR-020
(budgets and quota), ADR-021 (Nexar Desktop) · Brings part of the v0.7 automation milestone forward

## Context

The owner wants to create scheduled tasks in the app, for example "every weekday at 08:30, prepare my
meeting brief" or "every Monday, run a dependency and test health check on this repository". Scheduled
work runs while nobody is watching, so it must be safer than interactive work, not looser.

## Decision

### 1. What a schedule is

A schedule is stored data in `<state>/.nexar/schedules.json` (0600 where supported): an id, a name, the
mode (Cowork or Code), the project, either a workflow with its inputs or a free-text task, the
recurrence, a **required budget per run** (`maxCostUsd`), what to do when approval is needed, and an
enabled flag. Inputs follow ADR-017: rendered as untrusted input, documents by reference.

### 2. Recurrence

A deliberately small set, in the owner's local time zone: once at a date and time, daily, weekdays,
weekly on chosen days, or monthly on a day of the month, each at a time of day. No free-form cron in
v1. Times that do not exist or repeat during a daylight-saving change run once, at the first valid
instant.

### 3. Who runs it

- The **desktop app's main process** runs the scheduler while the app is open or minimized to the
  tray. Closing the window keeps it in the tray when any schedule is enabled; quitting stops it.
- The scheduler uses an injected clock. It checks due schedules once a minute.
- **Missed runs:** when the app starts and a run was missed within the last 12 hours, it runs once (not
  once per missed slot) and the run is marked "late". Older misses are recorded as skipped.
- **Concurrency:** one run per schedule at a time; at most two scheduled runs at once overall. A run
  that is still going when its next slot arrives skips that slot.

### 4. Every run is an ordinary task with tighter defaults

- `TaskOrigin.source = 'schedule'` with the schedule id as the correlation id. It goes through the same
  engine, routing (all hard filters, ADR-020), approvals and telemetry as any task.
- **The budget is enforced.** A schedule without `maxCostUsd` cannot be saved; unknown cost under that
  limit is rejected (ADR-020 §5 default).
- **Approvals wait or skip, never auto-approve.** If a step needs approval, the run either waits (the
  request appears in Approvals and as a notification) or stops and records "skipped: needs approval",
  as the owner chose. No setting approves on the owner's behalf.
- Results are drafts (Cowork) or uncommitted changes that still need review and owner approval (Code).
  Outward actions stay impossible (ADR-016).
- Each run records its outcome on the schedule (last run, result, next run) using ids and codes only.

### 5. Interfaces

The desktop bridge gains schedules list, create, update, pause, resume, delete and run-now. Validation
is in the main process. A CLI command for listing schedules may follow; a headless always-on scheduler
(a Windows service or the v0.7 daemon) needs its own ADR.

## Rationale

Running schedules inside the desktop app needs no background service, no network listener and no new
privilege, and every run reuses the existing task, approval and budget controls.

## Alternatives considered

- **Windows Task Scheduler launching the CLI:** works with the app closed, but splits state and
  approvals across processes and needs a service-style install. Deferred to the always-on ADR.
- **Free-form cron expressions:** powerful but error-prone for a desktop owner; the fixed set covers
  the requested uses.
- **Auto-approving scheduled steps:** rejected; it would defeat ADR-016.

## Consequences

- New package code: a pure recurrence calculator (next run from a schedule and a clock), a schedule
  store and a scheduler loop, all with fake-clock tests.
- `TaskOrigin.source` gains `schedule`. The tray icon appears only when schedules exist.

## Risks

- **Runs while the owner is away can spend money.** Mitigated by the required per-run budget, quota
  reservations (ADR-020) and the "today" spend view.
- **Sleep and hibernation** delay runs; the missed-run rule bounds the catch-up to one run.
