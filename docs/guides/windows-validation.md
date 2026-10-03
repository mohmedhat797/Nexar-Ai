# Windows validation (NXR-051)

This checklist separates automated evidence from owner acceptance. The native write-capable
engineering plane remains Linux/WSL2 (ADR-018); Windows Desktop opens no network listener.

## Automated checks

Use the repository-pinned pnpm rather than an unrelated global version:

```powershell
npx --yes pnpm@10.33.0 install --frozen-lockfile
npx --yes pnpm@10.33.0 check
npx --yes pnpm@10.33.0 desktop:e2e
node apps/cli/dist/main.js doctor
node apps/cli/dist/main.js resources --discovered
npx --yes pnpm@10.33.0 desktop:package:win
$env:NEXAR_DESKTOP_EXECUTABLE = (Resolve-Path release/desktop/win-unpacked/Nexar.exe).Path
npx --yes pnpm@10.33.0 desktop:e2e
Remove-Item Env:NEXAR_DESKTOP_EXECUTABLE
```

Doctor probes versions and local sign-in state only; no model calls. Never copy vendor login files.
The offline Electron E2E uses a throwaway state directory and the echo resource; it opens a project,
reads a file, stores a draft, changes theme and relaunches to prove persistence.

Packaging builds the application, deploys its production dependency graph, and writes
`release/desktop/Nexar-0.1.0-windows-x64-setup.exe` plus a SHA256 sidecar. The packaged E2E
uses that build's executable, a project with spaces, and shipped catalogs without repository-path
overrides. Windows CI repeats both E2E variants and uploads the installer and checksum.
The NSIS installer is one-click, per-user, does not request elevation, and does not launch the
app automatically. Uninstall is configured to preserve application state. No update publishing
or signing credentials are used. The unsigned installer may trigger SmartScreen; owner-machine
installation and the exact prompt behavior remain manual acceptance.

Desktop secures its dedicated Windows state tree before reading configuration: protected ACLs allow
the current user, SYSTEM and local Administrators. It rejects reparse paths, hard-linked files,
foreign-owned entries and unrelated nonempty directories, and never changes AppData or Temp parent ACLs. Existing state
is recognized by its Nexar config or Desktop marker. Overrides must name a dedicated local state
directory; UNC and redirected roots are refused. External config state-directory overrides require
their own audit. Trees over 10,000 entries fail closed. Chromium's runtime data (disk caches,
storage, crash dumps) lives outside that tree in `%LOCALAPPDATA%\Nexar\Runtime`, so the per-entry
guard stays small and fast. Trusted SYSTEM/Admin-owned entries are
normalized only with rights the caller already has; the final owner is the current user. These
startup checks do not provide handle-based protection against concurrent path replacement. A
startup failure while securing state requires fixing ownership or the path first.

The CI matrix keeps the Linux security suites. Windows skips Linux-plane bubblewrap launcher,
Unix socket, Linux mount-host and shell-based harvest/engineering fixtures, POSIX process-group
semantics, and POSIX file modes. Pure policy and pre-launch guard tests remain active. Windows
directory containment tests use junctions. Individual file-symlink fixtures report a capability skip
on `EPERM` when Developer Mode or symlink privilege is missing; they remain enabled on capable hosts.

## Owner acceptance (pending)

- [ ] Verify the installer SHA256 and install using a standard user account, without elevation.
- [ ] Launch the installed app; confirm state is under `%APPDATA%\Nexar`.
- [ ] Inspect `Get-Acl -LiteralPath "$env:APPDATA\Nexar"`: other ordinary accounts must not have access.
      Audit explicit permissions and overrides separately; chmod numbers are not Windows ACL evidence.
- [ ] Open a project whose folder name contains spaces; preview a text file.
- [ ] Run an offline echo Cowork task, open its Markdown draft and reveal it in Explorer.
- [ ] Change theme, close the app, reopen; confirm project and theme persisted.
- [ ] Sign in to Claude Code using its own supported login. Select it explicitly in Desktop and run
      one small read-only Cowork task; this consumes subscription allowance.
- [ ] Confirm the route explanation identifies the real resource and the result is stored as a draft.
- [ ] Cancel a small native task and confirm the conversation remains usable.
- [ ] Confirm Code mode does not offer an unsandboxed Windows write path; complete WSL A1–A6 later.
- [ ] Uninstall/reinstall the app; verify state retention and no elevation request.

Installer execution and unsigned-installer/SmartScreen behavior still need owner evidence.
These boxes are intentionally unchecked; CI and fake runtimes do not establish owner acceptance.
