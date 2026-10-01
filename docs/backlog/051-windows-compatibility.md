# NXR-051: Windows compatibility pass, Windows CI and installer

**Milestone:** v0.5 — Nexar Desktop · **Labels:** desktop, windows · **Depends on:** NXR-050

## Summary

Make the engine and the desktop app run natively on Windows 10/11, prove it in CI, and ship an installer.

## Problem

Everything so far was built and tested on Linux. Windows launches CLIs through `.cmd` shims, has different paths and no POSIX file modes.

## Objective

The desktop app installs and runs on Windows with Claude Code and Codex resources, and a Windows CI job keeps it working.

## Scope

- Audit subprocess launching (shims, quoting, `PATHEXT`), path handling, file modes (0600/0700) and symlink checks for Windows.
- A `windows-latest` CI job for the platform-independent test suites; Linux-only suites (bubblewrap, sandbox) skip with a reason.
- electron-builder NSIS installer for x64; per-user install; no admin rights.

## Out of scope

- Code signing (needs an owner certificate decision).
- Engineering lanes on Windows (they run on the WSL2 plane, NXR-055).

## Technical notes

- File-mode protections map to Windows ACLs where needed (state directories readable only by the owner).
- Never weaken a check to make it pass on Windows; skip only what cannot apply and document it.

## Acceptance criteria

- [ ] The Windows CI job is green.
- [ ] The owner installs the app on their laptop and runs a Cowork task with Claude Code.
- [ ] Known Windows gaps are listed in the security model.

## Testing expectations

CI on `windows-latest`; owner-run checklist on the real laptop.

## Security considerations

Equivalent protections for state files on Windows; no unsandboxed write path is introduced.
