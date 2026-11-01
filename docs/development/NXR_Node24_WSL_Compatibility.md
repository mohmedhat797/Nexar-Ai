# Node 24 WSL compatibility

Environment: `nexar-plane`, WSL2, x86_64, non-root runtime user `nexar`. Baseline Node 22.23.3 and pnpm 10.33.0 are independently installed from Windows. Windows drives are not mounted into this distro; this policy was preserved.

The official hash-verified Node 24.22.2 Linux archive was transferred over stdio into a new private root-owned staging directory and verified again in Linux before extraction. The separate `/opt/node-v24.22.2-linux-x64` tree is root-owned 0755; npm reports 11.19.1. Old `/opt/node` and `/usr/local/bin/node` remain unchanged and report 22.23.3. Archive/binary hashes are in [toolchain implementation](NXR_Node24_Toolchain_Implementation.md).

## Acceptance versus deployment

The installed launcher still points at source `3153459396e220a63633f8b4c82eb2b866200377` and `/opt/dsh` still reports **0.2.0-rc.2**. **G-13 is not resolved.** Updating Node does not deploy current Nexar or DSH rc.5. No installed Plane source, launcher, data or native account home was overwritten.

Current-source validation uses an isolated Linux candidate/helper and rc.5 runtime, with explicit acceptance environment inputs. Acceptance scripts now derive a versioned Linux Node path from `.nvmrc` and accept a validated `NEXAR_SEC02_LINUX_NODE_BIN` override. They never silently use the old `/opt/node/bin/node`. Existing helper/protocol/DSH version checks are unchanged.

Required validation: exact Node/pnpm, native dependency/build compatibility, ACP and SDK where used, current helper handshake, bubblewrap/engineering/Cowork isolation, credentials, containment, process cancellation, cleanup, sessions and memory. Final commands/source IDs/outcomes are recorded in [final acceptance](NXR_Node24_Electron44_Final_Acceptance.md).

G-14 remains a historical unexplained intermittent timeout. Relevant WSL Full execution must capture stall/timer evidence and preserve any recurrence; neither an increased timeout nor a later passing run alone closes it. WSL Full is not native Ubuntu Full. Rollback keeps old runtimes and the installed Plane unchanged; no privileged system Node replacement or host fallback is permitted.

## Initial candidate failure and correction of the test invocation

The first Linux Full on failed Electron candidate `c797e544fa754626f528579703289fe8fe25dec7` stopped in offline tests after 124.89 seconds: 4,779 passed, 2 failed, 32 skipped. Both failures were existing POSIX private-state fixtures expecting newly created 0644/0755 files/directories. The isolated wrapper's `umask 077` had instead created 0600/0700 fixtures before the code under test ran. No test expectation or application permission check was changed. The corrected invocation uses the standard `022` mask for the test process while keeping the isolated HOME, runtime directory, log parent and actual private application stores protected. A fresh Full run is required; this initial failure is not a pass.

The independent 25 ms timer/fsync monitor recorded maximum timer overrun 14.405 ms and maximum fsync 39.162 ms during that run. It was not injected into workers and cannot prove worker-specific stalls absent. `sessions.test.ts` did not produce the historical G-14 timeout in this run; G-14 nevertheless stays open. The earlier monitor script was not recovered, so this ignored diagnostic recreates the documented timer/fsync approach rather than claiming byte-identical instrumentation.

## Clean fallback Full evidence

On `32e21a1f81eeb90b634a04ef5f9671676b6244d8`, tree `0bf77425d2b41f1810b2a87736cec8577300c4dd`, one clean, stable-source Full invocation returned `NEXAR_LINUX_WSL2_PASS` in 354.62 seconds. All 14 required stages passed: 4,828 tests passed, 39 skipped, zero failed or pending. The independent monitor recorded maximum timer overrun 314.546 ms and fsync 339.391 ms across 13,780 samples. G-14 remains open. This establishes that candidate's WSL behavior; later build-script changes require their own source-bound qualification. It does not deploy the installed Plane or establish native Ubuntu acceptance.

Final code qualification repeated Full on clean `c510db3d6bececc3e1d4291e75c16e2949a44dee`, tree `26a2c8babca43cc5107bb2521a8e7cc95e955548`: **`NEXAR_LINUX_WSL2_PASS`**, 403.75 seconds, all 14 required stages passed, 4,836 passed / 39 skipped / zero failed or pending. Source remained stable. Desktop took 177.480 seconds, native bubblewrap 3.672 seconds, and Gitleaks 2.080 seconds. The independent monitor recorded 15,447 samples, maximum timer overrun 558.821 ms and fsync 583.574 ms. These observations do not close G-14; G-13 and native Ubuntu acceptance also remain separate. Documentation-only follow-ups must distinguish their head from this tested code identity.
