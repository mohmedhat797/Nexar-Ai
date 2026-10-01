# NXR-050: Desktop foundation — host package, Electron shell, bridge, Cowork chat

**Milestone:** v0.5 — Nexar Desktop · **Labels:** desktop · **Depends on:** none

## Summary

Create `apps/desktop` (Electron + React) and the shared `@nexar/host` composition, with a typed, validated bridge and the first working screens.

## Problem

Nexar has no graphical interface; the CLI alone is hard to start with (see ADR-021 context).

## Objective

An owner can open the app, add a project folder, run a Cowork task on a real resource, see why that resource was chosen, open the resulting draft, decide approvals, browse resources and workflows, and switch themes.

## Scope

- Move CLI composition into `@nexar/host`; CLI behaviour unchanged.
- Electron main process hosts the engine (`EngineHost`); sandboxed renderer with CSP; preload exposes `window.nexar` over `ipcRenderer.invoke`; every channel validated with zod in main.
- Per-user state under Electron `userData` (config, `.nexar/`, `desktop-settings.json`); projects added with the native folder dialog; `project-only` workspace policy.
- Screens: sidebar with Cowork/Code switch, projects and sections; Cowork chat with routing explanation and artifacts; files panel; Resources; Approvals; Workflows; Settings → Appearance (six themes, density).
- `TaskOrigin.source = 'desktop'`.

## Out of scope

- Providers, AI behavior wiring, schedules, Code-mode engineering, OpenWorker agent (NXR-052 to NXR-056).
- Installers and Windows-specific fixes (NXR-051).

## Technical notes

- The renderer is untrusted: no Node access, no raw HTML from model output, navigation and new windows denied.
- Streaming progress uses main → renderer events that carry codes and numbers only.

## Acceptance criteria

- [ ] The app starts, adds a folder as a project and runs a task end to end with the echo resource offline and with a real resource when available.
- [ ] Every bridge channel rejects malformed input and paths outside the project.
- [ ] Themes apply to the whole app and persist across restarts.
- [ ] `pnpm check` passes; an Electron E2E job runs in CI under Xvfb.

## Testing expectations

Unit tests for the bridge schemas and handlers with a fake engine; Playwright Electron E2E tests (offline, echo resource) under Xvfb; no paid calls.

## Security considerations

Renderer sandboxing and CSP verified by tests; no secrets or prompts in IPC responses, logs or telemetry; ADR-012 path containment on every path input.
