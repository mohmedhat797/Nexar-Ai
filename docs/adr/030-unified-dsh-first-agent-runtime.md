# ADR-030: Unified DSH-first agent runtime

- **Status:** Proposed (2026-10-10). Implementation proceeds on `feat/nexar-unified-dsh-runtime` as a
  Draft PR; nothing merges until the owner accepts this ADR.
- **Supersedes on acceptance:** ADR-004 (OpenWorker productivity engine), ADR-026 (Cowork lane —
  supervised OpenWorker). **Amends:** ADR-002, ADR-024 §4/§9/§10, ADR-027 §7A/§9, ADR-028.
- **Detail:** [`docs/architecture/unified-dsh-runtime/`](../architecture/unified-dsh-runtime/architecture.md)
  (architecture, implementation blueprint, migration plan, threat model, acceptance matrix).
- **Relation to NXR-070 / PR #40:** compatible decisions are kept (connection-scoped identity,
  multi-account isolation, provenance, unknown-quota semantics, owner-approved decisions). Its
  dual-harness assumption (OpenWorker for Cowork, DSH for Code) is **not** adopted. ADR-029 stays
  Proposed and independent.

## Context

Nexar v0.6 runs two agent harnesses: a supervised Python OpenWorker server for Cowork (ADR-026) and
DeepSeek Harness (`dsh`) over ACP inside the WSL2 sandbox for Code (ADR-018/019/027 §9b). Both are
already driven through the same Nexar-owned seams — the Control Model Gateway (control loop), the
Intelligence Bridge (delegated units), the shared `DelegationUnitLimit`, recorded permission
decisions and `LocalArtifactStore` — but the owner pays for two runtimes, two permission
translators, two provider bridges, a Python prerequisite, and a loopback OpenWorker server.

Upstream facts (verified 2026-10-10, [`deepseek-harness.md`](../research/upstream/deepseek-harness.md)
plus the 0.2.x re-check recorded in the architecture document):

- Latest tag `dsh-v0.2.1-alpha.2` (`d743267`, 2026-10-09, npm `alpha`); npm `latest`/`next` =
  `0.2.0-rc.2` (`639ed01`), the version Nexar's adapter already pins and verified.
- `dsh` runs natively on Windows (base bundle switches `tool-bash`→`tool-pwsh`,
  `bash-sandbox`→`pwsh-sandbox` on `win32`).
- ACP (`dsh --profile acp`): persistent sessions, per-session MCP servers, `session/cancel`,
  `session/request_permission` round-trips, per-session model options, context-usage updates.
- SDK (`dsh --profile sdk`): no cancel, no server→client requests (approvals are a "dead
  capability"), one model per process, no per-prompt result — in 0.2.1-alpha.2 as in rc.2.
- Configuration is a documented patch-overlay surface (`--patch` YAML rows by id; a row's config
  is replaced whole). The system prompt's `personaSuffix` is re-assembled every model step;
  `compaction-basic` condenses only conversation history.

## Decision

1. **One primary agent runtime.** DeepSeek Harness is Nexar's only agent harness. Cowork and Coding
   are **DSH profiles**, not engines. A future mode is a new profile (data), never a new harness.
   Native agents (Claude Code, Codex) remain NRC **work resources** (bounded units, Code-lane
   native executor); they are not harnesses.
2. **Managed Cowork/Coding profile interface: ACP v1 over stdio**, Nexar's own JSON-RPC client (`integrations/deepseek-harness`),
   `dsh --profile acp --patch <nexar overlay>`. ACP is the only DSH surface with cancel and
   permission round-trips, both mandatory for Nexar authority (B3). SDK, headless and in-process
   Cordis plugins are rejected (no approvals / one-shot / unstable internals). Nexar configures DSH
   only through documented overlay rows and environment variables listed in the architecture
   document; it imports no `@deepseek-ai/*` package. The existing standalone DSH SDK resource adapter
   remains a compatibility work resource outside these managed profiles; it is not a Cowork runtime
   and must never be eligible for Desktop direct session fallback.
3. **Pin `@deepseek-ai/dsh@0.2.0-rc.2` exactly.** It is the reviewed version and
   the one Nexar's ACP code was tested against. `0.2.1-alpha.2` is rejected (alpha channel, newer
   is not more stable). The runtime refuses to start on a version mismatch. Upgrades are deliberate,
   re-verified changes to the pin.
4. **Two placements, one contract.** Cowork runs a host-local DSH ACP child of Desktop main
   (Windows-native) — one process per engine turn, `cwd` = a private scratch directory,
   `DSH_PERMISSION_MODE=workspace-write` rooted there, isolated `DSH_HOME`, minimal explicit
   environment. Coding keeps its placement: DSH inside the WSL2 bwrap sandbox through
   `PlaneLaneEngine`/`EngineeringRunner`, unchanged security envelope. Both use the same
   `DshProfile` contract, overlay renderer, ACP client and permission broker.
