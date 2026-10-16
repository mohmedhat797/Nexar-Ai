# NXR-SEC-02 — Windows and WSL acceptance

Date: 2026-10-16. Windows Full CI passed all 16 required stages on build 26300. Source and packaged
Desktop E2E each passed 25/25. Selected build 26200 (SEC02-F06 Path B) and owner acceptance remain unverified.

## Source and environment

- Starting consolidated baseline: `fcr02/opus-integration`, `8e35e46c192e11022185e6d12117b610f107351e`.
- Implementation: `feat/nxr-sec02-isolated-cowork`, dedicated worktree `.nexar/sec02`.
- Tested implementation commit: `dc27f551fdab7c80337982598ba07c7c0faca8e5`; exact Git tree
  `249bfcc10c4d32aa6b7abddcbfca1a2f71ebcd24`. CI ran directly on this clean commit (`isDirty: false`,
  `sourceStable: true`).
- Previous tested implementation `3b3e26a3ab641f5273ad43ddce6de0ca4065f847` is parent commit.
- Actual Windows: x64 build 26300; Node 22.23.3, pnpm 10.33.0, Electron 44.5.1.
- WSL: `nexar-plane`, non-root `nexar` UID 1000, Node 22.23.3, bubblewrap 0.9.0,
  kernel 6.18.33.2-microsoft-standard-WSL2, socat.
- Pinned Linux DSH: `/opt/dsh/lib/node_modules/@deepseek-ai/dsh/lib/bin.js`, `0.2.0-rc.2`.
- Linux Cowork helper: `/usr/local/bin/nexar` provisioned from `/home/nexar/src/Nexar-Ai`,
  protocol `nexar-cowork@1`, helper release `0.1.0-sec02.1`, capabilities
  `['stdio-rpc', 'gateway-socket', 'bridge-socket', 'flat-scratch']`.
- No Windows optional feature, persistent Windows identity/security policy, or WSL configuration changed.
  Tests reused the existing unprivileged ephemeral bubblewrap namespaces.
- Linux checkout `/home/nexar/src/Nexar-Ai` matches Windows across all 457 selected production/dependency
  Git index entries, sorted-list SHA-256 `d4daa742211f9a55e740d1add365402db8c9329633016d4422f4dc8bc8388a25`.

## Current acceptance evidence

| Run                                          | Result                                                                                  | Raw evidence                                             |
| -------------------------------------------- | --------------------------------------------------------------------------------------- | -------------------------------------------------------- |
| Windows Full CI                              | PASS, 16 required stages; 1,835.62 seconds                                              | `.nexar/ci/reports/report-2026-10-16T16-36-30-282Z.json` |
| Offline outcomes                             | 4,338 passed, 167 skipped, four pending, zero failed/todo/unclassified; 4,509 collected | `.nexar/ci/test-offline.json`                            |
| Real DSH context                             | 3/3 PASS                                                                                | Full CI stage log                                        |
| Mandatory isolated Windows context/transport | 8/8 PASS, no skips (tested with default `/usr/local/bin/nexar` helper)                  | `.nexar/ci/cowork-wsl.json`                              |
| Real Linux boundary and Coding gate          | 15/15 PASS, no skips                                                                    | Linux `.nexar/ci/cowork-kernel.json`                     |
| Additional actual Coding prompt              | PASS: workspace write, outside write prevented, owner context in all three requests     | Linux `.nexar/sec02-coding-regression.json`              |
| Direct syscall/mount evidence                | PASS: hidden reads/writes ENOENT, input write EROFS, host TCP ECONNREFUSED              | Linux `.nexar/sec02-kernel-evidence.json`                |
| Source Desktop E2E                           | 25/25 PASS (9 files)                                                                    | Full CI source stage log                                 |
| Fresh Windows packaging                      | PASS; bundled DSH pin and artifact freshness/hash verified                              | Full CI package metadata                                 |
| Packaged Desktop E2E                         | 25/25 PASS (9 files, bundled DSH runtime only)                                          | Full CI packaged stage log                               |
| Literal pre-commit pnpm check                | PASS: 4,338 passed, 167 skipped, four pending; build PASS                               | Full CI stage logs                                       |
| Secret scanning                              | CI history and staged changes PASS                                                      | Full CI log; staged Gitleaks pass                        |

