# ADR-021: Nexar Desktop — an Electron app with Cowork and Code modes

**Status:** Accepted (2026-10-01) · Builds on ADR-004 (OpenWorker), ADR-006 (local-first), ADR-012
(path containment), ADR-014/015 (no network transport, audited access), ADR-016 (approvals), ADR-018
(engineering plane), ADR-019 (lanes), ADR-020 (resource intelligence) · Related: ADR-022 (provider
credentials), ADR-023 (scheduled tasks) · Design reference: the owner-approved clickable mockup
(Workspace, Setup, Settings, Scheduled, Providers screens)

## Context

Nexar works today through the `nexar` CLI and, for OpenWorker, through a stdio MCP server. The owner's
goal is a desktop app on their laptop, Windows first, that works on the folders they create for their
projects, in the way Claude Cowork or the Codex app do, but with Nexar's own engine underneath: routing
across many AI resources with explanations, quota and cost awareness, workflows, approvals and the
sandboxed engineering pipeline.

A first-run UX review found that the CLI alone is hard to start with: no setup step, a default
configuration that only has the offline echo resource, required flags without defaults, and noisy
errors. The owner chose a desktop app over a CLI polish pass or a browser dashboard, and chose Electron,
a chat-plus-files layout and a mockup-first process.

The owner also asked for two working modes, matching the Claude desktop app and the Codex app:

- **Cowork:** documents, files, email and calendar drafts. OpenWorker is responsible for this work
  (ADR-004 already names it the productivity engine).
- **Code:** repositories, changes and tests. DeepSeek Harness (DSH) is responsible for this work.

## Decision

### 1. Technology and packaging

- A new workspace app, **`apps/desktop`**: Electron (exact-pinned) with a React renderer built by Vite.
- **Windows 10/11 x64 is the first-class target.** macOS and Linux builds come later from the same code.
  Installers (NSIS on Windows) are produced with electron-builder in a later phase; until then the app
  runs from the repository.
- The renderer UI follows the mockup: sidebar with the Cowork/Code switch, projects and sections; a
  chat or session in the middle; files or changes on the right; Settings with Appearance, AI behavior
  and Providers tabs.

### 2. Process model and the IPC boundary

- **The Nexar engine runs in Electron's main process**, built by a shared composition module (below).
  The engine is asynchronous and its heavy work runs in subprocesses (agents, sandbox), so the UI stays
  responsive. The main process talks to the engine through one `EngineHost` interface, so moving the
  engine into an Electron `utilityProcess` later is a local change if profiling shows UI stalls.
- **The renderer is untrusted.** It displays model output and file content, so it is treated like an
  external client:
  - `sandbox: true`, `contextIsolation: true`, `nodeIntegration: false`, `webSecurity` on, no
    `remote` module, no `webview`.
  - A strict Content-Security-Policy: scripts and styles only from the packaged app; no remote content.
  - Navigation away from the app and new windows are denied; external links open only through an
    explicit, allowlisted `shell.openExternal` call.
  - Model output is rendered as text or sanitized Markdown, never as raw HTML.
- **A narrow, typed bridge.** The preload script exposes one object, `window.nexar`, built with
  `contextBridge`. Each method calls `ipcRenderer.invoke` on a named channel. The main process validates
  every request with a zod schema before acting, exactly as the MCP server validates tool calls. Request
  fields never widen scopes or paths (ADR-015). Responses carry the same allowlisted data the CLI
  prints: ids, codes, numbers, explanations and artifact references.
- **No network listener.** The app opens no port. The MCP server stays stdio-only (ADR-014). A future
  remote or mobile surface still needs its own ADR.

### 3. Shared composition

The CLI's composition (config loading, adapter instantiation, quota, history and discovery sources) moves
into a new package, **`@nexar/host`**, used by both `apps/cli` and `apps/desktop`. It is the only place
adapters are instantiated. CLI behaviour does not change.

### 4. Where the app keeps its state

- The desktop app has a per-user home: `%APPDATA%\Nexar` on Windows (Electron `userData`; the platform
  equivalent elsewhere). It holds `nexar.config.json`, the `.nexar/` state directory (approvals,
  telemetry, engineering records, schedules) and `desktop-settings.json` (theme, density, mode defaults).
  The CLI can point at the same config with `--config`.
- **Projects are folders the owner picks** with the native folder dialog. Each becomes a Nexar project
  whose root is the canonical path. Every path from the renderer goes through `resolveContainedPath`
  (ADR-012), and the desktop engine uses the `project-only` workspace policy: no task runs outside a
  project the owner added.
- Artifacts keep their ADR-013 location inside each project (`<root>/.nexar/artifacts/...`), so they are
  visible in the project's files panel and in Explorer.

### 5. Modes

A mode is a named set of defaults, not a separate engine. Switching mode changes the sidebar, the default
agent, the permission profile and the right-hand panel.

| Mode       | Default agent        | Other agents                    | Writes                                                                    |
| ---------- | -------------------- | ------------------------------- | ------------------------------------------------------------------------- |
| **Cowork** | **OpenWorker**       | Claude Code, Auto (Nexar picks) | Drafts only, by default, in the project (ADR-013); never sends or uploads |
| **Code**   | **DeepSeek Harness** | Claude Code, Codex, Auto        | Only in the sandboxed private clone; commits only through `commitPatch`   |

