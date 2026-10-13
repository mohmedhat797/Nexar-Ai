# Unified DSH runtime — acceptance matrix

This table maps requirements to tests; it does not certify that every gate has run on every platform. Current exact-source verdicts and remaining blockers are in [FCR01_Final_Verification.md](../../development/FCR01_Final_Verification.md) and [FCR02_Reliability_Diagnostics.md](../../development/FCR02_Reliability_Diagnostics.md). ADR-030 is Proposed and PR #41 Draft.

## Release gates and owner decisions (OD-SEC-01 to OD-SEC-07, 2026-10-13)

Nexar is accepted as a **Windows Desktop** product for the current milestone. The full Owner
Decision Register is in the
[NXR-SEC-01 owner handover](../../development/NXR_SEC01_Final_Owner_Handover.md#owner-decision-register).

**Primary evaluation baseline (OD-SEC-01):** Windows 11 Pro **25H2** x64 (build **26200**), fully
updated. Windows 11 26H2 may be evaluated as an additional compatibility target. The existing
Windows CI evidence (FCR-02, `e2a82ae`) was produced on Windows 11 Pro build 26300. It has **not**
yet been repeated on the 26200 baseline.

| Gate                                                                                  | Status for this milestone                                                                                                                                                                                                                    |
| ------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Windows Full Local CI, source E2E, packaged E2E, installer verification, Gitleaks     | **Mandatory**                                                                                                                                                                                                                                |
| Real pinned DSH tests, Permission Broker, NRC, Project Memory, session integrity      | **Mandatory**                                                                                                                                                                                                                                |
| Cowork OS read/write isolation (A17, [NXR-SEC-01](NXR_SEC01_Security_Test_Report.md)) | **Mandatory, unresolved** (OD-SEC-02, OD-SEC-04). Windows AppContainer is the preferred direction; LPAC remains an evaluation candidate. **Neither has passed feasibility.** A trusted-content release policy is not an accepted substitute. |
| WSL2 Coding sandbox (bubblewrap, socat relays, Coding ACP)                            | **Mandatory**: an existing dependency of Windows Coding                                                                                                                                                                                      |
| Native Ubuntu Full CI, native Linux Desktop E2E/Xvfb, native Linux Gitleaks           | **DEFERRED BY OWNER DECISION** (OD-SEC-01), not PASS. Results are not claimed, and cross-platform acceptance is not claimed.                                                                                                                 |

Deferral is not certification: no Linux release is implied. **Reinstatement trigger:** native
Ubuntu gates become mandatory again before any Linux (or other non-Windows) desktop or CLI release,
or if Coding moves off WSL2.

**Gates on later phases (OD-SEC-05, OD-SEC-07):** production isolation integration needs four
things in order:

1. a passing feasibility test, run by the owner-authorized engineer in a disposable Windows 11
   Pro 25H2 VM (OD-SEC-03);
2. independent Opus review of that evidence;
3. documented architecture and residual risks;
4. explicit owner approval.

ADR-030 acceptance and the PR #41 merge each need explicit owner approval. Integration
preparation is not push authorization.

**Tracked items (OD-SEC-06):**

- The gateway child exit and the Providers second-turn timeout remain **unresolved, instrumented**
  reliability observations.
- The upstream DSH dependency advisories (MCP SDK OAuth, fflate) remain **tracked technical debt**
  for the reviewed managed configuration. The dependency tree is not claimed vulnerability-free.

**Current status:** `WINDOWS_NATIVE_ISOLATION_UNVERIFIED` · `COWORK_OS_ISOLATION_INCOMPLETE` ·
`NATIVE_UBUNTU_FULL_CI_DEFERRED` · `NXR_SEC01_BLOCKED_BY_EXTERNAL_FEASIBILITY_EVIDENCE` ·
`ADR030_PROPOSED` · `PR41_DRAFT_NOT_MERGED` · `NXR070_NOT_AUTHORIZED`.

Every requirement maps to at least one automated test. "Real DSH" = the pinned `dsh` runtime
installed by `scripts/install-dsh-runtime.mjs` (CI sets `NEXAR_DSH_ENTRY`), no credentials, model
traffic only to a deterministic fake Chat Completions endpoint owned by the test.

| Id  | Requirement                                                     | Test(s)                                                                                                                                                                                                                                 | Unit   |
| --- | --------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ |
| A1  | Real DSH runtime initializes (pinned version, overlay accepted) | `integrations/deepseek-harness/src/acp/local.real.test.ts` (initialize → session/new → close; version gate)                                                                                                                             | 01     |
| A2  | DSH executes Cowork through Nexar                               | `apps/desktop/src/main/dsh-cowork.test.ts` (fake ACP), `local.real.test.ts` (prompt → scratch write), `apps/desktop/e2e/cowork.e2e.ts` (proposal → saved draft artifact)                                                                | 01, 03 |
| A3  | DSH executes a sandboxed coding workflow                        | `packages/host/src/lane-engine.dsh.integration.test.ts`, engineering suites (Linux CI) + coding overlay test; actual WSL2 pinned DSH/bubblewrap prompt in the [FCR-01 fixture](../../development/evidence/fcr01-real-coding-fixture.md) | 04     |
| A4  | Model selection follows Nexar policy                            | `dsh-cowork.control.test.ts`: Auto, pinned, pinned-unavailable (`fallback: none` fails, `auto` restarts once)                                                                                                                           | 02     |
| A5  | Connection identities isolated                                  | two fake connections; only the selected one is called; DSH env holds no key                                                                                                                                                             | 02     |
| A6  | Required context survives mode transitions                      | `packages/operating/src/context.test.ts` + `service.test.ts` (Cowork → Code → Cowork)                                                                                                                                                   | 05     |
| A7  | Compaction/overflow cannot drop mandatory constraints           | `dsh-cowork.context.real.test.ts`: owner channel → memory → actual ACP model system request; project isolation, real automatic compaction and pre-spawn overflow refusal                                                                | 05, 08 |
| A8  | Nexar remains the permission authority                          | `cowork-policy.test.ts` (escalation outside scratch denied, `danger-full-access` denied, `*_always` never chosen), `permissions` regression                                                                                             | 01, 03 |
| A9  | No active OpenWorker dependency                                 | static test: no import of / reference to OpenWorker runtime in `apps`, `packages`, `integrations` (legacy schema literals allowlisted); `pnpm check:boundaries`                                                                         | 06     |
| A10 | Electron integration operational                                | `pnpm desktop:e2e` source run                                                                                                                                                                                                           | 03, 07 |
| A11 | Windows source + packaged E2E                                   | CI `windows-latest` desktop E2E; packaged E2E (`package:win` + launch)                                                                                                                                                                  | 07     |
| A12 | Linux engineering + sandbox tests                               | WSL2 (mandatory for Windows Coding): full offline suite incl. real bubblewrap, socat relays, sandboxed ACP and the real Coding fixture. Native Ubuntu `pnpm check`: **deferred** (OD-SEC-01)                                            | 04     |
| A13 | No duplicate execution accounting                               | `engine-gateway/gateway.test.ts`: once per provider attempt incl. retry/restart; `tests/integration/control-accounting.test.ts`: shared sink → JSONL → quota; ACP gateway cost unavailable                                              | 02, 08 |
| A14 | Existing data safe                                              | sessions fixtures with legacy `openworker` values load; settings with legacy keys load                                                                                                                                                  | 05, 06 |
| A15 | Security regressions green                                      | B1–B9 regression suites (`capabilities`, `bridge`, `delegation-limit`, `gateway`, `sessions`, `approvals`, `sandbox`) plus ACP isolation/model-route guards; Linux sandbox execution requires Ubuntu CI                                 | all    |
| A16 | Direct session fallback remains bounded model execution         | `apps/desktop/src/main/operating.test.ts`: real NRC exclusions, forbidden preferences, model-label spoofing, no bounded candidates and single execution record                                                                          | 08     |
| A17 | Cowork OS isolation (Windows)                                   | [NXR-SEC-01 test matrix](NXR_SEC01_Security_Test_Report.md): OS-level denial of outside reads/writes, junction escape, network and process creation on real DSH; fail-closed launcher. **Not yet implemented or executed**              | SEC-01 |

## Invariant → test map

| Invariant                         | Existing suite kept                           | New test                                                                                                                                               |
| --------------------------------- | --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| B1 capability validation first    | `packages/contracts/src/capabilities.test.ts` | —                                                                                                                                                      |
| B2 monotonic unit limit           | `packages/engine-gateway/src/bridge.test.ts`  | DSH Cowork control restart keeps one limit                                                                                                             |
| B3 Nexar authority                | `acp/acp.test.ts` permission cases            | Cowork starts read-only; actual per-call broker, unknown mutation schema denial, physical scratch checks and actual reduced tool catalog               |
| B4 standalone excludes `reviewOf` | `packages/contracts/src/gateway.test.ts`      | —                                                                                                                                                      |
| B5 no cross-turn native grants    | —                                             | per-turn `DSH_HOME` removed; no `session/resume`; concurrent Coding overlays isolated and fresh homes after cancellation (`acp/acp.test.ts`)           |
| B6 stable resource ids            | resource-controller suites                    | —                                                                                                                                                      |
| B7 sandbox enforcement            | `acp/launch` + sandbox suites                 | coding overlay keeps launcher checks                                                                                                                   |
| B8 sessions readable              | `packages/sessions` suites                    | legacy-engine fixture                                                                                                                                  |
| B9 single writer                  | sessions lease suites                         | project-memory lease test; deterministic fresh-lease and stale-takeover races in `store-lease-race.test.ts`, unreadable lease and abandoned claim deny |