5. **NRC stays the model authority.** A DSH profile's overlay declares exactly one model route,
   `nexar` (pi-ai `openai-completions` → the Control Model Gateway, ADR-027 §7A), and selects it as
   the ACP default. Cowork never gives a provider key to DSH; the old OpenWorker direct-key path is
   not carried over. The one exception is the existing Code-lane native-key path (ADR-027 §9b), where
   the NRC itself selected the DSH resource and its own DeepSeek credential: that overlay keeps the
   resource's route instead of `nexar`, and everything else in the profile applies. The control resource is pinned per engine turn by the gateway; a model-change
   notification naming any other route fails the turn. Delegated units go through the Intelligence
   Bridge MCP relay mounted per ACP session, under the per-turn `DelegationUnitLimit` (B2). Usage is
   accounted once, by the gateway/bridge, never from DSH's token meter.
6. **Nexar is the permission authority.** Every `session/request_permission` is answered by Nexar's
   `PermissionBroker` under the profile policy (deny by default, `*_always` never chosen, decisions
   recorded). Cowork: writes inside the turn scratch allowed (owner-asked under `ask-before-write`,
   denied under `read-only`), the Bridge's two tools allowed, everything else denied. The Cowork
   overlay additionally disables shell, jobs, web, plugin-manager and telemetry rows. DSH permission
   modes never grant Nexar authority.
7. **Sessions and context.** Nexar sessions remain canonical with one writer (B9). Every DSH session
   is per engine turn, in a per-turn `DSH_HOME`, and deleted at turn end — no native session, grant
   or approval survives a turn (B5). Owner-confirmed project knowledge lives in a new Nexar-owned
   **project memory** (constraints, decisions, requirements, review obligations, pending work),
   rendered by `context@2` in a pinned section and in the DSH system prompt `personaSuffix`, so DSH
   compaction cannot drop it. If required context does not fit its budget, the turn fails closed;
   it is never truncated. Model output never becomes required context without owner confirmation.
8. **OpenWorker is removed** from every execution path after DSH Cowork passes parity. The generic
   Work Bridge v2 (inbound MCP `nexar.submit_work`) moves to `@nexar/work-bridge`. Legacy records
   that name `openworker` stay readable; no code path starts it.
9. **Packaging.** Desktop ships the pinned DSH runtime (installed from the npm registry at build time
   with lockfile integrity) and runs it with Electron's Node (`ELECTRON_RUN_AS_NODE=1`); an owner
   override path is allowed and version-checked. No elevation, no PATH dependency.

## Security invariants preserved

B1 capability validation before alias normalization · B2 monotonic per-turn `DelegationUnitLimit`
(also across control restarts) · B3 upstream permission modes never grant Nexar authority · B4
standalone one-unit grants exclude `reviewOf` · B5 no native-session carry-over of grants · B6
stable resource ids and pins · B7 write-capable engineering sandboxed, minimal child environments ·
B8 existing sessions readable and protected · B9 single session writer. Mapping to tests:
[`acceptance-matrix.md`](../architecture/unified-dsh-runtime/acceptance-matrix.md).

## Consequences

- Python and OpenWorker are no longer prerequisites; Cowork works on a clean Windows install.
- Cowork requires a control-compatible (`model-turn`) resource; without one it falls back to
  `direct` with `fallbackReason: dsh-control-unavailable` (honest fallback, ADR-024 §9). Desktop
  direct session execution is **A: bounded, non-agent model execution**: NRC routes one text request
  only to a `model` descriptor bound to the reviewed `pi` or `echo` adapter; it starts no agent loop,
  tools, native runtime session or delegation. It may store the returned text as a Nexar draft,
  except in read-only Cowork. Agent/tool-runtime descriptors and unreviewed adapter bindings are
  excluded before routing. An owner preference naming a registered forbidden resource fails with
  `POLICY_REJECTED` (`direct-resource-not-bounded`); no eligible bounded resource fails with
  `NO_ELIGIBLE_RESOURCE`. Unknown preference ids retain NRC preference semantics. Extending the
  bounded adapter allowlist requires review and regression evidence. Native Code-lane work resources
  keep their existing sandboxed execution contract.
- DSH is a developer preview with breaking changes; the exact pin, version gate, overlay row tests
  and real-runtime CI tests are the containment.
- Desktop installer grows by the DSH runtime's dependency tree.

UDSH-08 independent implementation findings and evidence are recorded in
[`UDSH08_Architecture_Review.md`](../architecture/unified-dsh-runtime/UDSH08_Architecture_Review.md).
The review corrected unrestricted direct fallback, shared Coding ACP state, model-route change
enforcement and missing persistent control-call accounting. Remaining acceptance gaps are blockers; this ADR remains
Proposed until the owner explicitly accepts it.

## Alternatives considered

- **Keep OpenWorker for Cowork (NXR-070 dual harness):** two runtimes, two permission translators,
  Python; rejected by the owner's objective.
- **DSH SDK profile:** no cancel and no approval channel; would force `danger-full-access` or
  fail-closed tools. Rejected.
- **DSH Cordis plugin inside the runtime:** lockstep-versioned internals; rejected (ADR-008).
- **Long-lived shared DSH process for all Cowork turns:** the sandbox root is the process `cwd` and
  credentials/overlays are per launch; per-turn processes give per-turn isolation. Rejected for v1.
