# Nexar security model and threat assumptions

Windows compatibility evidence and remaining gaps: native launchers resolve supported Node npm
shims to a script and Node executable, without evaluating batch argument expansion. Arbitrary batch
launchers are refused. Live process trees are killed on abort/timeout with the host's system
`taskkill.exe`; orphan descendants after prior leader exit still require Job Object containment.
Windows file modes are not ACL evidence: Desktop startup secures its dedicated state tree with a
protected DACL granting this user, SYSTEM and local Administrators access. Foreign-owned entries,
redirected paths, hard-linked files and unrelated existing folders fail closed; parent ACLs stay
unchanged. SYSTEM/Admin-owned entries can be normalized only with the caller's existing ACL and
owner rights; the final owner must be the current user. Startup path checks do not prevent concurrent
replacement by a compromised OS account. Explicit config state-directory overrides outside
Desktop's data tree still need an audit. Linux controls stay enforced on the WSL engineering plane.
See the [Windows checklist](../guides/windows-validation.md) and
[continuation state](../devlog/operating-layer-progress.md); NXR-051 remains open.

Windows artifact publication uses an exclusive hard link from a random staging file; it never opens
the predictable destination, because Windows `wx` can follow a dangling file link. Filesystems that
do not support hard links fail closed. Artifact, engineering-history and relay-result readers verify
regular-file identities before reading; Windows does not implement POSIX `O_NOFOLLOW`.

Nexar will handle source code, client documents, email, calendars, OAuth sessions, API keys, and
subscription logins. Security is an architectural requirement, not a later feature.

## Assets

| Asset                                                 | Where it lives                                   | Nexar's rule                                                                                              |
| ----------------------------------------------------- | ------------------------------------------------ | --------------------------------------------------------------------------------------------------------- |
| Provider API keys                                     | Owner's environment (`.env`, shell, OS keychain) | Referenced by env var _name_ in config; injected only into the runtime that needs it                      |
| Subscription / OAuth sessions (Claude Code, Codex, …) | Each runtime's own credential store              | Never read, copied, or extracted by Nexar; used only through the runtime's supported CLI/SDK              |
| Source code, documents                                | Owner's filesystem                               | Passed to a resource only when the task requires it; `local-only` tasks never reach third-party resources |
| Telemetry, sessions                                   | `.nexar/` (git-ignored), file mode 0600          | Contains prompts' metadata, never credentials                                                             |

## Trust boundaries

1. **Nexar process ↔ external runtimes** (dsh, claude, codex, agy; write-capable ones only inside the v0.3 sandbox): separate processes,
   launched with a scrubbed, explicit environment and an isolated state directory. Runtime output is
   untrusted input to Nexar.
2. **Nexar ↔ model providers**: third-party data processors. Routing respects
   `requirements.privacy = 'local-only'` by rejecting resources whose `dataLocality` is
   `third-party`.
3. **OpenWorker ↔ Nexar** (v0.2): OpenWorker is a separate application that launches `nexar mcp serve`
   over stdio. Every tool call is authenticated with a client token, authorized against that client's
   scopes, audited, and treated as untrusted task input (ADR-014, ADR-015).
4. **Repository ↔ local machine**: nothing machine-specific (tokens, session DBs, `.nexar/`, `.env`)
   is ever committed. CI scans for secrets.

## Threat assumptions

- The owner's machine and OS account are trusted. Nexar does not defend against a compromised host.
- Model output and agent actions are **not** trusted: agents can be prompt-injected by repository
  content, documents, or email. Mitigations: least-privilege tool surfaces per adapter, read-only
  modes where available, human approval for outward actions (none can run in v0.2), and audit records.
  Prompt injection is mitigated, not prevented: see the v0.2 controls and known gaps below.
