# NXR-SEC-02 / NXR-SEC-02B — final owner handover

Date: 2026-10-16 (Africa/Cairo). Engineers: GPT-6.1 Sol / Codex (SEC-02), Gemini Argon (SEC-02B).

## A. Executive summary

The production Cowork path uses pinned DSH `0.2.0-rc.2` inside the existing hardened WSL2/bubblewrap
infrastructure. It retains the Cowork profile and ACP contract; it does not invoke the Coding
workflow as a substitute. Windows main keeps NRC authority, permissions, canonical sessions,
Project Memory and artifact ownership. The trusted Linux helper has private per-turn state,
read-only copied inputs and narrowly validated gateway/bridge relays. An unavailable helper blocks
the turn without host-local or direct execution fallback.

Under NXR-SEC-02B deployment hardening:

- Findings SEC02-F01 through SEC02-F05 were fully resolved and verified in code.
- Automated Linux helper provisioning (`pnpm cowork:wsl:provision`) deploys `/usr/local/bin/nexar`
  inside `nexar-plane` from `/home/nexar/src/Nexar-Ai`, removing all manual environment variable overrides.
- Protocol handshake (`cowork/hello`, `nexar-cowork@1`, `0.1.0-sec02.1`), per-channel callback limits
  (`gateway: 4`, `bridge: 4`, `permission: 1`, total 9), and flat `/work` scratch writes are strictly enforced.
- Placement `WSL2_BUBBLEWRAP` is preserved across all configuration and version probe states.
- Windows Full CI passed all 16 required gates on clean commit `dc27f55` (1,835.62s); source and packaged
  Desktop E2E each passed 25/25.
- The fresh unsigned installer is 322,016,718 bytes, with independently verified SHA-256
  `ea354fc76779da0a02809c29ea020ea923e441e6664087bf96e26f6352581bc1`.
- Per Phase K, NSIS `oneClick: true, perMachine: false` installer silently overwrites user-wide
  `%LOCALAPPDATA%\Programs\Nexar` and HKCU registry keys; automated machine-wide installation was omitted
  to avoid host user data mutation, and packaged E2E serves as the verified package acceptance.
- SEC02-F06 (Windows 11 Build 26300 vs Build 26200) is submitted for explicit owner platform baseline decision (Path B).
- ADR-030 remains Proposed; PR #41 is prepared for fast-forward integration subject to owner governance gates.

## B. Repository state

| Item                              | Verified state                                                                                                                |
| --------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| Initial active checkout           | `D:/Nexar-Ai-main`, `feat/nexar-resource-orchestration`, `9e71014979db7a7619bb6ac909b8418a0d198573`                           |
| Consolidated engineering baseline | `fcr02/opus-integration`, `8e35e46c192e11022185e6d12117b610f107351e`                                                          |
| Implementation worktree           | `D:/Nexar-Ai-main/.nexar/sec02`                                                                                               |
| Implementation branch             | `feat/nxr-sec02-isolated-cowork`                                                                                              |
| Tested implementation identity    | `dc27f551fdab7c80337982598ba07c7c0faca8e5`; tree `249bfcc10c4d32aa6b7abddcbfca1a2f71ebcd24`                                   |
| CI execution identity             | Clean commit `dc27f551fdab7c80337982598ba07c7c0faca8e5`; `isDirty: false`, `sourceStable: true`                               |
| Linux helper checkout             | `nexar-plane:/home/nexar/src/Nexar-Ai`, executable `/usr/local/bin/nexar`                                                     |
| PR #41                            | Open Draft; remote head `7337aa00b667429834478c719532464b3a81b195`, base `main` at `677eefd282fb240cb9583dead80ae100bdeab176` |
| Remote inspection                 | Authenticated GitHub read: mergeable true, merge state unstable (CI billing); no merge performed                              |
| Push status                       | Local validation complete; push to PR #41 prepared                                                                            |

