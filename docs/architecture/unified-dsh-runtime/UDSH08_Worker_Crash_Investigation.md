# UDSH-08C — Windows native worker crash investigation

Date: 2026-10-10 (Africa/Cairo). Investigated baseline:
`a07f4865e7b268f5d7a577b83be8a99a08289ef4`, branch
`feat/nexar-unified-dsh-runtime`.

## Finding and acceptance impact

The `0xC0000409` failure is **reproduced on Node 24; native cause unresolved**.
Two full-suite runs failed, while isolated and controlled runs, the traced third
Node 24 run, and the verified Node 22 full gate passed. A missing subprocess-close barrier in the gateway test fixture
was corrected. This establishes more reliable cleanup and future exit evidence;
it does not establish that fixture teardown caused the native crash. Resource
contention and the local Node major version remain hypotheses, not root causes.

The original report does not supply a PID, executable, fail-fast subcode, native
stack, dump, or a retained worker exit trace. Therefore the exact historical
crashing process cannot be identified honestly from the available evidence.
Association with a test file alone does not distinguish its Vitest worker, its
gateway child, the esbuild service, or the Vitest coordinator.

## Process and configuration inventory

| Item                                        | Observed value                                                                  |
| ------------------------------------------- | ------------------------------------------------------------------------------- |
| Local executable                            | `C:\Program Files\nodejs\node.exe`                                              |
| Local Node                                  | `v24.15.0`, win32-x64                                                           |
| Repository Node selection                   | `.nvmrc`: `22`; manifest engines: `>=22.19`                                     |
| Prior exact-head Windows and Ubuntu CI Node | `v22.23.3`                                                                      |
| Installed Vitest                            | `5.0.3`                                                                         |
| Worker mechanism                            | Default `forks`: separate Node child processes                                  |
| Windows worker budget                       | `maxWorkers: 4` in `vitest.config.ts`                                           |
| File isolation / parallelism                | Isolation on; files parallel by default                                         |
| Within gateway file                         | Sequential tests; no `.concurrent` declarations                                 |
| Deliberate request concurrency              | One test sends four concurrent HTTP requests and asserts rejection of the fifth |
| Windows test / hook budgets                 | 15 s / 30 s, with explicit 60 s build and 30 s startup hooks                    |

The file builds the gateway with esbuild and launches it using `process.execPath`.
These are Node children, not Electron applications or DSH runtimes. The gateway
entry imports the shared HTTP translator; its runtime I/O uses Node HTTP, TCP /
named pipes and crypto. No third-party native addon was found in this translator
or engine-gateway source path. Native code still exists in Node itself, esbuild's
separate service, and test tooling: installed dependencies include a Rolldown
Windows native binding. Presence does not prove involvement in a crash.

A process inventory also showed unrelated Codex/lean-ctx service processes.
They were not stopped. An Application-log query for event 1000 / `node.exe` over
the previous ten days returned no entries. That limited query neither proves no
crashes occurred nor substitutes for a dump. No sensitive environment values,
prompts, bridge tokens or provider credentials were captured.

## Exit code interpretation

Unsigned decimal `3221226505` (signed `-1073740791`) is `0xC0000409`.
Microsoft documents it as a non-continuable user-mode fail-fast exception.
Although its legacy status name is `STATUS_STACK_BUFFER_OVERRUN`, the code alone
does not establish an actual stack buffer overwrite, out-of-memory condition, or
resource contention. The exception parameter / fail-fast reason and native stack
are needed to identify the cause.

