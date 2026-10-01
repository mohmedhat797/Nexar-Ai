# ADR-019: Engineering lanes, resource selection and Nexar-owned acceptance

**Status:** Accepted (2026-10-01) · Issues: #16 (NXR-023 Delegate Skills), #13 (NXR-020 DSH ACP),
#14 (NXR-021 Codex), #15 (NXR-022 Antigravity), #17 (NXR-024 sandbox)
Builds on: ADR-005 (Resource Controller ownership), ADR-011 (native agent adapters), ADR-016
(approvals), ADR-018 (engineering execution plane).
Evidence: [`docs/research/upstream/v0.3/`](../research/upstream/v0.3/), in particular
[`delegate-skills-product.md`](../research/upstream/v0.3/delegate-skills-product.md),
[`codex.md`](../research/upstream/v0.3/codex.md),
[`antigravity.md`](../research/upstream/v0.3/antigravity.md),
[`claude-code-write.md`](../research/upstream/v0.3/claude-code-write.md) and
[`worktrees-and-acp.md`](../research/upstream/v0.3/worktrees-and-acp.md).

## Context

v0.3 turns Nexar into an engineering machine: the owner gives one engineering task, and several
write-capable AI resources (Claude Code, Codex, Antigravity, DeepSeek Harness, Pi) work on it. The
owner decided that:

- **Native adapters and Delegate Skills are both used, with separate responsibilities.**
- **The Resource Controller (NRC) owns resource selection.** Delegate Skills owns decomposition and
  lane delegation but must not permanently bypass the NRC: lanes express capabilities, Nexar picks
  the resource, and vendor relays are at most an execution mechanism.
- **DSH owns agent orchestration where appropriate**, with its ACP permission requests mapped onto
  Nexar approvals.
- **Nexar owns** task identity, resource selection, policy, approvals, project and worktree
  boundaries, audit, telemetry and acceptance gates.
- **Agents never push and never commit.** Nexar owns acceptance.

Research found that Delegate Skills relays hard-code one implementer per relay, find CLIs on `PATH`,
run no worktrees, and (for Claude) force a vendor sandbox that fails under Nexar's outer sandbox.
They are a good **methodology** (lane taxonomy, brief structure, review loop) and a usable
**mechanism**, but not a resource selector or a security boundary.

## Decision

### 1. Engineering task

An `EngineeringTask` is Nexar's unit of engineering work:

- `id`: a Nexar task id, which also names the worktree and the result branch
- `projectId` and a `repository` path that must resolve inside the project through
  `resolveContainedPath` (ADR-012)
- `baseRef`, resolved once to a commit SHA (`baseCommit`) that every lane and gate uses
- `goal`: owner text, treated as **untrusted input** and rendered inside `<untrusted-input>`
- `plan`: the id of a lane plan (default `implement-review`)

Tasks are created from the CLI (`nexar engineer …`) in v0.3. The MCP Work Bridge does not get
engineering scopes in v0.3.

### 2. Lanes are data; capabilities, not resources

A **lane plan** is data (`engineering/plans/<id>.json`), in the same spirit as ADR-017 workflows.
Each lane declares:

- a role: `architecture`, `feature`, `tests`, `review` or `debugging` (the Delegate Skills taxonomy)
- `access`: `read-write` or `read-only`
- the required `capabilities` (for example `repo-editing`, `shell-execution`, `code-review`)
- a brief template (Markdown, following the Delegate Skills brief structure: objective, context, in
  and out of scope, contracts, acceptance criteria, constraints)
- dependencies on earlier lanes

v0.3 runs lanes **sequentially in one task worktree**. Parallel lanes in separate worktrees with a
Nexar merge step are follow-up work. Built-in plans:

| Plan                    | Lanes                                                                             |
| ----------------------- | --------------------------------------------------------------------------------- |
| `implement-review`      | `feature` (rw) → gates → `review` (ro)                                            |
| `implement-test-review` | `feature` (rw) → `tests` (rw) → gates → `review` (ro)                             |
| `plan-implement-review` | `architecture` (ro, produces a plan document) → `feature` (rw) → gates → `review` |

