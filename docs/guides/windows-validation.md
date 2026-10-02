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
```

Doctor probes versions and local sign-in state only; no model calls. Never copy vendor login files.
The offline Electron E2E uses a throwaway state directory and the echo resource; it opens a project,
reads a file, stores a draft, changes theme and relaunches to prove persistence.

The CI matrix keeps the Linux security suites. Windows skips Linux-plane bubblewrap launcher,
Unix socket, Linux mount-host and shell-based harvest/engineering fixtures, POSIX process-group
semantics, and POSIX file modes. Pure policy and pre-launch guard tests remain active. Windows
directory containment tests use junctions. Individual file-symlink fixtures report a capability skip
on `EPERM` when Developer Mode or symlink privilege is missing; they remain enabled on capable hosts.

## Owner acceptance (pending)

- [ ] Build/install the forthcoming x64 NSIS installer using a standard user account, without elevation.
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
- [ ] Uninstall/reinstall the app and document state retention behavior after packaging is delivered.

Installer and unsigned-installer/SmartScreen behavior still need implementation and real evidence.
These boxes are intentionally unchecked; CI and fake runtimes do not establish owner acceptance.
