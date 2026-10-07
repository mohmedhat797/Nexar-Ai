# NXR-068: Dynamic Provider Model Catalogs

**Milestone:** v0.6 · **Status:** offline implementation and strengthened local gates complete;
exact-head CI and owner live acceptance pending.
**Depends on:** NXR-060/061/062/065/067a · **Blocks:** NXR-066b.
**Decision:** [ADR-028](../adr/028-dynamic-provider-sessions-and-model-inventory.md).
**Evidence:** [upstream comparison](../research/upstream/provider-model-inventory-patterns.md).

**Gate revision (owner, 2026-10-07):** GitHub billing blocks CI. Continue with full pinned local
check, Desktop E2E, Windows packaging/packaged E2E and review per coherent checkpoint; exact-head
CI remains mandatory before merge/release. CI is unverified, not waived for release.

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

The checked items record fake-provider/runtime regression coverage. They do not record live
entitlement acceptance. See [local gate evidence](../devlog/evidence/nxr-068-local-gates.md).

- [x] Account sign-in triggers route-specific discovery; successful auth with no inventory publishes no
      explicit model. Two fake accounts see different model sets.
- [x] A refreshed `gpt-new` list removes old configured `gpt-old`; native Codex-only availability
      never becomes a ChatGPT Responses resource.
- [x] Refresh adds/removes models, retains stable ids through display changes/disappearance, and
      deduplicates concurrent runs. Old connection generations cannot publish after disconnect.
- [x] Failure retains visible stale metadata/time; stale models do not route as fresh. Empty live
      lists remove explicit choices. Provider-default omits the vendor model override.
- [x] Native agents and account/API model turns coexist without false control compatibility.
- [x] Explicit/Auto selection uses existing NRC/strategy. Rejection is fixed/redacted, invalidates,
      refreshes and permits fallback only at a safe boundary under owner policy.
- [x] Legacy settings are preserved as hints only; cache is bounded, versioned and non-secret.
- [x] IPC rejects extra secret fields; no account ids, tokens, prompts or response bodies in logs,
      descriptors, telemetry, renderer or cache. CI calls only fake providers/runtimes.
- [x] Full pinned `pnpm check`, focused regressions, source Desktop E2E, Windows packaging and
      packaged Desktop E2E pass.
- [ ] Full exact-head CI passes before merge/release; currently blocked by GitHub billing.
- [ ] Owner live provider acceptance is separately initiated and recorded after CI.

## Implemented boundaries (2026-10-07)

Contracts, cache/freshness, stable materialization, account Responses discovery/custom model execution,
Claude SDK metadata initialization, explicit Google listing, strict IPC, Providers model/freshness UI
and existing Auto/explicit selection are implemented with fake-only regression tests. Source SDK
0.3.292 was verified before pinning. Review fixes cover disconnect/scope-loss/rejection races, late
account generations, cache file identity and non-destructive legacy pin migration.

Native Codex exposes provider-default without an override; explicit native model/list is deferred
because a browser-safe minimum server release was not verified. Unknown native error text is not
treated as model rejection. Claude/Google listing does not prove authentication. These limits are
intentional and documented in the owner runbook. No live provider acceptance is claimed.

## Deferred

Multi-account management UI, broad protocol capability matrix, replacing OpenWorker with Goose,
Google ACP execution migration, API catalog redesign, plane-side account login, automatic Code
lane replay/restart, Scheduler, Memory, Automation, Mobile and control plane.
