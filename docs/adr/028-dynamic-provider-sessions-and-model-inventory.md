# ADR-028: Dynamic Provider Sessions and Model Inventory

**Status:** Accepted (owner direction; implementation NXR-068). **Date:** 2026-10-06.
Builds on ADR-003/005/007/020/022/025/027. Evidence:
[`provider-model-inventory-patterns.md`](../research/upstream/provider-model-inventory-patterns.md).

## Context

NXR-067 sign-in worked in the owner's first smoke, but inference rejected Nexar's default model.
`chatgptPlan.models` is configuration, not an account inventory. A connection represents access;
authentication alone cannot publish a model. OpenWorker's separate installation failure does not
explain or fix this defect. Native Codex choices and account-backed Responses choices may differ.

## Decision

### Domain and ownership

Provider → connection → runtime/session → model inventory → resources. Extend existing
`ProviderConnection` and descriptor/state contracts; do not introduce a second router or a giant
driver interface. Small inventory ports compose with the existing authentication and execution
ports. One provider can have multiple opaque Nexar connection ids and multiple runtime/route ids
per connection. Current UI may expose one native default profile and one account connection.

A provider session means observed runtime state for that connection, not an Operating Session,
provider account identifier or model. Its current model is distinct from the owner's preference
and the NRC's decision. Changing a model sets per-invocation/session options, never vendor global
configuration. Nexar Operating Sessions remain canonical across provider switches.

### Inventory

An inventory is bounded, connection- and runtime-scoped, with status `fresh`, `stale`, `unavailable`
or `unsupported`, `observedAt`, optional runtime version/current selection, and public entries.
Entries carry a discriminated selection (`model` with returned id, or `provider-default`), display
name, availability, only verified capabilities/limits/reasoning facts, compatibility (`native-agent`
or `model-turn`), support class and source (`live-runtime`, `official-api`, `static-verified`,
`provider-default`). Unknown facts remain absent. Static catalogs are versioned and non-authoritative;
their entries are never elevated to account availability simply because authentication succeeds.

`provider-default` delegates choice to a runtime that supports omitting its model override. It is
not a model slug, has no invented context/reasoning limits, and never goes to a model API as `model`.
Native resources remain `kind: agent`; enumerated native choices produce agent variants with
`underlying.model`. Explicit account-backed single-turn models are `kind: model`. Native discovery
does not grant `model-turn` or prove OpenWorker/DSH control compatibility.

### Materialization and routing

Materialization is pure and engine-independent: connection + inventory + integration-owned resource
template → descriptors. Stable ids derive from provider, connection, immutable runtime/route class
and selection id, never display labels or refresh times. Removed entries disappear from the active
registry; reappearance uses the same id, preserving history. Existing resource identities may be
retained where they already imply exactly one immutable route. Configuration cannot restore a
model rejected by the inventory source.

Fresh eligible entries enter the normal Resource Registry, NRC hard filters and `strategy@1`.
Stale entries remain visible with their last observation but are unavailable for new Auto/pinned
selection in the initial policy. No fresh inventory means no explicit model resources. Auto remains
the default. Existing control-resource policy supplies explicit compatible model pinning and fallback;
work preferences use the existing behavior policy. No provider-specific routing.

### Refresh, cache and failure boundaries

Cache only public metadata, bounded and strictly validated, atomically written using existing private
state mechanisms. Cached observations load stale; never assume they belong to a freshly authenticated
account. Clear/invalidate before reauthentication/disconnect, discard results of older generations,
and never reuse inventory across connection/runtime or machine boundaries. Native runtimes that do
not expose a privacy-safe account identity require fresh discovery after process restart/recheck.

Refresh after successful owner sign-in, explicit Refresh Models, runtime version change, account
switch, model rejection and a bounded periodic interval. Deduplicate concurrent refreshes and bound
time, output, entries and requests. No discovery on every model turn, paid capability probes,
prompt-based listing, private backend calls or credential file reads. Runtime commands capable of
starting sign-in require an explicit owner action; background refresh must not open a login flow.

