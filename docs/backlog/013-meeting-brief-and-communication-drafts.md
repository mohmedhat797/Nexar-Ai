# NXR-013: Meeting brief generation and calendar/email preparation

**Milestone:** v0.2 — Personal Work · **Labels:** personal-work, openworker · **Depends on:** NXR-010, NXR-014, NXR-016

## Summary

Generate meeting briefs and prepare calendar and email **drafts** for the owner to review. Nothing is ever
sent or modified automatically.

## Problem

Meeting preparation is a known task kind (`meeting-preparation`) but has no workflow. Calendar and email
connectors belong to OpenWorker ([ADR-004](../adr/004-openworker-productivity-engine.md)); Nexar must
combine them without gaining the ability to act outward-facingly without approval.

## Objective

Given a meeting (from OpenWorker's calendar connector or pasted input) Nexar produces a brief artifact, and
optionally a draft email or calendar change, all marked as drafts pending human action.

## Scope

- Workflow `meeting-brief`: inputs are attendees, agenda, prior notes/documents, project; output is a Markdown brief.
- Draft outputs (follow-up email, agenda proposal, reschedule suggestion) stored as artifacts with status `draft`.
- Connector data arrives through the Work Bridge from OpenWorker; Nexar never holds calendar/email credentials.
- Clear labeling so a draft cannot be mistaken for a sent item.

## Out of scope

- Sending email, creating or editing calendar events (needs [NXR-014](014-human-approval-framework.md) and is not in this item).
- Building Gmail/Calendar connectors (OpenWorker owns them; managed OAuth there is paused upstream per the
  [research note](../research/upstream/openworker.md)).
- Transcription of recordings.

## Technical notes

- Task kind `meeting-preparation` exists in `KNOWN_TASK_KINDS` in `@nexar/contracts`; requires `knowledge-work`-style
  capabilities (configure via rules).
- Work Bridge types in `@nexar/integration-openworker`; OpenWorker's sketched `taskType` values
  (`meeting.summarize`, `calendar.triage`, `email.triage`) are a proposal in the research note, not an upstream API.
- Attachments are passed as `ArtifactRef`s, never inline; results stored via [NXR-016](016-artifact-storage.md).
- Research risk: unattended OpenWorker runs stall on approvals beyond workspace writes; keep this workflow
  interactive or draft-only.

## Acceptance criteria

- [ ] A meeting brief is generated from structured input offline (echo adapter) and saved as an artifact.
- [ ] Draft email/calendar outputs carry an explicit `draft` marker and are never transmitted by Nexar.
- [ ] No code path in Nexar calls a send/create/update connector action without an approval record.
- [ ] Missing or oversized input fails with `VALIDATION_ERROR` and a clear message.
- [ ] Usage of third-party resources respects `privacy: local-only` when set.

## Testing expectations

Offline tests for input validation, brief/draft artifact shapes and the no-auto-send guarantee.
End-to-end with a real OpenWorker and connectors is manual and opt-in (`NEXAR_LIVE_TESTS=1`).

## Security considerations

Emails and calendar invites are untrusted input and a prompt-injection vector: output must not trigger
actions. Attendee data is personal; do not log it at info+. Drafts are local files under the project only.
