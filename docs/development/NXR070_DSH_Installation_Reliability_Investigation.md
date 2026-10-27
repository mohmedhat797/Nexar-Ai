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
- The outer Full-CI installation deadline remains180000ms. The direct installer now applies that same total budget internally, where npm was previously unbounded locally; the120000ms maximum version-probe limit is retained and each child receives at most the remaining overall budget. No deadline was increased. Owned child timeout/tree termination uses the existing CI process supervisor.
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

### Follow-up: verified publication blocked by old-generation deletion

An isolated rc.3 upgrade Full invocation on `fe106fd9872a70aae5a78161f615539f8c684282`, tree `a59d46e08b3b472bb1521771484c52a145d70b73`, reproduced a **different, newly attributable** installer timeout. The aggregate report `report-2026-10-27T02-39-05-898Z.json` has SHA256 `7da65909f95aeb54b1bc04bb7512f739dca7e17aff8ad0436887a513e2895bbd`. Its installation stage timed out after 180,299 ms. Source stayed clean and unchanged.

Npm completed and the real CLI version probe succeeded by elapsed 130,384 ms. Publication started, but no publication-complete event was emitted before termination. The generated stage disappeared, the target directory had the new generation's creation timestamp and contained the verified rc.3 entry, and the previous sibling was partially deleted: its top-level module count fell from 197 to 190 and its DSH manifest/entry were missing. The ownership file remained after termination. These observations establish both completed renames and an interrupted recursive deletion on the publication readiness path. The old generation's deletion, rather than package acquisition or version verification, prevented this invocation from reporting ready. They do **not** establish why individual Windows filesystem operations were slow, or explain the original historical rc.2 npm timeout.

Because that publication code belongs to the shared B′ installer, its correction is made here and propagated through normal merges. The installer retains the exact previous sibling instead of synchronously recursively deleting it before readiness. Pin, npm integrity checks, staging, identity/version verification, exclusive admission, rename compensation, 180-second deadline and fail-closed lock behavior remain unchanged. No retry, cache trust shortcut or deadline increase is introduced. Retained generations consume disk space and require explicit, verified owner-controlled maintenance outside installation; there is no automatic garbage collector. Historical failed/partial generations remain evidence and must not be silently reused or deleted.

The deterministic regression failed against the preceding implementation (16 passed, one failed: the previous generation was removed). It asserts a complete retained sentinel, a usable newly published runtime, a retention event, ready only after publication and release of the ownership lock. Raw RED evidence: B′ `.nexar/ci/dsh-publication-retention-red-20261027.*`, log SHA256 `db7d3dd15065d6f8910de72bbbfab9803cb0bdd3d8d2da9c048d1fdf85f8f6df`. Corrected GREEN: all 17 installer tests passed, zero failed/skipped/pending, Node22.23.3, 2265ms; `.nexar/ci/dsh-publication-retention-green-20261027.*`, log SHA256 `d77383b71bf8e261117b0a57ee960fdd39474ded192b872b9f6bbe3bf90ad513`. Subsequent source-bound acceptance remains separate; this regression does not simulate the Windows deletion latency or prove the original historical delay fixed.

Implementation commit: `754312a24b38fafd715c5ee093af72172764569f`; tree `e4aa52591dcf18c776e1bcf5c46f1d4d97b88583`. Complete `pnpm check` passed before that commit:4518passed,178skipped,four pending, build passed; exact staged tree stable before/after. Log `.nexar/ci/dsh-phase-a-complete-check-initial-20261026.log`, SHA256 `024d94026b0b85c6cc23bdc382a2df812386aff7fd25db3a1dc30ed4c00864b6`.

### Standalone B′ Windows Full — actual failed aggregate

One complete invocation ran from2026-10-26T20:59:43Z through21:50:54Z (27October in Cairo at completion), on clean754312a/e4aa at both boundaries. No tracked source changed. Command: the repository's supported `scripts/local-ci/runner.mjs --mode=full --profile=windows`, with explicit pinned Node/Gitleaks, two workers and a fresh runtime target.

