# Continuing Nexar on your own machine

Current continuation (2026-10-02): work is on `feat/nexar-operating-layer`, draft PR #36. Windows
automated acceptance, Operating Sessions and routing, and Desktop encrypted API-key setup are
implemented, including explicit provider metadata checks. Owner Windows acceptance remains pending; vendor sign-in,
WSL Code, OpenWorker Cowork and behavior settings follow. Schedules and Mobile are deferred.
Use the [continuation state](../devlog/operating-layer-progress.md) for the exact next unit and
the [Providers guide](providers.md) for key setup. The phase-1 snapshot below is historical.

This is the hand-over guide for developing and testing Nexar locally, written at the end of the
**Nexar Desktop phase 1** session (2026-10-01). It says where things stand, how to run and test
everything, how the desktop app is built, and exactly what to build next.

Branch: `claude/eager-ptolemy-j5bbnj` · Pull request: mohmedhat797/Nexar-Ai#35 (CI green) ·
Decisions: [ADR-021](../adr/021-nexar-desktop.md), [ADR-022](../adr/022-provider-credentials.md),
[ADR-023](../adr/023-scheduled-tasks.md) · Phase report:
[`v0.5-desktop-phase1-report.md`](../devlog/v0.5-desktop-phase1-report.md) · Owner-approved mockup:
https://claude.ai/artifact/2XgS6QfxvKVjpuazraeojN (private to you; the target for every screen).

## 1. Where things stand

| Area                                                                   | State                                                             |
| ---------------------------------------------------------------------- | ----------------------------------------------------------------- |
| Engine, CLI, MCP server, workflows, approvals (v0.1–v0.2)              | Done, merged                                                      |
| Engineering plane: sandbox, worktrees, lanes, review, commit (v0.3)    | Done, merged; runs on Linux / WSL2 only                           |
| Resource intelligence: quota, cost, history, discovery (v0.4)          | Done, merged                                                      |
| `@nexar/host` shared composition                                       | Done (this branch)                                                |
| **Nexar Desktop phase 1 (NXR-050)**                                    | **Done (this branch): runs on Linux; never run on Windows yet**   |
| Windows pass, providers, AI behavior, schedules, Code mode, OpenWorker | Not started: NXR-051 to NXR-056 ([backlog](../backlog/README.md)) |

What the app does today: open a folder as a project; Cowork chat with a routing card and a "Why this
choice?" breakdown; progress events; the result saved as a draft in
`<project>\.nexar\artifacts\<task>\drafts\result.md` with Open and Show in folder; a project files
panel with text preview; AI resources (configured and discovered); approvals; workflows; Settings →
Appearance with six themes and density (persisted). Code mode shows a placeholder.

## 2. Set up on Windows

Prerequisites:

- **Node.js ≥ 22.19** (LTS installer from nodejs.org) and **pnpm 10**: `corepack enable` in an
  administrator terminal once, then `pnpm --version` should print 10.x.
- **Git for Windows.**
- Optional, for real AI work: **Claude Code** (`claude`, signed in through its own login; `claude auth status` shows it) and/or
  **Codex** (`codex`, signed in with `codex login`). Nexar finds them on `PATH` and never reads their
  logins.
- Later, for engineering (Code mode): WSL2 with Ubuntu, following
  [`wsl2-engineering-plane.md`](../integration/wsl2-engineering-plane.md).

```powershell
git clone https://github.com/mohmedhat797/Nexar-Ai.git
cd Nexar-Ai
git checkout claude/eager-ptolemy-j5bbnj   # or main, once PR #35 is merged
pnpm install
pnpm build
```

`pnpm install` downloads Electron. If the app later says Electron is missing, the start and E2E
scripts fetch it automatically; you can also run
`node node_modules/.pnpm/electron@44.5.1/node_modules/electron/install.js`.

## 3. Run it

```powershell
pnpm --filter @nexar/desktop start          # the desktop app (build first)
node apps/cli/dist/main.js doctor           # the CLI: what is installed and usable
node apps/cli/dist/main.js resources --discovered
```

**Where the app keeps its data:** `%APPDATA%\Nexar` (Linux: `~/.config/Nexar`).

