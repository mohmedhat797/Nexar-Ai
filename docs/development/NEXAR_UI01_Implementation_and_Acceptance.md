# NEXAR UI-01 — Upstream Intelligence Foundation

## Implementation & Acceptance Report

**Date:** 2026-10-17  
**Milestone:** UI-01 (Upstream Intelligence Foundation)  
**Git Branch:** `feat/nexar-upstream-intelligence-ui01`  
**Base Commit:** `6ea56f99d758bc18698c1fa5770b399a283fe6ad` (origin/main)  
**Agent Runtime:** Unified DeepSeek Harness (`@deepseek-ai/dsh@0.2.0-rc.2`)  
**Architecture Reference:** T3 Code Orchestrator V2 (Reference Only, Not Installed)  
**Status:** Verification Complete — Production Intelligence Foundation Ready

---

## 1. Executive Summary

UI-01 establishes the foundational data model, offline manifest, discovery adapters, state machine, and neutral contracts for tracking upstream dependencies and architectural references (ADR-029 / ADR-030).

### Key Architectural Invariants Enforced

1. **Zero Runtime Mutation:** Upstream observations, evaluation states, and registry records are strictly read-only and decoupled from Nexar Resource Controller (NRC) routing. An observed or approved upstream release never mutates runtime pins or execution paths automatically.
2. **Strict Role Partitioning:**
   - **DeepSeek Harness (`deepseek-harness`):** Configured as `runtime-dependency` pinned strictly to accepted `@deepseek-ai/dsh@0.2.0-rc.2`. Mutable floating dist-tags (`latest`, `next`, `canary`) are actively rejected.
   - **T3 Code Orchestrator (`t3-code`):** Configured strictly as `architecture-reference` with `currentRuntimePin: null`. It is not installed as an npm dependency, runtime agent, or secondary harness.
3. **Deterministic Update State Machine:** Six-stage version-scoped lifecycle (`AVAILABLE` → `EVALUATED` → `APPROVED` → `INSTALLED` → `VERIFIED` with `ROLLED_BACK`). Stages cannot be skipped, transition to `APPROVED` requires explicit evaluation evidence, and rolling back preserves the complete historical audit log.
4. **Secret-Free Manifest & State:** Manifest and observation validators actively scan for and reject any secret, token, key, password, credential, or bearer fields.
5. **Offline Operation:** All schema validation, state transitions, channel classifications, and manifest parsing operate 100% offline with zero network egress or telemetry.

---

## 2. Implemented Architecture & Components

### 2.1 Reviewed Upstream Manifest

- **File:** `config/upstreams.json`
- **Schema:** `schemaVersion: "1.0.0"`
- **Entries:**
  1. `deepseek-harness`:
     - Role: `runtime-dependency`
     - Discovery: `npm-registry`
     - Channel: `prerelease`
     - Accepted Pin: `@deepseek-ai/dsh@0.2.0-rc.2`
     - ADRs: `["ADR-002", "ADR-030"]`
     - Last Approved Evidence: Verified under NXR-SEC-02B / ADR-030 acceptance
  2. `t3-code`:
     - Role: `architecture-reference`
     - Discovery: `git-tags`
     - Channel: `stable`
     - Accepted Pin: `null` (never installed)
     - ADRs: `["ADR-029"]`
     - Last Approved Evidence: Architectural comparison reference for Resource Fabric v2

### 2.2 Neutral Contracts & State Transitions

- **File:** `packages/contracts/src/upstream.ts`
- **Exported Types & Interfaces:**
  - `UpstreamUpdateState`: `'AVAILABLE' | 'EVALUATED' | 'APPROVED' | 'INSTALLED' | 'VERIFIED' | 'ROLLED_BACK'`
  - `UpstreamRole`: `'architecture-reference' | 'runtime-dependency'`
  - `UpstreamDiscoveryAdapterKind`: `'git-tags' | 'npm-registry'`
  - `UpstreamReleaseChannel`: `'stable' | 'prerelease' | 'all'`
  - `UpstreamCompatibilityState`: `'COMPATIBLE' | 'EVALUATED' | 'INCOMPATIBLE' | 'UNKNOWN'`
  - `UpstreamApprovedEvidence`: Structured audit record (milestone, verifier, verdict, date, commit)
  - `UpstreamEntry`: Deeply typed manifest entry with role-specific invariants
  - `UpstreamManifest`: Manifest container
  - `UpstreamTransitionEvent`: Immutable audit record of state changes
  - `UpstreamUpdateRecord`: Immutable record of a specific version's lifecycle
  - `UpstreamUpdateObservation`: Validated observation from discovery adapters
