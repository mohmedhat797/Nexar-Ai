# NXR-070D′ installed Plane compatibility and upgrade

**Status: the installed Plane on this machine runs `616042f` and DSH `0.2.1-rc.5`, and passes verification. G-13 is closed for this machine once the owner accepts that an unmerged commit is what is installed.** Procedure: [Upgrading an installed Plane](../guides/plane-upgrade.md).

## Before and after

|             | Before                                    | Now                                                              |
| ----------- | ----------------------------------------- | ---------------------------------------------------------------- |
| Launcher    | Starts an older build in `~/src/Nexar-Ai` | Starts `~/src/releases/616042f706b7058042226f37b9659ee2ef40a773` |
| DSH runtime | `0.2.0-rc.2`                              | `0.2.1-rc.5`, a real directory at `/opt/dsh`                     |
| Cowork      | Refused with `unsupported-version`        | Answers `nexar-cowork@1` with Bubblewrap isolation               |

`~/src/Nexar-Ai` was not touched, and it is what a rollback returns to.

## What was run

On `616042f`, in order: send, prepare, rollback, status, activate, status, selftest. Rollback returned to the original launcher and rc.2, then activation moved forward again.

All 9 checks passed against the launcher itself:

- the launcher starts this release
- the launcher keeps its Plane config
- the runtime is a real directory
- the runtime is `0.2.1-rc.5`
- the Bubblewrap selftest passes
- the Plane loads its config and answers `nexar-plane/1`
- Cowork answers `nexar-cowork@1`
- Cowork runs the pinned runtime
- Cowork reports the Bubblewrap isolation

The Bubblewrap selftest confirmed a writable workspace, read-only root, read-only `.git`, invisible host files, loopback only and a proxy that denies a non-allowlisted `CONNECT`.

Windows Full stage 13 then ran real isolated Cowork through `/usr/local/bin/nexar`, so that acceptance used the installed Plane and not a candidate helper.

## What is preserved, and how that is known

Before switching, the script records the path, type, mode and owner of everything under `~/.nexar`, `~/.codex`, `~/.claude` and `~/validation`, into root-only storage. It compares them afterward and fails the upgrade on a lost entry or a changed mode or owner. It never opens those files. `/etc/wsl.conf` is not written.

This proves that names, modes and owners survived. It does not prove file contents are unchanged, and it does not prove that a signed-in provider still works: verification starts no vendor CLI and makes no paid call.

## Faults found by rehearsing on the real Plane

| Fault                                                                                          | Found by                     | Fix       |
| ---------------------------------------------------------------------------------------------- | ---------------------------- | --------- |
| `runuser` is outside the PATH the script set                                                   | First rehearsal              | `01c79c2` |
| The Plane ignores SIGTERM, so verification never ended                                         | First rehearsal              | `01c79c2` |
| A rollback after real use could report failure for files removed on purpose                    | First rehearsal              | `01c79c2` |
| A symlinked `/opt/dsh` hid the command from the sandbox: the toolchain path resolved elsewhere | Only the installed Plane run | `79be762` |

The automatic restore worked each time an activation failed. The last fault is the reason a candidate helper cannot stand in for the installed Plane: isolated checkouts did not show it.

## Limits

- **Rollback doesn't undo data changes.** It restores the launcher and runtime. Anything a newer build wrote into owner state stays there.
- **The build is from an unmerged branch.** After merge, upgrade to the merged commit with the same procedure.
- **A read-only audit ran `nexar doctor` on the Plane.** This happened before the upgrade, even though the owner had declined `claude` shell checks. It made no paid call. `verify.mjs` deliberately avoids it.