- Upstream runtimes are fast-moving pre-1.0 projects (DeepSeek Harness declares "no security
  audit"). Mitigations: exact version pins, isolation via subprocesses, contract tests, deliberate
  upgrades.
- Third-party telemetry in upstream runtimes is disabled where documented (e.g. DSH
  `session-log-deepseek` upload).

## Mandatory rules

- No credential, token, cookie, or session database is committed. `.env.example` only.
- Config schema rejects inline secrets: credentials are `{ source: 'env', name }` or
  `{ source: 'runtime-managed' }`.
- Logs pass through key-based redaction (`api_key`, `token`, `secret`, `password`,
  `authorization`, `cookie`, `credential`).
- Adapters must not log prompts at `info` level or above (prompts may contain client data).
- Probes are side-effect free and never make paid calls.
- Live/paid tests are opt-in (`NEXAR_LIVE_TESTS=1`) and never run in CI.
- Destructive or outward-facing actions (sending email, pushing code, deleting files) require an
  executor and explicit, action-bound human approval (ADR-016). v0.2 registers no executors, so Nexar
  performs none.
- Any path derived from a request, workflow input or model output is checked with `resolveContainedPath`
  and only the canonical result is used; rejected paths are never echoed (ADR-012).
- Artifacts are written only through `LocalArtifactStore` (ADR-013).
- The MCP server is stdio-only; it must never be exposed over a network (ADR-014).

## v0.2 controls

Eight hard gates. Each is enforced in code and proven by offline tests (`pnpm test`).

| #   | Gate                                                   | Enforced in                                                                                                                                                                                                                            | Proven by                                                                                                                                                                                                                                                 |
| --- | ------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Realpath containment (symlinks and `..` cannot escape) | `packages/projects/src/path-policy.ts` (`resolveContainedPath`, `isWithin`); `packages/core/src/engine.ts` (`enforceWorkspace`, before routing); `packages/artifacts/src/store.ts` (per-level realpath)                                | `packages/projects/src/path-policy.test.ts`; `packages/core/src/projects.test.ts` (symlink attack never reaches the adapter); `packages/artifacts/src/store.test.ts`; `integrations/openworker/src/bridge.test.ts`; `integrations/mcp/src/server.test.ts` |
| 2   | Invalid project paths fail closed                      | `packages/projects/src/path-policy.ts` (`canonicalRoots`) and `registry.ts`: a missing or non-directory root or working directory is `CONFIGURATION_ERROR`; engine `project-only` default                                              | `packages/projects/src/path-policy.test.ts` (`canonicalRoots`); `packages/projects/src/registry.test.ts`; `packages/core/src/projects.test.ts` (unresolvable path, `project-only` default)                                                                |
| 3   | Work Bridge authentication                             | `packages/access/src/registry.ts`, `credentials.ts`, `scopes.ts` (256-bit token, SHA-256 at rest, constant-time, revocable, scopes); `integrations/mcp/src/server.ts` (authenticates on every call)                                    | `packages/access/src/registry.test.ts`; `integrations/mcp/src/server.test.ts` (missing, wrong, revoked tokens; scope rejections); `integrations/mcp/src/stdio-process.test.ts` (real transport, no token)                                                 |
| 4   | Every request is audited, exactly once                 | `packages/access/src/audit.ts` (`withAudit`, `startAudit`, `JsonlAuditLog`, 0600); `integrations/mcp/src/server.ts`                                                                                                                    | `packages/access/src/audit.test.ts`; `integrations/mcp/src/server.test.ts` (one record per call including failures; write failure is surfaced)                                                                                                            |
| 5   | No secrets in audit or telemetry                       | `packages/access/src/audit.ts` (explicit field allowlist, sanitized ids); `packages/telemetry/src/redact.ts`; `packages/core/src/engine.ts` (`artifacts.stored` carries refs only)                                                     | `packages/access/src/audit.test.ts` (allowlisted keys only); `packages/access/src/registry.test.ts` (only the hash is stored); `packages/telemetry/src/telemetry.test.ts`; `packages/core/src/artifacts.test.ts`; `integrations/mcp/src/server.test.ts`   |
| 6   | MCP stdout is protocol-only                            | `integrations/mcp/src/stdio.ts` (`redirectConsoleToStderr`; logs and notice go to stderr)                                                                                                                                              | `integrations/mcp/src/stdio-process.test.ts` (raw stdout bytes are JSON-RPC only); `integrations/mcp/src/server.test.ts` (`redirectConsoleToStderr`)                                                                                                      |
| 7   | Outward actions fail closed without approval           | `packages/approvals/src/outward.ts` (`performOutwardAction`: executor required first, then approval, consume, execute; `V0_2_OUTWARD_EXECUTORS` is empty); `gate.ts` (deny-all default); `packages/workflows` has no outward code path | `packages/approvals/src/approvals.test.ts` (no executors; deny by default; binding; single use; restart recovery); `packages/workflows/src/static.test.ts` (no mail, HTTP or approvals import); `packages/workflows/src/runner.test.ts` (drafts only)     |
| 8   | Request input cannot grant filesystem permissions      | `integrations/openworker/src/schema.ts` (strict schema; no scope, path-policy or permission fields); `integrations/mcp/src/server.ts` (client cost cap, scopes from the token); `packages/projects/src/merge.ts` (stricter wins)       | `integrations/mcp/src/server.test.ts` (request fields do not widen scopes); `packages/projects/src/merge.test.ts`; `packages/workflows/src/runner.test.ts` (inputs cannot choose project or directory)                                                    |

Supporting controls: artifact names are sanitized with a forced extension and written with `O_EXCL`
(`packages/artifacts/src/sanitize.ts`, `store.ts`); workflow inputs are wrapped as untrusted and never
enter the trusted system prompt (`packages/workflows/src/runner.ts`, `runner.test.ts`); the DeepSeek
Harness adapter kills its whole process group on stop (`integrations/deepseek-harness/src/process-tree.test.ts`).

## v0.3 controls

Engineering lanes (ADR-018, ADR-019). Each control is enforced in code and proven by offline tests
(`pnpm test`); rows that need a real bubblewrap are `describe.skipIf` tests and skip where it is
missing. The numbering continues the v0.2 table.

| #   | Control                                                                                                                                                                                                          | Enforced in                                                                                                                                                           | Proven by                                                                                                                                                                                                                                                                                       |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 9   | Fail-closed sandbox: no bwrap or user namespaces means write lanes refuse, never run unsandboxed                                                                                                                 | `packages/sandbox/src/availability.ts`, `launcher.ts` (`SANDBOX_UNAVAILABLE`, non-retryable); `packages/engineering/src/execution.ts`                                 | `packages/sandbox/src/availability.test.ts`; `launcher.test.ts` (fails closed); `packages/engineering/src/runner.test.ts` (non-sandbox launcher rejected before any worktree); `apps/cli/src/sandbox.test.ts` (exit 7)                                                                          |
| 10  | Explicit namespaces, read-only root, `.git` read-only bind (also against `mv`), `--cap-drop ALL`, nested user namespaces off                                                                                     | `packages/sandbox/src/profile.ts` (`buildBwrapArgs`); `launcher.ts`                                                                                                   | `packages/sandbox/src/profile.test.ts`; `launcher.test.ts` (`.git` protection); `launcher.integration.test.ts` (real bwrap; skips without it); `selftest.ts` via `apps/cli/src/sandbox.test.ts`                                                                                                 |
| 11  | Egress proxy: unix socket only (0600), exact-host allowlist, IP literals and private/loopback addresses refused, connects to the vetted IP                                                                       | `packages/sandbox/src/proxy.ts`; the sandbox has `--unshare-net` and reaches the proxy through a bind-mounted socket                                                  | `packages/sandbox/src/proxy.test.ts`; `launcher.integration.test.ts` (proxy mode)                                                                                                                                                                                                               |
| 12  | Credential mounts are owner-declared, validated (no home, ancestors, system paths or denied credential segments, also via symlink) and never read                                                                | `packages/sandbox/src/mounts.ts`; adapters pass declarations through unchanged                                                                                        | `packages/sandbox/src/mounts.test.ts`; `integrations/claude-code/src/engineering.test.ts` (mounts passed through); `integrations/delegate-skills/src/adapter.test.ts` (Codex home never read)                                                                                                   |
| 13  | Write mode refused without the sandbox in every adapter (and by harvest)                                                                                                                                         | `integrations/{claude-code,codex,antigravity,delegate-skills}/src/adapter.ts`; `integrations/deepseek-harness/src/acp/launch.ts`; `packages/worktrees/src/harvest.ts` | `integrations/claude-code/src/engineering.test.ts`; `integrations/codex/src/adapter.test.ts`; `integrations/antigravity/src/adapter.test.ts`; `integrations/delegate-skills/src/adapter.test.ts`; `integrations/deepseek-harness/src/acp/acp.test.ts`; `packages/worktrees/src/harvest.test.ts` |
| 14  | Private clones: `--no-local --single-branch --no-tags`, no remote, neutral hooks; no owner `.git` exposure and no secret objects from other branches                                                             | `packages/worktrees/src/create.ts`, `clone.ts`                                                                                                                        | `packages/worktrees/src/create.test.ts`; `sandbox.integration.test.ts`                                                                                                                                                                                                                          |
| 15  | Harvest runs in a read-only, no-network sandbox with Nexar's pristine `GIT_DIR`; planted `fsmonitor`/`diff.external` never run on the host                                                                       | `packages/worktrees/src/harvest.ts`; `packages/engineering/src/static.test.ts` forbids host git in `@nexar/engineering`                                               | `packages/worktrees/src/harvest.test.ts` (planted config and attributes); `sandbox.integration.test.ts` (real bwrap); `packages/engineering/src/static.test.ts`                                                                                                                                 |
| 16  | Patch policy: no `.git`, `..`, absolute or backslash paths, `.gitmodules`, `.gitattributes`, `.github/workflows/`, gitlinks; symlinks off by default; size and count caps; empty patch fails; project deny globs | `packages/worktrees/src/patch-policy.ts`, `patch-parse.ts`                                                                                                            | `packages/worktrees/src/patch-policy.test.ts`; `patch-parse.test.ts`; `packages/engineering/src/runner.test.ts` (violations, deny globs, empty patch)                                                                                                                                           |
| 17  | Gates and setup run on a fresh clone with the patch applied and no network (setup only gets owner-listed hosts)                                                                                                  | `packages/worktrees/src/verify.ts`; `packages/engineering/src/execution.ts`                                                                                           | `packages/worktrees/src/verify.test.ts`; `packages/engineering/src/runner.test.ts` (no-network gates and setup, owner-listed hosts, gate timeout and cancel)                                                                                                                                    |
| 18  | Review diversity: the review lane excludes the implementing resources (`required` fails the task; `preferred` records `review.same-resource`); an unparseable verdict is `request-changes`                       | `packages/engineering/src/execution.ts`, `verdict.ts`                                                                                                                 | `packages/engineering/src/runner.test.ts` (required, preferred, unparseable verdict); `verdict.test.ts`                                                                                                                                                                                         |
| 19  | Owner approval of `engineering.commit`: fingerprint-bound to project, repository, base commit, patch hash and branch; single-use; deny and expiry mean `not-accepted`                                            | `packages/engineering/src/execution.ts`; `packages/approvals/src/{gate,fingerprint}.ts`                                                                               | `packages/engineering/src/runner.test.ts` (deny-all, denied, expired, exact consumed action, fingerprint mismatch); `packages/approvals/src/approvals.test.ts`                                                                                                                                  |
| 20  | Plumbing commit never touches the owner's tree, index, HEAD or hooks; refuses an existing or non-`nexar/` branch; Nexar never pushes                                                                             | `packages/worktrees/src/commit.ts` (`commitPatch`); no push code in `@nexar/engineering`                                                                              | `packages/worktrees/src/commit.test.ts`; `packages/engineering/src/static.test.ts` (never invokes `git push`; no network or mail import)                                                                                                                                                        |
| 21  | ACP permissions become approvals: deny by default, option chosen by kind, `*_always` never selected, policy decisions recorded with `recordPolicyDecision`, unsupported protocol versions rejected               | `integrations/deepseek-harness/src/acp/permissions.ts`; `packages/approvals/src/policy.ts`                                                                            | `integrations/deepseek-harness/src/acp/acp.test.ts`; `packages/approvals/src/approvals.test.ts` (`recordPolicyDecision`)                                                                                                                                                                        |
| 22  | Records and telemetry carry ids, counts and hashes only (no prompts, diffs, gate output or absolute paths); progress output is scalar-only                                                                       | `packages/engineering/src/record.ts`, `runner.ts`; `apps/cli/src/commands/engineer.ts`                                                                                | `packages/engineering/src/runner.test.ts` (records and telemetry carry no sensitive data; failure record free of paths); `apps/cli/src/engineer.test.ts`                                                                                                                                        |

Supporting controls: the launcher forces `--clearenv` plus an explicit environment; the Claude Code
adapter denies `git commit|push|add|...` in its tool settings as defense in depth
(`integrations/claude-code/src/adapter.ts`); the Delegate Skills adapter hashes the relay before every
run and executes a private copy, so a swap of the original file has no effect
(`integrations/delegate-skills/src/pin.ts`, `adapter.test.ts`); the sandbox kills background processes
when bwrap is killed (`packages/sandbox/src/launcher.integration.test.ts`).

Live evidence (not part of CI): two end-to-end runs and a debug egress log are in
[`docs/devlog/evidence/v0.3/`](../devlog/evidence/v0.3/). The only denied hosts were `ab.chatgpt.com`,
`registry.npmjs.org` and `*.oaiusercontent.com`.

## v0.4 controls

Resource intelligence ([ADR-020](../adr/020-resource-intelligence-scheduler.md)). Routing can only
narrow choices; it never authorizes anything. Every v0.3 control (sandbox, patch policy, review
diversity, gates, owner approval, Nexar-owned commit, no push) sits outside routing and is unaffected
by any score.

| #   | Control                                                                                                                                                                                             | Enforced in                                                                                                                    | Proven by                                                                                                                                                                |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 23  | Hard filters before scoring: a score never re-admits a candidate rejected for exclusion, capability, availability, auth, privacy, context, quota (exhausted, reserved, strict) or cost              | `packages/resource-controller/src/hard-filters.ts`, `intelligence-policy.ts`                                                   | `intelligence-policy.test.ts` (seeded invariant over 250 cases; "a perfect history never re-admits" for each filter)                                                     |
| 24  | Fallback to `deterministic@1` reuses the same hard-filter stage, is stamped in `policy.fallback`, logged at warn with codes only, and fails closed when no fallback exists                          | `packages/resource-controller/src/controller.ts`, `fallback.ts`                                                                | `packages/resource-controller/src/fallback.test.ts`                                                                                                                      |
| 25  | The policy never receives the prompt: only `TaskSizeEstimate` (chars/4 counts), the lane role and the clock                                                                                         | `packages/resource-controller/src/controller.ts`, `size.ts`                                                                    | `seams.test.ts` (no prompt text in the policy input); `apps/cli/src/route-explain.test.ts` (no prompt in the explanation)                                                |
| 26  | Quota comes only from owner declarations, Nexar's own accounting and documented vendor signals; unknown stays unknown (never unlimited, never zero); no credential, dashboard or private-API reads  | `packages/resource-controller/src/quota.ts`; `packages/telemetry/src/quota-source.ts`; `integrations/claude-code/src/parse.ts` | `quota.test.ts`; `quota-source.test.ts` (unaccounted runs never counted as zero); `integrations/claude-code/src/rate-limit.test.ts` (undocumented fields ignored)        |
| 27  | History files are untrusted: tail-bounded (8 MiB / 50k lines), shape-guarded, numbers clamped, prototype-safe keys; engineering records are size-bounded and never read through a symlink           | `packages/telemetry/src/{reader,history}.ts`; `packages/engineering/src/lane-history.ts`                                       | `reader.test.ts`; `history.test.ts`; `lane-history.test.ts` (symlinked record and task directory, oversize, malformed); `intelligence-policy.test.ts` (poisoned history) |
| 28  | Unknown cost under a strict `maxCostUsd` is rejected by default; Claude Code also gets its documented `--max-budget-usd`                                                                            | `packages/resource-controller/src/cost.ts`; `integrations/claude-code/src/adapter.ts`                                          | `cost.test.ts`; `apps/cli/src/route-explain.test.ts` (fails closed); `integrations/claude-code/src/adapter.test.ts` (budget flag)                                        |
| 29  | Discovery never authenticates: CLI detection is a `stat` only (never executes), the pi catalog needs an owner provider list, endpoints are owner-listed only (no scanning, no redirects, 1 MiB cap) | `packages/resource-registry/src/{path-lookup,discovery}.ts`; `integrations/pi/src/{catalog,local-endpoint}-discovery.ts`       | `path-lookup.test.ts` (marker binary never runs); `integrations/pi/src/discovery.test.ts`; `apps/cli/src/resources-discovery.test.ts`                                    |
| 30  | Configured resources win every id collision; discovered resources start `unknown` and are probed like any other; discovered ids cannot be referenced from routing rules                             | `packages/resource-registry/src/discovery.ts` (`mergeDiscovered`); `apps/cli/src/composition.ts`                               | `packages/resource-registry/src/discovery.test.ts`; `apps/cli/src/resources-discovery.test.ts`                                                                           |

Telemetry and explanations carry ids, codes, counts and numbers only. Quota labels from config are
never printed by `nexar resources`, and discovery reports carry source ids, statuses, counts and
error codes, never paths or messages.

## v0.5 controls (Nexar Desktop, ADR-021)

| #   | Control                                                                                                                                                               | Enforced in                                                           | Proven by                                                                               |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| 31  | The renderer is untrusted: `sandbox`, `contextIsolation`, no Node integration, strict CSP (header and meta), navigation, new windows, webviews and permissions denied | `apps/desktop/src/main/window.ts`, `src/renderer/index.html`          | `apps/desktop/e2e/desktop.e2e.ts` (web preferences, no `require`/`process` in the page) |
| 32  | One narrow bridge: fixed channels only, every request validated by a strict zod schema in the main process, errors mapped to codes, crashes answered generically      | `apps/desktop/src/main/{bridge,channel}.ts`, `src/preload/preload.ts` | `apps/desktop/src/main/bridge.test.ts`                                                  |
| 33  | Paths from the renderer are project-relative, contained with `resolveContainedPath` and never echoed; projects are added only through the native folder dialog        | `apps/desktop/src/main/{channel,projects}.ts`                         | `bridge.test.ts` (`..`, absolute and symlink escapes)                                   |
| 34  | Only Nexar artifacts of the store's own file types can be opened with the OS default handler                                                                          | `apps/desktop/src/main/artifacts.ts`                                  | `bridge.test.ts` (planted `.exe` and `.html` refused)                                   |
| 35  | Model output is rendered as text, never as HTML; no network listener; the engine uses the `project-only` workspace policy                                             | `apps/desktop/src/renderer/*`, `src/main/engine-host.ts`              | `bridge.test.ts`, E2E                                                                   |

## Known gaps (tracked in the backlog)

- **v0.2 read-only runs are still unsandboxed.** The OS-level sandbox gap is closed for engineering
  lanes (v0.3, NXR-024), but ordinary `nexar run` tasks and MCP work run as the owner's user and rely
  on each runtime's own permission model (read-only modes, least-privilege tool surfaces).
- **TOCTOU window:** a symlink swapped inside a project between the realpath check and the runtime's
  use is not detected for v0.2 runs. Mitigated by passing the canonical path and per-level checks.
  Inside the engineering sandbox the window is bounded by the mount namespace: the agent can only
  reach its own private clone.
- **No seccomp filter yet** in the sandbox. Nested user namespaces are disabled with
  `--disable-userns` instead ([NXR-025](../backlog/025-seccomp-filter-for-sandbox.md)).
- **Environment values appear in bwrap's argv on the host.** Values passed to the launcher (for example
  a DeepSeek API key) are readable through `/proc` by the same OS user. Fix: pass them with `--args <fd>`
  ([NXR-026](../backlog/026-launcher-env-via-args-fd.md)).
