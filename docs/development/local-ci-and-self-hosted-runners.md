# Nexar Local CI & Self-Hosted Runner Infrastructure Guide

This guide describes how to run and configure the **Nexar Local CI** infrastructure and optionally deploy **GitHub Self-Hosted Runners** to continue Nexar development and verification without dependence on GitHub-hosted Actions minutes.

---

## 1. Overview & Architecture

Hosted CI is currently running: run `41225379130` passed on `c97136b` on 31 October 2026. Local CI still covers what hosted runners do not, including packaged E2E and the WSL Plane.

GitHub Actions included billing minutes on private repositories can be exhausted (e.g. 3,000 / 3,000 minutes limit reached). When GitHub-hosted runners are blocked, development cannot rely on hosted CI runs.

Nexar Local CI provides a unified, cross-platform validation orchestrator that executes the exact quality gates locally on developer workstations or dedicated self-hosted runners.

```text
                           Developer / Agent
                                  │
                  ┌───────────────┴───────────────┐
                  ▼                               ▼
         pnpm ci:local:quick              pnpm ci:local:full
                  │                               │
                  ▼                               ▼
       Environment Preflight            Environment Preflight
                  │                               │
       Formatting (Prettier)            Dependencies (frozen lockfile)
                  │                               │
         ESLint Boundaries              DSH Runtime (0.2.0-rc.2 pin)
                  │                               │
       TypeScript Typecheck             Static Gates (Format/Lint/Types)
                  │                               │
       Offline Test Suite               Offline Vitest Suite
                  │                               │
                  ▼                     Production Build
          QUICK_PASS / FAIL                       │
                                        CLI Smoke Tests
                                                  │
                                        Real DSH Offline ACP Tests
                                                  │
                                        Desktop E2E (Windows / Xvfb)
                                                  │
                                        Desktop Packaging & Packaged E2E
                                                  │
                                        Linux Sandbox Validation
                                                  │
                                        Gitleaks 8.28.0 Security Scan
                                                  │
                                                  ▼
                                     NEXAR_LOCAL_CI_PASS / FAIL / BLOCKED
                                                  │
                                                  ▼
                                      Structured Reports (.nexar/ci/reports)
```

---

## 2. Prerequisites & Toolchain Verification

### 2.1 Node.js Version Selection

- **Required Version:** `Node.js 22.23.3` (major version 22 pinned in `.nvmrc`).
- **Rationale:** Node.js 24 has been associated with intermittent native Vitest fork-worker fail-fast crashes (`0xC0000409` user-mode exception). Local CI enforces Node 22 during preflight.
- **Verification:**
  ```bash
  node -v
  # Expected: v22.x.x (e.g., v22.23.3)
  ```
- **Custom Node binary:** If the system default Node is different, pass `--node-bin=<path>` or set `NEXAR_NODE_BIN`:
  ```powershell
  $env:NEXAR_NODE_BIN = "D:\Nexar-Toolchains\node-v22.23.3-win-x64\node.exe"
  ```

### 2.2 pnpm Version

- **Required Version:** `pnpm@10.33.0` (declared in `package.json`).
- **Verification:**
  ```bash
  pnpm -v
  # Expected: 10.33.0
  ```

### 2.3 DeepSeek Harness (DSH) Runtime Pin

- **Pinned Version:** `@deepseek-ai/dsh@0.2.0-rc.2` (ADR-030).
- **Installer:** `scripts/install-dsh-runtime.mjs` installs and verifies the pinned runtime from `integrations/deepseek-harness/dsh-runtime.package-lock.json`.
- The packaged Windows desktop build bundles this runtime under `resources/dsh-runtime`.

### 2.4 Gitleaks Security Scanner

- **Required Version:** `Gitleaks 8.28.0`.
- **Search locations:** System `PATH`, `process.env.GITLEAKS_BIN`, `.nexar/gitleaks-8.28.0/gitleaks.exe`, or `D:\Nexar-Ai-main\.nexar\gitleaks-8.28.0\gitleaks.exe`.
- **Verification:**
  ```bash
  gitleaks version
  # Expected: 8.28.0
  ```

---

## 3. Running Nexar Local CI

### 3.1 Quick Mode (`ci:local:quick`)

Designed for rapid inner-loop developer feedback during code editing.

```bash
pnpm ci:local:quick
```

Environment preflight checks Node, pnpm and the DSH pin before these five executed stages:

1. Prettier format check
2. ESLint static analysis
3. Package boundaries and secret guard (`scripts/check-boundaries.mjs`)
4. TypeScript typecheck
5. Offline test suite

Preflight is reported separately from the stage manifest; frozen dependency installation is a Full stage.

Result: `LOCAL_CI_QUICK_PASS` or `LOCAL_CI_QUICK_FAIL`.

### 3.2 Full Mode (`ci:local:full`)

Required for pull requests and release candidate acceptance.

```bash
pnpm ci:local:full
```

Runs a 16-entry stage manifest across static quality, offline tests, production build, CLI smoke, source desktop E2E, Windows packaging, fresh packaged E2E, Linux sandbox checks, and Gitleaks. Required stages depend on platform: Windows Full PASS means all 15 Windows stages passed and the Linux-only stage is BLOCKED/optional, not 16 successful executions. Linux sandbox is mandatory on Linux. Interrupted/preflight-failed runs, missing required stages, stale artifacts or unsupported Node cannot establish acceptance.