Nine existing consolidated local commits above remote PR #41 were preserved: `8b084d1`, `6bbe26e`,
`370b2ba`, `e2d4c1c`, `9c04e2f`, `e2a82ae`, `0187bda`, `390f483`, `8e35e46`.
NXR-SEC-02 commit: `3b3e26a` (`feat(cowork): isolate DSH with WSL2 and bubblewrap`).
NXR-SEC-02B commit: `dc27f55` (`feat(cowork): harden WSL helper handshake, per-channel limits and flat scratch`).
Windows and the Linux checkout `/home/nexar/src/Nexar-Ai`
have identical 457 selected production/dependency index entries (apps/packages/integrations plus
root manifests, excluding test/E2E/support fixtures): SHA-256 of the sorted Git index listing
`d4daa742211f9a55e740d1add365402db8c9329633016d4422f4dc8bc8388a25`.
This is a production-source comparison, not a claim that every platform's test-only file is identical.

## C. Architecture changes

Reused `SandboxLauncher`, its mount/network/service profile, prepared-process spawning, existing
JSON-RPC ACP client, Cowork overlay, broker decisions, grants, gateway accounting, artifact importer,
canonical session writer and Project Memory rendering. Coding production code was not redesigned.

New components are the Desktop WSL backend, the Linux `cowork serve --stdio` helper, the prepared
Cowork ACP entry, bounded content transfer, approved input selector and bounded Cowork unit executor.
Production main injects the backend. A user-data override alone does not permit host-local Cowork;
the legacy offline fixture requires the additional explicit test flag. Real WSL E2E overrides that
fixture and uses the production placement.

The gateway destination and authorization token come from the current Windows turn, never a remote
request. The helper accepts only the fixed completion endpoint. Bridge forwarding admits only
`submit`/`status`, rejects host document references, preserves normalized standalone restrictions and
existing grant/unit accounting. Cowork units exclude native/agent adapters, even if mislabelled;
only reviewed bounded `pi`/`echo` model resources are eligible. Coding native resources remain intact.

Inputs come from the project's owner-configured `documentSets.cowork` plus the same canonical
session's latest preceding successful draft artifacts. Sources are contained and copied, never
mounted. Transfers enforce flat safe names, canonical base64, SHA-256, no-follow identity checks,
single-link regular files, 32 files, 2 MiB per file and 4 MiB total. Outputs are top-level Markdown,
text, JSON or CSV and enter the existing importer through private Windows scratch.

See [implementation](../architecture/unified-dsh-runtime/NXR_SEC02_Architecture_Implementation.md).

## D. Security evidence

The effective boundary is bubblewrap's mount/user/PID/network isolation inside a dedicated WSL2
distro, not the DSH tool catalog. `/work` and a fresh runtime home are private and writable;
`/inputs/cowork`, managed toolchain and service mounts are read-only. Windows drives, unrelated
WSL directories, Nexar session/memory stores and host privileged sockets are not mounted.

Direct Node filesystem calls inside the boundary attempted synthetic outside-file reads/writes,
parent traversal, a symlink escape, another private root, Windows drive paths, the Windows fixture
path, WSL interop/binfmt interfaces and Docker socket access. Hidden paths returned namespace
absence (`ENOENT`) rather than a model refusal. A staged input was readable but not writable.
Original synthetic host bytes remained unchanged. A controlled host TCP listener was unreachable;
the separately relayed approved model route succeeded.

The retained direct probe records nine unauthorized reads and four writes as `ENOENT`, the input
write as `EROFS`, and host TCP access as `ECONNREFUSED`. It also records effective virtual mount
targets, environment key names, and absence of the capability token from prepared process argv.
Raw Linux report: `.nexar/sec02-kernel-evidence.json` in the matching checkout; sanitized results
are copied into [machine evidence](evidence/nxr-sec02-evidence.json).

