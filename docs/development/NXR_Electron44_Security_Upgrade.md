# Electron 44 security upgrade

Selected exact maintenance release: **44.10.1**, replacing 44.5.1. Published [Electron release metadata](https://releases.electronjs.org/releases.json) identifies embedded Node **24.22.1**, Chromium **152.0.7977.169**, V8 **15.2.124.45** and modules ABI **149**. Actual source and packaged process evidence belongs in [final acceptance](NXR_Node24_Electron44_Final_Acceptance.md), not inferences from development Node.

The lock pins Electron's package integrity to `sha512-CTqxvx02P+xCR/xUxAWBexQEJ42g9Rzy1/0N+ofGAtI/atgSYZKQnTX9/juwzftocWbZtoF2ftEGMGJujJDeBw==`. Node type/peer updates are documented separately. Electron Builder 26.15.3, pnpm and the DSH lock remain unchanged.

## Exposure and correction

The [October Node advisory](https://nodejs.org/en/blog/vulnerability/october-2026-security-releases) covers Brotli memory corruption, DNS input validation, TLS/IP normalization and permission-model issues. Nexar's provider HTTP/Fetch/SDK consumers make the patched runtime relevant; absence of a direct Brotli call does not exclude transitive decompression. No malicious payload was executed and reachable exploitation is not established. Node 24.22.2 includes the preceding security corrections.

[Electron 44.10.0 release notes](https://releases.electronjs.org/release/v44.10.0) document the embedded Node update and filesystem/archive/process corrections inherited by the selected maintenance line. Nexar's OS sandbox, path containment and strict renderer boundary remain independent protections; no claim that every vulnerability is eliminated is made.

## Preserved boundaries and tests

No production window/preload/IPC/CSP/navigation/permission setting was weakened. The added E2E test reads `process.versions` in Playwright's trusted main-process context, records PID/launcher linkage and validates the actual Electron/Node/Chromium/V8 identities for source and packaged executions. It adds no renderer-facing diagnostics API.

Existing connection, session, memory, DSH, cancellation, process ownership, private-state and safe-shutdown suites remain mandatory. Source build, NSIS creation, win-unpacked execution and clean-machine installation are separate claims. Owner-installed Desktop is not replaced. Retained vulnerable binaries are rollback evidence only; public release/signing and installed Plane exposure remain separate gates.
