# Node 24 migration assessment — NXR-T3-SEC01+

Date: 2026-11-01. Owner-authorized implementation, based on accepted main `6bc038021b66b8d093bad5a4fbd936794f048da3`. D′ and research PR 49 are separate and unchanged.

## Version decision

Freeze development/acceptance Node **24.22.2**, pnpm **10.33.0**, Electron **44.10.1** and DSH **0.2.1-rc.5**. Electron's embedded Node is independently expected to be **24.22.1**; it is not replaced with the development executable.

The [official Node index](https://nodejs.org/dist/index.json) listed 24.22.2 as the newest 24 LTS patch at selection. [24.22.1](https://nodejs.org/en/blog/release/v24.22.1) is the preceding security release; [24.22.2](https://nodejs.org/en/blog/release/v24.22.2) adds maintenance fixes. The index and blog differ by one calendar day for publication; selection uses the exact version and verified artifacts, not an assumed date. [Node 26.13.0](https://nodejs.org/en/blog/release/v26.13.0) is a separate LTS major with additional Linux prerequisites; no migration to it is authorized or needed here.

`.nvmrc` is the single development pin. The package engine range is `>=24.22.2 <25`, describing the supported major and minimum patched release; CI acceptance requires the exact `.nvmrc` patch. Package manager and Electron authorities remain their existing manifests. DSH retains its independent manifest/lock.

## Runtime identity matrix

| Purpose                    | Baseline executable / version                                    | Selected execution / authority                                         | Migration and proof                                                |
| -------------------------- | ---------------------------------------------------------------- | ---------------------------------------------------------------------- | ------------------------------------------------------------------ |
| Windows shell              | Program Files Node, 24.15.0                                      | Preserved, outside project acceptance                                  | No global PATH or installation change                              |
| Windows project/CI         | `D:\Nexar-Toolchains\node-v22.23.3-win-x64\node.exe`             | Versioned `node-v24.22.2-win-x64\node.exe`; `.nvmrc`                   | Both execute independently; new archive/executable hashes verified |
| Electron                   | 44.5.1 / embedded Node 24.21.0                                   | 44.10.1 / expected 24.22.1; Desktop package and actual-process test    | Source/packaged verification recorded in final acceptance          |
| Hosted Windows/Ubuntu      | setup-node previously read major 22                              | setup-node reads exact `.nvmrc`; explicit executable/pnpm verification | Hosted results must be independently observed                      |
| WSL development/acceptance | `/usr/local/bin/node`, 22.23.3                                   | `/opt/node-v24.22.2-linux-x64/bin/node`; exact project pin             | Official artifact, separate install; existing default preserved    |
| Installed WSL Plane        | Launcher uses `/usr/local/bin/node`; source `3153459…`; DSH rc.2 | Unchanged                                                              | G-13 remains open; new Node does not update Plane                  |
| Managed Windows DSH        | rc.5 pin                                                         | Same package/lock, installed with new toolchain                        | Version verified; ACP/SDK execution requires acceptance suites     |
| Managed Linux DSH          | Installed `/opt/dsh` is rc.2                                     | Isolated rc.5 candidate for current-source acceptance                  | Do not rewrite `/opt/dsh` or native account homes                  |
| Desktop packaging          | Previous accepted Node 22 build toolchain                        | Node 24.22.2 drives unchanged Builder 26.15.3                          | NSIS/packaged execution distinct from clean-machine installation   |
| Native Codex/Claude        | Relevant installed commands are native `.exe` files              | Unchanged; no login or inference performed                             | Their installation/auth/runtime lifecycle is not migrated          |

pnpm 10.33.0's published engine supports Node 24; actual version, frozen workspace installation, targeted tests, typecheck, lint and build passed. Type definitions were aligned to exact `@types/node` 24.19.2. Lock changes are Electron, Node types, their type dependencies/peer resolutions; no framework upgrade. No application compatibility fix was needed by those gates.

Native/platform components are exercised through their actual consumers: esbuild and Vite build, Electron launch, existing DSH real-runtime tests and packaging. A new ABI does not justify rebuilding every package. The existing install-script allowlist remains unchanged.

## Security and remaining gates

Preserve NRC, ConnectionManager, Review Diversity, Permission Broker, FileSessionStore, ProjectMemoryStore and WSL/bubblewrap. No account schema, native home, credential store, session schema or provider runtime pin is changed. No paid calls or live accounts are used.

The previous Node 22 install and old Electron/source baseline remain recovery evidence, not approved long-term security targets. Global Node 24.15.0 and installed Plane Node 22 remain separate residual environments. Full Windows, WSL, packaged Desktop, rollback and hosted outcomes are tracked in [final acceptance](NXR_Node24_Electron44_Final_Acceptance.md); do not infer them from the targeted gates above.
