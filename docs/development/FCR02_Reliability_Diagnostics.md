# FCR-02 — Reliability diagnostics

**Date:** 2026-10-13 (Africa/Cairo). **Reviewer:** Claude Opus 5.5. **Implementer:** Claude Sonnet 5.5
(two packages, both reviewed against the actual diff and re-executed by the reviewer).
**Branch:** `fcr02/opus-integration` (local; not pushed).
**Scope:** the two intermittent Windows failures retained in
[FCR02_Opus_Final_Review.md](../architecture/unified-dsh-runtime/FCR02_Opus_Final_Review.md) §7.
Cowork OS isolation and native Ubuntu CI are out of scope and remain open.

## Summary

| Failure                                  | Root cause established | Change                                                       | Reproduced since                         | Verdict                            |
| ---------------------------------------- | ---------------------- | ------------------------------------------------------------ | ---------------------------------------- | ---------------------------------- |
| Gateway child exit 1 before ready        | No                     | Structured exit diagnostics, in the child and its supervisor | 0 of 40 targeted runs + full suites      | `GATEWAY_FAILURE_UNRESOLVED`       |
| Providers E2E second turn not seen, 60 s | No                     | Test-only failure bundle, turn latency, IPC and egress logs  | 0 of 20 Providers runs + 3 full E2E runs | `PROVIDERS_E2E_FAILURE_UNRESOLVED` |

Neither failure is claimed fixed. Each now leaves enough evidence to classify the next occurrence.

## 1. Gateway child exited with code 1 before ready

**Original symptom.** This happened once, during a full `pnpm check` on 2026-10-12. The failing test
was `apps/desktop/src/control-gateway/server.test.ts > control gateway translator > exits when
stdin closes`, with `gateway child exited before ready (pid=45832, code=0x1)`. One test failed and
4,284 passed. The focused rerun passed 21/21, as did both later Full CI unit stages.

**Why there was no diagnostic.** `control-gateway/main.ts` exits 1 from three places: a stdin error,
a server error, or a Node uncaught exception. Both the production supervisor
(`control-gateway-child.ts`) and the test harness spawned the child with stderr set to `ignore`.
The supervisor logged only `{ crashes }`.

**Diagnostic changes** (commit `9c04e2f`, a production change):

- **Child.** Before every non-zero exit it writes exactly one stderr line,
  `{"nexarGatewayExit":{"phase":"config|stdin|listen|uncaught","code":"<short code>"}}`, using a
  synchronous write. It never writes a message, stack, path or endpoint. A new
  `uncaughtException` handler, which also covers unhandled rejections, exits 1 with phase
  `uncaught`. The exit codes (0, 2, 1), the `{port}` ready line and the loopback bind are unchanged.
- **Supervisor.**
  - stderr is piped and always drained into a 4 KB tail.
  - Only a strictly validated diagnostic line is parsed, and raw stderr is never logged.
  - `control-gateway.exited` and `control-gateway.start-failed` carry fixed fields: `cause`
    (`timeout`, `exited-before-ready` or `invalid-ready-line`), `exitCode`, `signal`, `ready`,
    `elapsedMs`, `phase` and `code`.
  - The thrown error is still `INTEGRATION_UNAVAILABLE`. Restart, crash counting, stop and kill
    behaviour are unchanged.
- **Test harness.** Its early-exit errors now include `diagnostic=<phase>/<code>` or `none`.
- **New shared module** `control-gateway/exit-diagnostic.ts`: the formatter and the strict parser.

**Regression tests** (+23):

- **Formatter and parser:** they reject extra keys, unknown phases, path-like codes and noise.
- **Real built child, one test per phase:**
  - `config`: all three bad-config shapes exit 2.
  - `listen`: a `--require` preload emits `EADDRINUSE`.
  - `stdin`: the preload makes stdin emit `EIO`.
  - `uncaught`: covers both a throw and a rejection.
- **Supervisor with a fake child:**
  - a phase/code line before ready produces the expected log;
  - fake paths and tokens never reach a log;
  - more than 1.5 MiB of stderr is drained without unbounded retention;
  - `timeout` and `invalid-ready-line` causes are logged;
  - restart behaviour and post-ready crashes are unchanged;
  - `stop()` logs nothing.
- **Mutation-checked:** an unbounded tail, a missing wait for stdio close, and a missing
  uncaught handler each make a test fail.

**Reproduction attempts** (Windows 11 10.0.26300, Node 22.23.3, long-name `TEMP`):