Result: `NEXAR_WINDOWS_FULL_PASS` (Windows), `NEXAR_LINUX_FULL_PASS` (Native Linux), `NEXAR_LINUX_WSL2_PASS` (WSL2), or `NEXAR_WINDOWS_FULL_FAIL` / `NEXAR_WINDOWS_FULL_BLOCKED`. Cross-platform aggregation evaluates both into `NEXAR_CROSS_PLATFORM_ACCEPTANCE_PASS` or `NEXAR_CROSS_PLATFORM_ACCEPTANCE_INCOMPLETE`.

### 3.3 Report Mode (`ci:local:report`)

Displays the latest recorded validation report:

```bash
pnpm ci:local:report
```

Inspects `.nexar/ci/reports/latest.json`, validates the exact 40-character source commit and full dirty-content fingerprint, and prints the breakdown. Full reports bind start/end source identity and require stability. Raw assertion JSON classifies skipped, pending and todo separately; totals must reconcile. Cross-platform PASS requires matching source and native Linux metadata; a WSL2 report cannot substitute for native Ubuntu.

---

## 4. Reports & Evidence Artifacts

All validation reports are saved locally under `.nexar/ci/reports/`:

- `report-<timestamp>.json`: Complete machine-readable telemetry and stage breakdown.
- `report-<timestamp>.md`: Human-readable Markdown summary with parity matrix.
- `latest.json` & `latest.md`: Symlinks/copies of the most recent validation run.

> [!NOTE]
> `.nexar/` is excluded in `.gitignore` and enforced by `scripts/check-boundaries.mjs`. Raw temporary logs and traces remain ignored. A sanitized acceptance evidence record may be deliberately committed under docs/development/evidence; it contains source identities, counts and artifact hashes without credentials or personal executable paths.

---

## 5. Platform Considerations

### 5.1 Windows Desktop GUI Session

- Desktop E2E tests drive Electron via Playwright.
- On Windows, Electron requires an interactive graphical user session.
- When running automated validation or self-hosted runners on Windows, the runner must run within an interactive desktop logon session (not as an isolated non-interactive Windows service) so that Electron windows can initialize and render.

### 5.2 Linux Sandbox Prerequisites (ADR-018)

- Linux validation tests the bubblewrap (`bwrap`) sandbox and Unix socket relay (`socat`).
- Requires unprivileged user namespace permissions or AppArmor profile (`/etc/apparmor.d/bwrap`).
- On Windows hosts, the Linux sandbox stage is reported honestly as `BLOCKED` with status category `ENVIRONMENT_UNSUPPORTED`, preventing false positive claims.

---

## 6. Optional GitHub Self-Hosted Runners

When GitHub-hosted runner minutes are exhausted, you can connect isolated self-hosted runners to execute the same local CI commands.

### 6.1 Workflow Configuration

Workflow file: `.github/workflows/ci-self-hosted.yml`

- Trigger: manual `workflow_dispatch`.
- Labels:
  - Windows runner: `[self-hosted, Windows, X64, nexar-windows-ci]`
  - Linux runner: `[self-hosted, Linux, X64, nexar-linux-ci]`

### 6.2 Security Boundaries for Self-Hosted Runners

1. **Isolated Virtual Machines:** Never run a self-hosted runner directly on your primary developer machine with personal API keys or unlocked credentials in the user environment.
2. **Ephemeral / Dedicated Users:** Use a clean runner user account with minimal permissions.
3. **No Secrets in Repo:** Workflows run offline; offline test fixtures use deterministic mocks. Do not supply live AI provider tokens to the runner.
4. **Controlled Triggers:** The workflow uses `workflow_dispatch` only. Untrusted pull requests from forks cannot automatically execute code on your runner.

### 6.3 Registering a Windows Runner

1. In GitHub, navigate to **Settings** → **Actions** → **Runners** → **New runner**.
2. Select **Windows**, architecture **x64**.
3. Download and extract the official runner package into `C:\actions-runner`.
4. Configure runner with required labels:
   ```powershell
   ./config.cmd --url https://github.com/mohmedhat797/Nexar-Ai `
     --token <REGISTRATION_TOKEN> `
     --labels "self-hosted,Windows,X64,nexar-windows-ci" `
     --name "nexar-win-01"
   ```
5. Run the runner interactively in a graphical session:
   ```powershell
   ./run.cmd
   ```

### 6.4 Registering a Linux Runner

1. In GitHub, navigate to **Settings** → **Actions** → **Runners** → **New runner**.
2. Select **Linux**, architecture **x64**.
3. Install prerequisites on Ubuntu:
   ```bash
   sudo apt-get update && sudo apt-get install -y bubblewrap socat xvfb
   ```
4. Configure runner:
   ```bash
   ./config.sh --url https://github.com/mohmedhat797/Nexar-Ai \
     --token <REGISTRATION_TOKEN> \
     --labels "self-hosted,Linux,X64,nexar-linux-ci" \
     --name "nexar-linux-01"
   ```
5. Start runner:
   ```bash
   ./run.sh
   ```

### 6.5 Deregistering a Runner

When finished with testing or recycling a VM:

```bash
# Windows
./config.cmd remove --token <REMOVAL_TOKEN>

# Linux
./config.sh remove --token <REMOVAL_TOKEN>
```

---

## 7. Restoring GitHub-Hosted CI Later

Once GitHub Actions billing limits or included minutes are restored on the repository:

1. Re-run failed runs via the GitHub web UI or `gh run rerun <run_id>`.
2. The standard `.github/workflows/ci.yml` will automatically resume normal execution.
3. Keep `.github/workflows/ci-self-hosted.yml` and `pnpm ci:local:*` available as ongoing zero-cost local validation tools.
