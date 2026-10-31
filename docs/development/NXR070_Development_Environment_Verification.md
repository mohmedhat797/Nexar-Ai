# NXR-070 development environment verification

**Result: the canonical workspace and toolchain are healthy and support full acceptance runs.** Measured on 31 October 2026 on the owner's machine. Local details stay in the ignored evidence directory.

## Toolchain

| Check                    | Result                                                                                       |
| ------------------------ | -------------------------------------------------------------------------------------------- |
| Node.js 22.23.3          | Runs from `D:\Nexar-Toolchains`; hash matches the migration receipt                          |
| npm 10.9.9               | Runs from the same Node.js install                                                           |
| pnpm 10.33.0             | Resolves from the user's local bin directory, not `D:\Nexar-Toolchains`                      |
| Gitleaks 8.28.0          | Runs from `D:\Nexar-Toolchains`; hash matches the receipt                                    |
| Electron 44.5.1          | Ran through 66 E2E tests, source and packaged                                                |
| CI executable resolution | The runner verified Node.js, pnpm and Gitleaks by explicit path                              |
| Windows PATH             | The session sets the toolchain first. See the stale user entry below                         |
| WSL independence         | `nexar-plane` uses its own Node.js in `/opt/node`, bubblewrap 0.9.0; no `/mnt` entry on PATH |
| Junctions and symlinks   | None at the top of the repository or toolchain folder                                        |

## Legacy directory

`D:\Nexar-Ai-nxr070` does not exist and was not recreated. No running process and no PATH entry refers to it.

In tracked files it appears only in the retirement list of the two cleanup scripts, in historical reports, and in historical evidence summaries. None is an active dependency, and Full passed without it.

## Items found

- The user PATH still holds `...\AppData\Local\Nexar\Runtimes\openworker-0.3.0\Scripts`, and the folder exists. It predates the DSH runtime and nothing in acceptance used it. It is left in place because it belongs to the owner's environment.
- An older Gitleaks copy remains at `.nexar/gitleaks-8.28.0`. It is unused, and no deletion was made.

## Repository and worktrees

Thirteen worktrees are registered. All their HEADs are merged into `main` and present on the remote. Uncommitted changes remain in `nxr066-runtime-validation` (16 files), `nxr070r` (2) and `nxr070b-audit` (1). Local branch `wip/v06` holds 36 unpublished commits. All were left untouched. Removing any of these needs a separate audit.

This work added one worktree, at `.nexar/worktrees/nxr070-post-merge-baseline`, following the workspace rules.

## Storage

| Measure    | After cleanup | Now       |
| ---------- | ------------- | --------- |
| `D:` total | —             | 192.1 GiB |
| `D:` free  | 39.82 GiB     | 36.2 GiB  |
| `C:` free  | 22.18 GiB     | 18.5 GiB  |

The cleanup's recorded 23.24 GiB recovery stands: `D:` free has fallen by 3.6 GiB since then, not by anything near that amount.

| Location                                 | Size      |
| ---------------------------------------- | --------- |
| `.nexar` total                           | 16.52 GiB |
| `.nexar/dsh-021-rc3-upgrade` worktree    | 4.17 GiB  |
| `.nexar/nxr070c` worktree                | 3.51 GiB  |
| `.nexar/nxr070b` worktree                | 2.01 GiB  |
| `.nexar/fcr01-audit` worktree            | 1.69 GiB  |
| `.nexar/sec02` worktree                  | 1.67 GiB  |
| `.nexar/nxr066-runtime-validation`       | 1.10 GiB  |
| `.claude/worktrees` (two)                | 2.94 GiB  |
| `release` (current build output)         | 1.45 GiB  |
| `node_modules`                           | 0.89 GiB  |
| `.nexar/dsh-runtime`                     | 0.47 GiB  |
| `.nexar/dsh-runtime.previous-*`          | 0.47 GiB  |
| `.nexar/retained-release-before-c97136b` | 0.19 GiB  |
| `.nexar/ci`                              | 0.21 GiB  |
| `D:\Nexar-Toolchains`                    | 0.15 GiB  |

The growth is mostly this run's new `release` output, the previous runtime generation and evidence. No substantial unexplained growth was found, and no cleanup was run. Three of the largest worktrees belong to merged PRs and can be retired after the audit the workspace rules require.

An earlier release folder, built on 9 October, was moved aside into the retained folder before this run so its installer stayed intact. Nothing was deleted.

**Capacity.** A Full run used a net 2.7 GiB on `D:`. Peak use during packaging was not measured. `D:` has room for normal builds. `C:` holds the temp directory and is lower, at 18.5 GiB. The WSL disk has 945 GiB free.
