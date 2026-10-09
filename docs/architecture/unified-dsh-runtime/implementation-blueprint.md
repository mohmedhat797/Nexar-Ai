# Unified DSH runtime — implementation blueprint

Companion to [ADR-030](../../adr/030-unified-dsh-first-agent-runtime.md) and
[architecture.md](architecture.md). Units are implemented by Claude Sonnet 5.5 (relay
`--model claude-sonnet-5-5`), reviewed and accepted by Claude Opus 5.5. Each unit is one
Conventional Commit (or a small series) on `feat/nexar-unified-dsh-runtime`; `pnpm check` must pass
before each commit.

## Package boundaries (after the transformation)

| Package                         | Owns                                                                                                                                                      | May import                              |
| ------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------- |
| `@nexar/contracts`              | `ControlEngine = 'dsh'` (legacy `'openworker'` readable only where persisted), `ProjectMemoryEntry` types                                                 | nothing                                 |
| `@nexar/project-memory` (new)   | Hardened file store for owner-confirmed project knowledge; render for context                                                                             | contracts                               |
| `@nexar/operating`              | `context@2` (required block + recent turns), lanes, fallback reasons `dsh-unavailable` / `dsh-control-unavailable`                                        | contracts, sessions                     |
| `@nexar/work-bridge` (moved)    | Work Bridge v2 (inbound MCP work), workflow bridge, schema                                                                                                | as today                                |
| `integrations/deepseek-harness` | `DshProfile` data, `renderProfileOverlay`, ACP client, host-local launcher, runtime resolver + version gate, `PermissionBroker`, Cowork permission policy | approvals, contracts, resource-registry |
| `@nexar/engine-gateway`         | unchanged contracts; engine label `dsh`                                                                                                                   | as today                                |
| `apps/desktop` main             | `DshCoworkService` (replaces `CoworkService`), DSH runtime status, packaging of the runtime                                                               | the above                               |
| `integrations/openworker`       | **deleted** after UDSH-06                                                                                                                                 | —                                       |

## Implementation order and dependencies

```text
UDSH-01 runtime foundation ──► UDSH-02 NRC/gateway binding ──► UDSH-03 Cowork profile ──┐
        │                                                                              ├─► UDSH-06 OpenWorker removal ─► UDSH-07 Desktop + packaging
        └──────────────► UDSH-04 Coding profile ───────────────────────────────────────┤
UDSH-05 context + project memory (independent of 02–04; integrates into 03/04 at render) ┘
```

UDSH-04 and UDSH-05 may run in parallel with UDSH-02/03 (disjoint files).

## UDSH-01 — DSH runtime foundation

**Files:** `integrations/deepseek-harness/src/{profiles.ts, overlay.ts, acp/local.ts, runtime/*.ts}`,
tests beside them; `scripts/install-dsh-runtime.mjs`; `.github/workflows/*` (CI step that installs
the pinned runtime and exports `NEXAR_DSH_BIN`).

- `profiles.ts`: `DshProfile` data for `cowork` and `coding`; `renderProfileOverlay(options)`:
  privacy rows (`session-log-deepseek`, `otel`, `session-telemetry-otel` disabled), the single
  `nexar` route, `acp` default `{provider: nexar, model: nexar-control}`, `system-prompt`
  `{personaPrefix, personaSuffix}`, disabled tool rows. All interpolations validated and emitted as
  JSON strings (valid YAML scalars); `{{` neutralized; size-bounded. Pure, unit-tested by parsing the
  output with a YAML-subset check and golden snapshots.
- Runtime resolution: `resolveDshRuntime({ override?, bundledDir?, platform })` →
  `{ command, args, env }` (Electron's Node with `ELECTRON_RUN_AS_NODE=1` running the bundled
  `dsh` entry, or an owner override); `probeDshVersion` runs `--version` with the base env and a
  deadline; mismatch with `DSH_PINNED_VERSION` → `unsupported-version`.