- **The Antigravity prompt is in argv** (`agy --print=<prompt>`), so it is visible in the host process
  list. The adapter is experimental and opt-in
  ([NXR-029](../backlog/029-antigravity-live-validation.md)).
- **Codex home is mounted read-write** (token refresh), so a lane can read its own Codex login inside
  the sandbox. It can talk only to the allowlisted OpenAI hosts.
- **No TLS inspection.** The proxy allows or denies by host name, so exfiltration to an allowlisted
  vendor endpoint is possible.
- **The review lane is advisory.** Models can miss problems or collude; gates and owner approval are
  the hard controls.
- **WSL-specific checks are unverified** until the owner runs the acceptance checks in
  [`docs/integration/wsl2-engineering-plane.md`](../integration/wsl2-engineering-plane.md). The
  mechanics were verified on Linux with bubblewrap 0.9.
- **Approver identity is not authenticated:** `decide()` trusts its caller (the local CLI). The v0.5
  control plane must authenticate approvers.
- **`clients.json` cross-process race:** writes are serialized within one process only, so the CLI and
  a running server writing at once can lose an update.
- **Prompt injection is mitigated, not prevented:** untrusted-input wrapping and the system prompts
  reduce it, but models can still follow injected text. The real guarantee is structural: workflows
  and the engine have no outward code path, so the worst case is a misleading local draft. Every
  output needs human review.
- **OpenWorker MCP tools may not be available in scheduled automations** (upstream behaviour,
  unverified; see the [OpenWorker research](../research/upstream/openworker.md)).
- No encryption at rest for `.nexar/` state, telemetry, audit or artifacts (owner-only file modes only).
- No rate limiting of failed authentication.
