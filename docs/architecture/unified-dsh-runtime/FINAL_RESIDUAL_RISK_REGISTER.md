# Nexar AI — Final Residual Risk Register

**Milestone:** Unified DSH Runtime & Local CI Infrastructure  
**Baseline Commit:** `ed2ded5f9b368f3954ebac0ab2c842eb2b2c4b22`  
**Review Date:** October 2026

---

## 1. Purpose

This register documents all residual risks, known platform limitations, and technical debt items remaining in the repository following the stabilization of the Unified DSH Runtime and Local CI infrastructure. None of these risks block owner acceptance of PR #41 or the kickoff of NXR-070.

---

## 2. Risk Register

### RISK-01: Native Windows Electron Worker Crash Edge-Case

- **Classification:** Reliability / Platform Quirk
- **Severity:** Medium
- **Likelihood:** Low
- **Description:** In earlier UDSH08 testing, rapid consecutive Electron worker restarts under heavy load on Windows occasionally triggered native runtime process exits.
- **Mitigation Implemented:** Process isolation boundary in `DshCoworkService` traps unhandled process exits, restarts turn cleanly on fallback resources, and records forensic telemetry without crashing the host application.
- **Owner Action Required:** Monitor crash telemetry during daily dogfooding.

### RISK-02: Missing Linux Headless GitHub Actions Runner

- **Classification:** DevOps / Infrastructure
- **Severity:** Medium
- **Likelihood:** High (Until Self-Hosted Runner or GitHub minutes acquired)
- **Description:** Cloud GitHub-hosted runner minutes are exhausted for the repository. Automated GitHub Actions runs currently fail due to billing suspension.
- **Mitigation Implemented:**
  1. Full Local CI suite (`scripts/local-ci/runner.mjs`) allows complete pre-commit/pre-push validation on developer machines.
  2. Optional self-hosted runner workflow (`.github/workflows/ci-self-hosted.yml`) prepared for private runner deployment.
  3. WSL2 validation scripts allow full Linux sandbox testing on developer workstations.
- **Owner Action Required:** Deploy an internal self-hosted runner or renew GitHub Actions billing when ready.

### RISK-03: Windows Coding Lane Lack of Bubblewrap

- **Classification:** Security / Sandbox Containment
- **Severity:** Low
- **Likelihood:** Medium
- **Description:** Native Windows does not support Bubblewrap namespaces. Coding lane commands on Windows execute via Node subprocesses without hardware-enforced filesystem sandboxing.
- **Mitigation Implemented:** Ephemeral git worktrees, explicit user approval gates before writes, and clear UI notifications indicating unsandboxed Windows execution. Full sandbox enforcement is available via WSL2.
- **Future Enhancement:** Windows Sandbox or Hyper-V isolation under NXR-070 Resource Fabric.

### RISK-04: Upstream DSH Pre-Release Version

- **Classification:** Dependency Lifecycle
- **Severity:** Low
- **Likelihood:** Low
- **Description:** DeepSeek Harness is pinned at `@deepseek-ai/dsh@0.2.0-rc.2`. Upstream may release newer release candidates or 1.0.0.
- **Mitigation Implemented:** Lockfile pinning (`pnpm-lock.yaml`) and preflight check in `scripts/local-ci/` verify lockfile consistency.
- **Future Action:** Evaluate upstream 1.0.0 release in a dedicated dependency upgrade PR.

---

## 3. Residual Risk Signoff

All residual risks are documented, understood, and mitigated by architectural firewalls. The codebase is safe for production use and further development.
