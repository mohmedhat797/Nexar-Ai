# NXR-070-BC — DSH installation reliability investigation

Owner authorization: 26 October 2026. Phase A preserves `@deepseek-ai/dsh@0.2.0-rc.2`; the separately authorized exact rc.3 upgrade is Phase B and cannot substitute for this evidence.

## Finding and limits

**The historical 180-second timeout's underlying delay remains unresolved.** Its failing boundary is established: npm was still reifying/unpacking dependencies, before the version probe. A separate deterministic defect was reproduced and corrected: failed reinstallation destroyed a previously working managed runtime before replacement acquisition succeeded.

No registry, DNS, TLS, antivirus, npm-cache lock or scheduler cause is claimed. The installer uses npm, not the pnpm store. Passing later runs are not retrospective closure of the timeout or the earlier Electron private-state delay.

## Source and historical evidence

Baseline B′: `ca8a603b442fe65750990f1f6f9671f42d7e20bc`, tree `204034739826e87c095807831c51844abfb18390`, initially clean. Original installer SHA256: `e20922d0749d678d63523cfc075cb22124012deb29c489d77597dcae518c83bc`.

| Evidence                                  | Actual result                                                        |
| ----------------------------------------- | -------------------------------------------------------------------- |
| B′ `report-2026-10-25T19-32-29-858Z.json` | FAIL at dsh-install, 180829ms, exit124, later required gates skipped |
| B′ report SHA256                          | `5b119937c082b1a38ec774c50b84913c7efcfe5416d797a10d2a50a6e5e4e977`   |
| B′ installer log SHA256                   | `685e70418950a623faade45e40dff11c288ddd8ff3d27149f3f284eded5a40d1`   |
| C′ `report-2026-10-25T19-36-40-909Z.json` | Install104232ms, all16 mandatory Windows stages PASS                 |
| C′ report SHA256                          | `a053d3fa7fb6dde15a6480ffb3079b32518c17de00d2ffe6dec4d3f88d97f196`   |

All original reports, runtimes, worktrees, startup evidence and disposable failure profiles remain preserved. Fresh evidence uses distinct names under `.nexar/ci/` in B′.

## Actual phase map

Pin/lock validation → exclusive installation admission → new sibling generation → **npm ci acquisition + integrity verification + dependency materialization** → installed package/name/bin containment validation → actual CLI `--version` → generation publication → ownership release → runtime ready.

The original implementation had no admission lock or staging; it wrote the target manifests and ran npm directly in the published directory. Acquisition, integrity checking and unpacking are npm-owned operations; they are not represented as separately measured phases unless npm actually supplies a timing observation.

## Toolchain and baseline campaign

Windows host: 20 logical CPUs, 16,890,322,944 bytes RAM. Explicit Node22.23.3, bundled npm10.9.9, pnpm10.33.0. The npm.cmd wrapper and direct bundled npm CLI both reported10.9.9; launcher-version mismatch was not reproduced. Default PATH's Node24.15.0 is not used for acceptance. No global PATH or security configuration was changed.

Original unmodified installer, clean baseline before/after, fixed serial campaign:

| Scenario                                                     | Observed result                                                                                |
| ------------------------------------------------------------ | ---------------------------------------------------------------------------------------------- |
| Fresh disposable directory, existing public npm cache        | PASS86934ms; npm unpack61802ms, command:ci64954ms                                              |
| Same directory, fully offline repeat                         | PASS102220ms; npm removed existing tree19271ms, unpack76297ms                                  |
| Fresh directory, empty disposable cache, offline             | Expected acquisition failure2597ms; no runtime claimed ready                                   |
| Previously verified runtime, empty disposable cache, offline | **Recovery defect reproduced**: failure20363ms, entrypoint present before and absent afterward |

Raw campaign: `.nexar/ci/dsh-install-baseline-20261026/results.json`. Deterministic failure observation: `failed-reinstall-existing.json` and `.log` in that directory; log SHA256 `0c6fc1a1829e2427643bede22e96665d85ccab9666fbfa92768b99d5e40c42e2`.

This demonstrates destructive reinstall behavior and considerable offline unpack time. It does not establish what made the historical invocation exceed180seconds.

## Implemented correction

