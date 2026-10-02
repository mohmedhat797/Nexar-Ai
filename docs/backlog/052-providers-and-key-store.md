# NXR-052: Providers — subscription sign-in, encrypted key store, local servers

**Milestone:** v0.5 — Nexar Desktop · **Labels:** desktop, security · **Depends on:** NXR-050

## Summary

NXR-052a/b/c/d/e implemented on the Operating Layer continuation: headless reference/resolver contract,
strict discovery source selection, encrypted Desktop storage, clipboard-only IPC and Providers UI.
Explicit non-generating metadata checks use strict provider-only IPC. Claude Code/Codex browser
sign-in and runtime-only status IPC have offline coverage; live browser acceptance is unverified.
Antigravity sign-in is disabled because no standalone command is verified. Owner-listed keyless
Ollama/OpenAI-compatible endpoint setup is implemented with consistent discovery/execution API bases.
NXR-052 is **not marked live-validated**; review the acceptance evidence before closing it. See the
[Providers guide](../guides/providers.md) and [progress log](../devlog/operating-layer-progress.md).

Implement ADR-022: the Providers settings tab with subscription sign-in, API keys in an encrypted key store and local servers.

## Problem

Desktop owners should not have to edit environment variables to connect providers.

## Objective

An owner can connect Anthropic, OpenAI, Google, DeepSeek, OpenRouter, Groq, Mistral, xAI, Ollama or a custom server, and DSH and pi-ai can use the keys.

## Scope

- `CredentialRef` source `keystore`; Electron `safeStorage` encryption; refusal without a real backend.
- Credential resolver injected into adapters by the host; resolution at call time in main only.
- Subscription sign-in through the vendors' documented login commands; status from existing free probes.
- Free key check via model listing.

## Out of scope

- Using subscriptions for pi-ai or DSH (forbidden by ADR-022).
- Sharing keys across machines.

## Technical notes

- API rows expose provider, storage/check status and a four-character suffix. Native rows expose
  only runtime, account mode, normalized status, safe version and lifecycle metadata.
- Fixed vendor browser-login commands use explicit public environments and null stdio. Interactive
  terminal/code-entry flows require the owner terminal; see the authentication research snapshot.

## Acceptance criteria

- [x] Keys never appear in config, logs, telemetry, audit, IPC responses or errors (offline leak tests).
- [x] A saved DeepSeek key lets DSH run; removing it makes DSH `AUTH_REQUIRED` (injected/fake runtime
      tests and call-time resolver tests; live DeepSeek execution remains unverified).
- [x] Linux without a keyring refuses to store keys (fake backend and Electron refusal coverage).

## Remaining delivery and owner acceptance

- Local / Custom address-entry, edit/remove, rediscovery and cached model counts are implemented
  for keyless owner-listed servers, with strict public-URL IPC. Keyed custom servers retain the
  existing explicit resource/config credential path; the form does not ingest custom keys.
- Native browser sign-in: implemented/offline-tested; real Claude/Codex callback flow unverified.
  Google remains explicitly unsupported pending a documented standalone flow.
- Installed Codex/Antigravity semantic versions and real provider metadata/generation acceptance
  remain unverified. No paid generation or live subscription login was used in CI.

## Testing expectations

Fake `safeStorage` round-trip tests; leak tests over logs and IPC; fake-runtime tests for login flows; no paid calls.

## Security considerations

See ADR-022: secrets resolved only in main at call time; DPAPI on Windows.
