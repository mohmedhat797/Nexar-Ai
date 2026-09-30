# ADR-002: DeepSeek Harness as primary agent execution kernel

**Status:** Accepted, amended by research (2026-09-30).
Evidence: [`docs/research/upstream/deepseek-harness.md`](../research/upstream/deepseek-harness.md)
(inspected `deepseek-ai/deepseek-harness@639ed01`, npm `@deepseek-ai/dsh@0.2.0-rc.2`).

## Context

Nexar needs an agent execution and orchestration kernel (agent loop, tools, sessions, subagents,
skills, MCP, provider routing) and should not build one. DeepSeek Harness (`dsh`, MIT, Node) is an
"everything is a plugin" harness built on Cordis. Research findings that shape the decision:

- **No in-process embedding API.** The SDK client always spawns a `dsh` runtime process and speaks
  newline-delimited JSON-RPC 2.0 over stdio (`initialize`, `session/prompt`, `shutdown`; notifications
  `session.event`, `session.status`, `subagent.started|finished`). Other routes: `dsh --profile
headless --json`, and a standard ACP v1 server (`dsh --profile acp`, the only route with cancel and
  permission round-trips).
- Developer preview, explicit "THERE WILL BE COMPATIBILITY-BREAKING CHANGES", near-daily
  prereleases, lockstep versions. Installing the SDK client pulls ~541 npm packages.
- One provider/model per runtime process. DSH already routes to many providers through its own
  `llm-pi-ai` adapter (pinned to pi-ai `^0.87.1`) and can orchestrate Claude Code and Codex as
  subagents.
- By default it uploads session-log suffixes to the official DeepSeek API; it keeps credentials in
  `$DSH_HOME/.credentials.yaml`.

## Decision

1. DeepSeek Harness is Nexar's **primary agent execution kernel** for engineering work, modeled as an
   **agent resource** (`kind: { type: 'agent', agent: 'deepseek-harness', interface: 'rpc' }`)
   selected by the NRC like any other resource.
2. Integration is **out-of-process** via `@nexar/integration-deepseek-harness`, which implements the
   SDK wire protocol with a small **Nexar-owned JSON-RPC client** and spawns an externally installed,
   exact-pinned `dsh` binary (`dsh --profile sdk`). Nexar does not depend on `@deepseek-ai/*` npm
   packages in v0.1.
3. Every launch uses: an isolated `DSH_HOME` under `.nexar/runtimes/deepseek-harness/`, an explicit
   minimal environment (only the resource's credential env var), a Nexar-generated `--patch` overlay
   (provider route, `session-log-deepseek` disabled), and a per-task cwd.
4. The adapter fails closed on an unexpected `serverInfo.name` or protocol shape. `session.event`
   payloads are treated as opaque JSON.
5. CI uses a fake `dsh` runtime that speaks the same protocol. Live runs are opt-in.

## Rationale

Process isolation matches the local-first security model and absorbs upstream churn at one small,
testable boundary. The wire protocol is the only documented surface (with a Python twin), so a thin
client is cheaper and less coupled than 541 transitive packages plus peer-dependency pinning to
Cordis. Treating DSH as a resource, not as a mandatory layer, keeps "who executes" (NRC) separate
from "how work is orchestrated" (DSH).

## Alternatives considered

- `@deepseek-ai/dsh-sdk-client` as a dependency — viable fallback if the protocol drifts faster than
  we can track; rejected for v0.1 on footprint and coupling.
- Cordis plugin inside DSH / in-process imports — rejected: unstable lockstep internals would leak
  into Nexar.
- Hard fork — rejected: upstream moves too fast; violates upstream isolation.
- ACP adapter first — deferred: needed for cancel/approvals (v0.3); reusable for other ACP agents.

## Consequences

- Model switching for DSH = a new runtime process per (provider, model). Acceptable for v0.1.
- No mid-turn cancel via the SDK protocol: abort = terminate the process.
- Users must install `dsh` separately (`npm i -g @deepseek-ai/dsh@<pinned>`); `nexar doctor` reports it.

## Risks

Protocol has no version negotiation and "no compatibility promise"; autonomous runs may require
`DSH_PERMISSION_MODE=danger-full-access` (not used by Nexar in v0.1); non-DeepSeek model quality in
DSH is unverified; approval fail-closed behavior in SDK mode is unverified.

## Follow-up work

Live smoke test with `DEEPSEEK_API_KEY` (manual, documented); ACP adapter with cancel + approvals
(v0.3); contract tests against DSH's `llm-mock-server`; version-upgrade playbook.