| File                    | What it is                                                                       |
| ----------------------- | -------------------------------------------------------------------------------- |
| `nexar.config.json`     | The app's Nexar config. Created on first run; projects you add are written here. |
| `desktop-settings.json` | Theme, density, mode.                                                            |
| `.nexar\`               | Telemetry, approvals, engineering records (never commit this anywhere).          |

Delete the folder to start fresh. Your project folders are never deleted; removing a project only
removes it from the config.

**Using a real AI instead of the echo resource.** The first-run config contains only the offline
`local-echo` resource and turns on discovery, so an installed and signed-in Claude Code appears in
**AI resources** as `discovered:cli:claude-code`. In the chat composer, pick it in the **AI** selector
(Auto still prefers the echo resource, because it is the configured default). To make Claude Code the
default, close the app, copy the `claude-code` resource from
[`config/nexar.config.example.json`](../../config/nexar.config.example.json) into the `resources` array
of `%APPDATA%\Nexar\nexar.config.json` and set `"defaultResourceId": "claude-code"`. (Discovered ids
cannot be referenced from the config by design, ADR-020 §9.) Real runs use your subscription
allowance.

## 4. Test it

| Command                        | What it runs                                                                            | Notes                                                                    |
| ------------------------------ | --------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| `pnpm check`                   | format, lint, upstream boundaries, typecheck, all unit tests, build: the CI gate        | Must pass before every commit. 1863 tests on Linux.                      |
| `pnpm vitest run apps/desktop` | The 58 desktop bridge tests                                                             | Fast; use while changing `src/main`.                                     |
| `pnpm desktop:e2e`             | Playwright drives the real Electron app (first run → project → task → theme → relaunch) | Build first. On Linux without a display: `xvfb-run -a pnpm desktop:e2e`. |
| `NEXAR_LIVE_TESTS=1 pnpm test` | Opt-in live tests against real runtimes                                                 | May cost money. Never in CI.                                             |

**On Windows, expect some unit tests to fail until NXR-051 is done.** The sandbox, worktree and some
file-permission tests assume Linux (bubblewrap, POSIX modes, unix sockets). That list is the first
input to the Windows pass. Do not delete or skip tests to make them pass; mark Linux-only suites with
`describe.skipIf(process.platform === 'win32')` only where the feature cannot exist on Windows, and
say why.

## 5. How the desktop app is built

```
apps/desktop/
  src/main/       Electron main process: hosts the engine (engine-host.ts), the bridge (bridge.ts,
                  channel.ts and one module per area), config and settings stores, window hardening
  src/preload/    preload.ts: exposes window.nexar (one method per channel) via contextBridge
  src/shared/     channel names and request/response types shared by main, preload and renderer
  src/renderer/   React UI (App.tsx, components/, theme.ts with the six themes)
  e2e/            Playwright E2E spec
  scripts/        build.mjs (esbuild main + preload, Vite renderer), start.mjs, e2e.mjs