| Condition                                                         | Runs | Failures |
| ----------------------------------------------------------------- | ---: | -------: |
| `server.test.ts` sequential (implementer)                         |   30 |        0 |
| `server.test.ts` concurrent with a full `pnpm test` (implementer) |   10 |        0 |
| `server.test.ts` sequential (reviewer re-execution)               |   10 |        0 |
| Focused files: 3 files, 51 tests (reviewer)                       |    1 |        0 |
| Full `pnpm check` (implementer), with a concurrent full unit run  |    2 |        0 |

**Remaining uncertainty.**

- A failure while the bundle's imports are loading happens before the uncaught handler is
  registered. It would exit 1 without a diagnostic line, as would a hard kill, out-of-memory or
  native crash. A missing `phase` therefore narrows the cause to those.
- In production an early exit still fails closed (`unavailable()`, one bounded restart).

**Classification:** unresolved intermittent failure. No product defect is demonstrated.

## 2. Providers E2E: the second turn's result was not observed

**Original symptom.** This happened once, in the first Full CI source E2E on 2026-10-12, stage
00:07:48–00:12:33Z. In `apps/desktop/e2e/providers.e2e.ts`, after the relaunch and the key removal,
the poll for `result-text` count 2 still saw 1 after its full 60 s, and the test took 76 s. That
run overlapped the WSL2 validation, and every stage ran 1.2–1.9× slower. Later runs passed.

**Lifecycle traced** (reviewer, source inspection):

1. The renderer Send triggers `sessions:submitTurn` over IPC.
2. `OperatingService` chooses the lane. `local-echo` is not `model-turn` (`core/config.ts`), so
   Cowork reports control unavailable and the turn runs **direct**.
3. The NRC selects `local-echo` and the echo adapter executes.
4. The turn is persisted and a turn-changed event goes to the renderer, which renders `result-text`.

A saved DeepSeek key cannot make Cowork ready here, because `model-turn` requires a fresh,
authenticated provider inventory. The direct lane is therefore the expected path for both turns.
Before this package, nothing recorded which step stalled.

**Diagnostic changes** (commit `e2a82ae`, test code only):

- Per-turn latency lines on stderr: `turn` on success, `turn-failed` otherwise.
- A test-launcher IPC timing log, `ipc-timing.jsonl`: channel, timing, ok and error code only. The
  asserted `ipc-trace.jsonl` frame shape is unchanged.
- A main-process `fetch` host log, `egress.jsonl`: host only. It is an observation and blocks
  nothing.
- An `onTestFailed` bundle, written before `afterAll` deletes the fixture, under the git-ignored
  `apps/desktop/.nexar/e2e-diagnostics/providers-<ISO>/`. It holds:
  - `turns.json`: the main-process view through the IPC handlers, plus the stored session files,
    allowlisted to ids, states, timestamps, lanes, task resource/policy/path and error code, with no
    text;
  - `ui.json`: renderer counts, error elements and Send state;
  - the timing and egress logs;
  - a secret-redacted output tail;
  - a screenshot and a Playwright trace.
- `NEXAR_E2E_TRACE=0` disables tracing.

This distinguishes the cases: a turn that is terminal in main while the UI shows 1 points to a
renderer or IPC-event problem; a non-terminal turn points to a backend stall; an error code points
to a provider or routing failure.

**Reproduction attempts and measurements** (implementer, re-checked by one reviewer run):

| Condition                                      | Runs | Failures | Turn 1 observed ms (min/median/max) | Turn 2 observed ms | Main-side turn 2 ms |
| ---------------------------------------------- | ---: | -------: | ----------------------------------- | ------------------ | ------------------- |
| Isolated, tracing on                           |   10 |        0 | 263 / 494 / 506                     | 265 / 272.5 / 492  | 164 / 181.5 / 228   |
| Concurrent with a full `pnpm test`, tracing on |    5 |        0 | 533 / 595 / 867                     | 499 / 543 / 808    | 238 / 309 / 435     |
| Isolated, tracing off                          |    5 |        0 | 248 / 250 / 263                     | 248 / 252 / 257    | 121 / 146 / 167     |
| Reviewer re-execution, tracing on              |    1 |        0 | 497                                 | 265                | —                   |
| Full source E2E suite (22 tests)               |    2 |        0 | —                                   | —                  | —                   |

