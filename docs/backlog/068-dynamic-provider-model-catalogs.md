# NXR-068: Dynamic Provider Model Catalogs

**Milestone:** v0.6 · **Status:** offline implementation and strengthened local gates complete;
full exact-head CI passed for `0244d97`; owner live acceptance pending.
**Depends on:** NXR-060/061/062/065/067a · **Unblocks:** NXR-066b preparation (live results pending).
**Decision:** [ADR-028](../adr/028-dynamic-provider-sessions-and-model-inventory.md).
**Evidence:** [upstream comparison](../research/upstream/provider-model-inventory-patterns.md).

**Gate revision (owner, 2026-10-07):** strengthened local gates applied during the GitHub billing
outage. Billing is restored; [CI 37553210679 attempt 2](https://github.com/mohmedhat797/Nexar-Ai/actions/runs/37553210679/attempts/2)
passed for `0244d974704b9350a2ddec873872514db8d5de1a` (Ubuntu, Windows, secret scan, including
installer/SHA256 upload). Any later head still requires its own full CI before merge/release.

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
- [x] Full exact-head CI passed for `0244d97`; later heads require their own full CI before merge/release.
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
