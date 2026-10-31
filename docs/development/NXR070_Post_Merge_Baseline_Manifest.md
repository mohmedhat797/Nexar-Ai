# NXR-070 post-merge baseline manifest

This record describes the source tested on 31 October 2026. It certifies this exact commit and tree only. Later commits need their own acceptance.

## Source

| Field              | Value                                                                    |
| ------------------ | ------------------------------------------------------------------------ |
| Repository         | `mohmedhat797/Nexar-Ai`                                                  |
| Branch             | `main`                                                                   |
| Commit             | `c97136b8377419fc6784b88ec321ec5f9d40818f`                               |
| Tree               | `547bd6ac8290556aeb5252c8f33d43e5ae810fe4`                               |
| Git status         | Clean before and after every acceptance run                              |
| Remote tracking    | Local `main` equals `origin/main`; fast-forward from `41b918b`, no reset |
| Open pull requests | None when the run began                                                  |

| Pull request                            | Merged as | State  |
| --------------------------------------- | --------- | ------ |
| #44 NXR-070B′ multi-API-key connections | `8325ff0` | Merged |
| #45 NXR-070C′ review diversity          | `f98da1d` | Merged |
| #46 DSH `0.2.1-rc.5`                    | `60df7cc` | Merged |
| #47 Workspace maintenance               | `c97136b` | Merged |

## Dependency and runtime identity

| Item                                     | Value                                                              |
| ---------------------------------------- | ------------------------------------------------------------------ |
| `pnpm-lock.yaml` SHA-256 prefix          | `aa709df6`                                                         |
| `dsh-runtime.json` SHA-256 prefix        | `8ba9840d`                                                         |
| Runtime lock SHA-256                     | `17b0419f5728bd62f2a0ce2e67b8bb75332e4486a0422e906967aa426d65fb40` |
| DSH package                              | `@deepseek-ai/dsh@0.2.1-rc.5`                                      |
| Installed `lib/bin.js` SHA-256           | `80112efe368efb1a39720c7ada0af00442e5131fb2744edaaff8a3e8bb499e6f` |
| Sealed runtime tree SHA-256              | `ccbd7a129a4c1b831d33de36bc81b764521b8dd230b77196bed9d9131db9520d` |
| Sealed runtime size                      | 27,826 files, 507,342,499 bytes                                    |
| Override: `zod`                          | 4.6.7                                                              |
| Override: `undici`                       | 8.12.3                                                             |
| Override: `fflate`                       | 0.8.3                                                              |
| Override: `@modelcontextprotocol/client` | 2.3.1                                                              |

Two independent installs on this commit produced the same runtime tree hash, and the packaged tree hash matches it.

## Tools and platform

| Item         | Value                                                                            |
| ------------ | -------------------------------------------------------------------------------- |
| Node.js      | 22.23.3, `node.exe` SHA-256 prefix `9c924516`, matches the migration receipt     |
| npm          | 10.9.9                                                                           |
| pnpm         | 10.33.0                                                                          |
| Electron     | 44.5.1                                                                           |
| Gitleaks     | 8.28.0, `gitleaks.exe` SHA-256 prefix `54230c22`, matches the migration receipt  |
| Windows      | 11 Pro, build 10.0.26300                                                         |
| WSL          | 2.7.14.0                                                                         |
| Linux kernel | `6.18.33.2-microsoft-standard-WSL2`                                              |
| Distribution | `nexar-plane`: Node.js 22.23.3 from `/opt/node`, bubblewrap 0.9.0, socat present |

## Packaged output of the accepted Full run

| Item                | Value                                                              |
| ------------------- | ------------------------------------------------------------------ |
| Installer           | `Nexar-0.1.0-windows-x64-setup.exe`                                |
| Size                | 325,785,217 bytes                                                  |
| SHA-256             | `444de65250892d784be4d230679ce526802a97ebe54a159cb8a441aa39bfb895` |
| Bundled DSH         | `0.2.1-rc.5`, tree hash above                                      |
| Authenticode status | Not signed                                                         |

## Evidence

Raw logs, test reports, machine metadata and the machine-readable companion, `baseline-manifest.json`, are in the Git-ignored directory `.nexar/acceptance-evidence/post-merge-20261031-c97136b/`. Its `SHA256SUMS.json` lists every copied file.

| Evidence                  | Identity                                                                      |
| ------------------------- | ----------------------------------------------------------------------------- |
| Windows Full log SHA-256  | `240208b14d57a50fe8ce25f68d089d38a7e439eb82d27371a0211a80360aa034`            |
| First WSL run log SHA-256 | `570249fc953cdff7848bbeac8bc79a8005572b19e30f81cfaa753e13456604f7`            |
| WSL rerun log             | Hash recorded in `post-merge-wsl-full-rerun1-20261031-c97136b.execution.json` |
| Hosted CI                 | Run `41225379130` on `c97136b`: success                                       |
