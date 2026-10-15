# NXR-SEC-02 — Windows and WSL acceptance

Date: 2026-10-16. Windows Full CI passed all 16 required stages on build 26300. Source and packaged
Desktop E2E each passed 25/25. Selected build 26200 and owner acceptance remain unverified.

## Source and environment

- Starting consolidated baseline: `fcr02/opus-integration`, `8e35e46c192e11022185e6d12117b610f107351e`.
- Implementation: `feat/nxr-sec02-isolated-cowork`, dedicated worktree `.nexar/sec02`.
- Tested implementation commit: `3b3e26a3ab641f5273ad43ddce6de0ca4065f847`; exact Git tree
  `bf749cfcb88ed5adb2be80f3c0b9e6c2ed1ebafb`. CI ran before this commit at base `8e35e46` plus
  dirty fingerprint `7f0df05ccb9c8ac8f5fb9363121983539a73dadee66c869d4f2538f790582d2e`,
  identical at start/end. The post-validation commit has the captured staged tree; no implementation
  changed afterward. The final handover commit changes documentation/evidence only.
- Previous tested implementation `e2a82aeba3236b9e099100535c4ba1f9f87b3dda` is historical.
- Actual Windows: x64 build 26300; Node 22.23.3, pnpm 10.33.0, Electron 44.5.1.
- WSL: `nexar-plane`, non-root `nexar` UID 1000, Node 22.23.3, bubblewrap 0.9.0,
  kernel 6.18.33.2-microsoft-standard-WSL2, socat.
- Pinned Linux DSH: `/opt/dsh/lib/node_modules/@deepseek-ai/dsh/lib/bin.js`, `0.2.0-rc.2`.
- No Windows optional feature, persistent Windows identity/security policy, or WSL configuration changed.
  Tests reused the existing unprivileged ephemeral bubblewrap namespaces.
  Existing installed Windows/WSL applications were not upgraded.
- Final Linux validation checkout: `/var/tmp/nexar-sec02-20261015-2f415e0b/repo`, transferred using
  a Git bundle and staged binary patch. Existing `/usr/local/bin/nexar` was preserved.
- Its 457 selected production/dependency Git index entries match Windows, sorted-list SHA-256
  `b02fb44c1b3ac2b9c751eccf1fbff9437d61cbc109909f6e2cd912e935b5974f`.
  Test/E2E/support fixtures are excluded from this comparison.

## Current acceptance evidence

| Run                                          | Result                                                                                  | Raw evidence                                             |
| -------------------------------------------- | --------------------------------------------------------------------------------------- | -------------------------------------------------------- |
| Windows Full CI                              | PASS, 16 required stages; 2,627.89 seconds                                              | `.nexar/ci/reports/report-2026-10-15T22-31-19-362Z.json` |
| Offline outcomes                             | 4,335 passed, 167 skipped, four pending, zero failed/todo/unclassified; 4,506 collected | `.nexar/ci/test-offline.json`                            |
| Real DSH context                             | 3/3 PASS                                                                                | Full CI stage log                                        |
| Mandatory isolated Windows context/transport | 8/8 PASS, no skips                                                                      | `.nexar/ci/cowork-wsl.json`                              |
| Real Linux boundary and Coding gate          | 15/15 PASS, no skips                                                                    | Linux `.nexar/ci/cowork-kernel.json`                     |
| Additional actual Coding prompt              | PASS: workspace write, outside write prevented, owner context in all three requests     | Linux `.nexar/sec02-coding-regression.json`              |
| Direct syscall/mount evidence                | PASS: hidden reads/writes ENOENT, input write EROFS, host TCP ECONNREFUSED              | Linux `.nexar/sec02-kernel-evidence.json`                |
| Source Desktop E2E                           | 25/25 PASS                                                                              | `.nexar/ci/logs/1792104322018-desktop-e2e-source.log`    |
| Fresh Windows packaging                      | PASS; bundled DSH pin and artifact freshness/hash verified                              | Full CI package metadata                                 |
| Packaged Desktop E2E                         | 25/25 PASS                                                                              | Full CI packaged stage log                               |
| Literal pre-commit pnpm check                | PASS: same 4,335 passed, 167 skipped, four pending; build PASS                          | `.nexar/sec02-pnpm-check.log`                            |
| Secret scanning                              | CI history and staged changes PASS                                                      | Full CI log; `.nexar/sec02-staged-gitleaks.json`         |

The optional `linux-sandbox` stage is BLOCKED/non-required on Windows. Separate real WSL execution
passed; neither result establishes native Ubuntu acceptance. Overlapping suites are reported
separately and must not be added into a unique-test total.

Installer: `release/desktop/Nexar-0.1.0-windows-x64-setup.exe`, **322,016,429 bytes**, unsigned.
SHA-256 `a9ab53e7b4aa64d35939b131e538958c2aff48595ab4cacab176e0830b3d5b1e`, independently recomputed
with Get-FileHash and matching its generated checksum. Build timestamp
`2026-10-15T23:07:23.774Z` (2026-10-16 02:07:23 Africa/Cairo).
Packaged tests used that stage's fresh `win-unpacked/Nexar.exe`. No NSIS installation or
installed-copy smoke was performed; no signed/public release readiness is claimed.

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

Install/build the matching source and CLI (including `dist/bridge-relay.cjs`) in an owner-controlled
Linux checkout without exposing Windows drives. Configure Desktop's existing `codePlane.command`
to that matching executable. Supply these variables to Full Local CI:

```text
NEXAR_SEC02_WSL_DISTRO=nexar-plane
NEXAR_SEC02_WSL_COMMAND=/absolute/path/to/matching/nexar
NEXAR_SEC02_WSL_REPO=/absolute/path/to/matching/source
```

Invoke `scripts/local-ci/runner.mjs --mode=full --workers=2` with pinned Node 22 and the existing
Gitleaks binary option. The new required `cowork-isolation-wsl` stage rejects missing configuration
and skipped real assertions. It runs isolated canonical-context tests, creates its own synthetic
Windows fixture, then invokes the Linux kernel/Coding gate. Source and packaged E2E opt into the
actual WSL backend while retaining historical hermetic host-local fixture cases.

The direct syscall and additional Coding fixture/drivers are retained in this worktree's ignored
`.nexar/`; their sanitized results are captured in the machine evidence. Actual user data and
credentials were not used. Selected Windows 11 Pro 25H2/build 26200, permanent WSL2 support,
independent security review and owner acceptance remain separate gates.
