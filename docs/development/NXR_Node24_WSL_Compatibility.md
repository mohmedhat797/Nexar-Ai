# Node 24 WSL compatibility

Environment: `nexar-plane`, WSL2, x86_64, non-root runtime user `nexar`. Baseline Node 22.23.3 and pnpm 10.33.0 are independently installed from Windows. Windows drives are not mounted into this distro; this policy was preserved.

The official hash-verified Node 24.22.2 Linux archive was transferred over stdio into a new private root-owned staging directory and verified again in Linux before extraction. The separate `/opt/node-v24.22.2-linux-x64` tree is root-owned 0755; npm reports 11.19.1. Old `/opt/node` and `/usr/local/bin/node` remain unchanged and report 22.23.3. Archive/binary hashes are in [toolchain implementation](NXR_Node24_Toolchain_Implementation.md).

## Acceptance versus deployment

The installed launcher still points at source `3153459396e220a63633f8b4c82eb2b866200377` and `/opt/dsh` still reports **0.2.0-rc.2**. **G-13 is not resolved.** Updating Node does not deploy current Nexar or DSH rc.5. No installed Plane source, launcher, data or native account home was overwritten.

Current-source validation uses an isolated Linux candidate/helper and rc.5 runtime, with explicit acceptance environment inputs. Acceptance scripts now derive a versioned Linux Node path from `.nvmrc` and accept a validated `NEXAR_SEC02_LINUX_NODE_BIN` override. They never silently use the old `/opt/node/bin/node`. Existing helper/protocol/DSH version checks are unchanged.

Required validation: exact Node/pnpm, native dependency/build compatibility, ACP and SDK where used, current helper handshake, bubblewrap/engineering/Cowork isolation, credentials, containment, process cancellation, cleanup, sessions and memory. Final commands/source IDs/outcomes are recorded in [final acceptance](NXR_Node24_Electron44_Final_Acceptance.md).

G-14 remains a historical unexplained intermittent timeout. Relevant WSL Full execution must capture stall/timer evidence and preserve any recurrence; neither an increased timeout nor a later passing run alone closes it. WSL Full is not native Ubuntu Full. Rollback keeps old runtimes and the installed Plane unchanged; no privileged system Node replacement or host fallback is permitted.