- Host-local ACP session (`acp/local.ts`): spawns with an explicit minimal env (`PATH`,
  `SystemRoot`, `TEMP`/`TMP`, `USERPROFILE`/`HOME`, `DSH_HOME`, `DSH_PERMISSION_MODE`,
  `DSH_TELEMETRY_DISABLED=1`, `NEXAR_CONTROL_TOKEN`), `cwd` = Nexar-created scratch (must be a
  realpath under the caller's scratch base; else `POLICY_REJECTED`), `windowsHide`, kills the process
  tree on close/abort/timeout; reuses `acp/run.ts` session machinery and `PermissionBroker`.
- `scripts/install-dsh-runtime.mjs <dir>`: `npm install --no-audit --no-fund --omit=dev`
  `@deepseek-ai/dsh@<pin>` into `<dir>`; prints the resolved bin path; refuses unpinned versions.
- **Acceptance:** overlay/unit tests offline; a real-runtime test (`NEXAR_DSH_BIN` set in CI)
  starts `dsh --profile acp` host-locally with a profile overlay, completes `initialize` →
  `session/new` → `session/close`, and asserts the version gate. A second real test runs one prompt
  against a deterministic fake Chat Completions server bound by the test (loopback) through the
  `nexar` route: the model returns a tool call `write` into the scratch, then a final text; the test
  asserts the file exists in scratch, the permission broker recorded the decision, and the final text.

## UDSH-02 — NRC binding (control and units)

**Files:** `apps/desktop/src/main/dsh-cowork.ts` (control/bridge plumbing part),
`packages/contracts/src/connection.ts` (`ControlEngine`), `packages/engine-gateway` label updates,
tests.

- Control grant opened through the existing `BridgeHost.mint` with engine `dsh`, the policy from
  `orchestration.cowork.controlResource`, and the existing `ControlGatewayChild.baseUrl()`; the turn
  token goes only into the DSH child env.
- Delegation: relay from `bridge-relay-path.ts` mounted as the ACP session's stdio MCP server
  `nexar` with `NEXAR_BRIDGE_ENDPOINT` + token env; permission broker `bridgeTools` = the two
  normalized relay tool names (computed as in the plane, `acp/gateway.ts`).
- One `DelegationUnitLimit` per Cowork turn shared across control restarts (B2); the standalone
  one-unit rule (`reviewOf` excluded, B4) unchanged.
- `ControlEngine` becomes `'dsh'`; persisted session records keep accepting `'openworker'` for reading.
- **Acceptance:** two fake model-turn resources on different connection ids: Auto selects by policy;
  owner pin selects the pinned one and the other receives no call; a pinned unavailable resource with
  fallback `none` fails the turn (`control-resource-failed`), with fallback `auto` restarts once on
  the next-ranked resource; usage recorded exactly once per gateway call; no provider key in the DSH
  child env (asserted on the spawn options).

## UDSH-03 — Cowork profile

**Files:** `apps/desktop/src/main/dsh-cowork.ts`, `cowork-drafts.ts` (generic draft import moved
from the OpenWorker package), `main.ts` wiring, `shared/api.ts` `CoworkStatusDto` states
(`ready`, `dsh-missing`, `unsupported-version`, `startup-failed`, `configuration-missing`), tests,
`e2e/cowork.e2e.ts`.

- `DshCoworkService` implements the existing Cowork port (`run`, `available`, `reason`,
  `fallbackReason`, `status`, `refresh`, `warm`, `dispose`, `effectiveControlResourceId`) so
  `operating.ts` and the renderer change minimally.
- Permission policy (`integrations/deepseek-harness/src/cowork-policy.ts`): allow `write`/`edit`
  tools only when every target path resolves inside the turn scratch; `ask-before-write` routes the
  allow through an owner approval (existing `askOwner` pattern); `read-only` denies writes;
  bridge tools allowed; all else denied; every decision recorded.
- Prompt: `context@2` text, the delegation instruction when delegation is active.
- Drafts imported through `LocalArtifactStore` (drafts/, sanitized, size-capped, no links); read-only
  imports nothing.
- **Acceptance:** Desktop E2E with the real bundled/CI DSH runtime and a deterministic fake control
  resource: a proposal-generation turn completes in a Cowork session and yields a saved draft
  artifact; cancel ends the process tree; a write outside scratch is denied and recorded.

## UDSH-04 — Coding profile

**Files:** `integrations/deepseek-harness/src/acp/launch.ts`, `acp/gateway.ts`,
`packages/host/src/lane-engine.ts` (overlay call), tests.

- `prepareAcpLaunch` renders `renderProfileOverlay({ profile: coding, nexarRoute, requiredContext })`
  in gateway mode (and the privacy rows in native-key mode). Sandbox, harvest, gates, review,
  approval and `commitPatch` unchanged.
- **Acceptance:** existing `lane-engine.dsh.integration.test.ts` and engineering suites stay green;
  new test asserts the coding overlay (persona, privacy rows, shell enabled, single route); on Linux
  CI the real-sandbox fixture repo test modifies a file and runs the gate, with no push (existing
  invariants).

## UDSH-05 — Unified context and project memory

**Files:** `packages/project-memory/*` (new), `packages/operating/src/context.ts` (`context@2`),
`packages/operating/src/service.ts` (inject memory), Desktop channels `projectMemory:list|add|remove`

- zod schemas + preload + renderer panel (minimal), tests.

* Store: one JSON per project, `0600`/`0700`, temp+rename, bounded (256 entries, 1,000 chars each,
  32 KiB rendered), realpath-contained, symlink/hardlink refusal, schema-validated, prototype-safe,
  corrupt → fail closed (`VALIDATION_ERROR`), writes only under the sessions lease holder.
* `context@2`: required block first, rendered completely or the turn fails with `VALIDATION_ERROR`
  `{ reason: 'required-context-overflow' }`; then recent turns (context@1 rules); manifest records
  required entry ids and hash. Rendered as owner-confirmed policy, separate from untrusted turn text.
* Required block also passed to the DSH overlay `personaSuffix` for both profiles.
* **Acceptance:** a constraint added during a Cowork session appears in the Code turn's context and
  the coding overlay, and again in a later Cowork turn; 50 long prior turns never displace it; an
  oversized required block fails closed; legacy session files (context@1 manifests) still load.

## UDSH-06 — OpenWorker removal

**Files:** delete `integrations/openworker/src/{supervisor,session,client,policy,providers}.ts` and
their tests/fakes; move `bridge.ts`, `schema.ts`, `artifacts.ts` (if still used), `workflow-bridge`
tests to `packages/work-bridge`; update `integrations/mcp`, `apps/cli`, `apps/desktop` imports,
settings (`openworker` executable settings removed, legacy keys ignored on read), renderer texts,
`scripts/check-boundaries.mjs`, docs (`overview.md`, `security.md`, README, guides).

- Persisted enums keep legacy literals readable (`engine: 'openworker'`, fallback reasons,
  `TaskOrigin.source: 'openworker'`), never produced.
- **Acceptance:** `rg -i openworker` over `packages integrations apps` (excluding legacy-read schema
  literals, migration tests and docs history) is empty; `pnpm check` green; Desktop E2E Cowork passes
  with no OpenWorker installed (asserted: settings have no OpenWorker executable).

## UDSH-07 — Desktop and packaging

**Files:** `apps/desktop/scripts/{build,package-win}.mjs`, `electron-builder` config,
`apps/desktop/src/main/dsh-runtime.ts`, Settings/status UI, `e2e/*`.

- Build step installs the pinned DSH runtime into `build/dsh-runtime` via
  `scripts/install-dsh-runtime.mjs` and ships it as `extraResources` (outside asar).
- Status surfaces `ready | dsh-missing | unsupported-version | startup-failed`; diagnostics are codes
  and fixed texts.
- **Acceptance:** packaged Windows app starts, reports DSH `ready` with the pinned version, and the
  packaged E2E runs a Cowork turn against the deterministic control resource.

## Rollback

Each unit is a separate commit. Before UDSH-06, OpenWorker code remains (unused once UDSH-03 wires
DSH); reverting UDSH-03 restores the OpenWorker Cowork lane. After UDSH-06, rollback is a revert of
the removal commit. No persisted format is rewritten: session records and approvals keep their
schema; project memory is a new file that older builds ignore.