On discovery failure preserve last-known metadata as visibly stale; retain its timestamp. An empty
successful authoritative list removes previous explicit entries. A model/account/route rejection
returns a fixed structured Nexar reason, immediately marks the resource unavailable, and schedules
one bounded refresh. Do not retry the same unsupported request or hard-code a replacement. NRC
fallback is permitted only by existing policy. Refresh cannot switch the pinned control resource
mid-loop: fail that loop, then restart at an existing safe boundary. Automatic Code lane restart
from base remains an explicitly tracked ADR-027 follow-up; do not replay writes in this change.

### Provider implementation choices

- **OpenAI first:** use the official account-token `GET /v1/models`, its `models` array and only
  `visibility: list` entries, preserving ordering and display names. Use the returned `slug` on the
  public Responses route with the same connection token. API-key `{ data: [...] }` catalogs and
  Codex app-server `model/list` are separate sources. No default slug, private backend or token
  harvesting. The execution adapter must support returned ids absent from pi-ai's static catalog
  using its supported custom Responses provider facility; unknown costs/limits stay unknown.
- **Anthropic:** use the official Agent SDK initialization model metadata with a held-open empty
  async input that never sends a user prompt, then close the query. Isolate initialization from
  project settings/hooks/plugins/MCP, use a private scratch cwd and an explicit minimal child env;
  runtime credentials remain vendor-owned. Metadata initialization may refresh native auth or load
  runtime state, so it is bounded and lifecycle-tested, not described as having no side effects.
  Native `--model` chooses only the current runtime's discovered choices.
  If enumeration is unavailable, retain explicit runtime-default agent semantics and explain the
  limitation, rather than importing API/manifest choices as subscription entitlement. No Messages
  API subscription OAuth adapter is added.
- **Google:** retain the vendor-native `agy` executor initially. Its documented free `models`
  listing and per-invocation `--model` are a smaller seam than replacing execution with ACP.
  Conservatively normalize only recognized bounded listing rows; no static Gemini fallback, no
  third-party Antigravity OAuth. Model listing proves inventory, not authenticated status. ACP live
  model/config-option support is a future migration candidate requiring lifecycle, approvals,
  authentication, platform and terms validation. Provider-default remains available where supported.

### UI, migration and observability

Providers shows connection, runtime, models, freshness/time and Refresh Models. AI Behavior /
Orchestration shows Auto and compatible explicit resources; stale/removed preferences are visible,
not silently replaced or sent to a provider. No visual redesign or Cowork engine migration.

Legacy `chatgptPlan.models` is retained as a preference hint only, never an inventory source. It may
be ignored when absent from a fresh inventory; retaining its raw value avoids destructive migration
and preserves owner settings. Remove the implicit production default. Any later destructive schema
migration must use the existing backup + atomic-write pattern and tests. Inventory persistence is a
new versioned schema: corrupt/unrecognized cache fails closed without rewriting owner config.

Events record ids, fixed reasons, timestamps and counts for refresh/failure/add/remove/rejection and
selection/fallback. No prompts, provider bodies, tokens, OAuth details, account ids or arbitrary
upstream fields. Subscriptions stay subscription allowance; quota remains unknown unless reported.

## Rationale and alternatives

Adopt runtime-reported choices and separated app/provider state from T3 Code, and composable provider
inventory/setup/switching surfaces from Goose. Adapt both to Nexar's resource registry and NRC.
Defer multi-account UI, broad protocol capabilities, ACP execution migration and API-catalog redesign.
Reject copied credential stores, fabricated model defaults, manifest-as-entitlement, provider routing
inside engines, replacing OpenWorker here and switching control resources during a tool loop.

## Consequences and validation

NXR-068 blocks NXR-066b; NXR-067a stays implemented and 067b requires this revision. No merge of
PR #39 or owner live authentication until implementation and exact-head CI pass. Offline fixtures
must prove account-specific/route-specific choices, additions/removals, stale/empty behavior,
provider-default, stable ids, explicit/Auto selection, rejection/refresh/fallback, API/native
coexistence, migration preservation and no secret propagation. Provider metadata is untrusted;
strict normalization must not publish credentials or unsupported capability claims.
