# NXR-070 — Execution Readiness Plan

Estimates are qualified engineering assumptions for the Opus-architect / Sonnet-implementer workflow (ADR-009), not guarantees. "Dispatch" = one implementer brief + review + gates. Sizes are relative.

## 1. Phases

| Phase                    | Units                                      | Entry gate                                 | Exit gate                                                                  | Complexity (assumption)      |
| ------------------------ | ------------------------------------------ | ------------------------------------------ | -------------------------------------------------------------------------- | ---------------------------- |
| P0 Decision              | 070-0 docs reconcile + ADR-029 amendments  | Owner reads the Decision Brief             | Owner approves the amended ADR-029 and the scope (OD-1…OD-6)               | S: 1 docs dispatch           |
| P1 Identity              | 070A′                                      | P0                                         | Golden id vectors byte-identical; exact-head CI green                      | S: 1 dispatch                |
| P2 Second accounts (API) | 070B′, 070C′                               | P1                                         | Offline E2E two API connections; review-dimension corpus; CI green         | M + S: 2–3 dispatches        |
| P3 Facts and policy      | 070F′, 070G′                               | P1 (G′ also C′)                            | v1 golden unchanged; @2 invariants; CI green                               | M + M: 3–4 dispatches        |
| P4 Native accounts       | 070D′ (+ Claude spike), 070E′ if unblocked | P2; spike report reviewed                  | Fake-runtime conformance; CI green; owner-approved live Codex second login | M (+S spike): 2–3 dispatches |
| P5 UI and continuity     | 070H′, 070I′ (I′ may start after P0)       | B′ (H′)                                    | Desktop E2E; context@2 corpus                                              | M + M: 3 dispatches          |
| P6 Acceptance            | 070J′                                      | P1–P5 merged to a PR branch, exact-head CI | Owner live matrix PASS                                                     | M: evidence + owner session  |

Rough total: 15–20 dispatches. The main uncertainties are the Claude spike, the F-17 answer, and Windows E2E flakiness on this machine (Node 24 vs pinned 22).

## 2. Main implementation risks

| Risk                                        | Likelihood | Mitigation                                                         |
| ------------------------------------------- | ---------- | ------------------------------------------------------------------ |
| Settings migration bug loses owner config   | Low–Med    | Additive section, backup, fail-closed reads, fixture corpus (T-14) |
| IPC widening (open ids)                     | Med        | Main-generated ids, forged-id tests (T-02)                         |
| Claude config isolation fails               | Med        | Spike first; keep unsupported if unproven                          |
| OpenAI multi-account policy unknown         | Med        | 070E′ conditional                                                  |
| v1 decision drift from shared code refactor | Low–Med    | Golden corpus; keep v1 modules untouched                           |
| Local Windows CI flakiness (Node 24)        | Known      | `--maxWorkers=2` rerun; exact-head CI is authoritative             |

## 3. Parallelization

After P1, the work splits into independent tracks: {B′ → D′ → H′}, {C′, F′ → G′} and {I′}. I′ is independent of A′ and may start right after P0. To avoid merge conflicts, give each track its own worktree and branch, and cherry-pick onto one integration branch in DAG order.

## 4. Specialist roles

| Role                                     | Where needed                                   |
| ---------------------------------------- | ---------------------------------------------- |
| Architect / reviewer (Opus)              | Every unit: brief, diff review, gates, commits |
| Implementer (Sonnet via claude-delegate) | All code units                                 |
| Security review pass                     | A′, B′, D′ (T-01…T-06, T-15, T-16)             |
| Electron / IPC                           | B′, H′                                         |
| Owner                                    | P0 decisions; live logins; acceptance          |

## 5. CI gates (per unit, unchanged from v0.6 practice)

1. `pnpm check` (format, lint, boundaries, typecheck, test, build) locally before every commit.
2. Gitleaks, plus BOM/control-character/CRLF scan of the diff.
3. Exact-head CI green on Ubuntu and Windows, including source Desktop E2E, Windows packaging and packaged E2E, before stacking the next unit.
4. The v0.6 security regression suites (engine-gateway, mcp relay, cowork, approvals, sandbox) pass unchanged.
5. No paid or live calls in CI.

## 6. Release gates

1. Every unit in scope is merged to the integration branch, with exact-head CI green on its final head.
2. Desktop and plane are built from the same SHA when either surface changed.
3. The owner live acceptance matrix passes:
   - two API-key connections;
   - two Codex connections (owner logins);
   - Auto routing across them;
   - review dimension `connection` preferred;
   - a cross-provider turn sequence preserving `context@2` required items;
   - v0.6 regression set (Cowork SOW, read-only standalone unit, Code native lane).
4. The evidence document records SHAs, consent, counts and reasons, with no secrets.
5. The PR stays draft until the owner accepts.

Control-loop live scenarios are Cowork only. Code Control needs DSH configuration, which is outside NXR-070 (F-10).

## 7. Owner decision points

| ID           | Decision                                                                                     | Default recommendation  |
| ------------ | -------------------------------------------------------------------------------------------- | ----------------------- |
| OD-1         | Approve ADR-029 with Amendments A–E (or request changes)                                     | Approve with amendments |
| OD-2         | Defer ACP worker (070E old) out of NXR-070                                                   | Defer                   |
| OD-3         | Defer native session resume/fork; adopt `context@2`                                          | Defer / adopt           |
| OD-4         | Multi-account order: API keys → Codex → (ChatGPT plan conditional) → Claude only after spike | Approve                 |
| OD-5         | Review dimensions: default stays resource-id; `connection` available opt-in                  | Approve                 |
| OD-6         | No cash budget/billing enforcement in NXR-070                                                | Confirm                 |
| OD-7 (later) | Switch Desktop default policy to `resource-intelligence@2` after P3 evidence                 | Decide after P3         |
| OD-8 (later) | Live logins for second Codex/plan accounts                                                   | Owner-initiated only    |