A failed gate or a `request-changes` review starts a bounded **`debugging`/rework round** (default 1,
maximum 3). The round gets the gate output or findings as untrusted input. The task fails when rounds
run out.

### 3. The Resource Controller selects a resource for every lane

Each lane becomes a `NexarTask`:

- `kind`: `coding` for rw lanes, `review` for the review lane and `analysis` for architecture
- `requirements.capabilities`: the lane's capabilities
- the project's privacy setting

Nexar routes it with the normal `RoutingPolicy`. Every `RouteDecision` is recorded with the lane.
Rules:

- **Write capability is a resource claim, enforced by the adapter.** Only resources whose adapter
  implements sandboxed write mode declare `repo-editing`, and the adapter refuses write mode without
  a sandbox (section 5).
- **Review diversity.** The review lane gets the implementing resources in
  `excludedResourceIds`. Project policy `reviewDiversity` is `preferred` by default: if no other
  resource is eligible, Nexar re-routes without the exclusion and records the reason code
  `review.same-resource`. With `required`, the task fails instead. The E2E uses `required`, so at
  least two resources participate.
- **Owner preference.** The project config may set `preferredResourceIds` per lane role. This uses
  the existing requirement field, so routing stays explainable. v0.3 adds **no** scoring, quota or
  learning (v0.4).

### 4. Executors: native adapters first, Delegate Skills relays as a mechanism

The NRC picks a **resource**. The resource's `runtime.adapter` names the executor:

- **Native adapters** (`claude-code`, `codex`, `antigravity`, `deepseek-harness`, `pi`) are the
  default executors. Each implements `ExecutionAdapter` with a write mode.
- **`integrations/delegate-skills`** is an `ExecutionAdapter` that runs a pinned relay script for
  resources configured with `adapter: "delegate-skills"`, with `options.relay` set to `codex`,
  `antigravity` and so on. It passes explicit flags, so the relay's own implementer choice is never
  used to pick a resource. It runs under the same sandbox launcher. The Claude relay is not used:
  Claude Code stays native because its relay forces a vendor sandbox that cannot nest.
- **Delegate Skills' methodology** lives in Nexar as data: the lane taxonomy, brief templates and
  review loop above. Nexar renders the briefs. The relays only carry them.

### 5. Process launcher contract

`@nexar/contracts` gains a `ProcessLauncher`. The engine passes it to adapters through an optional
`ExecutionContext.workspace`:

```ts
interface EngineeringWorkspace {
  readonly path: string; // canonical host path of the task worktree
  readonly access: 'read-only' | 'read-write';
  readonly launcher: ProcessLauncher;
}
interface ProcessLauncher {
  readonly isolation: 'none' | 'sandbox';
  prepare(spec: LaunchSpec, signal: AbortSignal): Promise<PreparedLaunch>;
}
```

- `LaunchSpec` holds `command`, `args`, the complete `env` (nothing is inherited), the workspace and
  its access mode, `network` (`none`, or `proxy` with an exact-host allowlist) and narrow `mounts`
  (credential mounts, ADR-018 section 7).
- `prepare` returns the **wrapped** command, args and env that the adapter spawns, the path at which
  the workspace appears to the process, and a `dispose()` that stops the per-launch proxy. Adapters
  keep their own spawn, stream parsing and process-group kill logic, so the launcher does not
  re-implement process handling.
- `@nexar/sandbox` implements `isolation: 'sandbox'` with the verified bwrap profile and the egress
  proxy. If bwrap or user namespaces are missing, it fails with the new error code
  `SANDBOX_UNAVAILABLE` and never falls back.
- An adapter asked to work on a `read-write` workspace **must** throw `POLICY_REJECTED` unless
  `launcher.isolation === 'sandbox'`.
- Inner vendor sandboxes and permission bypass flags are enabled only on that path (ADR-018
  section 6).
- Read-only v0.2 behaviour, with no workspace, is unchanged.

