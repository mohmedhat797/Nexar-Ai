# NEXAR AI — RESOURCE FABRIC V2

## NXR-070B′: MULTI-API-KEY CONNECTIONS IMPLEMENTATION & ACCEPTANCE REPORT

**Assigned AI:** Gemini Argon  
**Role:** Principal Software Architect, Senior TypeScript Engineer, Security Reviewer & Release Integration Lead  
**Date:** 2026-10-17  
**Repository:** `mohmedhat797/Nexar-Ai`  
**Milestone:** NXR-070B′ (Multi-API-Key Connections & Credential Isolation)  
**Branch:** `feat/nxr-070b-multi-api-connections`  
**Base Accepted Main Commit:** `6ea56f99d758bc18698c1fa5770b399a283fe6ad`  
**Primary Agent Runtime:** Unified DeepSeek Harness (`@deepseek-ai/dsh@0.2.0-rc.2`)  
**Accepted Production Architecture:** ADR-030 (Accepted)  
**Accepted Resource Architecture:** ADR-029 (Accepted)

---

## 1. Executive Summary

Milestone **NXR-070B′** implements the core infrastructure for multiple API-key connections per provider within the Nexar Resource Fabric v2. It provides:

1. Strong, OS-enforced credential isolation for owner API keys in `DesktopKeyStore`.
2. Atomic persistence and backup rollback for user connections in `SettingsStore`.
3. Complete lifecycle state management (`ACTIVE`, `DISABLED`, `TOMBSTONED`) and active execution guards in `ConnectionManager`.
4. Strict account assurance levels (`VERIFIED_SAME_ACCOUNT` vs `OWNER_ASSERTED_SAME_ACCOUNT`).
5. Desktop IPC channels and Preload bridge endpoints for UI consumption.
6. Multi-connection catalog discovery and resource qualification in `integrations/pi`.
7. Comprehensive deterministic offline test suites and clean monorepo CI validation (`pnpm check`).

---

## 2. Architectural Design & Boundaries

### 2.1 Connection Identity & Lifecycle State Machine

In accordance with ADR-029:

- **Built-in Canonical Connections:** 5 immutable baseline connections (`deepseek.api`, `openai.chatgpt-plan`, `openai.subscription`, `anthropic.subscription`, `google.subscription`). Built-in connections cannot be removed or tombstoned.
- **Owner Custom Connections:** Follow ID scheme `<provider>.api.c<suffix>` where suffix is a 10-character lowercase alphanumeric string (e.g., `anthropic.api.cpersonal01`).
- **Lifecycle States:**
  - `ACTIVE`: Available for task admission and execution.
  - `DISABLED`: Temporarily disabled by the user; preserved in configuration, but ineligible for task admission.
  - `TOMBSTONED`: Soft-deleted connection; explicitly recorded in `tombstones` array, prevented from being recreated accidentally, and eligible for restore.
- **Credential Retention Principle:** When a connection is tombstoned/removed, its stored credential is **retained by default** in `DesktopKeyStore` to prevent accidental credential loss. Credential purging requires explicit invocation of `connectionForgetCredentials`.

### 2.2 Credential Isolation in `DesktopKeyStore`

To prevent cross-account credential leakage and collision:

- **Canonical Provider Keys:** `<PROVIDER>_API_KEY` (e.g., `ANTHROPIC_API_KEY`).
- **Owner Connection Keys:** `<PROVIDER>_API_KEY__C<SUFFIX>` (e.g., `ANTHROPIC_API_KEY__CWORKTEAM12`).
- **Owner Blob Names:** `<PROVIDER>__C<SUFFIX>` (e.g., `OPENAI__CPROTEAM01`).
- Key names and blob names are strictly validated using regex `^[A-Z0-9_]{1,64}__C[A-Z0-9]{1,32}$`. Any malformed or unauthorized key names are rejected with validation errors.
- Secrets are encrypted using Electron's `safeStorage` backend (DPAPI on Windows, Keychain on macOS, libsecret on Linux) with secure private file ACLs.

### 2.3 Atomic Configuration Persistence with `.bak` Backup

In `SettingsStore`:

- When writing connection configurations, the existing file is first copied to `<filepath>.bak`.
- The new configuration is written to `<filepath>.tmp.<random>` and atomically renamed to `<filepath>`.
- If parsing fails during load, `SettingsStore` reports validation failures cleanly without corrupting the store.

### 2.4 Active Execution Protection

In `ConnectionManager`:

- Active tasks acquire a lease (`acquireLease(connectionId)`) before running.
- In-flight execution prevents lifecycle mutations: attempting to disable, remove, forget credentials, or rotate keys on a connection with active leases throws `POLICY_REJECTED` (`ExecutionInFlightError`).
- Releasing all leases allows pending lifecycle operations to proceed safely.