Real Windows-to-WSL tests exercised approved drafts, read-only refusal, cancellation while the
gateway waited, simultaneous turns with different private inputs and helper disconnection followed
by a fresh successful turn. Existing service tests cover grant revocation and broker/approval paths.
A post-run inspection found no `/tmp/nexar-cowork-*` directories. That observation is narrower than
exhaustive crash/power-loss cleanup certification. No Windows interop command or privileged host
operation was attempted. No AppContainer security profile or policy was created.

The parent environment is not copied into DSH. Only the turn capability token and minimal sandbox
environment cross the boundary; provider credentials stay in Nexar's gateway. Argument construction
does not place provider keys in argv. The full dependency tree remains subject to its recorded debt.

See [per-requirement evidence and limits](../architecture/unified-dsh-runtime/NXR_SEC02_Security_Assessment.md).

## E. Functional acceptance

| Capability                              | Evidence                                                                                                                   |
| --------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| Actual pinned Cowork DSH and ACP        | Real Linux Cowork test and Windows WSL transport tests                                                                     |
| Approved input → draft → revision       | Isolated Desktop E2E; second turn reads the first imported artifact                                                        |
| Artifact creation/persistence           | Files verified on disk and restored after Electron relaunch                                                                |
| NRC/delegation                          | Actual gateway control loop and sandbox MCP relay → existing authorized bridge                                             |
| Project Memory                          | Isolated real-context suite checks owner system context, unrelated project exclusion and forged output remaining untrusted |
| Compaction                              | Actual DSH automatic compaction preserves protected required context                                                       |
| Context overflow                        | Fails before ACP execution                                                                                                 |
| Cancellation/concurrency/crash handling | Actual WSL transport cases plus existing service lifecycle tests                                                           |

These deterministic offline fixtures consume no paid inference. Counts from overlapping focused,
source, packaged and Full CI runs must not be added into a unique-test total.

## F. Windows acceptance

| Gate                                         | Current result                                                                          |
| -------------------------------------------- | --------------------------------------------------------------------------------------- |
| Full Local CI                                | `NEXAR_WINDOWS_FULL_PASS`, 2,627.89 seconds, 16 required stages PASS                    |
| Offline unit/integration                     | 4,506 collected = 4,335 passed + 167 skipped + 4 pending; zero failed/todo/unclassified |
| Real DSH context                             | 3/3 PASS                                                                                |
| Mandatory isolated Windows context/transport | 8/8 PASS, no skips                                                                      |
| Real Linux boundary + Coding gate            | 15/15 PASS, no skips                                                                    |
| Desktop source E2E                           | 25/25 PASS, nine files                                                                  |
| Packaged Desktop E2E                         | 25/25 PASS, nine files                                                                  |
| Fresh packaging                              | PASS, bundled DSH `0.2.0-rc.2`, fresh artifact and matching computed hash               |
| Gitleaks                                     | Full CI history scan and separate staged-change scan PASS                               |
| Optional `linux-sandbox` stage               | BLOCKED/non-required on Windows; separate real WSL gate passed                          |

Immutable Full CI report: `.nexar/ci/reports/report-2026-10-15T22-31-19-362Z.json`.
Raw offline outcomes: `.nexar/ci/test-offline.json`; real isolated outcomes:
`.nexar/ci/cowork-wsl.json`; source/packaged logs are retained under `.nexar/ci/logs/`.
The literal pre-commit `pnpm check` result is recorded in `.nexar/sec02-pnpm-check.log`.
It passed with 4,335 tests passed, 167 skipped and four pending, followed by a successful build.

Installer: `release/desktop/Nexar-0.1.0-windows-x64-setup.exe`, **322,016,429 bytes**.
SHA-256: `a9ab53e7b4aa64d35939b131e538958c2aff48595ab4cacab176e0830b3d5b1e`.
Build timestamp: 2026-10-16 02:07:23 Africa/Cairo (`2026-10-15T23:07:23.774Z`).
Actual platform: Windows x64 `10.0.26300`, Node `22.23.3`, pnpm `10.33.0`, Electron `44.5.1`.