- The default agent is an **owner preference** (tier 3 in ADR-020), so it wins over learned scores; the
  routing policy still applies every hard filter, and Auto lets Nexar choose. When the default agent is
  unavailable (not installed, not signed in, no key), routing falls back to the next eligible resource
  and the explanation says why.
- **Cowork through OpenWorker** needs the Nexar → OpenWorker seam that ADR-004 (decision 4) planned and
  that is not built yet: a pinned, contract-tested adapter driving a Nexar-supervised `openworker-server`
  (its own state directory), with OpenWorker's approval requests mapped onto Nexar approvals. Until it
  ships, Cowork tasks route among the other document-capable resources.
- **Code through DSH** uses the existing ACP lane (ADR-019) and the full engineering pipeline: sandbox,
  patch policy, gates, a review by a different resource, owner approval and a Nexar-owned local commit.
  On Windows this pipeline runs on the WSL2 plane (ADR-018); the desktop app hands engineering tasks to
  a Nexar engine inside WSL2. That bridge is a later phase. Until then, Code mode on Windows offers
  sessions in read-only or plan permission modes and shows engineering as unavailable.

### 6. Settings

- **Appearance:** themes (Light, Dark, Sand, Midnight, Forest, High contrast), density, and following
  the Windows light/dark setting. Renderer-only; stored in `desktop-settings.json`.
- **AI behavior, per mode.** The owner chooses the default agent, the model (or Auto), reasoning effort
  and a permission mode. Each choice maps onto options the runtimes already document:
  - Cowork: read only · drafts only (default) · ask before every write.
  - Code: plan only · ask before edits · auto-edit in the sandbox (default) · full auto in the sandbox
    (also installs packages from allowlisted hosts). These map to Claude Code's `permissionMode`, Codex's
    sandbox and approval settings, and DSH's ACP permission handling (ADR-019), always inside Nexar's
    sandbox.
  - Agent network: off, or allowlisted hosts only.
  - **Locked rules are shown, not configurable:** write access only in the sandbox, review by a
    different AI, agents never commit or push, no outward actions (email, upload, publish) without a
    future ADR (ADR-016).
- **Providers:** see ADR-022.

### 7. What the renderer can ask for (v1 bridge surface)

Projects (list, add by dialog, remove), resources (list with quota and provenance, discovery), route
explanation, run a task (with streaming progress events), artifacts (list, open in the OS, show in
folder), approvals (list, approve, deny), workflows (list, run), settings (read, write), and later
schedules (ADR-023) and providers (ADR-022). Each method is a separate, schema-validated channel.

## Rationale

- Electron runs the existing TypeScript engine unchanged, in-process, with the largest ecosystem for a
  Windows desktop app. Tauri would need the Node engine as a separate sidecar process.
- Keeping the engine in the main process and treating the renderer as an untrusted client reuses the
  security model that already protects the MCP server, instead of inventing a new one.
- Modes as defaults (not separate engines) keep one routing, approval and telemetry path, so every
  existing control applies in both modes.

## Alternatives considered

- **Local web dashboard on `localhost`:** works everywhere, but opens a network port, which ADR-014
  forbids without a security review, and is not the native app the owner wants.
- **Tauri:** smaller binaries, but a Rust shell plus a Node sidecar adds a process boundary and a
  second toolchain.
- **Embedding OpenWorker's own desktop app:** rejected; OpenWorker stays an out-of-process component
  (ADR-004, no fork).
- **A separate engine per mode:** rejected; it would duplicate routing, approvals and telemetry.

## Consequences

- A new app, a new package (`@nexar/host`) and new IPC tests. The CLI keeps working unchanged.
- CI gains an Electron end-to-end job (Playwright under Xvfb) and, in a later phase, a Windows job.
- `TaskOrigin.source` gains `desktop` (and `schedule`, ADR-023).
- The v0.5 milestone becomes **Nexar Desktop**. The mobile app and remote control plane move to a later
  milestone and still need their own ADR.

## Risks

- **The engine has never run natively on Windows.** Subprocess launching (`.cmd` shims), paths,
  POSIX file modes (0600/0700 have no Windows equivalent) and symlink checks need a compatibility pass
  and a Windows CI job before the app is usable there.
- **Renderer compromise** through crafted model output. Mitigated by sandboxing, CSP, no raw HTML and
  main-process validation of every request.
- **OpenWorker integration** depends on a pre-1.0 upstream API (ADR-004). It is pinned and
  contract-tested, and Cowork works without it.
- **DSH on Windows** needs WSL2 and a DeepSeek API key; Code mode degrades to the other agents without
  them.

## Follow-up work (phases)

1. **Foundation:** this ADR, ADR-022, ADR-023; `@nexar/host`; the `apps/desktop` shell with the
   bridge, projects, Cowork chat on real resources, resources, approvals, workflows and Appearance
   settings; Electron E2E tests.
2. **Windows compatibility pass** of the engine and a Windows CI job; installer.
3. **Providers** (ADR-022) and **AI behavior** settings wired to the adapters.
4. **Scheduled tasks** (ADR-023), with a tray icon.
5. **Code mode:** engineering through the WSL2 plane; DSH as the default agent.
6. **Cowork through OpenWorker:** the ADR-004 automations seam, pinned and contract-tested.
