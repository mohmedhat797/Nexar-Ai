# UDSH-08 — final stabilization and acceptance evidence

Date: 2026-10-10 (Africa/Cairo). ADR-030 remains **Proposed**. PR #41 remains Draft.
Readiness is **BLOCKED**: GitHub did not start Ubuntu, Windows or secret-scan jobs because
account payments failed or the spending limit was reached. The owner instructed this
continuation to finish and report that CI blocker. Local results do not substitute for
mandatory exact-final-head CI. This report distinguishes verified behavior from hypotheses.

## A. Baseline

- Initial checkout: `D:/Nexar-Ai-main`, branch `feat/nexar-resource-orchestration`,
  SHA `9e71014979db7a7619bb6ac909b8418a0d198573`, clean working tree.
- Reused registered implementation worktree:
  `D:/Nexar-Ai-main/.claude/worktrees/serene-williams-59b5fe`, branch
  `feat/nexar-unified-dsh-runtime`, clean at
  `a07f4865e7b268f5d7a577b83be8a99a08289ef4`. Remote fetch and PR lookup confirmed the same head.
- Baseline [CI run 38010020730](https://github.com/mohmedhat797/Nexar-Ai/actions/runs/38010020730):
  Ubuntu PASS; secret scan PASS; Windows FAIL only in packaged Desktop E2E.
  Windows source E2E, unit tests and packaging passed.
- Prior units retained: `d876f09` (01), `886f2e4` (02/03), `552c5b0` (04),
  `42bfa3d` (05), `48b49d3` (06), `ba2a7b4` (07), `a07f486` (development log).
- No reset, force push, modification of main, deletion of unrelated worktrees, live inference,
  owner credential changes, deployment, release publication or merge is part of this continuation.

## B. Windows packaged E2E investigation

Baseline Windows job `114087672079` passed 21/22 packaged E2E tests. Providers failed at
`providers.e2e.ts:536`, the **second launch**, in `firstWindow()` after 30 seconds. The retained
log contains no process-exit or startup-phase evidence, so it cannot distinguish a crashed
process from a delayed window. DSH Cowork tests had already passed in that same package.

The Providers fixture was missing the process-exit barrier and startup tracing present in the
shared E2E harness. It now registers a close listener before requesting quit and awaits the
actual child exit before reusing state. A failed shutdown remains a failure. It emits only
allowlisted startup phases/timings and numeric process status; arbitrary logs, paths and clipboard
content are never printed by the new diagnostics. Its first-window budget remains 30 seconds.

Four subprocess/security regressions verify the exit barrier, fail-closed shutdown timeout,
failed-close reclamation, and bounded secret-safe diagnostic extraction. The baseline isolated packaged Providers run
passed (1 test, 18.11 s). The corrected isolated run passed (1 test, 10.46 s); startup traces
reported windows at 2,791 ms and 2,991 ms. This establishes local behavior, not the cause of
the historical CI timeout. Full-suite and blocked final-head CI evidence is recorded below.

The fresh final-source Windows package also passed Providers independently (1/1, 16.83 s),
with window startup phases at 2,679 ms and 2,615 ms. This run uses its packaged executable;
it does not reuse the baseline binary. Mandatory packaged Windows CI remains blocked.
The full fresh-package suite passed 8 files / 22 tests in 192.38 s, including Providers
after the earlier scenarios and Cowork using the bundled runtime. Providers window phases
were 4,535 ms and 2,439 ms in that suite; its timeout remains unchanged.

## C. Required context through the actual DSH boundary

`apps/desktop/src/main/dsh-cowork.context.real.test.ts` uses a real project/session fixture,
the owner project-memory channel, OperatingService context assembly, DshCoworkService, pinned
DSH ACP, the real loopback gateway translator, and a deterministic fake model port. No paid
provider participates. The model boundary receives the system request, rather than a mocked
overlay renderer result.

Assertions cover stored source/project identity; the exact required block and hash; actual overlay
contents while the model request is in flight; the model-facing system message; isolation of an
unrelated project; model output remaining untrusted conversation rather than owner memory; and
overflow refusal before ACP execution/model calls. Three real-runtime tests passed in 13.45 seconds.
The compaction fixture uses unmodified upstream defaults and large balanced tool steps to trigger
actual automatic compaction. A deliberately contradictory fake summary appears in the real
post-compaction request, while the protected system block/hash and canonical owner memory remain
unchanged. No fake summarizer output gains owner authority.

## D. Windows native worker failure

See [bounded investigation](UDSH08_Worker_Crash_Investigation.md). Local Node is 24.15.0;
repository/CI Node is 22 (baseline CI 22.23.3); Vitest is 5.0.3, with four Windows fork workers.
The historical `0xC0000409` report lacks a PID, executable, fail-fast reason, dump or native stack.
Its historical PID and native cause remain unestablished. Contention is a hypothesis.

A definite test teardown defect was fixed: gateway subprocesses are now awaited through `close`
before endpoint/temp cleanup, and expected status/signal are asserted. Native crashes remain
test failures. Baseline and corrected targeted suites passed 21/21. The controlled 1/2/4-worker
matrix passed 65 tests with five existing platform skips per run; three targeted repeats passed
21/21 each. No observed child remained alive. Final full-suite/CI results are required below.
No CI settings or security assertions were weakened. Two final local full-suite runs on Node 24
reproduced native fork-worker fail-fast exits, first in ChatGPT-plan/provider-key-check suites,
then in the gateway suite. Both gates failed and build was not reached. The correction fixes a
demonstrated teardown weakness but does not resolve the native failure. The detailed investigation
retains counts, archive ids, version verification and the configured Node 22 comparison.
The independently verified Node 22.23.3 full gate passed 4,229 tests (160 existing skips)
and the production build. A bounded third Node 24 run traced all 224 fork workers and
also passed (107.21 s; archive `84be82abe908d982`), without a fail-fast exit to capture.
These clean runs do not resolve the preceding native crashes or prove contention.

## E. Architecture and security review

The independent review traces production code, rather than treating architecture text as proof.
The review discovered an unrestricted Desktop direct route capable of selecting native agents or
the standalone DSH SDK resource. That was classification **B** before correction. Desktop direct
session execution now admits only reviewed bounded model adapters (`pi`, `echo`) through NRC
hard exclusions and explicitly rejects a forbidden owner preference. Coding/native work-resource
execution keeps its own lane. The corrected direct path is classification **A**: no tool round-trip
or agent loop, and at most the existing bounded model request.

Coding review additionally found persistent/shared ACP DSH_HOME/overlay state and missing
model-route notification enforcement. Each run now owns a random private home, enforces the
selected model in gateway and native-key modes, and cleans up after process termination. Preparation
cancellation and a bounded cleanup grace prevent an uncooperative launcher from defeating deadlines;
late cleanup waits for settlement. Cleanup failure cannot produce a successful result or mask an
earlier execution error. A never-settling launcher may retain an empty private directory, never reused.

The review also found missing durable control-call accounting. The gateway now writes one resource
attributed record per actual provider attempt into Nexar's shared telemetry sink, including retries
and cancellation. Failed calls have unknown usage. Gateway-backed Coding ACP does not repeat the
model cost under the runtime resource. Pi token/cache counts remain measured and catalog costs are
estimates; plan cash cost is unavailable. Sink failures are non-fatal like existing telemetry and
never trigger a second paid request. A JSONL-to-quota regression verifies exact token attribution.

The first fresh-source Desktop run passed 20/22 tests but its two SOW assertions assumed all
control-plane records were delegated units. The corrected assertions still require the exact
four delegated kinds and now independently require one control record per actual fake-model
request, with selected-resource, successful-outcome and routing checks. The repeated full
source suite passed all 22 tests in 196.88 s. No security assertion or test was removed.

Cowork uses per-turn scratch/home, Nexar permissions and NRC gateway control. Legacy sessions stay readable;
canonical memory/session ownership stays with Nexar. Host-local Cowork's lack of OS read isolation
remains an explicitly documented residual boundary, not a newly established sandbox guarantee.

## F. Validation commands and results

All inference fixtures are offline. Commands run from the implementation worktree unless noted.
The native validation process prepends the official cached Node 22.23.3 binary directory to its
own PATH and invokes the user-recommended `lean-ctx.cmd` wrapper. No global Node, CI configuration,
manifest, lockfile or tool security setting is changed. The source E2E sets `NEXAR_DSH_ENTRY`;
packaged E2E sets `NEXAR_DESKTOP_EXECUTABLE=release/desktop/win-unpacked/Nexar.exe` and the runner
removes external runtime-entry variables, requiring the bundled DSH runtime.
The final repeated `pnpm check` also passed after the Desktop accounting assertion correction:
208 files / 4,229 tests, 16 files / 160 existing skips, 170.16 s for tests, and production build.
Coordinator PID 23460 and worker PIDs 26352, 15276, 25576 and 25676 were independently verified
against the official Node 22.23.3 binary. No Nexar/Electron test process remained after E2E.

| Command / gate                                                                                                  | Result                                                                                                       |
| --------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `pnpm exec vitest run tests/desktop-startup-diagnostics.test.ts`                                                | PASS: 4 tests; also included in the full gate                                                                |
| `pnpm exec vitest run --config apps/desktop/e2e/vitest.e2e.config.ts providers.e2e.ts` with packaged executable | PASS: baseline 1/1; preliminary corrected 1/1; fresh final package 1/1, 16.83 s                              |
| Focused ESLint/Prettier for startup diagnostics and Providers                                                   | PASS                                                                                                         |
| Required-context real ACP fixture                                                                               | PASS: 3 tests, actual model request and automatic compaction                                                 |
| `pnpm check` with installed pinned DSH                                                                          | PASS on verified Node 22.23.3: 208 files / 4,229 tests; 16 files / 160 existing skips; production build PASS |
| Source Desktop E2E                                                                                              | PASS: 8 files / 22 tests, 196.88 s after the accounting assertion correction                                 |
| `pnpm desktop:package:win` (rebuild and fresh runtime install)                                                  | PASS: fresh executable, NSIS installer and SHA256 file; bundled DSH `0.2.0-rc.2`                             |
| Full packaged Desktop E2E                                                                                       | PASS: fresh package, 8 files / 22 tests, 192.38 s; bundled runtime only                                      |
| Local Gitleaks 8.28.0 `git --redact --exit-code 1 .`                                                            | PASS: 251 commits, no leaks found (before remaining documentation/test commits)                              |
| Exact-final-head Ubuntu / Windows / secret scan                                                                 | BLOCKED: jobs not started; GitHub account billing/spending-limit annotation                                  |
| Paid/live-provider inference                                                                                    | Not run by design; offline tests do not prove live compatibility                                             |
| Native Linux bwrap execution on this Windows host                                                               | Not applicable locally; required in Ubuntu CI                                                                |

Fresh installer: `release/desktop/Nexar-0.1.0-windows-x64-setup.exe`, 322,008,390 bytes.
Independently verified SHA256 (matching the generated checksum file):
`c519be936613bb207671a3d6ae199abfe796320a994bb23c6722368d1bde9801`.
Windows `Get-AuthenticodeSignature` reports `NotSigned`; a signed installer is not claimed.

## G. Git and PR

Existing branch: `feat/nexar-unified-dsh-runtime`.
Existing [Draft PR #41](https://github.com/mohmedhat797/Nexar-Ai/pull/41).
Focused stabilization commits:

- `2f4ecb1ddab4e4d24bf4e8d0912165f17a266f64`: Providers process-exit barrier and safe startup diagnostics.
- `6fc157126598938d9fc4e80b11d0d87f4061f919`: actual DSH model-facing owner context and compaction regressions.
- `6cd030c616eca9f39c3615453772cf301726494a`: bounded direct fallback, isolated Coding ACP state and model-route enforcement.
- `eaf52cec7cda11be8132b849adb1501bbc0cd66f`: durable resource usage once per control attempt.
- `92aa49c5b782e10a77d6c9435bf5e4fbc977ed89`: checked gateway subprocess shutdown and bounded native-crash evidence.
- `4d2d8904d9d61387e71af9b3992e9688f01710bc`: independent Desktop assertions for control calls and delegated usage.

The complete code/test head is `4d2d8904d9d61387e71af9b3992e9688f01710bc`. The subsequent
report/architecture commit changes documentation only. Source and fresh-package E2E and the
final repeated repository gate validate this complete code/test snapshot.

Each was pushed without force, its remote SHA and file list verified, and its corresponding local diff reviewed.
PR diff output exceeds GitHub's 20,000-line limit, so the paginated PR-files API and per-commit
remote file lists were used alongside local diff review. The final immutable head, final CI run
and final local secret-scan result are recorded in the updated PR body and completion response;
the report/documentation commit necessarily follows the code/test commits it describes.
Previous successful CI is baseline evidence only.

For example, [run 38017156938](https://github.com/mohmedhat797/Nexar-Ai/actions/runs/38017156938)
for `eaf52cec7cda11be8132b849adb1501bbc0cd66f` concluded failure in about two seconds.
All three jobs had zero steps and the same check annotation: recent account payments failed
or the spending limit needs to be increased. No runner executed tests or secret scanning.
This is an external Actions availability blocker, not evidence of a failing test or a passed gate.

## H. Outstanding risks and decisions

- Reproduced native fail-fast cause remains unproved; retained crash risk must accompany the
  supported Windows full-suite result and the bounded matrix.
- The historical packaged Providers timeout has not reproduced in isolation; process diagnostics
  and exit barriers are corrective evidence, with final-head Windows CI still mandatory.
- Live-provider compatibility is outside this offline acceptance run.
- Cowork's host-local read boundary and pinned developer-preview runtime remain existing risks.
- Only the owner can accept ADR-030 or authorize merging. Routine fixes do not change that boundary.

## I. Recommendation

`NEXAR_UNIFIED_DSH_IMPLEMENTATION_BLOCKED`

Keep PR #41 Draft and ADR-030 Proposed. Restore GitHub Actions availability, then rerun
Ubuntu, Windows (including fresh packaging/Providers/full packaged E2E) and secret scanning
on the exact final PR head. Preserve the native-crash residual risk during owner review.
Local success and historical CI success cannot establish those mandatory gates.
