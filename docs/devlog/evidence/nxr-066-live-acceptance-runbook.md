# NXR-066 live acceptance runbook (owner)

Owner-initiated, never CI. Uses real subscriptions and plan allowance. Nothing is pushed. Results go
to `docs/devlog/evidence/nxr-066-owner-acceptance.md` (ids, resource ids, reason codes, timings —
never prompts, outputs, tokens or account identifiers).

## 0. Preconditions

**Blocked on exact-head CI (2026-10-07):** NXR-068 passed strengthened local gates
([evidence](nxr-068-local-gates.md)), including full check, Desktop E2E, Windows packaging and
packaged E2E. GitHub billing makes CI unavailable; full exact-head CI must pass before resuming
this runbook. The owner's
first smoke confirmed ChatGPT authentication but exposed an unsupported assumed model and unavailable
OpenWorker. Use only a fresh model returned for the selected account and route.

- PR #39 head is green in CI; Desktop built from `feat/nexar-resource-orchestration`
  (`pnpm install && pnpm build`, then `pnpm --filter @nexar/desktop start`). First start migrates the
  config (backup `nexar.config.json.bak-<timestamp>`).
- The plane (`nexar-plane`) runs Nexar from the same branch (update its checkout, `pnpm install`,
  `pnpm build`), still hardened (A1–A6 as in NXR-055). Its config keeps the `nxr055-validation`
  project. `engineering.toolchainPaths` contains `/opt/node` (so DSH lanes can offer the bridge).
- Optional, improves coverage: finish `codex login --device-auth` inside the plane (review diversity
  on a different resource).

## 1. Providers — configured once

1. Desktop → Settings → Providers → **Anthropic**: Claude Code subscription shows signed in.
   Click **Refresh models** to initialize metadata without a user turn. Record fresh native choices;
   listing alone is not authentication proof. SDK initialization may refresh vendor-owned state.
2. **OpenAI → ChatGPT plan (Sign in with ChatGPT)** → **Connect**. Sign in in the browser and
   **allow plan usage** for Nexar. Status becomes "Connected" with plan sharing on. (Uses the
   ChatGPT plan's allowance; manage or revoke it in ChatGPT settings.)
3. Refresh the ChatGPT plan inventory. Record its returned model slug, freshness and resource id.
   Resources → details: that resource has `model-turn`, connection OpenAI / subscription / official;
   Claude Code is a native agent (work resource). Empty or stale inventory blocks this step.
4. Settings → Providers → **Engineering plane**: plane resources listed read-only.
5. Optional Google coverage: explicit **Refresh models** reads `agy models`; it may initialize the
   native keyring/sign-in. Record only returned choices; authentication remains unknown. A native
   Google resource remains experimental and is not a model-turn control resource.
6. Native Codex offers **provider default**, which omits `--model`. Explicit native catalog discovery
   remains deferred until a browser-safe `model/list` release is verified; it does not use the
   separate ChatGPT plan Responses catalog. Existing vendor default resources remain usable.
7. Select a fresh explicit resource in AI behavior, then return to Auto. Refresh once more and check
   additions/removals, freshness and retained pins. Empty/stale catalogs must not create a usable
   explicit choice. No credentials or raw native output belong in evidence.

## 2. Orchestration — Auto

Settings → AI behavior → Orchestration: Cowork control **Auto** (shows "Auto → returned model label"),
fallback **Auto**. Code shows the plane's policy read-only.

### First resumed smoke — read-only

Before SOW, start a conversation in the project and ask: **"Review the files in this project and
give me a short summary. Do not modify any files."** Record the fresh connection/route/model/resource,
selection reason and outcome; confirm zero file modifications and no fabricated model. If inventory
or execution fails, record the fixed reason and refresh outcome before proceeding to Cowork.

## 3. Cowork SOW (acceptance §14.2)

New Cowork conversation in a project with documents. Prompt: **"Create a professional SOW using this
project."** Expect and record:

- lane `cowork` (no fallback); Control line identifies the fresh resource recorded in step 1.3;
- OpenWorker delegated ≥ 1 unit through Nexar, at least one on the Claude Code subscription
  (unit ids, resource ids, outcomes);
- a draft artifact saved by Nexar;
- if the control loop fails with `unsupported-capability` (tool calls refused on the plan route),
  record it: that is the open question of the ChatGPT route; the honest result is a recorded control
  failure / fallback, not a silent switch.

## 4. Code change (acceptance §14.3)

Code conversation on `nxr055-validation`: **"Add a one-line comment at the top of src/slugify.js
describing the module."** Expect: lanes planned by the strategy; executor `engine`/`dsh` if the
plane has a `model-turn` control resource, otherwise **`executor: native` with
`control-unavailable`** (expected today: subscriptions are native agents on the plane); sandbox,
gates, review verdict; approve in Desktop → **local** commit; no push. Record task id, lanes,
resources, executor, reason, gate/review results, commit id.

## 5. Integrated flow (acceptance §14.4)

One conversation: proposal (Cowork) → "Review this repository" (Code report-only) → implementation
(Code write, approval, local commit). No resource chosen by hand. Record each turn's lane and
decisions.

## 6. Close-out

- Disconnect the ChatGPT plan if you do not want it to stay connected (Settings → Providers).
- Evidence file written; `project-current-state.md` updated; PR #39 stays draft until the owner
  accepts v0.6.
