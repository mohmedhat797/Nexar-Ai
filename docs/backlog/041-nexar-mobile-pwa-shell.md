# NXR-041: Nexar Mobile PWA shell

**Milestone:** v0.5 — Nexar Mobile · **Labels:** mobile · **Depends on:** NXR-040

## Summary

Build the first mobile-first Progressive Web App shell for Nexar: pair a device, see task status, answer
approvals and receive notifications.

## Problem

The [roadmap](../roadmap/ROADMAP.md) (v0.5) plans a mobile PWA and remote control through the local
control plane. Today the owner can only use Nexar from the machine it runs on, and approvals
([NXR-014](014-human-approval-framework.md)) have no surface away from the terminal.

## Objective

An installable PWA (`apps/mobile`, created when this milestone starts per ADR-001) that talks only to
the control-plane API ([NXR-040](040-control-plane-adr-and-daemon-skeleton.md)) and works on a phone browser.

## Scope

- App shell with navigation, installable manifest and service worker (offline shell only).
- Pairing screen using the one-time code flow from the control-plane ADR.
- Task list and detail: status, routing explanation (selected resource and reasons), result text, artifact links.
- Approvals inbox: view summary, approve or deny, with clear risk labeling.
- Submit a simple task (prompt, project, optional resource preference).
- Notifications for approvals and completions (mechanism per the ADR; Web Push if chosen).

## Out of scope

- Voice conversation, artifact preview beyond text/Markdown, project switching UI beyond a selector (later in v0.5).
- Native apps, hosted backend, multi-user support.
- Any logic that routes or executes work on the device.

## Technical notes

- Consume only the daemon's documented API; types for requests and responses come from a shared package or generated schema, not copied ad hoc (decide in the PR).
- Pick a small, conventional web stack and record why; keep it inside `apps/mobile` with strict TypeScript and the same gate (`pnpm check`).
- Do not store long-lived secrets in `localStorage`; use the approach set by the control-plane ADR for the device credential.
- Show `RouteDecision` reasons as they are; do not reinterpret them client-side.
- Stale or offline state must be visible; never show an approval as pending when it could have expired.

## Acceptance criteria

- [ ] The PWA installs on a phone and pairs with a local daemon.
- [ ] Task list and detail render status, selected resource and result.
- [ ] An approval can be approved or denied from the PWA and is reflected in the daemon audit log.
- [ ] Revoking the device on the daemon makes the PWA lose access.
- [ ] Automated UI tests run in CI and `pnpm check` passes.

## Testing expectations

Offline component tests and an end-to-end test against the daemon with the echo adapter, using a headless
browser if adopted. Device-level checks (installation, notifications) are manual. No paid calls.

## Security considerations

The device credential is a high-value secret: storage, expiry and revocation follow the control-plane ADR.
Enforce a strict Content-Security-Policy, escape all model output (untrusted), avoid logging prompts or
results client-side, and require reauthentication for approvals if the ADR demands it.
