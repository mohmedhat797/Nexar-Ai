# NXR-SEC-02 / NXR-SEC-02B — security assessment

Date: 2026-10-16. This implementation assessment is not independent owner acceptance.
Execution evidence and source identities are recorded in
[Windows/WSL acceptance](../../development/NXR_SEC02_Windows_WSL_Acceptance.md).

## Evidence interpretation

The direct Node filesystem probe in `acp/sandboxed.real.test.ts` runs inside real bubblewrap,
without asking the model or permission broker to refuse anything. Hidden host files return
`ENOENT` (absent from the mount namespace), not a claimed ACL denial. Approved input writes return
`EROFS`/permission errors. A controlled host TCP listener cannot be contacted from the isolated
network namespace. The Windows acceptance driver creates its own synthetic Windows file, passes
only its conventional `/mnt/<drive>/...` path to the probe, checks denial, then checks the host file
is unchanged. No real owner credentials or personal documents are used.

Under NXR-SEC-02B deployment hardening:

- Findings SEC02-F01 through SEC02-F05 were fully resolved and verified in code.
- Final Full CI passed all 16 required gates on build 26300: 4,338 offline tests passed, 167 skipped,
  four pending; source and packaged E2E each passed 25/25. The mandatory isolated Windows suite passed
  8/8, and the real Linux boundary/Coding gate passed 15/15 without skips.
- Implementation commit `dc27f551fdab7c80337982598ba07c7c0faca8e5` exactly matches the clean tested tree
  `249bfcc10c4d32aa6b7abddcbfca1a2f71ebcd24`; CI executed on the clean commit (`isDirty: false`).
- Helper version handshake (`cowork/hello`), per-channel callback limits (`gateway: 4`, `bridge: 4`, `permission: 1`),
  flat `/work` scratch writes, and probe placement reporting were deterministically verified by unit tests.

A separate retained direct probe records nine hidden-path reads and four writes as `ENOENT`,
read-only input writes as `EROFS`, and access to a live host TCP listener as `ECONNREFUSED`. Scratch
reads/writes and approved input reads succeeded. Its effective virtual mounts and environment key
names are in the retained Linux `/home/nexar/src/Nexar-Ai/.nexar/sec02-kernel-evidence.json` and
[sanitized machine evidence](../../development/evidence/nxr-sec02-evidence.json).
The capability token was absent from prepared process argv; provider credential variables were
absent from the sandbox environment. No secret values are included in that report.

Tests and statuses below must be read with their raw report results; a source test alone is not PASS.

