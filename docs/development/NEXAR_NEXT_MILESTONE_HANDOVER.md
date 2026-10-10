# Nexar AI — Next Milestone Handover: NXR-070 Resource Fabric v2

**Source Milestone:** Unified DeepSeek Harness Runtime & Local CI Infrastructure  
**Target Milestone:** NXR-070 — Resource Fabric v2  
**Target Branch:** New branch from `feat/nexar-unified-dsh-runtime` (or `main` post-PR #41 merge)  
**Author:** Gemini 3.8 High (Google Antigravity)  
**Date:** October 2026

---

## 1. Executive Handover Summary

The codebase is stabilized, verified, and sealed. All systems adhere strictly to the foundational architectural vision:
**ONE NEXAR. ONE PRIMARY AGENT RUNTIME. MULTIPLE OPERATING MODES. MULTIPLE MODELS AND PROVIDERS. ONE RESOURCE INTELLIGENCE SYSTEM.**

With the Unified DSH Runtime and Local CI infrastructure fully operational and verified, the repository is ready to commence **NXR-070 — Resource Fabric v2**.

---

## 2. Invariants that NXR-070 Must Uphold

When developing Resource Fabric v2, incoming engineers and agents must observe these non-negotiable architectural boundaries:

1. **NO OPENWORKER:** Do not reintroduce OpenWorker, worker-pools, or separate agent harnesses. DeepSeek Harness is the singular execution engine.
2. **NRC AUTHORITY:** Nexar Resource Controller remains the sole arbiter of quotas, units, provider selection, and token economics. Resource Fabric v2 extends NRC; it must never bypass NRC.
3. **PROJECT MEMORY OWNERSHIP:** Project memory is canonical within Nexar. DSH is a consumer, not the source of truth.
4. **COWORK & CODING UNIFICATION:** Both modes leverage DSH via profiles (`COWORK_PROFILE` and `CODING_PROFILE`). Do not fragment the execution layer.
5. **FAIL-CLOSED LOCAL CI:** All changes must pass `scripts/local-ci/runner.mjs --mode=quick` prior to committing. Never disable preflight checks or gitleaks scans.

---

## 3. Recommended NXR-070 Kickoff Checklist

Before starting work on NXR-070:

- [ ] Owner reviews and merges (or formally accepts) PR #41.
- [ ] Transition ADR-030 from `Proposed` to `Accepted`.
- [ ] Create a fresh milestone branch: `feat/nxr-070-resource-fabric-v2`.
- [ ] Run `node scripts/local-ci/runner.mjs --mode=quick` to confirm local preflight health.
- [ ] Inspect NRC interfaces in `packages/core/src/resource/` and `packages/approvals/`.

---

## 4. Final Handover Signoff

**`NXR070_PREREQUISITES_SATISFIED`**  
The foundation is solid, secure, and production-tested. The next milestone may begin upon owner authorization.