```

Rules that keep it safe (ADR-021; also in `CLAUDE.md`):

- **The renderer is untrusted.** It runs sandboxed with a strict CSP and no Node. Never use
  `dangerouslySetInnerHTML`; render model output as text.
- **Every request is validated in the main process** with a strict zod schema; errors leave as
  `{ code, message }` without paths or stacks; only the app's own page may call the bridge.
- **Paths from the renderer** are project-relative and go through `resolveProjectPath` /
  `resolveContainedPath`; never echo a rejected path.
- **No network listener**, no secrets over IPC, projects only through the native folder dialog.

**Adding a feature that needs the engine** (for example a new screen):

1. Add the channel name in `src/shared/channels.ts` and its request/response types in
   `src/shared/api.ts`.
2. Add a strict zod schema and a handler in the matching `src/main/<area>.ts` with `defineChannel`,
   and register the area's table in `src/main/bridge.ts` if it is new.
3. Add the method to `src/preload/preload.ts` and call it from the renderer through
   `src/renderer/bridge.ts`.
4. Add bridge tests in `src/main/bridge.test.ts` (bad input, path escapes, the happy path) and extend
   `e2e/desktop.e2e.ts` when the user can see it.
5. `pnpm check`, `pnpm desktop:e2e`, then commit.

## 6. What to build next, in order

Each item has a backlog file with scope, acceptance criteria, tests and security notes. Do them as
separate branches and pull requests.

1. **NXR-051: Windows pass** ([spec](../backlog/051-windows-compatibility.md)).
   - Run `pnpm check` and the app on Windows; list every failure.
   - Likely spots: launching `claude`/`codex` (`.cmd` shims and argument quoting in the adapters'
     `process.ts`), `PATHEXT`, path separators, 0600/0700 file modes (`packages/artifacts`,
     `packages/approvals`, config and settings writes), symlink checks in `packages/projects`.
   - Add a `windows-latest` job to `.github/workflows/ci.yml` (no bubblewrap step) and an
     electron-builder NSIS installer (`productName` is already `Nexar`).
2. **NXR-052: Providers** ([spec](../backlog/052-providers-and-key-store.md)). The Settings tab
   exists as a placeholder (`SettingsView.tsx`). Add the `keystore` credential source, a key store over
   Electron `safeStorage` in `src/main`, and a resolver injected through `@nexar/host`. Mockup:
   Settings → Providers.
3. **NXR-053: AI behavior settings** ([spec](../backlog/053-ai-behavior-settings.md)). Map each
   per-mode choice to adapter options (Claude `permissionMode`, Codex sandbox/approval, DSH ACP).
   Locked rules stay read-only.
4. **NXR-054: Scheduled tasks** ([spec](../backlog/054-scheduled-tasks.md), ADR-023). A pure
   recurrence calculator, a store under `.nexar\schedules.json`, a scheduler loop with an injected
   clock in the main process, and a tray icon. Mockup: Scheduled.
5. **NXR-055: Code mode** ([spec](../backlog/055-code-mode-wsl2.md)). The bridge from the Windows app
   to a Nexar engine in WSL2 (`wsl.exe`, stdio JSON, no network), the session and diff views, and
   Review & commit. Close the deferred WSL2 checks A1–A6 first.
6. **NXR-056: Cowork through OpenWorker** ([spec](../backlog/056-cowork-openworker-agent.md),
   ADR-004 decision 4).

Smaller gaps noticed while testing phase 1:

- The mockup's **first-run Setup screen** (detected tools, projects folder, routing choice) is not
  built; the app opens straight to "Open folder as project".
- **New task** only focuses the message box; chats are kept in memory and are gone after a restart
  (no conversation history yet).
- The "Today" card counts this session only.
- Each message is a separate task: the agent does not see earlier messages of the chat yet.

## 7. Working with Claude Code on this repository

`CLAUDE.md` holds the rules every change must follow and is read automatically by Claude Code.
The workflow used so far (ADR-009):

- One task per branch; read the relevant ADR first; change a decision only with a new or amended ADR.
- For larger work, write a brief (objective, why, context, in/out of scope, acceptance criteria,
  tests, security and git constraints, "do not redesign") and let an implementer work from it; then
  review the whole diff yourself, run `pnpm check` and the E2E, and commit one logical unit with a
  Conventional Commit message.
- Never commit secrets, `.env` or `.nexar\`; never push from an agent; never skip a failing test.
- Record notable AI usage in [`docs/devlog/ai-usage.md`](../devlog/ai-usage.md).

## 8. Troubleshooting

| Symptom                                                   | Fix                                                                                           |
| --------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| `nexar-desktop: not built yet`                            | `pnpm build` at the repository root.                                                          |
| "Electron failed to install correctly"                    | Run the `install.js` command from section 2, or `pnpm --filter @nexar/desktop start` again.   |
| `nexar-desktop: startup failed: …`                        | Usually an invalid `%APPDATA%\Nexar\nexar.config.json`; fix it or delete it to regenerate.    |
| Claude Code not listed in AI resources                    | `claude --version` must work in the same terminal; then **Refresh** in AI resources.          |
| E2E on Linux: "Missing X server"                          | Run it as `xvfb-run -a pnpm desktop:e2e`.                                                     |
| A task fails with `POLICY_REJECTED` about the working dir | The desktop app only runs tasks inside projects you added (`project-only` policy, by design). |