- Observed latency has 200 ms resolution, set by the unchanged poll interval.
- The longest second turn measured, about 0.8 s under load, is roughly 75 times shorter than the
  60 s poll, so the poll timeout is **not** the binding constraint and was not changed.
- **Egress:** zero main-process `fetch` calls in any run, so no non-loopback host was contacted.
  Coverage is main-process `fetch` only.

**Classification:** unresolved intermittent failure. Neither a timing problem in the test nor a
defect is demonstrated. The slowdown in the original run cannot by itself account for a 60 s stall
on a sub-second step.

**Diagnostic caveats.**

- Tracing roughly doubles the observed per-turn latency, though it stays sub-second.
- Bundles may include DOM snapshots with synthetic fixture text and the local fixture path, which
  contains the Windows user name. They are local-only and git-ignored, and are never committed.
- The trace from a launch that was closed earlier is discarded.

## 3. Final Windows verification

Windows Full Local CI ran on the clean tested implementation, after both packages were committed:

- **Command:** `node scripts/local-ci/runner.mjs --mode=full --workers=2 --gitleaks-bin=<gitleaks 8.28.0>`.
  It ran with Node 22.23.3 and pnpm 10.33.0 on win32 10.0.26300, with a long-name `TEMP` and live
  tests unset.
- **Result:** `NEXAR_WINDOWS_FULL_PASS`, report `report-2026-10-12T22-01-40-449Z.json`, 1,513.95 s.
- **Source:** start and end commit `e2a82aeba3236b9e099100535c4ba1f9f87b3dda`, clean,
  `sourceStable: true`.
- **Stages:** 15 required stages PASS (dependencies, DSH install, format, lint, boundaries,
  typecheck, unit/integration, build, both CLI smokes, real DSH context, source E2E, Windows
  package, packaged E2E, Gitleaks). `linux-sandbox` is BLOCKED; it is not required on Windows and is
  not counted as a success.
- **Unit and integration:** 4,474 = **4,308 passed + 162 skipped + 4 pending**, 0 failed, 214 of
  230 files. The four pending are the nested bubblewrap cases that cannot run on Windows.
- **Other suites:** real DSH context 3/3; source E2E **22/22**; packaged E2E **22/22**. The
  Providers test logged turn latencies of 484/501 ms (source) and 875/277 ms (packaged). Source
  egress was zero requests; in packaged mode egress is not observable because there is no fixture
  launcher.
- **Installer:** `Nexar-0.1.0-windows-x64-setup.exe`, 322,014,142 bytes.
  - SHA-256 **`27cd71fe7378db3566e50841ac10b464eb90ccc435126befdcd779e181bcaaa7`**, recomputed by
    the reviewer.
  - Its timestamp, 22:21:12Z, lies inside this run's packaging stage (22:10:45Z–22:21:39Z).
  - The packaged `control-gateway.cjs` is byte-identical to the built one and contains the new
    diagnostics.
  - Bundled DSH 0.2.0-rc.2. NotSigned (development artifact).
- **Superseded evidence.** The earlier installer
  (`70be82a4a0f518b813e22ea5780c6fa926548f10241265cc309b78dea3e11016`, from `6bbe26e`) predates the
  production change in `9c04e2f` and is not used as evidence for this implementation.
- **Not covered.** Native Ubuntu Full CI, Linux Electron/Xvfb and Linux Gitleaks remain
  unexecuted. This document does not address them.

## 4. Reliability recommendation

- **Gateway:** `GATEWAY_FAILURE_UNRESOLVED`. No reproduction in 40+ targeted runs. Structured,
  privacy-safe exit diagnostics now reach both the logs and the test failure message.
- **Providers E2E:** `PROVIDERS_E2E_FAILURE_UNRESOLVED`. No reproduction in 20 targeted and 3 full
  E2E runs. A failure now leaves a bundle that tells a backend stall, a routing or provider error
  and a renderer-update problem apart. The 60 s poll is about 75 times the measured worst case, and
  it was not changed.
- **Windows:** `WINDOWS_RELIABILITY_ACCEPTANCE_INCOMPLETE`. Full CI passes on the exact
  implementation, but two observed intermittents remain unexplained, so reliability is not declared
  verified.
- **Integration:** `FCR02_RELIABILITY_CHANGES_READY_FOR_INTEGRATION`. Both packages were reviewed
  against their diffs, re-executed by the reviewer, and passed Full CI with a fresh installer.
- **Next step if either failure recurs:** classify it from its bundle or log line before changing
  any timeout or code. Do not add retries.
