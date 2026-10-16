# NXR-SEC-01 — Windows acceptance and WSL2 Coding regression

**Date:** 2026-10-13 (Africa/Cairo). **Scope decision:** OD-SEC-01, Windows-first. Native Ubuntu
gates are deferred and **not claimed** (`CROSS_PLATFORM_ACCEPTANCE_NOT_CLAIMED`); see the
[acceptance matrix](../architecture/unified-dsh-runtime/acceptance-matrix.md).

## Verdicts

| Area                     | Verdict                                 | Basis                                                                                                                                                                                                                         |
| ------------------------ | --------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Windows final acceptance | **`WINDOWS_FINAL_ACCEPTANCE_FAIL`**     | Every executed Windows gate passes on the current implementation, but the mandatory requirement "Cowork isolation verified on supported Windows" (OD-SEC-02, A17) is unmet. No gate failed; the acceptance cannot be granted. |
| WSL2 Coding              | **`WSL2_CODING_ACCEPTANCE_PASS`**       | Exact current source, clean, all required WSL2 Coding checks passed                                                                                                                                                           |
| Cross-platform           | `CROSS_PLATFORM_ACCEPTANCE_NOT_CLAIMED` | OD-SEC-01                                                                                                                                                                                                                     |

## Windows evidence (current implementation)

NXR-SEC-01 changed **no production code**. The design and feasibility gate are documented only.
The current head therefore carries the same implementation as the last Full CI run:

- `git diff e2a82ae..HEAD` outside `docs/` is empty.
- The Full CI evidence for `e2a82aeba3236b9e099100535c4ba1f9f87b3dda` applies, and no new
  installer is required. If production code changes, every mandatory gate below must run again.

| Gate                                       | Result (raw report `report-2026-10-12T22-01-40-449Z.json`)                                                    |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------------- |
| Verdict                                    | `NEXAR_WINDOWS_FULL_PASS`; start and end commit `e2a82ae`, clean, `sourceStable: true`                        |
| Environment                                | Windows 11 Pro 10.0.26300 x64, Node 22.23.3, pnpm 10.33.0, DSH 0.2.0-rc.2                                     |
| Format, lint, boundaries, typecheck, build | PASS                                                                                                          |
| Unit and integration                       | 4,474 = 4,308 passed + 162 skipped + 4 pending (Windows-unavailable bubblewrap), 0 failed                     |
| Real DSH context/compaction                | 3/3                                                                                                           |
| CLI smokes                                 | PASS                                                                                                          |
| Source desktop E2E                         | 22/22 (includes Cowork draft, providers, sessions, Project Memory)                                            |
| Windows package + packaged E2E             | PASS, 22/22                                                                                                   |
| Installer                                  | SHA-256 `27cd71fe7378db3566e50841ac10b464eb90ccc435126befdcd779e181bcaaa7`; bundled DSH 0.2.0-rc.2; NotSigned |
| Gitleaks 8.28.0                            | PASS                                                                                                          |
| Linux-only sandbox stage                   | BLOCKED on Windows (not required; covered by WSL2 below)                                                      |

Details and the independent hash recomputation are in
[FCR02_Reliability_Diagnostics.md](FCR02_Reliability_Diagnostics.md).

## WSL2 Coding regression (exact current source)

The run used the existing `nexar-plane` WSL2 distribution as an unprivileged user (Ubuntu 24.04 on
kernel `6.18.33.2-microsoft-standard-WSL2`, Node 22.23.3, bubblewrap 0.9.0, socat 1.8.0.0). The
setup was:

- a fresh clone from a verified git bundle of `fcr02/opus-integration`, in a new directory
  `/var/tmp/nexar-sec01-wsl-20261013`;
- an offline frozen install;
- the pinned DSH installed from the committed lockfile.

No system settings were changed.

| Item                                                                           | Result                                                                                                                                                                            |
| ------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Source start / end                                                             | `0187bda5cc3810713a57b73850dfc8e8997de1f6` / tree `4caf5109dc572c2a202529eb1fd43bfb41170e12`, both clean                                                                          |
| Typecheck, `tsc -b`, CLI build                                                 | PASS                                                                                                                                                                              |
| Full offline suite (`--maxWorkers=1`, JSON)                                    | **4,474 = 4,452 passed + 22 skipped**, 0 failed (skips: live/paid opt-ins and Windows-only suites)                                                                                |
| Real bubblewrap launcher                                                       | 12/12                                                                                                                                                                             |
| Sandbox availability                                                           | 5/5                                                                                                                                                                               |
| Lane-engine sandbox / DSH integration                                          | 2/2 + 2/2                                                                                                                                                                         |
| Real sandboxed DSH ACP                                                         | 1/1                                                                                                                                                                               |
| Bridge relay integration                                                       | 4/4                                                                                                                                                                               |
| Session lease race / real context                                              | 3/3 / 3/3                                                                                                                                                                         |
| CLI smokes (`resources`, offline `run`)                                        | PASS                                                                                                                                                                              |
| Real offline Coding fixture (SHA-256 `4f7755e6…`, byte-identical to FCR-01/02) | **PASS**: DSH 0.2.0-rc.2 in real bubblewrap, 3 deterministic model requests, workspace write verified, outside write blocked, required context in every request, no token in argv |

This is **WSL2 Coding validation**, not native Ubuntu certification.

## Reliability observations

The two FCR-02 intermittents (the gateway child exit and the Providers second turn) remain
**unresolved and instrumented**. Neither recurred in the runs above. NXR-SEC-01 changed no affected
path, so no additional stress cycle was run.
