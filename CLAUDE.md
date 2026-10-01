# CLAUDE.md — Nexar operating context

Nexar is a **Personal AI Operating Layer**: local-first, model/provider/agent-agnostic. It
understands a task → chooses an AI resource → orchestrates → executes safely → records telemetry.
External projects (DeepSeek Harness, pi-ai, OpenWorker, Delegate Skills, native coding CLIs) are
**components behind adapters**; Nexar owns the domain.

Read before architectural changes: [`docs/architecture/overview.md`](docs/architecture/overview.md),
the relevant [`docs/adr/`](docs/adr/) entries, and [`docs/architecture/security.md`](docs/architecture/security.md).
Change an architectural decision only via a new/amended ADR.

## Component responsibilities

| Concept                   | Package                        | Owns                                                                                                                    |
| ------------------------- | ------------------------------ | ----------------------------------------------------------------------------------------------------------------------- |
| Contracts                 | `packages/contracts`           | Domain types, `NexarError`, `Measured<T>`. Zero deps.                                                                   |
| Resource Registry         | `packages/resource-registry`   | What resources exist + dynamic state + probes; discovery merge + cache. **No routing.**                                 |
| Resource Controller (NRC) | `packages/resource-controller` | "Who executes?" — `deterministic@1` / `resource-intelligence@1`, quota, cost, explainable `RouteDecision`.              |
| Telemetry                 | `packages/telemetry`           | Structured JSON logs (stderr, redacted), sinks, bounded readers (quota accounting, history).                            |
| Core                      | `packages/core`                | Engine (task → route → execute → record), adapter registry, config.                                                     |
| Projects                  | `packages/projects`            | Projects, `resolveContainedPath` (realpath policy), defaults, document sets.                                            |
| Artifacts                 | `packages/artifacts`           | `LocalArtifactStore`: safe names, no overwrite, contained writes.                                                       |
| Approvals                 | `packages/approvals`           | Fail-closed, fingerprint-bound, single-use approvals; outward-action gate.                                              |
| Access                    | `packages/access`              | Client tokens, scopes, allowlisted JSONL request audit.                                                                 |
| Workflows                 | `packages/workflows`           | Workflow catalog, template renderer, runner. Data in `workflows/`.                                                      |
| Sandbox                   | `packages/sandbox`             | bwrap profile, `SandboxLauncher`, egress proxy; the only code that invokes bwrap.                                       |
| Worktrees                 | `packages/worktrees`           | Private clone, sandboxed harvest, patch policy, verification clone, `commitPatch`.                                      |
| Engineering               | `packages/engineering`         | Lane plans (`engineering/`), runner, gates, review verdict, task records.                                               |
| Host                      | `packages/host`                | Shared composition for CLI and desktop: config loading; the only place adapters are instantiated.                       |
| Adapters                  | `integrations/*`               | The **only** code that knows an upstream (incl. `mcp`, `openworker` bridge, `codex`, `antigravity`, `delegate-skills`). |
| Desktop                   | `apps/desktop`                 | Electron app (ADR-021): main process hosts the engine; sandboxed renderer; one zod-validated bridge.                    |
| CLI                       | `apps/cli`                     | Thin client: `doctor`, `resources`, `route`, `run`, plus the commands below.                                            |

Three questions stay separate: **who executes** (NRC) · **how work is orchestrated** (DSH / native
agent loop) · **how the provider is called** (pi-ai / runtime internals).

## Commands

```bash
pnpm install          # Node >= 22.19, pnpm 10
pnpm check            # format:check → lint → boundaries → typecheck → test → build (the CI gate)
pnpm test             # vitest (offline, deterministic)
NEXAR_LIVE_TESTS=1 pnpm test   # opt-in live tests (may cost money; never in CI)
pnpm build && node apps/cli/dist/main.js doctor
pnpm --filter @nexar/desktop start   # the desktop app (after pnpm build)
xvfb-run -a pnpm desktop:e2e         # Playwright drives the real app (Windows/macOS: without xvfb-run)
```

Continuing locally: [`docs/guides/local-development.md`](docs/guides/local-development.md).

CLI: `doctor` · `resources` (`--discovered`) · `route` (`--explain`) · `run` (`--project`, `--document-set`, `--workflow`, `--input`,
`--input-file`, `--list-input`; both take `--max-cost`, `--require-known-quota`) · `projects list` · `artifacts list` · `approvals list|approve|deny` ·
`clients add|list|revoke` · `mcp serve` · `workflows list` · `engineer run|list|show|plans|cleanup` ·
`sandbox selftest`. Check flags with `--help`.

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

**Path safety (ADR-012):** any path from a request, workflow input or model output goes through
`resolveContainedPath`; pass the canonical result onward, never the original string. Never echo a
rejected path in an error or log. Project-internal config paths resolve against the project's first
root; `roots` resolve against the config file's directory. The engine enforces workspace policy before
routing (default `project-only`; the CLI uses `project-or-unscoped`).

**Artifacts (ADR-013):** write only through `LocalArtifactStore` (sanitized names, forced extension,
`O_EXCL` no-overwrite, per-level realpath checks, 0600/0700). Drafts go under `drafts/`. Refs and
hashes go into telemetry, never content.