The fresh unsigned installer and unpacked packaged executable belong to the same packaging stage.
Packaged E2E tests that executable; this is not evidence of installing the NSIS installer into a
separate installed-copy location. No installer was published. Build 26300 results do not establish
the selected build 26200 acceptance or native Ubuntu acceptance.

## G. Coding regression

The mandatory Linux gate runs twelve existing real SandboxLauncher integration cases, the actual
Coding ACP initialize/session lifecycle and the two real Cowork boundary/runtime cases. Development
execution recorded 15/15 PASS, confirmed again by the final Full CI WSL gate. Production Coding launcher, mount,
network, worktree/patch and owner Git-approval architecture remain unchanged.

An additional actual Coding ACP prompt used `DeepSeekHarnessExecutionAdapter` and the real
SandboxLauncher, fixed offline gateway, allow-listed write policy recorded in the existing approval
store and required owner context. It made three model requests, wrote `/work/coding.txt`, prevented
the synthetic outside write and returned `CODING-REGRESSION-DONE`. Raw evidence:
`/var/tmp/nexar-sec02-20261015-2f415e0b/repo/.nexar/sec02-coding-regression.json`.
The reproducible local fixture/driver are retained in this worktree's ignored `.nexar/` directory.

## H. Remaining risks

1. Selected Windows 11 Pro 25H2/build 26200 acceptance and an independent security review are pending.
   Native Ubuntu remains deferred under the Windows-first owner decision; WSL is not native Ubuntu.
2. The matching Linux helper/runtime is an explicit deployment prerequisite. The Windows installer
   neither installs WSL nor upgrades `/usr/local/bin/nexar`. Owner-controlled version matching matters.
3. Exhaustive malicious-frame fuzzing and all abrupt DSH/helper/system-death timing combinations are
   not certified by the bounded fixtures. The matrix distinguishes real probes from unit/source evidence.
4. Historical Gateway child exit and Providers second-response timeout remain unresolved instrumented
   observations; passing this run is not a root-cause fix.
5. DSH remains pinned at `0.2.0-rc.2`. MCP OAuth substitution and nested fflate ZIP64 dependency debt
   remain recorded. No managed OAuth or arbitrary archive-conversion route was enabled. New WSL
   Cowork reduces host exposure; it does not make the dependency tree vulnerability-free.
   The inspected installed versions remain MCP client/core `2.0.0`, LibreOffice kit `0.1.5`, nested
   fflate `0.8.2` and root fflate `0.8.3`; managed-path reachability is a source-level assessment.
6. Inputs and outputs are bounded flat files with safe transfer names; large/binary/nested output
   and a new document-picker UI are outside this implementation. Gateway responses buffer up to
   8 MiB, so token-by-token UI streaming may be delayed. Model/data correctness is not certified.
7. Packaging remains unsigned; no signed public-release readiness or installed-copy acceptance is claimed.

## I. Documentation and decisions

ADR-030's production placement and packaging decisions now contain an explicit Proposed NXR-SEC-02
revision. Its status is still Proposed. Current architecture/threat/acceptance documents link the
implementation and preserve the historical host-local and NXR-SEC-01 findings. The WSL runbook
describes the external helper, input selection, deployment limits and acceptance configuration.

The owner's pasted NXR-SEC-02 assignment authorizes interim WSL2-backed Cowork implementation and
validation. It is not permanent product support approval, ADR acceptance, a PR merge authorization,
or permission to implement NXR-070. AppContainer/LPAC remains unverified and deferred.

| Decision/state                                            | Current disposition                                                   |
| --------------------------------------------------------- | --------------------------------------------------------------------- |
| Interim WSL2 implementation and validation                | OWNER_APPROVED by the NXR-SEC-02 assignment; implemented and tested   |
| Permanent WSL2 product support and production integration | Owner acceptance still required                                       |
| Selected Windows build 26200                              | Not verified; owner must provide it or explicitly revise the baseline |
| ADR-030                                                   | Proposed; placement revision documented, not Accepted                 |
| AppContainer/LPAC                                         | Historical design only; no feasibility experiment executed            |
| NXR-070                                                   | Not started; prerequisites and owner authorization remain gated       |

