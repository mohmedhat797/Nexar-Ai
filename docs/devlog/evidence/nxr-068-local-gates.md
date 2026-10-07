# NXR-068 local gate evidence (2026-10-07)

This record covers the dynamic provider inventory implementation on
`feat/nexar-resource-orchestration`, after architecture checkpoint `3c893a7`.
The owner authorized continued development with strengthened local gates while GitHub billing
prevents CI. Full exact-head CI remains required before merge/release; PR #39 stays draft.

## Environment and commands

Windows host, Node 22.23.3, pnpm 10.33.0. Commands used the following launcher to avoid the
developer shell's Node 24 runtime:

```powershell
npx --yes --package=node@22 --package=pnpm@10.33.0 -- pnpm check
npx --yes --package=node@22 --package=pnpm@10.33.0 -- node apps/cli/dist/main.js resources
npx --yes --package=node@22 --package=pnpm@10.33.0 -- node apps/cli/dist/main.js run --kind general 'ci smoke'
npx --yes --package=node@22 --package=pnpm@10.33.0 -- pnpm desktop:e2e
npx --yes --package=node@22 --package=pnpm@10.33.0 -- pnpm desktop:package:win
$env:NEXAR_DESKTOP_EXECUTABLE = 'D:\Nexar-Ai-main\release\desktop\win-unpacked\Nexar.exe'
npx --yes --package=node@22 --package=pnpm@10.33.0 -- pnpm desktop:e2e
Remove-Item Env:NEXAR_DESKTOP_EXECUTABLE
```

## Results

| Gate | Result |
| --- | --- |
| Full `pnpm check` | Passed: formatting, lint, boundaries (910 tracked files), typecheck, 3,960 tests, build |
| Offline CLI smoke | Passed: only `local-echo` listed and selected; execution succeeded |
| Source Desktop E2E | Passed: 22 scenarios across 8 files (183.32s) |
| Windows packaging | Passed: unsigned per-user x64 installer and SHA256 |
| Packaged Desktop E2E | Passed: 22 scenarios across 8 files (184.36s), using packaged Nexar.exe |
| Gitleaks 8.28.0 | Passed: all 221 existing commits and the staged implementation diff; no leaks |
| Exact-head CI | Unavailable: GitHub billing/spending limit; no success inferred |
| Owner live acceptance | Pending owner initiation after CI |

The full suite has 195 passing files and 16 skipped files: 3,960 passed and 158 skipped tests.
Live-provider tests remain disabled; Linux sandbox integration and gateway smoke cannot run on this
Windows host without bubblewrap. The initial full run found one old host assertion expecting
top-level function tools. It now verifies the account route's developer `additional_tools` item;
the complete final check passed after that correction.

The first full source Desktop E2E run passed 21 scenarios and exposed one async navigation race:
AI behavior loaded candidates before inventory refresh finished and never read them again.
Periodic reads now keep control and preferred-resource pickers current, with generation guards,
unmount cleanup and passive-read deferral during owner settings writes or explicit probe refresh.
The account regression, including catalog reappearance in both pickers, passed after this fix.

Gitleaks used the same pinned release as CI. The Windows archive was checked against the official
release SHA256 before execution. Scans used `--redact`, the repository configuration, and no raw
credential output. Temporary scanner files remain under ignored `.nexar/`.

The installer is `release/desktop/Nexar-0.1.0-windows-x64-setup.exe`; its generated SHA256 is
`627e1280b06ea966a857be0a7bb63ad7a4cb0508a7df7b2047f37935a4369c7b`.
Production deployment reported peer-dependency warnings; packaged startup and E2E validate module
loading and offline app behavior, while real native metadata initialization remains owner acceptance.

## Review and provider boundaries

Offline regressions cover account-specific catalogs, returned model slugs outside PI's static
catalog, stable IDs through removal/reappearance, empty results, stale restore/expiry, cancellation,
late connection generations, disconnect/scope-loss races, rejection during refresh, stale execution
guards, strict public IPC/cache schemas, legacy pin migration and function-tool round trips.
Native discovery tests use injected fake runtimes; no real login or paid inference was performed.

Claude SDK 0.3.292 metadata initialization and Google `agy models` listing are explicit owner
refreshes with bounded lifecycle and cleanup. Their listing does not prove authentication.
Native Codex exposes provider default, omitting the model override, until browser-safe explicit
catalog discovery is verified. Claude/Google error text is not guessed to mean model rejection.
Inventory refresh does not replace a resource inside an active control loop.

The [owner runbook](nxr-066-live-acceptance-runbook.md) remains blocked on exact-head CI and starts
with a read-only project review before Cowork, Code and integrated acceptance.