- `scripts/dsh-runtime/install.mjs`: exclusive per-target ownership file; independently staged npm-ci generation; installed identity, contained entrypoint and exact CLI-version verification; publish only afterward. Unrelated directories and redirected targets are rejected.
- Replacement publication uses two same-parent renames, restoring the old directory if the second rename fails. This is **not** a universal atomic directory swap or a power-loss durability claim.
- Required npm lockfile/integrity checks remain enabled. No existing dependency tree is accepted as a trusted cache, including a tree with the right version but corrupted files.
- The180000ms installation policy and120000ms maximum version-probe policy remain; each child receives the remaining overall installation budget. The original outer Full-CI deadline is unchanged. Owned child timeout/tree termination uses the existing CI process supervisor.
- `scripts/local-ci/process-util.mjs` adds only an optional child-spawn PID observation callback, with a matching type declaration. Existing callers and failure semantics are preserved.
- Diagnostics emit bounded, fixed-schema phase metadata, UUID generation, UTC and monotonic elapsed times, numeric parent/child PID and exit/timeout classification. Arbitrary npm output, arguments, environment, credentials and private account fields are not published. Malformed pin values are not echoed.
- Successful replacement removes only its known, generated previous-generation sibling; failed cleanup is explicitly reported as retained. Failed staging remains available for diagnosis and is never treated as an executable runtime.

## Corrected real-package campaign

Same exact rc.2 pin, pinned Node, disposable target, fixed serial attempts; source diff identity unchanged within every attempt:

| Scenario                                           | Actual result                                                                                        |
| -------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| Fresh staged install                               | PASS68642ms; npm-ci68245ms, version253ms, publication41ms                                            |
| Forced offline/empty-cache reinstall failure       | Expected failure2187ms; **previous entrypoint remains present with identical SHA256**; lock released |
| Offline repeated staged installation after failure | PASS80555ms; npm-ci68452ms, version252ms, publication11767ms; stable published entrypoint            |

Raw evidence: `.nexar/ci/dsh-install-staged-20261026/results.json` plus individual uniquely named logs. These campaign results are pre-commit working-source evidence, not clean aggregate Windows acceptance. The failed acquisition is an expected negative test and is not counted as a successful installation.

The original and corrected forced-failure observations provide real-package RED/GREEN evidence for preservation of the prior runtime. Reduced observed durations are supplemental measurements, not a statistical reliability or original-timeout closure claim.

## Regression verification

`tests/dsh-runtime-install.test.ts` covers fresh/repeated generations, acquisition/integrity/interruption/timeout failure preservation, partial-stage rejection, corrupt existing trees, immutable exact version, escaped bin rejection, deterministic competing installers, publication rollback, retained abnormal-termination lock, unknown target/junction rejection, diagnostic allowlist and actual child-PID observation.

Focused command: pinned Node running Vitest over `tests/dsh-runtime-install.test.ts`, `tests/local-ci-security.test.ts`, `tests/local-ci.test.ts`, one worker, JSON reporter. Result: **49passed, zero failed/skipped/pending**. Raw `.nexar/ci/dsh-install-phase-a-focused-final-20261026.json`, SHA256 `ba4132a97f9dc12ea7ef62239fe1010ebe1343d9ea66d49ab20faa24e70192f2`.

An earlier targeted lint execution found two unsafe-finally throws and four require-await violations; corrected before final repository validation. It was not a passing lint result.

## Recovery limitations

A hard-killed installer can leave a lock and a partial sibling generation. Restart deterministically refuses that target rather than guessing that a PID is stale. An operator must establish that the recorded installation and its owned children have exited before removing that specific ownership file; retained stage/previous directories remain diagnostic evidence. No automated PID-only lock stealing, automatic security retry, broad cleanup or user-data migration is implemented.

Two-rename publication can be interrupted between moves. In-process rename failures restore the previous generation; hard termination at that exact boundary may require explicit recovery from the retained previous sibling. No user connection/session/memory store is located in these installer-owned runtime directories.

## Acceptance status

Complete repository check and clean source-bound B′ Windows Full CI are pending at this implementation checkpoint. Final exact commits, tree identities, reports and source-stability results will be recorded after execution. **Current installation verdict: `NXR070_DSH_INSTALLATION_ROOT_CAUSE_UNRESOLVED`.**

Phase B must retain its own branch, exact rc.3 identity, compatibility/rollback evidence and Draft PR. Neither a successful rc.3 install nor C′'s historical Full PASS may be substituted for B′ standalone acceptance.
