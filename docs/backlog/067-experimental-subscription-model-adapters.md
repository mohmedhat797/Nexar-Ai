# NXR-067: Experimental subscription model-turn adapters (owner-enabled)

**Milestone:** v0.6 — Resource orchestration · **Labels:** providers, experimental, security · **Depends on:** NXR-062; owner enablement · **ADR:** [ADR-027](../adr/027-resource-orchestration-architecture.md) ([plan](../architecture/resource-orchestration-plan.md))

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
