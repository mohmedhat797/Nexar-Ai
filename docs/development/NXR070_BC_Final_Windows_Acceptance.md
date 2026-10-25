# B′/C′ Windows acceptance — targeted startup investigation

Execution date: 25 October 2026. This report preserves failed invocations and separates aggregate acceptance from supplemental evidence. Final publication identity is recorded in the ignored publication receipt after commits and remote verification.

## Toolchain and platform

| Item            | Verified identity                                                             |
| --------------- | ----------------------------------------------------------------------------- |
| Windows         | Windows 11 Pro, 10.0.26300, x64                                               |
| Host            | 20 logical CPUs; 15.73 GiB RAM                                                |
| Acceptance Node | 22.23.3                                                                       |
| Node executable | `D:/Nexar-Ai-nxr070/.nexar/research-toolchain/node-v22.23.3-win-x64/node.exe` |
| pnpm            | 10.33.0                                                                       |
| DSH             | `@deepseek-ai/dsh@0.2.0-rc.2`                                                 |
| Electron        | 44.5.1; embedded Node 24.21.0/libuv 1.52.1                                    |
| Gitleaks        | 8.28.0, `D:/Nexar-Ai-main/.nexar/gitleaks-8.28.0/gitleaks.exe`                |
| WSL             | `nexar-plane`, kernel 6.18.33.2-microsoft-standard-WSL2; Linux Node 22.23.3   |

The legacy toolchain directory remains required and was not deleted or relocated. Dependency pins and lockfiles were not upgraded. Heavy Windows, packaging and WSL suites run serially. The existing test worker option is used where recorded; no coverage or security assertion is removed.

## Historical acceptance remains source-specific

- B′ `06e55f36` previously passed all 16 required Windows stages, source 29/29 and packaged 29/29. Raw report SHA256: `1cb1fea82daf65dad360cc25ae1ca7aca6b707b25916cb45c544d9524325b16c`.
- C′ `80e70a60` failed its aggregate on packaged restart, 28/29, after source 29/29. Raw report SHA256: `0115e7c77e8ac5f71491efcb5fa1c4b9c4f57500cb9e17a3be649dbe0136155b`.
- The older C′ `1c584208` Full PASS is historical; it does not accept the later failed or current source.

## Complete Full CI attempts during this assignment

All rows used the actual full runner and its required-stage list. Reports are under the named branch worktree's `.nexar/ci/reports/`. No failed row is reclassified because a later command passed.

| Branch/source                          | Report                                 | Aggregate | Observed blocker                                                                                      | SHA256                                                             |
| -------------------------------------- | -------------------------------------- | --------- | ----------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| B′ `1c3f3a89`                          | `report-2026-10-25T16-07-21-903Z.json` | FAIL      | Pinned DSH installer exceeded existing 180-second limit; later gates skipped                          | `0985fc805ca94dc7f997c35a042abfe5279917010d8d9af77a288b1988782082` |
| B′ `1c3f3a89`                          | `report-2026-10-25T16-20-00-214Z.json` | FAIL      | Installer again exceeded limit after preserved-runtime restoration                                    | `6def09743f9809d7f34635c4209d991bab8406c06e76c35614a4c32aacbb1e5a` |
| C′ `acf29da7`                          | `report-2026-10-25T16-28-14-531Z.json` | FAIL      | Same installer gate                                                                                   | `6e3f7e475d20d4d855c8aba60f5911f2ead0a971af1cef1a323d6e33492ab82d` |
| C′ `acf29da7`, fresh runtime directory | `report-2026-10-25T16-36-44-136Z.json` | FAIL      | Fresh directory still exceeded installer limit; old-directory removal is not a sufficient explanation | `c923725f5c5c57084ea79df85740aab8936f09967897b596661d16ef1e4263bc` |
| B′ `428eb770`                          | `report-2026-10-25T18-00-27-447Z.json` | FAIL      | Installer passed in 132.52 s; offline stage exposed seven introduced trace-double failures            | `882727dca35c4644bcaf1cffc501331ee4d787905c8c97d179e664504b99cbf8` |

The B′ `428eb770` report identifies tree `96cb27640c497d17afecee0834f796ca6adad88c`, clean start/end and stable source. It passed dependency verification, runtime installation, format, lint, boundaries and typecheck before failing offline tests: 4,506 passed, seven failed, 167 skipped, four pending. The failure summary parser reported zero pending; the raw assertion statuses establish four pending. This reporting limitation is disclosed rather than treating pending tests as passed.

A bounded standalone installation diagnostic completed in 146.799 s with the same pinned runtime. Its JSON SHA256 is `11f42f23058c335bd0f9e5e626781e228478e0b647366147d26ae408a4049113`. A later direct pinned-Node invocation of the literal full-runner script passed installation. Neither result proves that pnpm's parent process caused the earlier stalls; no installer deadline or guard deadline was increased.

