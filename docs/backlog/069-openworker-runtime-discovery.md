# NXR-069: OpenWorker Runtime Discovery

**Status:** Deferred specification; no implementation started. **Milestone:** unscheduled maintenance
after NXR-066b. **Labels:** openworker, desktop, windows, security.
**Evidence:** [v0.3.1 compatibility](../research/upstream/openworker-0.3.1-compatibility.md).

## Summary / problem

Official Windows GUI installations bundle `sidecar/openworker-server.exe` with `_internal/`,
but do not establish Nexar's separate version CLI or PATH discovery. A published installer is
not runtime readiness. Owner overrides currently provide both executables.

## Objective / scope

Discover supported official runtime candidates safely and expose verifiable provenance, without
attaching to an owner's running GUI or borrowing its credentials/state.

- Explicit overrides first, then bounded known per-user NSIS and machine MSI installation
  locations (verify actual installer directories/registry entries before naming them as defaults).
- Preserve sidecar `_internal` adjacency; treat server and version provenance as one installation.
- Prove version from supported CLI or trustworthy packaged metadata. A GUI version alone cannot
  authorize a different sidecar; retain `>=0.3.1 <0.4.0` fail-closed guard and reject unknown provenance.
- Record candidate ownership, canonical path, file identity and installation origin. Reject writable
  path hijacks, links/reparse escapes and mismatched executables according to Windows policy.
- Handle uninstall/upgrade and stale paths; revalidate identity/version before launch. Never start
  a server during passive candidate discovery or silently switch one during an active turn.
- Validate official artifact checksums and relevant signatures with a trusted key/source; distinguish
  updater signatures from Authenticode. Record unavailable verification honestly.

## Out of scope

Broad disk/PATH recursion, reading credential stores, attaching to GUI state, disabling version
checks, auto-installing/upgrading, Linux plane changes, OpenShell migration and headless scheduling.

## Acceptance criteria / testing expectations

- [ ] Known per-user/machine layouts and explicit overrides covered by offline Windows fixtures.
- [ ] Supported, unsupported, missing, ambiguous and unverifiable versions produce fixed public states.
- [ ] Upgrade/removal races, ownership failure, reparse escape and server/version mismatch fail closed.
- [ ] No live runtime download/execution in CI; any owner machine probe has explicit lifecycle bounds.
- [ ] Private supervised state/token, loopback binding, approvals and fallback remain unchanged.

## Security considerations

Discovery grants no authentication or execution authority. No global OpenWorker settings, account
identifiers or tokens enter Nexar's renderer/cache/telemetry. Installation and provider acceptance
remain distinct owner actions.