**MCP / Work Bridge (ADR-014, ADR-015):** stdio only; stdout carries protocol frames only (logs to
stderr); every tool call is authenticated, authorized and audited exactly once; never expose the server
over a network or add a network transport without an ADR and security review. Audit records are a field
allowlist: no prompts, paths, content or tokens. Request fields must never widen scopes or paths.

**Approvals (ADR-016):** deny by default. v0.2 registers **no** outward executors (no email, calendar,
upload, push); adding one needs an ADR, an executor and approval binding. Nexar produces drafts only.

**Workflows (ADR-017):** a workflow is data (`workflow.json` + Markdown templates in `workflows/`), not
code. Every input is rendered inside an `<untrusted-input>` wrapper and never reaches the trusted system
prompt; documents are passed as references, not content; outputs are draft-only. `@nexar/workflows`
must not import mail, HTTP or approval-execution code (a static test enforces this).

**Engineering (ADR-018, ADR-019):**

- Write-capable lanes run only through the sandbox launcher; adapters refuse (`POLICY_REJECTED`)
  write mode when `launcher.isolation !== 'sandbox'`. No unsandboxed fallback.
- Agents never commit or push: `.git` read-only, no remote, proxy denies git hosts.
- The host never runs git inside an agent worktree: harvest runs in a sandbox with Nexar's pristine
  `GIT_DIR`. Patches must pass the patch policy.
- Commits only via `commitPatch`, after gates + review + owner approval (`engineering.commit`,
  fingerprint-bound, single-use) or an explicit project `ownerApproval: "never"`. Never push.
- Credential mounts are owner-declared and never read, parsed or copied. Egress is default-deny with
  exact-host allowlists. Gates have no network.
- Records and telemetry carry ids, counts and hashes only; no prompts, diffs, gate output or paths.
- Never call `recoverAfterRestart` from engineering commands (it would cancel pending requests of a concurrently running MCP server).
- `@nexar/engineering` imports no network, mail or push code (static test).

**Resource intelligence (ADR-020):**

- Hard filters run before scoring; a score never re-admits a rejected candidate and never authorizes
  anything (sandbox, patch policy, review diversity, gates, approval and commit stay outside routing).
  Keep the seeded invariant tests green when adding a filter or factor.
- Policies are pure: no IO, no real clock (`facts.now`), never the prompt (only `TaskSizeEstimate`).
  Quota, history and discovery are read outside the policy; a failing source means "unknown".
- Quota is `unknown` unless owner-declared, Nexar-accounted or vendor-reported through a documented
  interface. Never scrape dashboards, call private APIs, read credential stores or infer limits; never
  treat unknown as unlimited or zero. Never fabricate usage or cost (`Measured<T>`).
- History and engineering records are untrusted input: bounded, shape-guarded, clamped,
  prototype-safe, no symlinks. Owner preferences rank before learned signals by default.
- Fallback to `deterministic@1` reuses the same hard filters and is recorded in `policy.fallback`.
- Discovery finds candidates only: stat binaries (never run them), owner-listed endpoints and pi
  providers only, no LAN scans, config wins collisions, discovered ≠ authenticated.
- `deterministic@1` stays byte-for-byte unchanged; a new behavior is a new versioned policy.

**Desktop (ADR-021, ADR-022, ADR-023):**

- The renderer is untrusted: `sandbox`, `contextIsolation`, no Node, strict CSP, no navigation or new
  windows. Never render model output as HTML (`dangerouslySetInnerHTML` is forbidden).
- Every bridge channel has a strict zod schema validated in the main process; errors leave as
  `{ code, message }` without paths or stacks; only the app's own page may call the bridge. Add a
  channel in `src/shared/channels.ts` + `api.ts`, `src/main/<area>.ts`, the preload, and tests.
- Renderer paths are project-relative and contained (`resolveProjectPath`); projects are added only
  through the native folder dialog; the engine runs with the `project-only` workspace policy.
- No network listener in the app. Secrets never cross IPC; API keys (when built) are encrypted with
  `safeStorage` and resolved in main at call time. Schedules never auto-approve.

**Tests:** every behavior change ships with tests. CI must never call paid APIs.

**Git:** feature branch → one logical Conventional Commit per accepted unit (`feat:`, `fix:`,
`docs:`, `test:`, `chore:`, `ci:`) → push → PR to `main`. Never force-push or rewrite published
history. `pnpm check` must pass before every commit.

## Local state (`.nexar/`, git-ignored, never committed)

Next to the config file (or the cwd with the built-in config): `clients.json` (hashed tokens, 0600),
`audit.jsonl` (request audit), `approvals/` (approval records), `runtimes/` (isolated runtime state),
`engineering/<task>/record.json` (engineering task records), `telemetry.jsonl` (where configured).
The desktop app keeps the same files in `<appData>/Nexar` (`%APPDATA%\Nexar` on Windows) plus
`desktop-settings.json`. Artifacts live under each project root: `<root>/.nexar/artifacts/<task>/[drafts/]`. Engineering
worktrees live outside the repo, on the plane's own filesystem:
`$XDG_DATA_HOME/nexar/worktrees/<project>/<task>/` (default `~/.local/share/nexar/worktrees`).

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
example config `config/` · workflows `workflows/`. If it matters later, write it into the repo.