- **Core Functions:**
  - `classifyReleaseChannel(version)`: Distinguishes `stable` (`1.2.3`), `prerelease` (`-rc`, `-beta`, `-preview`), and `alpha-nightly` (`alpha`, `nightly`, `canary`, `dev`, `snapshot`).
  - `isChannelAllowed(version, allowedChannel)`: Filter for channel compliance.
  - `isFloatingDistTag(tag)`: Detects and rejects mutable floating tags in package specifiers.
  - `normalizeObservation(raw)`: Validates untrusted observations, strips malicious keys, fails closed on missing repos.
  - `detectIntegrityDrift(existing, observation)`: Detects changed SHA/checksum under identical version strings.
  - `createUpdateRecord(observation, initialState)`: Creates an immutable record in `AVAILABLE` state.
  - `transitionUpdateState(current, nextState, options)`: Pure state transition machine enforcing valid lifecycle edges, mandatory evaluation evidence, and immutable history preservation.
  - `validateUpstreamManifest(raw)`: Validates offline manifest against security rules, ADR linkages, and role constraints.

### 2.3 Contract Exports

- **File:** `packages/contracts/src/index.ts`
- Re-exports all upstream contracts and validators as part of `@nexar/contracts`.

---

## 3. Golden Test Verification Evidence (18 Required Tests)

The implementation is verified by the unit test suite in `packages/contracts/src/upstream.test.ts`. All 18 tests pass deterministically offline:

|   #    | Test Objective                          | Requirement / Invariant Verified                                                    |  Status  |
| :----: | :-------------------------------------- | :---------------------------------------------------------------------------------- | :------: |
| **01** | Release classification: stable          | Correctly identifies standard semver releases (`1.0.0`, `v2.4.1`) as `stable`       | **PASS** |
| **02** | Release classification: prereleases     | Correctly identifies `rc`, `beta`, and `preview` builds as `prerelease`             | **PASS** |
| **03** | Release classification: alpha & nightly | Distinguishes `alpha`, `nightly`, `canary`, `dev` from standard prereleases         | **PASS** |
| **04** | Mutable tag rejection                   | Detects and rejects mutable floating dist-tags (`latest`, `next`, `canary`)         | **PASS** |
| **05** | Identity fail-closed                    | Fails closed when an entry lacks an official HTTPS repository URL                   | **PASS** |
| **06** | Metadata validation                     | Rejects observations with empty, whitespace, or invalid version strings             | **PASS** |
| **07** | Duplicate observation handling          | Safely handles duplicate observations without mutating audit history                | **PASS** |
| **08** | Artifact integrity drift                | Detects changed artifact hashes under the exact same version string (retag/tamper)  | **PASS** |
| **09** | Missing evaluation evidence             | Strictly forbids transition to `APPROVED` when evaluation evidence is missing       | **PASS** |
| **10** | Invalid transition sequence             | Forbids skipping lifecycle stages (e.g., `AVAILABLE` directly to `APPROVED`)        | **PASS** |
| **11** | Installed vs Verified distinction       | Strictly enforces distinction between `INSTALLED` and `VERIFIED` states             | **PASS** |
| **12** | Rollback audit trail                    | Preserves complete historical transition events when an update is rolled back       | **PASS** |
| **13** | Unknown compatibility handling          | Classifies unknown compatibility safely as `UNKNOWN` without guessing               | **PASS** |
| **14** | Zero automatic promotion                | Guarantees new observations never automatically promote runtime pins or routes      | **PASS** |
| **15** | Secret & credential rejection           | Strictly rejects any secret, token, key, password, or credential fields in manifest | **PASS** |
| **16** | DSH accepted pin preservation           | Strictly preserves accepted DeepSeek Harness pin `@deepseek-ai/dsh@0.2.0-rc.2`      | **PASS** |
| **17** | T3 Code architecture-reference          | Enforces T3 Code as `architecture-reference` with `null` runtime pin                | **PASS** |
| **18** | Zero NRC routing authority              | Verifies upstream intelligence has zero resource IDs, routes, or NRC authority      | **PASS** |

---

## 4. Verification & Quality Gates Evidence

Executed across the entire repository workspace in worktree `.nexar/nxr-ui01`:

```
pnpm format:check  → PASSED (All matched files use Prettier code style)
pnpm lint          → PASSED (ESLint clean, 0 errors, 0 warnings)
pnpm check:boundaries → PASSED (Boundary check passed: 1027 tracked files)
pnpm typecheck     → PASSED (tsc -b && tsc -p tsconfig.test.json && tsc -p apps/desktop/tsconfig.renderer.json)
pnpm test          → PASSED (218 test files passed | 20 skipped | 4345 unit & integration tests passed)
pnpm build         → PASSED (tsc -b && @nexar/cli build && @nexar/desktop build)
```

---

## 5. Architectural Compliance & Security Posture

1. **ADR-030 Integrity:** Preserved 100%. DeepSeek Harness remains the sole primary agent runtime (`@deepseek-ai/dsh@0.2.0-rc.2`). No secondary harnesses or alternative runtimes were added.
2. **ADR-029 Alignment:** Upstream intelligence provides the clean offline foundation required for Resource Fabric v2 cross-system learning without coupling into runtime control.
3. **T3 Code Role:** Kept strictly as an architecture reference model. No code was imported or executed from T3 Code.
4. **Offline Isolation:** Works completely without external network access, obeying the desktop-first offline execution guarantees of Nexar.