---

## 3. Implementation Details by Subsystem

### 3.1 `@nexar/contracts` (`packages/contracts/src/connection.ts`)

- **Types & Enums:**
  - `ConnectionLifecycleState = 'ACTIVE' | 'DISABLED' | 'TOMBSTONED'`
  - `ConnectionIdentityAssurance = 'VERIFIED_SAME_ACCOUNT' | 'OWNER_ASSERTED_SAME_ACCOUNT' | 'UNVERIFIED_THIRD_PARTY' | 'OFFICIAL_ORGANIZATION'`
  - `PersistentConnectionRecord`: Full serializable representation including `id`, `provider`, `method`, `authClass`, `support`, `machine`, `label`, `enabled`, `builtIn`, `credentialGeneration`, `credentialScope`, `identityAssurance`, `lifecycleState`, `createdAt`, `updatedAt`.
  - `ConnectionsSettings`: Schema containing `connections: Record<string, PersistentConnectionRecord>` and `tombstones: string[]`.
- **Pure Helpers:**
  - `canConnectionAdmit(record)`: Returns `true` iff `record.enabled === true && record.lifecycleState === 'ACTIVE'`.
  - `isConnectionTombstoned(record, tombstones)`: Checks tombstone status.

### 3.2 `DesktopKeyStore` (`apps/desktop/src/main/desktop-key-store.ts`)

- Added pattern matchers:
  - `OWNER_KEY_PATTERN = /^([A-Z0-9_]{1,64})__C([A-Z0-9]{1,32})$/`
  - `OWNER_BLOB_PATTERN = /^([A-Za-z0-9_-]{1,64})__C([A-Z0-9]{1,32})$/`
- Added helper functions:
  - `isValidCredentialName(name)`
  - `isValidBlobName(name)`
- Updated `nameOf()` and `blobNameOf()` to accept owner connection suffixes.
- Updated `parseDocument()` to safely retain valid owner keys and blobs.

### 3.3 `SettingsStore` (`apps/desktop/src/main/settings-store.ts`)

- Added Zod schemas:
  - `PersistentConnectionRecordSchema`
  - `ConnectionsSchema`
- Added methods:
  - `getConnections(): Promise<ConnectionsConfigResult>`
  - `saveConnections(settings: ConnectionsSettings): Promise<void>`
- Enhanced `write()` with automatic `.bak` backup creation prior to atomic temporary write and rename.

### 3.4 Safe IPC Contracts & Preload Bridge (`apps/desktop/src/shared/`, `preload/`)

- Created `apps/desktop/src/shared/connections.ts` defining input and output DTO schemas:
  - `ConnectionDto`: Safe UI-facing projection (strips secret values, exposes `hasCredential`, `lifecycleState`, etc.).
  - `ConnectionIdSchema`, `ConnectionAddArgsSchema`, `ConnectionRotateKeyArgsSchema`, etc.
- Added IPC channels to `apps/desktop/src/shared/channels.ts`:
  - `connectionList`, `connectionAdd`, `connectionDisable`, `connectionEnable`, `connectionRemove`, `connectionRestore`, `connectionForgetCredentials`, `connectionRotateKey`, `chatgptPlanReplaceAccount`.
- Registered type-safe IPC invocations on `window.nexar` via `apps/desktop/src/preload/preload.ts` and `apps/desktop/src/shared/api.ts`.

### 3.5 `ConnectionManager` (`apps/desktop/src/main/connection-manager.ts`)

- Instantiated on desktop startup with `SettingsStore` and `DesktopKeyStore`.
- Implements:
  - `listConnections()`: Merges built-ins and custom connections, applying tombstone filtering and keystore presence checks.
  - `getConnection(id)`: Fetches individual record.
  - `addApiConnection(args)`: Validates provider, generates ID `provider.api.c<suffix>`, creates owner key `PROVIDER_API_KEY__C<SUFFIX>`, stores encrypted secret in `DesktopKeyStore`, and saves record with `OWNER_ASSERTED_SAME_ACCOUNT` assurance.
  - `disableConnection({ connectionId })`: Verifies no active leases, transitions to `DISABLED`, sets `enabled: false`.
  - `enableConnection({ connectionId })`: Transitions from `DISABLED` to `ACTIVE`, sets `enabled: true`.
  - `removeConnection({ connectionId })`: Verifies not built-in and no active leases, transitions to `TOMBSTONED`, adds ID to `tombstones` list. Retains credentials in KeyStore.
  - `restoreConnection({ connectionId })`: Removes ID from `tombstones`, transitions to `ACTIVE`, sets `enabled: true`.
  - `forgetCredential({ connectionId })`: Verifies no active leases, purges underlying key from KeyStore.
  - `rotateCredential({ connectionId, apiKey })`: Verifies no active leases, overwrites key in KeyStore, increments `credentialGeneration`.
  - `replaceChatGptPlanAccount({ idToken, accessToken, accountId })`: Validates token format, stores blob, updates ChatGPT plan binding with `VERIFIED_SAME_ACCOUNT` assurance.
  - Lease tracking (`acquireLease`, `releaseLease`, `activeLeasesCount`).

