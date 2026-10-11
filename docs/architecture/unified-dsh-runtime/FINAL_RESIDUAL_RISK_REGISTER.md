# Nexar AI — Final Residual Risk Register

## FCR-01 correction — current residual risks

The earlier statements that no risks block acceptance and the code is safe for production are superseded.

| Classification                                               | Risk                                                         | Current action/limit                                                                                                                                                                                                                                                |
| ------------------------------------------------------------ | ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Blocking / owner decision required                           | Host-local Cowork read access and post-grant filesystem race | Require real OS read isolation for untrusted use or an explicit owner-approved trusted-content release restriction; no acceptance by this review.                                                                                                                   |
| Blocking / external environment                              | Native Ubuntu Full CI                                        | Provide a safe isolated native Ubuntu executor or restore Actions availability. WSL2 is separately useful, and cannot substitute for this gate.                                                                                                                     |
| Supported-runtime limitation                                 | Node.js 24 worker fail-fast history                          | Node 22.23.3 is the validated host CI toolchain; standalone Node 24/Vitest remains unsupported. Pinned Electron 44.5.1 embeds Node 24.21.0 and its managed child path is separately exercised by E2E. Historical 0xC0000409 has no established Electron root cause. |
| Deferred nonblocking technical debt in managed configuration | Pinned DSH dependency advisories                             | Two upstream advisories, reviewed vulnerable OAuth/unzip APIs not reached by managed paths; arbitrary plugin/runtime configurations remain unverified.                                                                                                              |
| Public release requirement                                   | Unsigned development installer                               | Current package is NotSigned; internal testing is not publisher authenticity or public release certification.                                                                                                                                                       |
| Bounded reliability limitation                               | Separate-process file identity races                         | Public reads now share this store's mutation queue; another process can still encounter a fail-closed identity race. No corruption or data loss demonstrated.                                                                                                       |

Historical 0xC0000409 was associated with Node 24 Vitest/native workers; its root cause was not established as Electron. Cowork maps runtime exits to fixed errors and starts a fresh process on a later turn; it does not promise automatic successful replay of every crash. Writable Windows Coding does not bypass the sandbox guard. A configured self-hosted workflow is not executed evidence.

Detailed classification: [FCR01_Security_Findings.md](FCR01_Security_Findings.md). Overall remains `NEXAR_FCR01_BLOCKED_BY_EXTERNAL_DEPENDENCY`.

Node 22.23.3 is the validated host CI toolchain; standalone Node 24/Vitest remains unsupported. Pinned Electron 44.5.1 embeds Node 24.21.0 and its managed child path is separately exercised by E2E. Historical 0xC0000409 has no established Electron root cause.

Dual-writer lease acquisition was also reproduced and corrected in `723ae706`: exclusive acquisition claims serialize creation/stale takeover and unreadable leases deny. Abandoned claims require operator verification/repair; no automatic stealing.

## Historical report — superseded for current acceptance

The original report is retained below as historical evidence. Its readiness/security claims do not certify the corrected source; use the FCR-01 verdicts above.

> # Nexar AI — Final Residual Risk Register
>
> **Milestone:** Unified DSH Runtime & Local CI Infrastructure\
> **Baseline Commit:** `ed2ded5f9b368f3954ebac0ab2c842eb2b2c4b22`\
> **Review Date:** October 2026
>
> ---
>
> ## 1. Purpose
>
> This register documents all residual risks, known platform limitations, and technical debt items remaining in the repository following the stabilization of the Unified DSH Runtime and Local CI infrastructure. None of these risks block owner acceptance of PR #41 or the kickoff of NXR-070.
>
> ---
>
> ## 2. Risk Register
>
> ### RISK-01: Native Windows Electron Worker Crash Edge-Case
>
> - **Classification:** Reliability / Platform Quirk
> - **Severity:** Medium
> - **Likelihood:** Low
> - **Description:** In earlier UDSH08 testing, rapid consecutive Electron worker restarts under heavy load on Windows occasionally triggered native runtime process exits.
> - **Mitigation Implemented:** Process isolation boundary in `DshCoworkService` traps unhandled process exits, restarts turn cleanly on fallback resources, and records forensic telemetry without crashing the host application.
> - **Owner Action Required:** Monitor crash telemetry during daily dogfooding.
>
> ### RISK-02: Missing Linux Headless GitHub Actions Runner
>
> - **Classification:** DevOps / Infrastructure
> - **Severity:** Medium
> - **Likelihood:** High (Until Self-Hosted Runner or GitHub minutes acquired)
> - **Description:** Cloud GitHub-hosted runner minutes are exhausted for the repository. Automated GitHub Actions runs currently fail due to billing suspension.
> - **Mitigation Implemented:**
>   1. Full Local CI suite (`scripts/local-ci/runner.mjs`) allows complete pre-commit/pre-push validation on developer machines.
>   2. Optional self-hosted runner workflow (`.github/workflows/ci-self-hosted.yml`) prepared for private runner deployment.
>   3. WSL2 validation scripts allow full Linux sandbox testing on developer workstations.
> - **Owner Action Required:** Deploy an internal self-hosted runner or renew GitHub Actions billing when ready.
>
> ### RISK-03: Windows Coding Lane Lack of Bubblewrap
>
> - **Classification:** Security / Sandbox Containment
> - **Severity:** Low
> - **Likelihood:** Medium
> - **Description:** Native Windows does not support Bubblewrap namespaces. Coding lane commands on Windows execute via Node subprocesses without hardware-enforced filesystem sandboxing.
> - **Mitigation Implemented:** Ephemeral git worktrees, explicit user approval gates before writes, and clear UI notifications indicating unsandboxed Windows execution. Full sandbox enforcement is available via WSL2.
> - **Future Enhancement:** Windows Sandbox or Hyper-V isolation under NXR-070 Resource Fabric.
>
> ### RISK-04: Upstream DSH Pre-Release Version
>
> - **Classification:** Dependency Lifecycle
> - **Severity:** Low
> - **Likelihood:** Low
> - **Description:** DeepSeek Harness is pinned at `@deepseek-ai/dsh@0.2.0-rc.2`. Upstream may release newer release candidates or 1.0.0.
> - **Mitigation Implemented:** Lockfile pinning (`pnpm-lock.yaml`) and preflight check in `scripts/local-ci/` verify lockfile consistency.
> - **Future Action:** Evaluate upstream 1.0.0 release in a dedicated dependency upgrade PR.
>
> ---
>
> ## 3. Residual Risk Signoff
>
> All residual risks are documented, understood, and mitigated by architectural firewalls. The codebase is safe for production use and further development.
