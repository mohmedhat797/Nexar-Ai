# CLAUDE.md — Nexar operating context

Nexar is a **Personal AI Operating Layer**: local-first, model/provider/agent-agnostic. It
understands a task → chooses an AI resource → orchestrates → executes safely → records telemetry.
External projects (DeepSeek Harness, pi-ai, OpenWorker, Delegate Skills, native coding CLIs) are
**components behind adapters**; Nexar owns the domain.

Read before architectural changes: [`docs/architecture/overview.md`](docs/architecture/overview.md),
the relevant [`docs/adr/`](docs/adr/) entries, and [`docs/architecture/security.md`](docs/architecture/security.md).
Change an architectural decision only via a new/amended ADR.

## Component responsibilities

| Concept                   | Package                        | Owns                                                                |
| ------------------------- | ------------------------------ | ------------------------------------------------------------------- |
| Contracts                 | `packages/contracts`           | Domain types, `NexarError`, `Measured<T>`. Zero deps.               |
| Resource Registry         | `packages/resource-registry`   | What resources exist + dynamic state + probes. **No routing.**      |
| Resource Controller (NRC) | `packages/resource-controller` | "Who executes?" — policy + explainable `RouteDecision`.             |
| Telemetry                 | `packages/telemetry`           | Structured JSON logs (stderr, redacted), telemetry sinks.           |
| Core                      | `packages/core`                | Engine (task → route → execute → record), adapter registry, config. |
| Adapters                  | `integrations/*`               | The **only** code that knows an upstream.                           |
| CLI                       | `apps/cli`                     | Thin client: `doctor`, `resources`, `route`, `run`.                 |

Three questions stay separate: **who executes** (NRC) · **how work is orchestrated** (DSH / native
agent loop) · **how the provider is called** (pi-ai / runtime internals).

## Commands

```bash
pnpm install          # Node >= 22.19, pnpm 10
pnpm check            # format:check → lint → typecheck → test → build (the CI gate)
pnpm test             # vitest (offline, deterministic)
NEXAR_LIVE_TESTS=1 pnpm test   # opt-in live tests (may cost money; never in CI)
pnpm build && node apps/cli/dist/main.js doctor
```

## Rules

**Code:** TypeScript strict, ESM, `readonly` domain types, no default exports, small modules.
Errors crossing a package boundary are `NexarError` with a code. Usage metrics are `Measured<T>`
(never fake a `0`). Inject clocks/ids for determinism. No hidden global state.

**Upstream isolation (ADR-008):** upstream package names, binaries, protocols, and file formats
appear only in `integrations/<name>/`. Never export upstream types. Exact-pin upstream versions.
Every adapter has contract tests against a fake runtime; live tests use
`describe.skipIf(!process.env.NEXAR_LIVE_TESTS)`.

**Security:** never commit secrets, tokens, `.env`, `.nexar/`, session DBs. Config holds credential
_references_ (`{ source: 'env', name }`), never values. Never read or copy a runtime's own
credentials (Claude/Codex/DSH logins) — use their supported CLI/SDK. Probes never make paid calls.
Launch subprocess runtimes with an explicit, minimal env. Don't log prompts at info+.

**Tests:** every behavior change ships with tests. CI must never call paid APIs.

**Git:** feature branch → one logical Conventional Commit per accepted unit (`feat:`, `fix:`,
`docs:`, `test:`, `chore:`, `ci:`) → push → PR to `main`. Never force-push or rewrite published
history. `pnpm check` must pass before every commit.

## Development workflow (ADR-009)

- **Opus** = architect/orchestrator/reviewer: designs, decomposes, writes briefs, reviews every diff,
  runs gates, commits. **Sonnet** = implementer via `claude-delegate`
  (`node ~/.claude/skills/claude-delegate/scripts/relay.mjs --brief <file> --cd <repo> --model claude-sonnet-5-5`).
  Sonnet never commits and is never the final reviewer.
- Brief = objective, why, context, in/out of scope, contracts to preserve, acceptance criteria, tests,
  security + git constraints, "do not redesign". One concern per brief.
- Cloud-container specifics: relay sandbox needs `bubblewrap` + `socat`; the sandbox has **no
  network** (install deps from the orchestrator first); do **not** use `--session`/`--resume-last`
  (the child inherits the parent session id) — rework = fresh dispatch with a delta brief.
- Keep briefs and relay artifacts out of the repo. Log notable usage in `docs/devlog/ai-usage.md`.

## Where things go

ADRs `docs/adr/` · research snapshots (with SHAs) `docs/research/upstream/` · roadmap
`docs/roadmap/ROADMAP.md` · backlog `docs/backlog/` · devlogs/reports `docs/devlog/` ·
example config `config/`. If it matters later, write it into the repo.
