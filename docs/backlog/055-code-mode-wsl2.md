# NXR-055: Code mode through the WSL2 engineering plane

**Milestone:** v0.5 — Nexar Desktop · **Labels:** desktop, engineering · **Depends on:** NXR-050, NXR-051 · **ADR:** [ADR-025](../adr/025-code-lane-wsl-bridge.md)

## Summary

Run Code-mode sessions and engineering tasks from the Windows app on the WSL2 plane (ADR-018), with DSH as the default agent.

## Problem

The sandbox needs Linux; the app runs on Windows.

## Objective

From the Windows app the owner can start a coding session on a repository, see the agent's steps and changes, send them to review and gates, and approve a local commit.

## Scope

- A bridge from the desktop engine to a Nexar engine inside WSL2 (spawned over `wsl.exe`, stdio JSON, no network).
- Session view with plan, tool log and diff; Review & commit view.
- DSH via ACP as default; Claude Code and Codex as alternatives.

## Out of scope

- Native Windows sandboxing.
- Pushing.

## Technical notes

- All ADR-018/019 controls stay in force; the WSL2 checks A1–A6 must pass before this ships.

## Acceptance criteria

- [ ] An end-to-end engineering task from the Windows app ends in a `nexar/<task>` commit after approval
      (offline fake-plane E2E passes; owner live run pending).
- [x] Without WSL2 the app explains what is missing.

## Testing expectations

Fake WSL bridge tests; owner-run end-to-end check.

## Security considerations

The bridge carries ids, codes and diffs for display only; no credentials cross it.

## Status (2026-10-03)

**Implementation complete, offline-tested and CI-validated (run `37126853300` at `3f30513`: Linux,
Windows, secret scan). Owner live validation pending:** no `nexar-plane` distro exists on the owner
machine yet, so A1–A6 and the real engineering/report E2Es have not run.

| Criterion                                                              | Implementation                                                                                | Offline / CI evidence                                                                           | Live    |
| ---------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- | ------- |
| Windows → WSL stdio bridge, no listener, no shell                      | `apps/desktop/src/main/{code-plane,plane-connection}.ts` (`487b851`)                          | `code-plane.test.ts` (fixed args, `SystemRoot`-only env)                                        | pending |
| Strict versioned protocol                                              | `@nexar/plane-protocol` `nexar-plane/1` (`5c653c2`, additive report fields `f5c1304`)         | `schemas.test.ts`, `codec.test.ts`, back-compat tests                                           | pending |
| Plane entrypoint                                                       | `nexar plane serve --stdio`                                                                   | `apps/cli/src/plane.test.ts`                                                                    | pending |
| Readiness with actionable reasons                                      | `CodePlane.probe` states + Code banner / Settings → Code (`bc14f01`)                          | `code-plane.test.ts`, `code.e2e.ts` (no-plane scenario)                                         | pending |
| Id-only project mapping                                                | `code:setPlaneProject`, owner-edited distro/command                                           | `code.test.ts` schema negatives, E2E                                                            | pending |
| Engineering write execution → gates → review → approval → local commit | existing `EngineeringRunner` via the plane; plane approvals in Approvals                      | fake-plane `code.e2e.ts` (approve → branch + commit)                                            | pending |
| Report-only review execution                                           | `ChangePlan \| ReportPlan`, `repository-report` (`f5c1304`), Desktop review turns (`41fd1a9`) | `report.test.ts` (read-only lanes, no harvest/approval/commit), `code.e2e.ts` review + relaunch | pending |
| Cancellation                                                           | turn → `cancel` frame → runner abort → tree cleanup                                           | `code.test.ts`, `code-plane.test.ts`                                                            | pending |
| Restart without replay                                                 | ADR-024 interruption; diffs in memory only                                                    | `code.e2e.ts` relaunch scenarios                                                                | n/a     |
| Bounded diff                                                           | 256 KiB plane cap, verified against the patch record                                          | `plane.test.ts`, `code.e2e.ts`                                                                  | pending |
| No native Windows write fallback; honest lanes                         | `honest()` lane records; Code lane unavailable without the plane                              | `service.test.ts`, `code.e2e.ts` refusal                                                        | n/a     |
| No credentials across the bridge; no push                              | SystemRoot-only env; plane uses its own credential mounts; no push path                       | `code-plane.test.ts`; ADR-018/019 controls unchanged                                            | pending |

Owner steps (runbook [`wsl2-engineering-plane.md`](../integration/wsl2-engineering-plane.md)): create
the `nexar-plane` distro, harden `wsl.conf`, install `bubblewrap socat git`, Node ≥ 22.19 and pnpm,
install Nexar at `/usr/local/bin/nexar`, configure one engineering project, then run A1–A6, map the
Desktop project in Settings → Code and run one small review and one small change (no push).
