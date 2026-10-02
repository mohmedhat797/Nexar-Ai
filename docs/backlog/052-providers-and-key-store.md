# NXR-052: Providers — subscription sign-in, encrypted key store, local servers

**Milestone:** v0.5 — Nexar Desktop · **Labels:** desktop, security · **Depends on:** NXR-050

## Summary

NXR-052a/b implemented on the Operating Layer continuation: headless reference/resolver contract,
strict discovery source selection, encrypted Desktop storage, clipboard-only IPC and Providers UI.
Network key checks (052c), vendor sign-in (052d), and local endpoint setup UI remain. See the
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

- Renderer sees only provider, status and the last four characters.
- Login commands run in the vendor's own window with an explicit environment.

## Acceptance criteria

- [ ] Keys never appear in config, logs, telemetry, audit, IPC responses or errors.
- [ ] A saved DeepSeek key lets DSH run; removing it makes DSH `AUTH_REQUIRED`.
- [ ] Linux without a keyring refuses to store keys.

## Testing expectations

Fake `safeStorage` round-trip tests; leak tests over logs and IPC; fake-runtime tests for login flows; no paid calls.

## Security considerations

See ADR-022: secrets resolved only in main at call time; DPAPI on Windows.