### 6. DeepSeek Harness via ACP, with permissions mapped to approvals

DSH runs as `dsh --profile acp` under the sandbox launcher. Nexar's ACP client in
`integrations/deepseek-harness` handles each `session/request_permission` like this:

- It builds the action `{type: "agent.tool", adapter, tool, args}` from the preceding `tool_call`
  update and fingerprints it with `@nexar/approvals`.
- The lane's **permission policy** decides:
  - `ask` (default): create a single-use approval with a TTL and wait.
  - `allow-listed`: auto-approve tool kinds that the project config lists as safe _inside the
    sandbox_. Each auto-decision is still recorded as an approval record with `decidedBy: policy`.
- Approve → `allow_once`. Deny, expiry, error, abort or a fingerprint mismatch → `reject_once`.
- Nexar never selects `allow_always` or `reject_always`.
- `cancelled` is sent only after Nexar's own `session/cancel`.
- The client switches on `protocolVersion`: v1 is supported; any other version is rejected with
  `INTEGRATION_UNAVAILABLE`.

DSH's own sub-agent orchestration stays inside DSH. To Nexar, DSH is one resource on one lane.

### 7. Gates verify the patch, not the agent's worktree

When the write lanes finish, Nexar **harvests** a binary patch in a separate read-only, no-network
sandbox (ADR-018 section 8) and **validates** it:

- Paths must be relative and stay inside the repository. `..`, absolute paths, `.git/` and
  `.gitmodules` are denied, and projects can add to the deny list.
- Gitlinks (mode `160000`) are denied, and symlinks are denied by default.
- There is a size limit (default 5 MiB).
- An empty patch fails the task.

**Gates** run on a **fresh private clone at `baseCommit` with the patch applied**. They use the
sandbox with `network: none` and run the commands declared in project config:

```json
"engineering": {
  "setup": [{ "name": "install", "command": ["pnpm", "install", "--offline"], "timeoutMs": 300000 }],
  "gates": [{ "name": "test", "command": ["pnpm", "test"], "timeoutMs": 600000 }]
}
```

- Commands are argv arrays, never shell strings.
- `setup` gets network only when the owner lists domains for it in config. The agent never gets to
  choose them.
- Gate output is stored as an artifact. Only exit codes, durations and hashes go to telemetry.

### 8. Review lane

The review lane mounts the gate workspace **read-only**. It receives the patch as untrusted input
and must answer with schema-validated JSON:

- `verdict`: `approve` or `request-changes`
- `findings`: a list of `{severity, file?, message}`

A parse or validation failure counts as `request-changes`, so review fails closed.

### 9. Acceptance and the Nexar-owned commit

A task is **accepted** only when all of these hold:

1. The patch passes validation.
2. Every gate passes.
3. The review lane approves.
4. The owner approves, unless project policy `ownerApproval: "never"` is set. The default is
   `always`, and the E2E uses it.

Owner approval uses `@nexar/approvals`:

- Action type `engineering.commit`, bound to the fingerprint of
  `{project, repository, baseCommit, patchSha256, branch}`.
- The CLI shows the diff stat, gate results, review findings and the resources used.
- The grant is consumed immediately before the commit.

The commit is a **local** action and not an outward one in the sense of ADR-016, but it still uses
the same fail-closed approval machinery. Nexar creates it **without touching the owner's working
tree**:

1. Read `baseCommit` into a temporary index.
2. Run `git apply --cached` with the validated patch.
3. Run `write-tree` and then `commit-tree`.
4. Create `refs/heads/nexar/<task-id>`. Nexar refuses if the branch already exists and never moves
   an existing ref.

These steps run with `core.hooksPath=/dev/null`, `core.fsmonitor=false` and the owner's configured
identity. The commit message carries `Nexar-Task:`, `Nexar-Lane:`/`Nexar-Resource:` trailers per
lane, and `Nexar-Approval:`. **Nexar never pushes.** Merging or pushing the branch is the owner's
act.

Agents cannot commit or push, by construction:

