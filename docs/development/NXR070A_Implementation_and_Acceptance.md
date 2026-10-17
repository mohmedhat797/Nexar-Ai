# NXR-070A′ — Connection Identity Compatibility Slice

## Implementation & Acceptance Report

**Date:** 2026-10-17  
**Milestone:** NXR-070A′ (Connection Identity Compatibility Slice)  
**Git Branch:** `feat/nxr-070a-connection-identity`  
**Base Commit:** `6ea56f99d758bc18698c1fa5770b399a283fe6ad` (origin/main)  
**Agent Runtime:** Unified DeepSeek Harness (`@deepseek-ai/dsh@0.2.0-rc.2`)  
**Status:** Verification Complete — Production Implementation Ready

---

## 1. Executive Summary

NXR-070A′ establishes the foundational connection identity contracts and compatibility fixtures for Resource Fabric v2 (ADR-029) without altering live credentials, provider authentication, NRC routing decisions, canonical memory ownership, or execution boundaries.

All built-in connection IDs, resource IDs, and pins from accepted `main` (`6ea56f99d758bc18698c1fa5770b399a283fe6ad`) reproduce byte-for-byte with 100% backward compatibility.

---

## 2. Implemented Architecture & Contracts

### 2.1 Connection Definition & Credential Scope

- **File:** `packages/contracts/src/connection.ts`
- **Contracts:**
  - `ConnectionCredentialScope`: Safe discriminated reference union (`'keystore'`, `'account'`, `'native-home'`, `'none'`). Holds no secrets or credentials.
  - `ConnectionDefinition`: Additive contract extending `ResourceConnection` with `machine: 'desktop' | 'plane'`, `label`, `enabled`, `builtIn`, and `credentialScope`.
  - `ConnectionHost`: Union literal `'desktop' | 'plane'`.

### 2.2 Host-Qualified Connection Key

- **Function:** `connectionKey(machine: ConnectionHost, connectionId: string): string`
- **Output:** `${machine}:${connectionId}`
- **Validation:** Strict validation of host literals (`desktop` and `plane` only) and non-empty trimmed `connectionId`. Prevents cross-host credential bleeding and enables unambiguous attribution.

### 2.3 Centralized Built-In Connection Registry

- **Registry:** `BUILTIN_CONNECTIONS: Readonly<Record<BuiltinConnectionId, ConnectionDefinition>>`
- **Registered Built-ins:**
  1. `anthropic.subscription` (Claude Code native subscription)
  2. `openai.subscription` (Codex native subscription)
  3. `google.subscription` (Antigravity native subscription)
  4. `deepseek.api` (DeepSeek Harness API connection)
  5. `openai.chatgpt-plan` (ChatGPT Plan responses connection)
- **Immutability:** Deeply frozen (`Object.isFrozen`) at module initialization.

### 2.4 Owner-Created Connection ID Generator

- **Function:** `generateConnectionId(family: string, options?: GenerateConnectionIdOptions): string`
- **Format:** `<family>.c<10 base32>` using RFC 4648 lowercase base32 (`abcdefghijklmnopqrstuvwxyz234567`).
- **Randomness:** Cryptographically secure `globalThis.crypto.getRandomValues` by default; supports deterministic injected `rng` for testing.
- **Collision Protection:** Actively checks candidate IDs against:
  - `BUILTIN_CONNECTIONS`
  - Caller-supplied `existingIds`
  - Caller-supplied `tombstonedIds`
  - Caller-supplied `isTaken` predicate
- **Bounding:** Bounded retries (default `maxAttempts: 10`) with explicit failure throwing on exhaustion.

### 2.5 Catalog Resource ID Materialization

- **File:** `packages/resource-registry/src/materialize.ts`
- **Function:** `catalogResourceId(connection: ConnectionDefinition, provider: string, model: string): ResourceId`
- **Behavior:**
  - Built-in connection (`connection.builtIn === true`): Reproduces canonical `pi.<provider>.<model>` slug byte-for-byte.
  - Owner connection (`connection.builtIn === false`): Derives deterministic `catalog:<sha256([connectionKey, provider, model])>`.
  - Guarantees two distinct accounts using the same provider/model never produce colliding resource IDs.

### 2.6 Native Inventory & Plan Attribution Alignment

- **Files:** `packages/host/src/native-inventories.ts`, `apps/desktop/src/main/plan-inventory-identity.ts`
- Read canonical identity metadata directly from `BUILTIN_CONNECTIONS`, eliminating duplicate hardcoded identity strings while preserving runtime compatibility.

### 2.7 Desktop Plane DTO Attribution Helpers

- **File:** `apps/desktop/src/main/code-plane.ts`
- **Functions:**
  - `hostQualifyPlaneConnection(connectionId: string): string`
  - `hostQualifyPlaneResource(dto: PlaneResourceDto): PlaneResourceDto & { readonly machine: 'plane' }`
- Qualifies plane resources on receipt with `machine: 'plane'` without changing wire frames or negotiated protocol.

---

## 3. Golden Test Verification Evidence

The implementation is validated by comprehensive offline unit test suites in `packages/contracts/src/connection.test.ts`, `packages/resource-registry/src/materialize.test.ts`, and `apps/desktop/src/main/code-plane.test.ts`:

| Test Code  | Objective                                                                                              |  Status  |
| :--------- | :----------------------------------------------------------------------------------------------------- | :------: |
| **TST-01** | Built-In Identity Compatibility (exact byte-for-byte match with accepted main for all 5 built-ins)     | **PASS** |
| **TST-02** | Multi-Connection Identity (two distinct owner connections produce distinct SHA256 catalog IDs)         | **PASS** |
| **TST-03** | Stability across label changes, credential rotation, preference updates, and timestamps                | **PASS** |
| **TST-04** | Collision Handling with injected deterministic RNG, collision detection, and bounded retry failure     | **PASS** |
| **TST-05** | Host Qualification (Desktop vs Plane differentiation for identical connection IDs)                     | **PASS** |
| **TST-06** | Backward Compatibility (resource pins, legacy plan aliases, NRC selections, inventory hashes)          | **PASS** |
| **TST-07** | Security Invariant Regression (zero credentials in IDs, zero leaks, no unauthorized authority changes) | **PASS** |

---

## 4. Engineering Quality & Repository Verification Gates

All official repository quality and verification gates were executed locally and passed cleanly:

```text
pnpm format:check        -> PASS (All matched files use Prettier code style)
pnpm lint                -> PASS (0 errors, 0 warnings across all packages)
pnpm check:boundaries    -> PASS (1027 tracked files conform to architectural boundaries)
pnpm typecheck           -> PASS (tsc -b and desktop renderer types verify cleanly)
pnpm test                -> PASS (217 test files passed, 4344 tests passed, 0 errors)
pnpm build               -> PASS (CLI relay and Desktop bundles compiled cleanly)
gitleaks git --verbose   -> PASS (287 commits scanned, no leaks found)
```

---

## 5. Scope Exclusions & Governance Discipline

The following capabilities were strictly excluded from NXR-070A′:

- No persistent custom connection storage (deferred to 070B′)
- No credential encryption or storage modifications (deferred to 070B′)
- No live provider authentication or login flows
- No multi-account UI management
- No DeepSeek Harness version changes (retains `@deepseek-ai/dsh@0.2.0-rc.2`)
- No T3 Code runtime installation
- No NRC scoring or default routing modifications
- No `context@3` or Project Memory restructuring
- Reversibility: 100% reversible via single git revert with zero migration remnants.
