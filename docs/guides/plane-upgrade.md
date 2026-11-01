# Upgrading an installed Plane

The installed Plane is three things: the root-owned launcher `/usr/local/bin/nexar`, the Nexar build
it starts, and the root-owned DSH runtime at `/opt/dsh`. A test against an isolated checkout or a
candidate helper proves nothing about any of them; only `verify.mjs` against the launcher does.

`scripts/plane-upgrade/plane-upgrade.sh` upgrades them side by side:

- The new build goes to `~/src/releases/<commit>`. The old checkout is never touched, so it stays
  available to a rollback.
- The new runtime goes to `/opt/dsh-releases/<version>`, root-owned, and `/opt/dsh` becomes a symlink
  to it. The first upgrade moves the old directory whole into `/opt/dsh-releases`.
- The launcher is replaced atomically and keeps its `NEXAR_CONFIG_PATH` default.
- Config, credentials, sessions, Project Memory and `/etc/wsl.conf` are not written. Before the switch
  the script records the path, type, mode and owner of everything under `~/.nexar`, `~/.codex`,
  `~/.claude` and `~/validation` into the root-only `/var/lib/nexar-plane`. It never opens those files.
  An entry that disappears or changes mode or owner fails the upgrade.
- If verification fails, the previous launcher and runtime are restored and the upgrade reports failure.

## Steps

Close Nexar first. Activation and rollback refuse while `plane`, `cowork` or `mcp` serve processes run.

From a checkout of the commit on Windows, send a bundle and the script over stdin, because the
hardened distribution has no `/mnt`:

```bash
git bundle create plane.bundle HEAD
```

```bash
wsl -d nexar-plane --exec sh -c 'mkdir -p ~/bundles && cat > ~/bundles/plane.bundle' < plane.bundle
```

```bash
git show HEAD:scripts/plane-upgrade/plane-upgrade.sh | wsl -d nexar-plane --exec sh -c 'cat > ~/plane-upgrade.sh'
```

Build the release as the Plane user. This needs the network for the package registry:

```bash
wsl -d nexar-plane --exec sh /home/nexar/plane-upgrade.sh prepare /home/nexar/bundles/plane.bundle <commit>
```

Switch as root:

```bash
wsl -d nexar-plane -u root --exec sh /home/nexar/plane-upgrade.sh activate <commit>
```

To return to the previous installation:

```bash
wsl -d nexar-plane -u root --exec sh /home/nexar/plane-upgrade.sh rollback
```

`status` prints the active build and runtime for anyone.

## What verification proves

`verify.mjs` runs as the Plane user against the launcher and checks: the launcher starts this release
and keeps its config default; `dsh --version` is the pinned version; `nexar sandbox selftest` passes;
`plane serve --stdio` loads the existing config and answers `initialize`; `cowork serve --stdio`
answers `cowork/hello` with the pinned version and Bubblewrap isolation.

It starts no vendor CLI and makes no paid call, so it does not prove that a signed-in provider still
works. It deliberately avoids `nexar doctor`, which runs the provider CLIs' probes.

## What it does not undo

A rollback restores the launcher and runtime. `/opt/dsh` stays a symlink, to the old runtime, rather
than going back to a plain directory. Anything a newer build wrote into owner state stays there, so
roll back before using the new release for real work if the state formats differ.