## Repository checks and regressions

| Source/tree                                                                        | Command and configuration                               | Result                                                    | Evidence                                                                                                                             |
| ---------------------------------------------------------------------------------- | ------------------------------------------------------- | --------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| B′ staged tree `96cb27640c497d17afecee0834f796ca6adad88c`, committed as `428eb770` | `pnpm check`                                            | PASS; 4,513 passed, 167 skipped, four pending             | `electron-startup-b-agy-correction-check-v2-20261025.log`, SHA256 `7e47a4c1af82d305b305a1a97316bec586883b1bd25b2eb30ede6e24e3248a03` |
| C′ staged tree `276530fd3ca3b8137ad07fc314481abbe9734be2`, committed as `bdbabe0b` | `pnpm check`                                            | PASS; 4,570 passed, 169 skipped, four pending             | `electron-startup-c-agy-merge-check-20261025.log`, SHA256 `79690b5bc567a3dff9ee69d792d1afc615f4b9ca018ef7b20daa67a911093328`         |
| B′ staged tree `2f2bcaffc356e70d5b61e162ccede588c0be6b3b`, committed as `756fa8f2` | `pnpm check`, trace flags enabled                       | PASS; 4,513 passed, 167 skipped, four pending             | `electron-startup-b-trace-fixture-check-20261025.log`, SHA256 `c0ec8872e751adcaa68158072ea4249f3a42c84a352339deed15caf1c2f77fe3`     |
| C′ pending merge, staged tree `3ff431380fa734facad691cb751fcb6959d7f18b`           | `pnpm check`, trace flags enabled, default four workers | FAIL; 4,568 passed, two failed, 169 skipped, four pending | `electron-startup-c-trace-merge-check-20261025.log`, SHA256 `e42da3bdece80b5a79498b026bab719b5ade533692173ac52d522512611ad8d9`       |

The last row failed on the 15-second connection-lifecycle scenario and an Antigravity fixture readiness wait followed by `EBUSY` cleanup. The latter revealed a cancellation bypass corrected in the fixture. The connection timing mechanism remains unproven. Serial worker execution is an explicit supported acceptance configuration; it does not establish a causal explanation for either startup delay.

## Targeted actual Electron campaign

At C′ `acf29da7`, source startup cases passed 4/4 and packaged startup cases passed 4/4. Two restart-without-Cowork and two restart-after-two-isolated-turns attempts also passed. The exact predetermined matrix and measurement limits are in the root-cause and remediation reports.

| Supplemental raw JSON                                     | SHA256                                                             |
| --------------------------------------------------------- | ------------------------------------------------------------------ |
| `electron-startup-c-source-acf29da-20261025.json`         | `f81514ed61e355a17d4424ba9c84ed69fb09d3ab78816909caaa11030859c239` |
| `electron-startup-c-packaged-acf29da-20261025.json`       | `d4e171d17885fa41ecdd3e6d8bc90061793b729704403e63665d11fcba6c47c4` |
| `electron-startup-c-without-cowork-acf29da-20261025.json` | `215eda2591e2edff03a1b27a7f28ffd792071819ccf21ffea5c799efdb7e3f6a` |
| `electron-startup-c-cowork-1-acf29da-20261025.json`       | `edd7b53f7fb3a6fe642db190fd5d63d71d14f05dc2790fe0389f74ce5c278012` |
| `electron-startup-c-cowork-2-acf29da-20261025.json`       | `28a1b381992dbf69d4779525edb1f4a2ae2d54cb791f8f9772f812fdcffff6ef` |

## Package identity and installation limit

The supplemental C′ `acf29da7` installer SHA256 is `ee0be8e801b168caf792b1bb132f90923b21fdc892710b34e2677987f01a1022`; `Nexar.exe` SHA256 is `ceab2e3539800761b137131e64cff08c9b22448963b84422f24dda38719472ba`; `app.asar` SHA256 is `cacfd704e100a2a0a37c2372ee34bb15c02861912e26b18a0958aa023ef1013e`. The bundled DSH manifest retained rc.2 and the three unpacked helpers matched source bytes.

These tests launch `win-unpacked` with disposable profiles. A clean-machine NSIS installation was not performed and is not claimed. The owner's installed Nexar profile, real credentials and live paid provider requests were not used.

## Final-source acceptance status

Final corrected-source Full Windows and WSL results are pending execution at this report checkpoint. Historical and supplemental passes above do not satisfy that gate. The final owner handover and publication receipt must list the executed final results and any remaining unexecuted gates before owner review.