Raw immutable report: `.nexar/ci/reports/report-2026-10-26T20-59-43-641Z.json`, SHA256 `3ec5b896001663902891ae5e1528e525598b6cc81ae3a4ebe8bf3e24cdc40014`.

**Result: `NEXAR_WINDOWS_FULL_FAIL`,3068.46seconds.** Fourteen required stages passed; packaged Desktop failed and required Gitleaks was skipped. The optional native-Linux stage was also skipped after failure. The report contains all17 stage records; no failed stage is omitted.

| Gate                                 | Actual observed result                                     |
| ------------------------------------ | ---------------------------------------------------------- |
| Pinned rc.2 installation             | PASS90168ms; exact version and entry verified              |
| Formatting/lint/boundaries/typecheck | PASS                                                       |
| Offline suite with managed runtime   | 4529passed,167skipped,four pending, zero failed; total4700 |
| Build and both CLI smoke gates       | PASS                                                       |
| Real DSH context/compaction          | 3/3 PASS                                                   |
| Windows-to-WSL transport             | 8/8 PASS, including a separate nested Linux kernel gate    |
| Source Desktop                       | 33/33 PASS456749ms                                         |
| Windows packaging                    | PASS1170477ms; bundled runtime exactlyrc.2                 |
| Packaged Desktop                     | **32/33; one failed**782269ms                              |
| Gitleaks in this invocation          | **SKIPPED**, not PASS                                      |

The failing packaged scenario is `e2e/acceptance.e2e.ts`, “1. a Cowork SOW is orchestrated by DeepSeek Harness on Nexar’s control resource and delegated to other resources”, at `succeeded(page,0)` nearline322. It timed out waiting for success. Retained progress metadata shows a running turn, six control requests and zero work-provider requests. This does not establish a failure mechanism or link it to installation, the historical PowerShell guard timeout, or the proposed upgrade.

Failure log: `.nexar/ci/logs/1793050666729-desktop-e2e-packaged.log`, SHA256 `5fa205a5a767c77bee5897aa50634afd2457439756c5571dc7b56a5257bbdc13`. The execution recorder `.nexar/ci/dsh-phase-a-b-full-754312a-20261026.execution.json` independently confirms unchanged clean source. No rerun is substituted for this failure.

Created unsigned installer:322183407bytes, SHA256 `b6c458271f125b6e142de6021a933160a7642f8c4d44abbd970e01761ca7ea52`. It is an artifact of a **failed acceptance invocation**. E2E used win-unpacked; a clean-machine NSIS installation was not executed.

### Actual integrity-negative verification

After Full CI ended, a tiny synthetic local npm tarball and deliberately incorrect SHA512 in a disposable pin/lock fixture produced an actual npm **EINTEGRITY** rejection. The production installer module rejected publication, preserved the previously verified runtime entry byte-for-byte, released its ownership lock, and that runtime still executed `--version` asrc.2. The real project pin and lock were unchanged; source754 remained clean throughout.

Raw result: `.nexar/ci/dsh-phase-a-integrity-negative-754312a-20261027/result.json`. This is distinct from unit simulations of npm failures. No registry network, real credentials, sign-in or paid provider request was required.

**Phase A is acceptance-incomplete** because standalone B′ Windows Full did not pass. The demonstrated destructive-reinstall defect is corrected and verified; the original timeout's underlying delay and this packaged SOW stall remain unresolved. **Installation verdict: `NXR070_DSH_INSTALLATION_ROOT_CAUSE_UNRESOLVED`.**

Phase B must retain its own branch, exact rc.3 identity, compatibility/rollback evidence and Draft PR. Neither a successful rc.3 install nor C′'s historical Full PASS may be substituted for B′ standalone acceptance.
