# NXR-068: Dynamic Provider Model Catalogs

**Milestone:** v0.6 · **Status:** architecture checkpoint; implementation pending.
**Depends on:** NXR-060/061/062/065/067a · **Blocks:** NXR-066b.
**Decision:** [ADR-028](../adr/028-dynamic-provider-sessions-and-model-inventory.md).
**Evidence:** [upstream comparison](../research/upstream/provider-model-inventory-patterns.md).

## Objective

Anthropic, OpenAI and Google subscription/native connections expose honest runtime-scoped model
inventories. The owner can refresh, use NRC Auto or select an explicit supported resource and change
it without editing source. API/local resources coexist. A connected account never invents a model.

## Implementation units

1. A/B: additive Nexar inventory contracts, freshness/provenance and route compatibility; bounded
   cache and pure stable resource materialization. No vendor types in contracts or registry.
2. C: OpenAI account-token model listing first; remove default `gpt-5.2` publication and static
   pi-catalog execution dependence. Preserve existing encrypted sign-in and refresh. Reject stale
   model/account/route with fixed reasons, invalidate and refresh without infinite retry.
3. D: Claude native inventory through a verified non-generating runtime mechanism; per-invocation
   model overrides, or honest provider-default if unsupported. No credential reads or OAuth reuse.
4. E: Google native listing, refresh and per-invocation model selection; conservative unknown auth,
   no guessed Gemini catalog. Evaluate ACP with evidence, not an automatic migration.
5. F/G: strict main/preload schemas, Providers inventory/freshness/refresh, existing Auto/pinned
   resource policy; NRC/strategy/gateway regression and offline Electron E2E.
6. H: after full gate and exact-head CI, hand the updated runbook to the owner. Authentication and
   allowance-consuming acceptance are owner-initiated only; PR #39 stays draft.

## Acceptance

- [ ] Sign-in triggers route-specific discovery; successful auth with no inventory publishes no
      explicit model. Two fake accounts see different model sets.
- [ ] A refreshed `gpt-new` list removes old configured `gpt-old`; native Codex-only availability
      never becomes a ChatGPT Responses resource.
- [ ] Refresh adds/removes models, retains stable ids through display changes/disappearance, and
      deduplicates concurrent runs. Old connection generations cannot publish after disconnect.
- [ ] Failure retains visible stale metadata/time; stale models do not route as fresh. Empty live
      lists remove explicit choices. Provider-default omits the vendor model override.
- [ ] Native agents and account/API model turns coexist without false control compatibility.
- [ ] Explicit/Auto selection uses existing NRC/strategy. Rejection is fixed/redacted, invalidates,
      refreshes and permits fallback only at a safe boundary under owner policy.
- [ ] Legacy settings are preserved as hints only; cache is bounded, versioned and non-secret.
- [ ] IPC rejects extra secret fields; no account ids, tokens, prompts or response bodies in logs,
      descriptors, telemetry, renderer or cache. CI calls only fake providers/runtimes.
- [ ] Full pinned `pnpm check`, focused regressions, Desktop E2E and exact-head CI pass. Live
      provider acceptance remains separately recorded.

## Deferred

Multi-account management UI, broad protocol capability matrix, replacing OpenWorker with Goose,
Google ACP execution migration, API catalog redesign, plane-side account login, automatic Code
lane replay/restart, Scheduler, Memory, Automation, Mobile and control plane.