### 3.6 IPC Bridge Handlers (`apps/desktop/src/main/connection-channels.ts`)

- Implemented handlers with Zod schema validation and structured error handling (`VALIDATION_ERROR`, `POLICY_REJECTED`).
- Wired into desktop bridge in `apps/desktop/src/main/bridge.ts` and `apps/desktop/src/main/channel.ts`.

### 3.7 `integrations/pi` Multi-Connection Support (`integrations/pi/src/catalog-discovery.ts`)

- Added optional `connection` and `credentialName` configuration to `piCatalogDiscoverySource`.
- Default connection: outputs canonical resource IDs `pi.<provider>.<model>` and default key `PROVIDER_API_KEY`.
- Owner connection: outputs connection-qualified resource IDs `pi.<connection.id>.<model>` and owner key `PROVIDER_API_KEY__C<SUFFIX>`, preventing any resource ID collision between multiple accounts on the same provider.

---

## 4. Verification & Testing Evidence

### 4.1 Unit & Integration Test Summary

| Test File                                          | Tests Passed |  Tests Skipped  | Duration  | Key Validations                                                    |
| :------------------------------------------------- | :----------: | :-------------: | :-------: | :----------------------------------------------------------------- |
| `packages/contracts/src/connection.test.ts`        |    **33**    |        0        |   12ms    | Lifecycle admission rules, tombstone checks, schema validation.    |
| `apps/desktop/src/main/desktop-key-store.test.ts`  |    **52**    | 2 (OS-specific) |   2.4s    | Owner key/blob name validation, parse retention, encryption, ACLs. |
| `apps/desktop/src/main/connection-manager.test.ts` |    **19**    |        0        |   449ms   | Full lifecycle CRUD, lease guards, tombstone restore, IPC bridge.  |
| `integrations/pi/src/multi-connection.test.ts`     |    **3**     |        0        |    7ms    | Multi-connection discovery, ID qualification, credential scoping.  |
| **Total Focused Milestone Tests**                  |   **107**    |      **2**      | **~2.9s** | **100% Pass**                                                      |

### 4.2 Full Repository CI Gate (`pnpm check`)

Executed full verification across monorepo:

1. `pnpm format:check` — **PASSED** (all files Prettier compliant).
2. `pnpm lint` — **PASSED** (ESLint 0 errors, 0 warnings).
3. `pnpm check:boundaries` — **PASSED** (1056 tracked files validated).
4. `pnpm typecheck` — **PASSED** (Root, Test tsconfig, and Desktop Renderer tsconfig all 0 errors).
5. `pnpm test` — **PASSED** (**220 test files passed, 0 failed, 4,398 tests passed**, 178 live/bwrap skipped).
6. `pnpm build` — **PASSED** (CLI relay, Desktop main, preload, bridge-relay, control-gateway, signin-callback, and Vite renderer bundled).

---

## 5. Security & Isolation Compliance

- **No Secret Bleed:** Secret API keys never escape to IPC DTOs, logs, or plain settings files.
- **Strict Key Naming Boundaries:** KeyStore limits custom keys to `<PROVIDER>_API_KEY__C<SUFFIX>` pattern, preventing arbitrary secret injection.
- **Lease Protection:** In-flight tasks cannot have their credentials rotated or deleted beneath them.
- **Tombstone Preservation:** Soft-deleted connections cannot be silently resurrected or collided with.
- **OS Namespace Isolation Intact:** Cowork continues to run exclusively in WSL2/Bubblewrap; Coding retains sandboxing.
- **DSH Pinned:** Primary agent runtime remains strictly `@deepseek-ai/dsh@0.2.0-rc.2`.

---

## 6. Acceptance Verdict

```
MILESTONE_NXR_070B_IMPLEMENTATION_VERIFIED
CREDENTIAL_ISOLATION_AND_LIFECYCLE_ACCEPTED
FULL_CI_GATE_PASSED
READY_FOR_PR_CREATION_AND_OWNER_HANDOVER
```
