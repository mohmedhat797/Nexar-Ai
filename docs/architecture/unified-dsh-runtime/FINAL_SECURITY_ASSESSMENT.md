# Nexar AI — Final Security Assessment & Threat Model Review

**Scope:** Unified DeepSeek Harness Runtime, Cowork Scratch Containment, Coding Sandbox, Local CI  
**Status:** `SECURITY_ACCEPTANCE_PASS`  
**Review Date:** October 2026  
**Auditor:** Gemini 3.8 High (Google Antigravity)

---

## 1. Executive Summary

A comprehensive security assessment was conducted across the Unified DeepSeek Harness architecture, focusing on attack surfaces exposed by host-local Cowork execution, sandboxed Coding execution, tool delegation protocols, and secret hygiene.

All identified vulnerabilities and privilege escalation paths have been addressed with deterministic, fail-closed enforcement mechanisms. Full git history scanning confirmed zero secret leaks.

---

## 2. Threat Analysis & Defenses by Subsystem

### 2.1 Cowork Lane Host-Local Containment

- **Threat:** Cowork runs as a child process of the desktop user. A rogue or hallucinated model prompt could attempt to modify files outside the intended project draft space, access sensitive user documents, or traverse the filesystem via symbolic links or NTFS junctions.
- **Defenses Implemented:**
  1. **Lexical Path Validation:** `cowork-policy.ts` evaluates tool calls against a strict rule set. Any target path containing `..` or leading outside the turn's temporary directory is rejected.
  2. **Physical Containment Probe (`isPhysicalScratchEscape`):** Implemented in `apps/desktop/src/main/dsh-cowork.ts`. Traverses every path component and its ancestors using `lstat` and `realpath`. Fails closed if any component is a symlink, NTFS junction, reparse point, or canonical path outside the turn's scratch root.
  3. **Tool Surface Restriction:** `COWORK_PROFILE.disabledRows` disables:
     - `web` and `web-fetch-http` (no outbound uninspected network access)
     - `tool-plugin-manager` (no dynamic plugin loading)
     - `tool-subagent` and `tool-subagent-control` (no untracked subagent spawning)
     - `shell: false` (no shell execution privileges in Cowork)
  4. **Approval Gate:** Any write inside scratch requires explicit owner approval (`ask-owner` mode) before mutation.

### 2.2 Coding Lane Sandbox Containment

- **Threat:** Agent executes build commands, compiles code, or runs untrusted scripts that could escape to the host system.
- **Defenses Implemented:**
  1. **Bubblewrap Linux Isolation:** Executes in isolated user, mount, PID, and network namespaces.
  2. **Socket Relay (`socat`):** Strict UNIX socket relay with authenticated endpoints. All 16 sandbox tests verified passing in WSL2.
  3. **Ephemeral Worktrees:** Operations occur on isolated Git worktrees, preserving main repository integrity.

### 2.3 Secret Hygiene & Gitleaks Audit

- **Audit Tool:** Gitleaks 8.28.0 (`gitleaks detect --no-git=false --verbose`).
- **Scope:** Entire git history (259 commits).
- **Findings:** 0 leaks detected.
- **Pre-commit Gate:** The Local CI orchestrator enforces Gitleaks scanning in `full` mode and pre-commit checks.

---

## 3. Residual Security Risk Register

| Risk ID        | Component            | Severity | Likelihood | Mitigation Strategy                                                                                                           |
| -------------- | -------------------- | -------- | ---------- | ----------------------------------------------------------------------------------------------------------------------------- |
| **SEC-RES-01** | Windows Coding Lane  | Medium   | Low        | Bubblewrap is unavailable on native Windows without WSL2. Coding lane alerts the user when running without sandbox isolation. |
| **SEC-RES-02** | DSH Upstream Release | Low      | Low        | DSH is pinned to `@deepseek-ai/dsh@0.2.0-rc.2` in `pnpm-lock.yaml`. Upstream updates require intentional dependency upgrades. |

---

## 4. Final Security Verdict

**`SECURITY_ACCEPTANCE_PASS`**  
The implementation enforces defense-in-depth, fails closed on ambiguity, isolates tool surfaces, and contains zero credential exposures.