| Requirement                                 | Evidence source                                                                    | Scope                                                                                                                           |
| ------------------------------------------- | ---------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| SEC02-01/02 pinned DSH and ACP              | `sandboxed.real.test.ts`; `wsl-cowork.real.test.ts`                                | Real runtime, offline model                                                                                                     |
| SEC02-03 scratch read                       | Direct Node boundary probe                                                         | Actual filesystem API                                                                                                           |
| SEC02-04/05 Windows file read/write         | Windows driver fixture + Linux kernel probe                                        | Path absent; host bytes unchanged                                                                                               |
| SEC02-06/07 WSL host read/write             | Synthetic outside file + direct Node probe                                         | Path absent; original bytes unchanged                                                                                           |
| SEC02-08/09/10 traversal/symlink/direct API | Direct Node probe; file transfer tests                                             | Mount boundary plus no-follow extraction                                                                                        |
| SEC02-11 cross-project                      | Input selection tests; isolated context tests                                      | Registry/session containment and protected context                                                                              |
| SEC02-12 another turn                       | Hidden private file; concurrent real WSL turns                                     | No shared input contents; private roots                                                                                         |
| SEC02-13 network                            | Controlled host listener, new network namespace                                    | Connection denied/refused; gateway separately works                                                                             |
| SEC02-14/15 gateway/NRC                     | Isolated Desktop E2E; context real tests                                           | Existing gateway and NRC execution                                                                                              |
| SEC02-16 bridge misuse                      | `wsl-cowork.test.ts`, `cowork-executor.test.ts`                                    | Bad token/op/doc refs/native dispatch rejected                                                                                  |
| SEC02-17/18 approval/draft                  | Real WSL permission round trip; service approval tests                             | Real drafts-only/read-only; owner-ask existing broker                                                                           |
| SEC02-19 artifact import                    | `cowork-isolated.e2e.ts`                                                           | Real Desktop artifact persistence                                                                                               |
| SEC02-20/21 memory/compaction               | `dsh-cowork.context.real.test.ts`, isolated mode                                   | Actual model system requests, forged context excluded                                                                           |
| SEC02-22 cancellation                       | `wsl-cowork.real.test.ts`; service lifecycle tests                                 | Active real runtime cancellation, grant cleanup in service                                                                      |
| SEC02-23 crash cleanup                      | Actual helper disconnect/fresh-turn test; service crash tests; post-run inspection | No partial artifact import; fresh turn succeeds; no temporary roots remained; exhaustive abrupt-death timing remains unverified |
| SEC02-24/25 credentials/argv/logs           | Minimal env source; real request assertions; existing spawn/log tests              | No provider keys passed; per-turn capability token is intentional                                                               |
| SEC02-26 interop                            | `/mnt/c`, `/mnt/d`, `/run/WSL`, binfmt and socket probes                           | Interfaces absent; no Windows command execution attempted                                                                       |
| SEC02-27 unavailable                        | Isolated Desktop E2E; service test                                                 | Turn fails, zero model calls, no direct fallback                                                                                |
| SEC02-28 prepare failure                    | `sandboxed.test.ts`; SandboxLauncher tests                                         | Rejects missing launcher/downgrade; no local fallback                                                                           |
| SEC02-29 concurrent turns                   | Real Windows WSL test                                                              | Separate inputs and private output roots                                                                                        |
| SEC02-30 Coding regression                  | Real Coding ACP and SandboxLauncher integration tests                              | Existing security envelope                                                                                                      |

## Residual risks and limits

- Independent security review and owner approval remain required before integration/ADR acceptance.
- Windows 11 Pro 25H2 build 26200 is the selected baseline; current host is build 26300. Results on
  this host do not establish acceptance on the selected build or native Ubuntu.
- Actual helper disconnection/restart was exercised. Exhaustive DSH/helper/system-death timing,
  hostile descriptor fuzzing and adversarial interleavings are not certified by these bounded fixtures.
- The owner-managed WSL helper/runtime is an external prerequisite. The Windows installer does not
  install or upgrade that Linux component. Version-matching deployment must be checked.
- The runtime dependency tree is not vulnerability-free. Existing MCP SDK OAuth substitution and
  nested fflate ZIP64 debt remain tracked in FCR-02. No dependency upgrade or newly enabled OAuth,
  arbitrary ZIP conversion, shell/web/plugin tool path is introduced by this change. Installed
  MCP client/core remain `2.0.0`, LibreOffice kit `0.1.5`, nested fflate `0.8.2`, root fflate `0.8.3`.
  Managed-path reachability remains a source-level inference, not a vulnerability-free certification.
- Approved input content and drafts intentionally reach the owner-selected model. Isolation is not
  a guarantee that malicious content cannot influence a permitted model request.
- Runtime home is writable and per-turn. Its state is discarded; a compromised DSH process remains
  confined by mounts/network but can corrupt its own output. SHA-256 proves transfer identity, not
  document safety or model correctness.
- Historical gateway-child exit and Providers second-response timeout remain unresolved instrumented
  observations. Passing new runs must not be described as root-cause fixes.

AppContainer/LPAC feasibility remains unperformed. NXR-SEC-02 is the owner-authorized WSL2 route,
not proof of a Windows-native isolation design.
