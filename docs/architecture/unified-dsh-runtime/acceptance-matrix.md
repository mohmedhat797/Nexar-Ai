# Unified DSH runtime — acceptance matrix

Every requirement maps to at least one automated test. "Real DSH" = the pinned `dsh` runtime
installed by `scripts/install-dsh-runtime.mjs` (CI sets `NEXAR_DSH_BIN`), no credentials, model
traffic only to a deterministic fake Chat Completions endpoint owned by the test.

| Id  | Requirement                                                     | Test(s)                                                                                                                                                                  | Unit   |
| --- | --------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------ |
| A1  | Real DSH runtime initializes (pinned version, overlay accepted) | `integrations/deepseek-harness/src/acp/local.real.test.ts` (initialize → session/new → close; version gate)                                                              | 01     |
| A2  | DSH executes Cowork through Nexar                               | `apps/desktop/src/main/dsh-cowork.test.ts` (fake ACP), `local.real.test.ts` (prompt → scratch write), `apps/desktop/e2e/cowork.e2e.ts` (proposal → saved draft artifact) | 01, 03 |
| A3  | DSH executes a sandboxed coding workflow                        | `packages/host/src/lane-engine.dsh.integration.test.ts`, engineering suites (Linux CI) + coding overlay test                                                             | 04     |
| A4  | Model selection follows Nexar policy                            | `dsh-cowork.control.test.ts`: Auto, pinned, pinned-unavailable (`fallback: none` fails, `auto` restarts once)                                                            | 02     |
| A5  | Connection identities isolated                                  | two fake connections; only the selected one is called; DSH env holds no key                                                                                              | 02     |
| A6  | Required context survives mode transitions                      | `packages/operating/src/context.test.ts` + `service.test.ts` (Cowork → Code → Cowork)                                                                                    | 05     |
| A7  | Compaction/overflow cannot drop mandatory constraints           | `context@2` overflow fails closed; overlay `personaSuffix` contains the block                                                                                            | 05     |
| A8  | Nexar remains the permission authority                          | `cowork-policy.test.ts` (escalation outside scratch denied, `danger-full-access` denied, `*_always` never chosen), `permissions` regression                              | 01, 03 |
| A9  | No active OpenWorker dependency                                 | static test: no import of / reference to OpenWorker runtime in `apps`, `packages`, `integrations` (legacy schema literals allowlisted); `pnpm check:boundaries`          | 06     |
| A10 | Electron integration operational                                | `pnpm desktop:e2e` source run                                                                                                                                            | 03, 07 |
| A11 | Windows source + packaged E2E                                   | CI `windows-latest` desktop E2E; packaged E2E (`package:win` + launch)                                                                                                   | 07     |
| A12 | Linux engineering + sandbox tests                               | CI `ubuntu-latest` `pnpm check` incl. sandbox/engineering suites                                                                                                         | 04     |
| A13 | No duplicate execution accounting                               | gateway usage recorded once per call; DSH `usage_update` not recorded as telemetry (`dsh-cowork.test.ts`)                                                                | 02     |
| A14 | Existing data safe                                              | sessions fixtures with legacy `openworker` values load; settings with legacy keys load                                                                                   | 05, 06 |
| A15 | Security regressions green                                      | B1–B9 suites unchanged and passing (`capabilities`, `bridge`, `delegation-limit`, `gateway`, `sessions`, `approvals`, `sandbox`)                                         | all    |

## Invariant → test map

| Invariant                         | Existing suite kept                           | New test                                                |
| --------------------------------- | --------------------------------------------- | ------------------------------------------------------- |
| B1 capability validation first    | `packages/contracts/src/capabilities.test.ts` | —                                                       |
| B2 monotonic unit limit           | `packages/engine-gateway/src/bridge.test.ts`  | DSH Cowork control restart keeps one limit              |
| B3 Nexar authority                | `acp/acp.test.ts` permission cases            | Cowork escalation policy                                |
| B4 standalone excludes `reviewOf` | `packages/contracts/src/gateway.test.ts`      | —                                                       |
| B5 no cross-turn native grants    | —                                             | per-turn `DSH_HOME` removed; no `session/resume` issued |
| B6 stable resource ids            | resource-controller suites                    | —                                                       |
| B7 sandbox enforcement            | `acp/launch` + sandbox suites                 | coding overlay keeps launcher checks                    |
| B8 sessions readable              | `packages/sessions` suites                    | legacy-engine fixture                                   |
| B9 single writer                  | sessions lease suites                         | project-memory lease test                               |