References: [Microsoft fail-fast documentation](https://learn.microsoft.com/en-us/cpp/intrinsics/fastfail?view=msvc-170),
[Microsoft exception explanation](https://learn.microsoft.com/en-us/shows/inside/c0000409),
[Vitest worker pools](https://main.vitest.dev/config/pool),
[Vitest parallelism](https://main.vitest.dev/guide/parallelism).

## Bounded reproduction matrix

Every run uses deterministic offline providers. No tests were disabled, no worker
errors were ignored, and no CI worker or timeout settings were changed.

| Configuration                                             | Evidence                                                                                                 | Result                                                                                               |
| --------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| Historical baseline, Windows CI, Node 22.23.3 / 4 workers | Run `38010020730`, job `114087672079`; offline test step                                                 | PASS: 204 files, 16 skipped; gateway 21 tests, 2.800 s                                               |
| Historical baseline, Ubuntu CI, Node 22.23.3              | Same run, job `114087672653`; offline test step                                                          | PASS: 212 files, 8 skipped; gateway 21 tests, 0.736 s                                                |
| Local baseline, gateway alone, Node 24.15.0 / 1 worker    | `pnpm exec vitest run apps/desktop/src/control-gateway/server.test.ts --maxWorkers=1 --reporter=verbose` | PASS: 21 tests, 2.13 s                                                                               |
| Local corrected fixture, gateway alone / 1 worker         | Same target, `--maxWorkers=1`                                                                            | PASS: 21 tests, 5.52 s; incidental simultaneous Desktop E2E load                                     |
| Controlled Node 24, 1 worker                              | Four-suite command below, `--maxWorkers=1`                                                               | PASS: 4 files, 65 tests, 5 existing platform skips; 3.48 s                                           |
| Controlled Node 24, 2 workers                             | Four-suite command below, `--maxWorkers=2`                                                               | PASS: 4 files, 65 tests, 5 existing platform skips; 1.89 s                                           |
| Controlled Node 24, 4 workers                             | Four-suite command below, `--maxWorkers=4`                                                               | PASS: 4 files, 65 tests, 5 existing platform skips; 2.02 s                                           |
| Three sequential isolated Node 24 repetitions             | Same gateway target, `--maxWorkers=1`, fresh process per run                                             | PASS: 21 tests each; 1.94 / 2.08 / 2.24 s                                                            |
| Verified local Node 22.23.3 / 4 workers                   | Explicit cached official binary; coordinator and four workers independently verified                     | PASS: full `pnpm check`; 208 files / 4,229 tests, 16 files / 160 tests skipped; 132.24 s; build PASS |
| Node 24 full suite, first / second run                    | Lossless archives `ca622e2a4a72daec` / `b3f70bb35ce06252`                                                | FAIL: two / one native fork-worker exits; details below                                              |
| Node 24 full suite, third run with fork lifecycle trace   | Archive `84be82abe908d982`, coordinator PID 23664                                                        | PASS: 208 files / 4,229 tests, 16 files / 160 tests skipped; 107.21 s                                |
| Final-head Windows / Ubuntu / secret-scan CI              | GitHub check annotations; see final stabilization report                                                 | BLOCKED: jobs not started because account payments failed or spending limit was reached              |

The incidental shared-host run is not a controlled contention experiment. The
historical CI evidence establishes successful execution on two other runner
environments; it is not final-head validation of the fixture changes.

An attempted temporary Node 22 comparison (`pnpm dlx node@22.23.3 --version`)
failed before testing: that package's preinstall could not resolve
`node-bin-setup`. A second supported package, `node-win-x64@22.23.3`, downloaded
its payload but `pnpm dlx` failed with `ERR_PNPM_NO_IMPORTER_MANIFEST_FOUND`.
Executing the cached `node.exe` was blocked by the shell tool's allowlist;
an official direct download was also blocked (`Invoke-WebRequest`). The
repository manifest and lockfile and tool security settings were not changed.
These attempts initially prevented the comparison. Native-tool execution later
verified the downloaded official binary and completed the comparison below.

The controlled four-suite command, run separately for `$taskWorkers` 1, 2 and 4:

```powershell
pnpm exec vitest run apps/desktop/src/control-gateway/server.test.ts packages/engine-gateway/src/endpoint.test.ts integrations/openai-compat/src/server.test.ts apps/desktop/src/main/control-gateway-child.test.ts --maxWorkers=$taskWorkers
```

Runs were scheduled without other broad test suites. The background download of
the temporary Node package during part of this matrix is incidental package
installation, not a synthetic contention test. No native crash reproduced at
any worker budget. A post-matrix process inventory found no gateway child or
Vitest worker remaining; temporary-directory inventory remained unchanged.

## Narrow correction and observed cleanup

### Reproduction during final validation

The first complete `pnpm check` after lint/type corrections **failed** at its offline test step
on Node 24.15.0 / four workers: 206 files and 4,200 tests passed, 16 files / 160 tests skipped,
and two fork workers exited with unsigned status 3221226505 (`0xC0000409`). Vitest identified
their active files as `apps/desktop/src/main/chatgpt-plan.test.ts` and
`integrations/pi/src/key-check.test.ts`. The gateway suite passed. Build was not reached.
The lossless lean-ctx archive is `ca622e2a4a72daec`; this is a failed gate, not a successful rerun.

The crashing category is now established for this reproduction: Node-hosted Vitest fork workers,
not an observed gateway child or Electron application. Their PID and native subcode/stack were
not included by Vitest. A bounded Application-log query for event 1000/1001 over the reproduction
window yielded no matching entries. The absence of a native dump still prevents root-cause attribution.
No simultaneous broad suite was running; resource contention remains unproved.

`pnpm exec vitest run integrations/pi/src/key-check.test.ts --maxWorkers=1 --reporter=verbose`
then passed 59 tests on Node 24 in 733 ms. Using the already downloaded official
`node-win-x64@22.23.3` executable, the three-suite command
`node.exe node_modules/vitest/vitest.mjs run integrations/pi/src/key-check.test.ts apps/desktop/src/main/chatgpt-plan.test.ts apps/desktop/src/control-gateway/server.test.ts --maxWorkers=4`
passed 114 tests in 23.57 s. The full configured-version gate subsequently passed. This comparison
does not prove a Node-version bug and does not clear the failed Node 24 gate.

The earlier local Node 22 limitation was a shell-tool command restriction. The parent verified the
cached executable with the native execution tool (v22.23.3) without changing the manifest, lockfile
or security settings. The attempted `pnpm --use-node-version=22.23.3 check` still launched Node
24 workers: process inspection verified `C:/Program Files/nodejs/node.exe`, and a follow-up
`process.version` query returned v24.15.0. It is therefore a second Node 24 run, not Node 22 evidence.
That repeat failed after 207 files / 4,216 tests passed, with 16 files / 160 tests skipped and one
worker fail-fast in `control-gateway/server.test.ts` (145.41 s; archive `b3f70bb35ce06252`).
No broad concurrent validation workload was running. The native failure is reproduced, rather than
merely historical, and the gateway teardown correction does not resolve it.

The full configured-version command uses the explicit official Node 22 binary directory in the
environment of one native PowerShell validation process, with `NEXAR_DSH_ENTRY` set and live tests
disabled; it invokes the user-recommended `lean-ctx.cmd -c 'pnpm check'` wrapper. This changes no
repository configuration, global Node installation, CI setting or tool security setting. Worker
executable identity was verified independently: coordinator PID 27484 and worker PIDs
14616, 46332, 17872 and 12856 all used the official cached Node 22 executable.
The full `pnpm check` passed format, lint, 955-file boundary guard, typecheck,
4,229 tests (160 existing skips), and production build. Its test duration was 132.24 s.

The bounded third Node 24 full-suite run added an ignored, temporary child-process
fork observer. It recorded only numeric PID/parent PID, executable basename/version,
entry basename, lifecycle phase, exit code and signal. Coordinator PID 23664 launched
224 Vitest workers using Node 24.15.0; all 4,229 tests passed in 107.21 s (160 skips).
No fail-fast exit was observed. The lossless archive is `84be82abe908d982`.
Ordinary Vitest file-cleanup SIGTERM events were visible and were not interpreted as
gateway child success. The observer was removed after the run and is not production
code. A passing instrumented run does not repair the two preceding failed gates.

Previously the gateway fixture ended stdin and immediately called `kill()`,
without awaiting `close`; a loopback probe only ended stdin. The temporary script
removal hook was independent of child shutdown. This allowed child stdio and
process teardown to overlap with endpoint closure, temporary-file removal and
subsequent work. Successful test assertions did not establish completed cleanup.

The corrected fixture registers `close` when each child is spawned, ends stdin,
and waits for both process exit and stdio closure before releasing its endpoint
and temporary directory. Normal shutdown must report `{ code: 0, signal: null }`.
Malformed configuration must report `{ code: 2, signal: null }`. A five-second
cleanup bound attempts termination, whose nonzero / signaled exit fails the
assertion; it does not turn a hung or crashed child into success. Remaining live
fixture children are reclaimed even when startup fails before fixture assignment.
Early startup exits now report only child PID, unsigned hexadecimal code and
signal. Startup spawn errors reject promptly in both fixture groups.

The existing stdin-close and invalid-config regressions now await `close` and
assert both status and signal. All normal child paths, including dead-endpoint
and loopback probes, use the same checked shutdown barrier. The focused corrected
run passed these assertions. This is evidence of closed test subprocesses in that
run, not proof that every production process lifecycle is correct.

A post-run inventory contained no live `control-gateway.cjs` child and no
gateway temporary directory dated during the corrected run. Four directories
from older runs remained; they were left untouched because they predate this
investigation. Production `ControlGatewayChild.stop()` separately awaits its
tracked exit/error event with a two-second kill grace. That is an exit barrier,
not the stronger stdio-close barrier now used by this test fixture; its existing
unit tests remain part of the controlled matrix and full acceptance gate.

## Residual risk and next reproduction evidence

If the native crash recurs, retain the Vitest coordinator / worker PID and its
parent, gateway PID, executable version, unsigned status, signal, test and hook
phase, worker count, and bounded timing / process-lifetime evidence. Obtain a
fail-fast subcode and native stack using an appropriately scoped crash dump;
dumps may contain secrets and must stay local and untracked. Compare the same
bounded reproduction on the repository's Node 22 before attributing a Node 24
runtime defect. Preserve the failed command exit; do not classify a clean rerun
as repair of the historical crash.

The fixture defect is corrected. The reproduced native failure's cause remains
unestablished. Acceptance must state that residual risk explicitly and require
the final supported Windows test gate to succeed.
