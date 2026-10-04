# ADR-026: Cowork lane — a Nexar-supervised OpenWorker

**Status:** Accepted (2026-10-03) · Builds on ADR-004 (OpenWorker), ADR-013 (artifacts), ADR-015
(clients), ADR-016 (approvals), ADR-021 (Desktop), ADR-022 (credentials), ADR-024 (Operating Layer)
· Amends ADR-004 decision 4 (seam) · Implements NXR-056

## Context

ADR-024 routes productivity turns to the `cowork` lane, which reports unavailable today. ADR-004
decision 4 planned Nexar → OpenWorker through OpenWorker's automations API against a Nexar-supervised
`openworker-server`. The refreshed research ([openworker.md](../research/upstream/openworker.md),
upstream `v0.3.0`, `main` at `074ad3f`) shows the automations scheduler ticks every 30 s and models
scheduled tasks, not a job queue, while the WebSocket session protocol is the supported way to run a
turn now. Upstream also supports a supervisor-supplied in-memory API token, a private state directory
and binding the server's lifetime to its parent.

## Decision

### 1. Seam: a private, supervised `openworker-server` and its session protocol

- Desktop main launches its **own** `openworker-server` (never the owner's desktop sidecar): pinned
  version range starting at `0.3.0`, executable from owner configuration or `PATH`, shell-free, with a
  minimal explicit environment: `COWORKER_STATE_DIR` (private, under
  `%LOCALAPPDATA%\Nexar\Runtime\openworker`, outside the ACL-guarded state tree), a fresh random
  `COWORKER_API_TOKEN` per launch (in memory only, never written), `COWORKER_EXIT_WITH_PARENT=1` with
  the parent pid, `COWORKER_STATE_LOCK=strict`, `--host 127.0.0.1` and a free port.
- Nexar Desktop itself still opens no listener (ADR-021). The supervised child binds loopback only,
  authenticated by the per-launch token, as upstream designs it; Nexar is its only client.
- A Cowork turn is one OpenWorker session turn over `WS /ws/session/{id}` (token as the WebSocket
  subprotocol): Nexar-chosen session id, `set_mode` `interactive`, one `user_message` with the
  context@1 prompt, events streamed until `turn_done`; `interrupt` cancels.

### 2. Workspace and artifacts stay under Nexar's rules

The OpenWorker workspace for a turn is a fresh private scratch directory outside the project. The
project root is attached read-only. When the turn ends, Nexar imports produced regular files from the
scratch directory into the turn's drafts through `LocalArtifactStore` (sanitized names, size caps, no
links, `O_EXCL`), so ADR-013 holds: OpenWorker never writes into a project.

### 3. Approvals: deterministic Nexar policy, recorded

Every `permission_required` event is answered by Nexar policy, never by OpenWorker: file writes whose
target is inside the turn's scratch root are allowed; shell, network/web, connectors, scheduling,
MCP and anything outside the scratch root are denied. Each decision is recorded in
`@nexar/approvals` as a policy decision (`decidedBy: policy`, fingerprint-bound). OpenWorker cannot
approve itself, widen scope or reach an outward action. The private state has no connectors.

### 4. Resources: NRC chooses, OpenWorker executes

The NRC selects the turn's resource as for any task, restricted to resources OpenWorker can run:
pi-ai model resources whose provider maps to an OpenWorker provider and whose key the owner allowed
for OpenWorker (ADR-022 §4: per-provider "which runtimes may use it"). Nexar configures exactly those
keys into the private server at launch through its provider API and passes the chosen
`provider:model` per turn. Subscription logins are never used, keys never travel in the environment,
and OpenWorker never routes on its own. When no allowed resource exists, the lane reports
`configuration-missing`.

### 5. Availability, fallback and recursion

- States: `ready`, `openworker-missing`, `unsupported-version`, `startup-failed`,
  `configuration-missing`; the lane is available only when `ready`. Otherwise read/draft turns run
  `direct` with `fallbackReason: openworker-unavailable` and the UI says "OpenWorker unavailable.
  Using Nexar direct execution." (ADR-024 §9).
- Recursion is impossible by construction in this version: the supervised server is configured with
  no MCP servers, so it cannot call Nexar. Tasks carry the ADR-024 correlation (`depth`, chain with
  `openworker`); a Nexar entry point that receives a request whose chain already contains
  `openworker` refuses it. Turn-scoped delegation for child Nexar calls is follow-up work (NXR-059).

### 6. Lifecycle

Startup probe (health and version) with a bounded deadline; one server per Desktop process started on
first need; cancel, timeout and app exit end the session and the process tree. Restart follows ADR-024:
interrupted turns are never replayed.

## Rationale

- The session protocol is the supported, immediate turn seam; automations are scheduled work.
- A private server with a private state directory never touches the owner's OpenWorker data and keeps
  Nexar's policy authoritative.
- Importing drafts through `LocalArtifactStore` and answering approvals by policy keeps ADR-013/016
  intact without forking or patching OpenWorker.

## Alternatives considered

- **Automations API (ADR-004 d.4):** 30 s latency floor, accumulating task records; rejected for turns.
- **Nexar as OpenWorker's model provider (OpenAI-compatible gateway):** would need a Nexar listener and
  a security review; deferred.
- **Attaching to the owner's OpenWorker desktop app:** its token is in memory only and it is the
  owner's own state; rejected.

## Consequences

- New adapter in `integrations/openworker` (supervisor, session client, policy answerer), a Cowork
  executor port in `OperatingService`, Desktop availability/fallback state, per-provider OpenWorker
  opt-in in Providers, and a fake OpenWorker server for CI. Python is a runtime prerequisite of the
  owner's OpenWorker install, not of Nexar.

## Risks

- **Pre-1.0 upstream API.** Pinned version range, contract tests against a fake server, version probe.
- **Loopback listener of the child.** Per-launch random token, loopback only, Nexar the sole client,
  process tied to Desktop's lifetime.

## Amendment (2026-10-04): resource orchestration

§4 is superseded ([ADR-027](027-resource-orchestration-architecture.md) §7–9): OpenWorker's control loop uses an owner-pinned or NRC-Auto
control resource with `model-turn` from Nexar's registry (subscription, API, local or custom) through
the Control Model Gateway (NXR-063); until then, direct provider configuration with an allowed API key
remains a temporary compatibility path. Substantive units are delegated to Nexar (NXR-059). §5's "no
MCP servers" becomes "only the turn-scoped Nexar bridge server". OpenWorker's own `openai-codex` auth
store is not used as a Nexar connection.
