# NXR-040: Control-plane ADR and local daemon skeleton

**Milestone:** Nexar Mobile (deferred) · **Labels:** control-plane, security · **Depends on:** NXR-011, NXR-014

## Summary

Write the control-plane ADR (daemon API, device pairing, remote access model) and build a minimal local
daemon that exposes the Nexar engine over an authenticated API.

## Problem

[ADR-006](../adr/006-local-first.md) says the control plane is a local daemon first, with any remote or
always-on node needing its own ADR. The [architecture overview](../architecture/overview.md) (section 9)
sketches it, but there is no decision on the API, how a phone is paired, or how it reaches the owner's
machine. The security model has no authenticated local API yet.

## Objective

An accepted ADR plus a daemon skeleton (`apps/control-plane`, created now per ADR-001) that can submit
tasks, stream status and handle approvals for a paired device.

## Scope

- ADR covering: API style and versioning, task queue and approval endpoints, event streaming, device pairing and revocation, remote-access options (local network, tunnel, relay) with the chosen default and rejected alternatives.
- Daemon skeleton: loopback-bound HTTP server, health endpoint, task submit/status, approvals list/decide, event stream.
- Reuse the engine library; `TaskOrigin.source = 'control-plane'` or `'mobile'`.
- Device pairing: one-time code, per-device credential, revocation, audit.
- `nexar daemon start|stop|status` commands.

## Out of scope

- The PWA ([NXR-041](041-nexar-mobile-pwa-shell.md)), push notifications, voice.
- Hosted or cloud control plane (explicitly excluded by ADR-006 unless a new ADR decides otherwise).
- Multi-user accounts.

## Technical notes

- Builds on [NXR-011](011-work-bridge-authentication-and-audit-log.md) (credentials, audit) and [NXR-014](014-human-approval-framework.md) (approvals attach to tasks).
- Bind to loopback by default; remote exposure must be an explicit owner action with TLS and device auth.
- Task states, queue persistence and approvals live under `.nexar/` with file mode 0600.
- Keep the core as a library; the daemon is a thin host, like the CLI.
- Choose the HTTP framework conservatively and exact-pin it; record the rationale in the ADR.

## Acceptance criteria

- [ ] A new ADR is accepted and linked from `docs/adr/README.md`.
- [ ] The daemon starts on loopback only and rejects unauthenticated requests.
- [ ] A paired device can submit a task, observe status and answer an approval; a revoked device cannot.
- [ ] All requests are audited with device id and outcome.
- [ ] `apps/control-plane` is added to the workspace and `pnpm check` passes.

## Testing expectations

Offline integration tests start the daemon on an ephemeral loopback port with the echo adapter: pairing,
auth failures, revocation, task flow, approval flow, binding address. No live tests.

## Security considerations

This is the main new attack surface. Loopback by default, per-device credentials stored hashed,
short-lived pairing codes, CSRF/origin checks, rate limiting on pairing, TLS for any non-loopback access,
and no secrets in responses or logs. Threat-model the remote access option in the ADR.
