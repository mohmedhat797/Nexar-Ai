# Architectural Review: ADR-030 — Unified DeepSeek Harness First Agent Runtime

**Review Date:** 2026-10-10  
**Target Document:** `docs/adr/030-unified-dsh-first-agent-runtime.md`  
**Current Status:** **Proposed** (Preserved per governance policy)  
**Review Recommendation:** **ADR030_READY_FOR_OWNER_APPROVAL**  
**Associated PR:** [#41 (Draft)](https://github.com/mohmedhat797/Nexar-Ai/pull/41)  
**Evaluated Head:** `ead61d8`

---

## 1. Architectural Summary & Vision Alignment

ADR-030 establishes the unified agent runtime architecture for Nexar AI:

> **ONE NEXAR. ONE PRIMARY AGENT RUNTIME. MULTIPLE SPECIALIZED OPERATING MODES. MULTIPLE MODELS AND PROVIDERS. ONE RESOURCE INTELLIGENCE SYSTEM.**

### System Boundary Division

| Responsibility               | Nexar Core & Host Domain                           | DeepSeek Harness (DSH) Domain      |
| :--------------------------- | :------------------------------------------------- | :--------------------------------- |
| **User Experience & Shell**  | Desktop app, CLI, chat sessions, operating modes   | Headless protocol execution        |
| **Model & Resource Routing** | Nexar Resource Controller (NRC), quota, fallback   | Consumes selected model endpoint   |
| **Project Memory & State**   | Protected canonical system prompts, project files  | Ephemeral conversation context     |
| **Security & Governance**    | Permission brokering, confirmation prompts         | Executes within sandboxed boundary |
| **Agent Execution Loop**     | Orchestration, mode selection, telemetry ingestion | Tool-calling loop, ACP protocol    |

---

## 2. Verification of Architectural Invariants

### 2.1 Complete Removal of OpenWorker

- **Verification:**
  - Full codebase inspection confirmed zero active references to OpenWorker in runtime paths.
  - Boundary check (`pnpm check:boundaries`) confirms no leaks or references across 970 tracked files.
  - Cowork and Coding operating modes both execute exclusively via DeepSeek Harness runtime bridge.

### 2.2 Preserved Canonical Project Memory

- **Verification (`apps/desktop/src/main/dsh-cowork.context.real.test.ts`):**
  - Project memory blocks remain immutable and protected.
  - When automatic conversation compaction triggers, the canonical system block and hash remain unchanged.
  - Model outputs and synthetic summarizer text are strictly treated as untrusted conversation tokens and are never elevated into owner memory.
  - Oversized system blocks fail-closed before any ACP spawn or network calls occur.

### 2.3 Provider Intelligence & NRC Integration

- **Verification:**
  - NRC policy governs model routing, cost accounting, and fallback.
  - The DSH loopback gateway correctly translates requests without bypassing NRC quotas or security policies.
  - Local echo and test doubles ensure 100% offline testability without requiring live API keys or paid inference.

### 2.4 Packaging & Runtime Bundling

- **Verification:**
  - Production packaging bundles `@deepseek-ai/dsh@0.2.0-rc.2` directly into `resources/dsh-runtime`.
  - Packaged Desktop E2E executes cleanly using only the bundled runtime (`NEXAR_DESKTOP_EXECUTABLE`), with external `NEXAR_DSH_ENTRY` explicitly disabled.
  - Authenticode inspection and artifact mtime freshness checks ensure packaging integrity.

---

## 3. Residual Risks & Governance Boundaries

1. **GitHub Actions Billing Dependency:**
   - GitHub-hosted Actions minutes are exhausted (3,000 / 3,000).
   - Mitigated by Nexar Local CI orchestrator (`pnpm ci:local:quick` and `pnpm ci:local:full`) and GitHub Self-Hosted Runner configuration.
2. **Native Linux CI Gate:**
   - Linux Bubblewrap unprivileged sandbox is verified under WSL2 (12 passed, 4 skipped for socat).
   - Native Ubuntu Desktop E2E requires self-hosted runner deployment with an active Xvfb display server.
3. **Status Preservation:**
   - In accordance with owner rules, ADR-030 remains **Proposed** in the repository tree until the repository owner explicitly merges PR #41.

---

## 4. Final Architectural Verdict

```text
ADR030_READY_FOR_OWNER_APPROVAL
```

The Unified DeepSeek Harness First Agent Runtime implementation is architecturally sound, thoroughly tested, secure, and ready for owner approval and merge.