The optional `linux-sandbox` stage is BLOCKED/non-required on Windows. Separate real WSL execution
passed; neither result establishes native Ubuntu acceptance. Overlapping suites are reported
separately and must not be added into a unique-test total.

Installer: `release/desktop/Nexar-0.1.0-windows-x64-setup.exe`, **322,016,718 bytes**, unsigned.
SHA-256 `ea354fc76779da0a02809c29ea020ea923e441e6664087bf96e26f6352581bc1`, matching generated checksum.
Build timestamp `2026-10-16T17:01:06.666Z` (2026-10-16 20:01:06 Africa/Cairo).
Packaged tests used that stage's fresh `win-unpacked/Nexar.exe`.
Per Phase K instructions: NSIS `oneClick: true, perMachine: false` installer silently overwrites
user-wide `%LOCALAPPDATA%\Programs\Nexar` and registry keys
`HKCU\Software\Microsoft\Windows\CurrentVersion\Uninstall\ai.nexar.desktop` without permitting an
isolated temporary install location. Because automated machine-wide installation would alter the
user's host environment, installed-copy acceptance is explicitly not claimed; packaged E2E (25/25 PASS)
serves as the verified packaged artifact acceptance.

See [machine evidence](evidence/nxr-sec02-evidence.json) and
[final owner handover](NXR_SEC02_Final_Owner_Handover.md).

## Exploratory results and corrections

Initial focused Linux checks passed 23/23 at clone `d6d05ab4`; initial Windows real WSL drafting
and read-only checks passed 2/2; expanded Windows service/input/executor/WSL checks passed 44/44.
Their reports remain in the earlier disposable clones and this worktree's ignored `.nexar/`.
They are development evidence, not substitutes for the final frozen-source acceptance above.

The `d3afec4e` Linux clone recorded 22/23: a test fixture supplied `source/target` instead of
`hostPath/sandboxPath` for a mount. The declaration was corrected. An earlier shallow input mount
was corrected to `/inputs/cowork`. Other exploratory failures were corrected before acceptance:
owner-selected filenames with spaces needed separate safe transfer names; the filename fixture
needed the registry's sorted order; the first multi-turn E2E assertion checked the prior turn
before the new turn rendered; and a crash-test spawn wrapper needed defaults for optional arguments
and options under strict TypeScript. Earlier quick/typecheck failures and their raw reports remain
retained. No timeout was increased, assertion removed, or isolation weakened to obtain a PASS.

The stronger final E2E reads an approved input, writes a draft, then reads/revises the first imported
artifact in the same canonical conversation and restores both turns after restart.

## Reproduction and scope

Provision the matching source and CLI in `nexar-plane` via:

```powershell
pnpm cowork:wsl:provision
```

This deploys the matching checkout to `/home/nexar/src/Nexar-Ai` and `/usr/local/bin/nexar`.
With the default helper deployed, `NEXAR_SEC02_WSL_COMMAND` and `NEXAR_SEC02_WSL_REPO` are no longer
required (they remain available as optional override variables). Supply `NEXAR_SEC02_WSL_DISTRO=nexar-plane`
if using a non-default distro name.

Invoke `scripts/local-ci/runner.mjs --mode=full --workers=2` with pinned Node 22 and the existing
Gitleaks binary option. The new required `cowork-isolation-wsl` stage rejects missing configuration
and skipped real assertions. It runs isolated canonical-context tests, creates its own synthetic
Windows fixture, then invokes the Linux kernel/Coding gate. Source and packaged E2E opt into the
actual WSL backend while retaining historical hermetic host-local fixture cases.

The direct syscall and additional Coding fixture/drivers are retained in this worktree's ignored
`.nexar/`; their sanitized results are captured in the machine evidence. Actual user data and
credentials were not used. Selected Windows 11 Pro 25H2/build 26200, permanent WSL2 support,
independent security review and owner acceptance remain separate gates.