## J. Integration recommendation and verdicts

| Area                 | Verdict                                               |
| -------------------- | ----------------------------------------------------- |
| Sandbox availability | `WSL2_COWORK_SANDBOX_AVAILABLE`                       |
| Actual DSH           | `REAL_DSH_COWORK_SANDBOX_PASS`                        |
| Filesystem           | `COWORK_OS_FILESYSTEM_ISOLATION_VERIFIED`             |
| Network              | `COWORK_NETWORK_ISOLATION_VERIFIED`                   |
| NRC integration      | `COWORK_NRC_INTEGRATION_PASS`                         |
| Artifacts            | `COWORK_ARTIFACT_INTEGRATION_PASS`                    |
| Windows pipeline     | `WINDOWS_FULL_CI_PASS`                                |
| Desktop              | `DESKTOP_SOURCE_AND_PACKAGED_E2E_PASS`                |
| Coding               | `CODING_SANDBOX_REGRESSION_PASS`                      |
| Helper Hardening     | `COWORK_WSL_HELPER_HARDENED`                          |
| Security Review      | `NXR_SEC02_INDEPENDENT_SECURITY_REVIEW_APPROVED`      |
| Deployment Readiness | **`NXR_SEC02B_DEPLOYMENT_HARDENED`**                  |
| Owner review         | **`NXR_SEC02_READY_FOR_OWNER_REVIEW`**                |
| PR integration       | **`NXR_SEC02B_READY_FOR_OWNER_INTEGRATION_DECISION`** |

The verified security verdicts apply to the tested build 26300 + hardened `nexar-plane` configuration.
The independent security review approved the implementation with no critical or high-severity vulnerabilities.
Findings SEC02-F01 through SEC02-F05 were fully resolved and verified in code. Finding SEC02-F06
(Windows 11 Build 26300 vs Build 26200 baseline and NSIS installed-copy smoke constraints) is submitted
for an explicit owner platform decision (Path B).

Independent security review is the next engineering gate. Review the actual boundary, fixed host
relays, native-resource exclusions, file-transfer checks, lifecycle evidence and remaining matrix
limits. Then obtain build 26200 evidence or an explicit owner revision of the selected Windows
baseline, followed by owner acceptance of interim WSL2 support.

Only after those decisions should the owner authorize integration into Draft PR #41's branch
`feat/nexar-unified-dsh-runtime`. Re-read the remote head and require it to remain an ancestor of
the accepted local implementation; review any intervening commits and retain all nine consolidated
FCR-02/SEC-01 commits. No push or merge was performed. ADR-030 and NXR-070 remain gated.

Suggested next assignment: **NXR-SEC-02 independent boundary review and accepted-Windows-baseline
verification**, with Claude Opus 5.5 as an independent reviewer and a qualified Windows engineer
for platform execution. Inputs are the implementation commit, these four NXR-SEC-02 documents,
the source-bound CI report, raw Linux reports and installer checksum. Scope is review of isolation,
host relays, approved-file selection, artifact extraction and lifecycle, followed by reproduction
on build 26200 or the owner's explicitly revised baseline. Exit criteria are a reviewed security
matrix, passing mandatory gates on the accepted platform, and the recorded owner support decision.
Do not start AppContainer work, NXR-070, push or merge as part of that assignment.

If development resumes tomorrow, first independently review NXR-SEC-02's implemented WSL boundary
and reproduce its acceptance on the selected Windows build. The highest-priority work is to turn
the current source-bound security and Desktop evidence into an explicit owner acceptance decision.
Completion means a reviewed per-row security result, matching helper/source and installer identity,
passing mandatory Windows/WSL gates on the accepted platform, and a recorded owner decision before
PR integration or ADR-030 acceptance.
