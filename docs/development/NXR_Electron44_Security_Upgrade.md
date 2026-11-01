# Electron 44 security upgrade

Status: **BLOCKED — 44.10.1 is an incompatible, unqualified candidate, not an accepted security upgrade. Final implementation retains accepted 44.5.1 under the owner's fallback rule.** No installed application was replaced.

Candidate exact maintenance release: **44.10.1**, proposed in place of 44.5.1. Published [Electron release metadata](https://releases.electronjs.org/releases.json) identifies embedded Node **24.22.1**, Chromium **152.0.7977.169**, V8 **15.2.124.45** and modules ABI **149**. Actual source and packaged process evidence belongs in [final acceptance](NXR_Node24_Electron44_Final_Acceptance.md), not inferences from development Node.

The failed candidate lock pinned 44.10.1's package integrity to `sha512-CTqxvx02P+xCR/xUxAWBexQEJ42g9Rzy1/0N+ofGAtI/atgSYZKQnTX9/juwzftocWbZtoF2ftEGMGJujJDeBw==`; the final lock retains 44.5.1. Node type/peer updates are documented separately. Electron Builder 26.15.3, pnpm and the DSH lock remain unchanged.

## Reproduced compatibility blocker

On clean candidate `c797e544fa754626f528579703289fe8fe25dec7`, Windows Full passed through real DSH context and Windows-to-WSL isolation acceptance, then failed source Desktop E2E. DSH-backed scenarios reached no synthetic model endpoint and reported `PROVIDER_ERROR`; the mandatory 900-second E2E deadline expired. Packaging and packaged E2E were skipped, not passed.

An isolated direct ACP probe using the actual Electron executable reproduced the underlying failure before any model request: `node-addon-native-custom-loader@0.1.9`, reached through `node-addon-require-builtin@0.1.9` and `@deepseek-ai/dsh-app-boot@0.2.1-rc.5`, rejected `Node 24.22.1, V8 15.2.124.45-electron.0` with `unsupported Electron runtime fingerprint`. Both `process.versions` and `dsh --version` succeed under this executable; neither proves profile boot or ACP compatibility.

The [upstream support matrix at a58d3599a2e551d7d706d1ff796c9fd4bbaff63c](https://github.com/deepseek-ai/dsh-node-addon-require-builtin/blob/a58d3599a2e551d7d706d1ff796c9fd4bbaff63c/docs/support-matrix.md) explicitly describes version-specific Electron support and rejection of other fingerprints. Its supported 44.7.0 fingerprint embeds Node 24.21.0 / V8 15.2.124.28-electron.0, also used by accepted 44.5.1. [44.7.0 metadata](https://releases.electronjs.org/release/v44.7.0) confirms that older Node; it does not deliver the requested October Node fixes. Later 44.7.1/2 and 44.8–44.10 use different V8 fingerprints in official metadata. The installed locked package and actual boot failure are the primary evidence; the current upstream matrix is corroboration, not a claim that its commit is the npm package's unpublished git identity.

No fingerprint spoofing, native-loader bypass, DSH override/lock edit, unverified external Node substitution for packaged execution or security-control relaxation is an approved remedy. The owner's subsequent decision required a focused decoupling investigation before fallback. That [investigation](NXR_DSH_Electron_Runtime_Compatibility_Investigation.md) proved standalone Node execution works and rejection also occurs in Electron main, while secure packaged decoupling needs new distribution/provenance contracts. The final candidate therefore restores accepted 44.5.1 and qualifies Node 24 separately. The [dedicated-runtime proposal](NXR_DSH_Electron_Runtime_Decoupling_Implementation_Proposal.md) is not implemented in this assignment. No older Electron fallback is a long-term security resolution. A future upgrade must pass real profile/ACP initialization before long UI acceptance, in addition to version inspection.

## Exposure and correction

The [October Node advisory](https://nodejs.org/en/blog/vulnerability/october-2026-security-releases) covers Brotli memory corruption, DNS input validation, TLS/IP normalization and permission-model issues. Nexar's provider HTTP/Fetch/SDK consumers make the patched runtime relevant; absence of a direct Brotli call does not exclude transitive decompression. No malicious payload was executed and reachable exploitation is not established. Node 24.22.2 includes the preceding security corrections.

[Electron 44.10.0 release notes](https://releases.electronjs.org/release/v44.10.0) document the embedded Node update and filesystem/archive/process corrections inherited by the selected maintenance line. Nexar's OS sandbox, path containment and strict renderer boundary remain independent protections; no claim that every vulnerability is eliminated is made.

**Unresolved exposure:** retained Desktop Electron still embeds Node 24.21.0 and older Chromium/V8. It does not acquire the October embedded-Node/security corrections by building with Node 24.22.2. Strict renderer/IPC/sandbox/containment controls remain mitigations, not proof that vulnerable functionality is unreachable. No new Desktop security acceptance or safe long-term deployment recommendation is claimed. The dedicated-runtime work must unblock the patched Electron release before closing this security gate.

## Preserved boundaries and tests

No production window/preload/IPC/CSP/navigation/permission setting was weakened. The added E2E test reads `process.versions` in Playwright's trusted main-process context, records PID/launcher linkage and validates the actual Electron/Node/Chromium/V8 identities for source and packaged executions. It adds no renderer-facing diagnostics API.

Existing connection, session, memory, DSH, cancellation, process ownership, private-state and safe-shutdown suites remain mandatory. Source build, NSIS creation, win-unpacked execution and clean-machine installation are separate claims. Owner-installed Desktop is not replaced. Retained vulnerable binaries are rollback evidence only; public release/signing and installed Plane exposure remain separate gates.
