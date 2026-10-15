# NXR-SEC-02 — Windows and WSL acceptance

Date: 2026-10-16. Validation is in progress; this document is updated with final raw report identities
before handover. No incomplete gate is a PASS.

## Baseline and environment

- Starting consolidated baseline: `fcr02/opus-integration`, `8e35e46c192e11022185e6d12117b610f107351e`.
- Implementation: `feat/nxr-sec02-isolated-cowork`, dedicated worktree `.nexar/sec02`.
- Previous fully tested implementation: `e2a82aeba3236b9e099100535c4ba1f9f87b3dda`; its counts and
  installer are historical and do not verify the new placement.
- Actual Windows: x64 build 26300; Node 22.23.3, pnpm 10.33.0.
- WSL: `nexar-plane`, non-root `nexar`, Node 22.23.3, kernel 6.18.33.2, bubblewrap and socat.
- Pinned Linux DSH: `/opt/dsh/lib/node_modules/@deepseek-ai/dsh/lib/bin.js`, version `0.2.0-rc.2`.
- No WSL configuration, Windows optional feature, process identity or security policy changed.
- Disposable Linux source clones were created under `/var/tmp/nexar-sec02-20261015-*/repo` using a
  Git bundle plus the staged binary patch. Existing installed `/usr/local/bin/nexar` was preserved.

## Evidence obtained during development

| Run                                                                         | Result               | Raw evidence                                                            |
| --------------------------------------------------------------------------- | -------------------- | ----------------------------------------------------------------------- |
| Initial focused Linux boundary + real DSH + file/transport checks           | 23/23 PASS           | `/var/tmp/nexar-sec02-20261015-d6d05ab4/repo/.nexar/sec02-focused.json` |
| Initial Windows actual WSL draft/read-only                                  | 2/2 PASS             | `.nexar/sec02-windows-wsl.json`                                         |
| Expanded Windows service/input/executor/actual WSL cancellation/concurrency | 44/44 PASS           | `.nexar/sec02-windows-focused.json`                                     |
| Full quick gates                                                            | Pending final report | `.nexar/ci/reports/`                                                    |
| Mandatory isolated WSL/context/kernel/Coding gate                           | Pending              | `.nexar/ci/cowork-wsl.json`, Linux `.nexar/ci/cowork-kernel.json`       |
| Source Desktop E2E                                                          | Pending              | CI stage log                                                            |
| Fresh Windows package and packaged E2E                                      | Pending              | CI report and package manifest                                          |

The later temporary Linux clone `d3afec4e` recorded a failed test-fixture mount declaration
(`source/target` instead of `hostPath/sandboxPath`). Typecheck caught it and the fixture was
corrected. Its 22/23 result is retained as failed evidence, not reported as acceptance.

## Reproduction

Install the matching source and dependencies in an owner-controlled Linux checkout without exposing
Windows drives; build the CLI, including `dist/bridge-relay.cjs`. Point the Desktop's existing
`codePlane.command` at that CLI. Supply these variables to the Windows Full Local CI runner:

```text
NEXAR_SEC02_WSL_DISTRO=nexar-plane
NEXAR_SEC02_WSL_COMMAND=/absolute/path/to/matching/nexar
NEXAR_SEC02_WSL_REPO=/absolute/path/to/matching/source
```

Use the pinned Node 22 binary to invoke `scripts/local-ci/runner.mjs --mode=full --workers=2` and
the existing Gitleaks binary option. The runner prepends the verified Node directory for children.
Its new required `cowork-isolation-wsl` stage rejects missing configuration and any skipped real
assertion. The Windows driver runs isolated canonical-context tests, creates a synthetic Windows
host fixture, and invokes the Linux kernel/Coding gate in the matching checkout. Source and packaged
E2E opt into the actual WSL backend while retaining historical offline host-local regression cases.

Selected Windows 11 Pro 25H2/build 26200 acceptance and independent review remain separate owner gates.
