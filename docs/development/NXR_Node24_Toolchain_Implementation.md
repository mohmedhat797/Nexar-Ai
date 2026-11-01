# Node 24 toolchain implementation

Status: implementation and staged acceptance. [Final outcomes](NXR_Node24_Electron44_Final_Acceptance.md).

## Authorities and resolution

- Development Node: `.nvmrc` = `24.22.2`; `package.json` engine `>=24.22.2 <25`.
- Package manager: existing `packageManager: pnpm@10.33.0`; no upgrade.
- Desktop: accepted Electron 44.5.1 retained consistently across package/lock, Builder config and packaging guard. The 44.10.1 security candidate is blocked by a reproduced loader incompatibility, not shipped.
- Managed DSH: unchanged `dsh-runtime.json` and runtime lock at rc.5.

Local CI reads a strict full version from `.nvmrc`. Explicit `--node-bin` or `NEXAR_NODE_BIN` overrides are probed with a deadline and fail closed without fallback. Otherwise the exact running executable or version-derived stable candidates are selected. The orchestrator re-executes on the verified selected runtime when necessary, and stage PATH begins with that runtime. Report eligibility checks the exact version, never a major prefix. Full acceptance cannot waive mismatch. `scripts/verify-toolchain.mjs` verifies actual Node and pnpm in hosted/self-hosted jobs.

Successful executable probes are canonicalized before relaunch decisions. A junction/symlink alias cannot cause the orchestrator to relaunch itself indefinitely; a real linked-directory regression tests this path. Invalid explicit overrides still fail closed. Local-CI focused tests now total 37 passed, plus 13 Linux acceptance-input tests.

## Verified artifacts

Source: [official distribution](https://nodejs.org/dist/v24.22.2/) and its `SHASUMS256.txt` over HTTPS. SHA-256 comparison was performed before extraction. No remote installer script or machine-wide PATH update ran. Signature verification is not claimed.

| Artifact             | SHA-256                                                            |
| -------------------- | ------------------------------------------------------------------ |
| Windows x64 ZIP      | `ca1bff5d8ead13c9f2ea404a176db46bd430704d5b5113734049fa365e7799e2` |
| Windows node.exe     | `1c331340fa6cac5e4294725959070a143fa0507195a78ad77eed7943f719aac9` |
| Linux x64 tar.xz     | `48cc0e21e048790e54c0cf5749c2725005313d652651c40b7a21feb9697aaf75` |
| Extracted Linux node | `904a6d3484241d466989f9df9ba3aab822b1496191bdb28230eb491a55c32a52` |

Windows install: `D:\Nexar-Toolchains\node-v24.22.2-win-x64`. Linux install: `/opt/node-v24.22.2-linux-x64`, root-owned 0755. Both report Node 24.22.2, x64, and bundled npm 11.19.1. Windows `process.versions.modules` is 137. Previous Node 22.23.3 still executes on both platforms; neither directory was overwritten.

## Running without global changes

```powershell
$env:PATH = 'D:\Nexar-Toolchains\node-v24.22.2-win-x64;' + $env:PATH
node scripts/verify-toolchain.mjs
pnpm install --frozen-lockfile
pnpm ci:local:full
```

On Linux select the versioned `bin` directory in the invocation's PATH. Do not replace `/usr/local/bin/node` or `/opt/node`. Native provider installations are unaffected. The project continues to use pnpm 10.33.0; upstream DSH's source-development package manager is unrelated.

`@types/node` 24.19.2 also deduplicates Electron's compatible Node types. Typecheck/lint caught issues in new test code, which were corrected with explicit fixture typing; no production API workaround or weakened compiler rule was introduced. The root lock retains all unrelated package versions.

## Workspace and rollback

The managed worktree API created this checkout under `%USERPROFILE%\.codex\worktrees\nxr-node24-electron44\Nexar-Ai-main`, sharing the canonical repository's Git objects. The API cannot choose the requested D: destination. Ignored state and a private virtual store under `D:\Nexar-Ai-main\.nexar\node24-migration` keep dependencies/runtime logs on D:. Sealing uses the canonical runtime directory, because the existing guard correctly rejects a junction alias. Packaging output must have plain ancestors: the unused owned release junction was unlinked without deleting its D: target, and `release/` is a plain worktree directory. No security guard was relaxed. State/dependencies are independent of D′ and main's node_modules. No full repository clone or shared dependency-tree replacement occurred.

Rollback selects the previous exact source/lock and old Node executable in a disposable environment. Reverting configuration does not remove connections, native homes, canonical sessions or confirmed memory. No real Desktop downgrade or Plane deployment is part of this work. Actual rollback evidence is required in the final acceptance report.

Observed rollback proof: old Node 22.23.3 ran accepted main's CLI help with exit 0. A synthetic canonical session and owner-confirmed memory record created by that baseline were read by the Node 24 candidate and read again by Node 22 with identical file SHA-256 values. This fixture does not inspect real owner records and does not claim an installed-application downgrade test.

## Build-only artifact I/O correction

Repeated Windows Full invocations exceeded the existing packaging deadline. The final code reuses one synchronous hash scratch buffer and adds bounded four-worker copy/hash APIs used by `apps/desktop/scripts/package-win.mjs`. It retains the synchronous API, complete copied-byte digest, exclusive staged writes, path/link/identity/lock guards, settlement before error return, atomic publication and independent post-package actual/reference hashing. No DSH version/manifest/lock/override, package timeout, runtime launch, executable distribution, signing policy or application authority changes accompany it. The 27 artifact regressions, full-size byte/digest diagnostic and both platform results are detailed in [acceptance](NXR_Node24_Electron44_Final_Acceptance.md). It reduced observed promotion cost but did not resolve the Windows builder deadline; no Full PASS is inferred.
