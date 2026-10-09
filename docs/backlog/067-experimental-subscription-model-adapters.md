# NXR-067: Experimental subscription model-turn adapters (owner-enabled)

**Milestone:** v0.6 — Resource orchestration · **Labels:** providers, experimental, security · **Depends on:** NXR-062; owner enablement · **ADR:** [ADR-027](../adr/027-resource-orchestration-architecture.md) ([plan](../architecture/resource-orchestration-plan.md))

## Decision (2026-10-05)

**Reconciliation (2026-10-06):** 067a sign-in is implemented, CI-green and owner-reported successful.
067b is **partially implemented; requires revision through NXR-068**. Its resource publication uses
`chatgptPlan.models` with a static default, not discovered account/route availability. The live
rejection of that model invalidates the old publication assumption, not the authentication evidence.
NXR-067 remains in the backlog; native-agent models and account-backed model turns are separate.

ChatGPT goes first through OpenAI's **official** "Sign in with ChatGPT" token sharing
([research](../research/upstream/chatgpt-sign-in-token-sharing.md), ADR-022 amendment 2026-10-05):
an `official-account` connection whose access token calls the public Responses API. The
experimental Codex-client route is not built. Claude (high terms risk) and Gemini remain experimental
research items; Antigravity stays excluded.

- **067a:** the connection: PKCE sign-in with the loopback callback in a supervised child, token
  exchange/refresh/validation in main, key-store storage, connect/disconnect/status IPC, fake auth
  server tests.
- **067b:** the resources: model discovery per connection, `model-turn` resources through pi-ai's
  Responses client with the connection's access token, error mapping, Providers UI, E2E against a
  fake backend.
- Plane (Code) sign-in is a follow-up.

## Objective

Optional Nexar-owned adapters that give subscription connections `model-turn` (control-eligible), starting with ChatGPT, under the ADR-022 2026-10-04 policy.

## Problem

Official subscription runtimes are agents (work resources only); a subscription can drive a control loop only through a model-turn route, and every route found is experimental client-compat.

## Scope

- ChatGPT first, using OpenWorker's `CodexProvider`/`codex_auth` as the reference design: Nexar's own PKCE login in main, tokens in the key store under the connection, refresh in main, Responses-style turns with reasoning items in `extras`.
- Per adapter, before it ships: vendor support status, breakage risk, account/terms risk, token storage, refresh behaviour, backend assumptions.
- Claude only after re-verifying Anthropic's current terms on third-party subscription OAuth (high risk); Gemini CLI only after research; Antigravity excluded (terms §6).
- Disabled by default; labelled experimental; history down-ranks unreliable adapters.

## Acceptance criteria

- [ ] Fake backend: login state machine, refresh, model-turn with tools and extras, revoke; no token in logs, telemetry, IPC or engine views; disabled-by-default gate.

## Security considerations

Never harvest another application's credentials; never reuse OpenWorker's auth store; owner initiates every live login.