- `.git` is mounted read-only.
- The clone has no remote.
- The proxy denies git hosts.

Adapters also deny `git commit`, `git add` and `git push` in their tool settings, as defense in
depth.

### 10. Record, telemetry and audit

Each task keeps a record at `<state>/engineering/<task-id>/record.json` (0600). It has allowlisted
fields only:

- ids
- lane roles
- route decisions (reason codes)
- resource ids and usage (`Measured`)
- gate names, exit codes and durations
- the review verdict and finding counts
- `patchSha256`
- the approval id and decision
- the commit SHA

Telemetry events: `engineering.task.started|completed|failed`, `engineering.lane.routed`,
`engineering.lane.completed`, `engineering.gate.completed`, `engineering.review.completed` and
`engineering.commit.created`. Neither the record nor telemetry contains prompts, diffs, gate output
or paths outside the project. Those live in task artifacts. Per-lane outcomes (resource, usage,
gates, review verdict) are exactly the data v0.4 scoring will need. v0.3 records them and does not
score.

### 11. Packages

| Package                                        | Owns                                                                                     |
| ---------------------------------------------- | ---------------------------------------------------------------------------------------- |
| `packages/sandbox`                             | bwrap profile builder, `SandboxLauncher`, egress proxy; the only code that invokes bwrap |
| `packages/worktrees`                           | private clone, hardening, sandboxed harvest, patch validation, plumbing commit           |
| `packages/engineering`                         | task model, lane plans, brief rendering, gates, review parsing, acceptance, records      |
| `integrations/codex`                           | native Codex adapter (`codex exec --json`)                                               |
| `integrations/antigravity`                     | experimental `agy` adapter (spike-gated, ADR-020 if promoted)                            |
| `integrations/delegate-skills`                 | relay executor (mechanism only)                                                          |
| `integrations/claude-code`, `deepseek-harness` | gain sandboxed write mode / ACP client                                                   |

`@nexar/engineering` must not import network or HTTP code or push code. A static test enforces this,
as for workflows.

## Rationale

- Lanes as data keep Delegate Skills' proven decomposition while the NRC keeps resource choice, so
  "who executes" stays one explainable decision per lane.
- One launcher contract makes the sandbox a property the engine supplies and adapters verify, rather
  than something each adapter reimplements.
- Gating the harvested patch on a fresh clone means the code that is committed is the code that was
  tested.
- A plumbing commit on a new branch is reversible and never disturbs the owner's checkout.

## Alternatives considered

- **Delegate Skills relays as the orchestrator.** Rejected: fixed implementers bypass the NRC, there
  are no worktrees, and Claude's relay cannot nest.
- **Letting agents commit inside the worktree.** Rejected by owner decision. It would also need a
  writable `.git` (ADR-018).
- **Running gates in the agent's worktree.** Rejected: untracked or ignored files the agent left
  behind could make gates pass on code that is not committed.
- **Parallel lanes now.** Deferred: it needs a merge and conflict policy, and sequential lanes
  already prove the multi-resource flow.
- **Free-form LLM decomposition.** Deferred: an optional `architecture` lane produces a plan
  document, but lane structure stays declarative in v0.3.

## Consequences

- Projects that want engineering tasks declare `engineering` settings (gates, setup, policies).
- Each write-capable resource needs an adapter write mode plus contract tests with a fake runtime
  under a fake launcher, and a real-sandbox test where the binary exists.
- The owner approves commits from the CLI. A mobile approval interface waits for v0.5.

## Risks

- Prompt injection through repository content can still steer an agent inside its worktree. The
  sandbox, patch validation, gates, review and owner approval bound the damage to a rejected local
  branch.
- Reviewer collusion or weakness: model review is advisory; gates and owner approval are the hard
  controls.
- Offline gates require dependencies to be available without network (vendored, cached or
  owner-allowlisted setup).

## Follow-up work

Parallel lanes with merge, an MCP engineering scope, per-lane cost caps from quotas (v0.4),
learning-based routing (v0.4) and mobile approvals (v0.5).
