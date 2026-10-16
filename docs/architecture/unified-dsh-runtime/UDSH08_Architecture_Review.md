# UDSH-08D independent architecture and security review

Date: 2026-10-10. ADR-030 remains **Proposed**. This is source review plus focused offline regression
evidence, not owner acceptance, live-provider certification or final-head CI acceptance.

## Scope and authoritative documents

Read ADR-030, architecture, implementation blueprint, security threat model and acceptance matrix.
Inspected Desktop Operating/Cowork composition, DSH profiles/ACP/legacy SDK adapters, NRC hard
filters/control gateway/bridge, sessions, project memory, engineering launch and accounting paths.
No owner provider credential was changed and no paid model call was made. The Providers
fixture adds and removes only its synthetic key in isolated test state.

## Findings and corrections

### Direct fallback: prior B, corrected A

Before this change, `apps/desktop/src/main/operating.ts` created an ordinary task and called
`nexar.run` without excluding agent resources. NRC correctly enforced capabilities, availability,
authentication, privacy and cost, but those filters do not distinguish model execution from an agent
loop. DSH, Claude Code, Codex and Antigravity descriptors advertise the text/reasoning capabilities
that direct work requires. `integrations/deepseek-harness/src/adapter.ts:130` chooses ACP only when
an engineering workspace is present; otherwise `runtime-process.ts:145` launches `--profile sdk`.
The direct session call supplied no workspace. Therefore its production eligibility included
**B: an independent agent-runtime path**, rather than a guaranteed bounded model request. This was
an architectural conflict, even though normal model configurations could select a bounded resource.

The corrected Desktop direct session path (`operating.ts:63`) excludes all descriptors except
`kind.type=model` with reviewed `pi` or `echo` bindings, using NRC's existing `excludedResourceIds`
hard filter. Checking the adapter as well as the descriptor prevents a model-labeled native/custom
adapter from entering. A preferred registered forbidden resource fails explicitly with
`POLICY_REJECTED` and reason `direct-resource-not-bounded`. An empty bounded candidate set fails
with `NO_ELIGIBLE_RESOURCE`. Unknown preferences keep existing NRC preference semantics; they are
not promoted to strict pins. Safe candidates still pass ordinary NRC filters and attribution.

The resulting path is **A: bounded, non-agent model execution**. Pi calls `completeSimple` once with
text messages and no tools (`integrations/pi/src/adapter.ts:258`); echo computes a deterministic
reply. Neither path runs a tool loop, delegation or native runtime session. Nexar may store returned
text through `LocalArtifactStore`, subject to read-only Cowork. Code/native lane execution and
standalone compatibility resources remain separate. Extending the bounded allowlist requires review
and regression evidence.

### Coding ACP: shared state and route-change enforcement

Before the correction, `acp/run.ts` always chose `<state>/acp/<resourceId>` and `acp/launch.ts` wrote
and mounted the same `nexar.patch.yml`. It neither removed that DSH home on completion nor protected
concurrent project overlays from replacing one another. This contradicted the per-turn state
contract and created a concrete context/overlay race. The Coding notification handler also ignored
`config_option_update`, unlike Cowork's handler.

Coding now creates a random private home below `<state>/acp/turn-*`, mounts its own overlay and
removes that home after process/launcher cleanup. A changed model option fails with
`POLICY_REJECTED/model-route-changed` in both gateway and native-key mode. The expected native model
is the NRC-selected resource's actual provider/model, not always the `nexar` route. No legacy state
directory is deleted.

Preparation receives a linked cancellation signal. If interrupted preparation settles normally,
cleanup waits for it before removing the home. An uncooperative launcher is bounded by a two-second
cleanup grace; handled late cleanup waits for eventual settlement before disposal/removal, so no
write-after-delete race is introduced. `launch.ts` checks cancellation before writing the overlay
after preparation. A never-settling preparation may leave its unique private directory on disk;
the next turn never reuses it. Cleanup errors are logged with fixed codes and preserve the primary
execution failure. This limitation is explicit rather than proof of deletion under every filesystem
or launcher failure.

### Control-call accounting: missing persistence corrected

At review time `packages/engine-gateway/src/gateway.ts` validated a control request, called the
selected model port and returns its usage/resource attribution, but emits no successful usage record.
`packages/host/src/composition.ts:228` returns a bare `PiModelTurnPort`; Desktop's gateway event hook
only feeds `BridgeHost.noteControlEvent` (`main.ts:318`). `PiModelTurnPort` returns input/output token
measurements (`integrations/pi/src/model-turn.ts:295`), without accounting persistence. The quota
source consumes `execution.finished` records (`packages/telemetry/src/quota-source.ts:119`), so these
control calls do not contribute to the owner's configured consumption windows.

Delegated work is accounted through `packages/host/src/bridge-ports.ts:25` → `nexar.run`, and bounded
direct session execution is recorded once. No duplicate control billing was demonstrated. The
observed defect was **missing persistent control-call accounting**, contrary to ADR-030/A13's
once-per-call requirement. The correction exposes the runtime's existing composite telemetry sink
and connects both Desktop Cowork and the Engineering control gateway to it. Each provider attempt
writes one ordinary `execution.finished` record under the selected model resource, including failed,
cancelled and retried calls. Failed calls retain unknown usage. Pi preserves measured token/cache
counts and labels catalog costs estimated; plan cash cost remains unavailable. Gateway-backed Coding
ACP leaves its runtime cost unavailable to avoid duplicate model billing; native-key ACP retains its
reported cost. Prompts, output and tool arguments do not enter these records.

The regression covers retry/restart attribution, cancellation, preflight rejection, and a sink
failure that must never cause a completed provider request to repeat. An offline integration test
persists two calls through `createNexar`'s JSONL sink and reads 36 measured tokens from the existing
quota source, once each. As with existing execution telemetry, sink failure is non-fatal and
reported; durable accounting is unavailable if storage fails. No guarantee of persistence under a
failed filesystem is claimed.

## Runtime, policy, memory and security evidence

| Concern              | Source evidence and limit                                                                                                                                                                                                                                                                                                                                                                                           |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Primary managed loop | `dsh-cowork.ts:506` launches the Cowork ACP profile. Engineering uses `PlaneLaneEngine` and the Coding ACP profile through the existing runner/sandbox contract. No new Nexar agent loop was added.                                                                                                                                                                                                                 |
| No active OpenWorker | Source scan across `apps`, `packages`, `integrations` finds legacy read enums/protocol compatibility and retired display labels, with no OpenWorker integration, supervisor, import or launch path.                                                                                                                                                                                                                 |
| NRC and connections  | `select-control.ts:117` applies Auto/pinned control selection; `gateway.ts:164` resolves the exact selected resource descriptor. Pins with fallback `none` reject unavailable resources within the managed control path. Desktop fallback records its lane reason and follows bounded task preference rules. Postponed multi-account expansion is not claimed.                                                      |
| Credentials          | Cowork `acp/local.ts` constructs an explicit allowlisted environment with private HOME/USERPROFILE/DSH_HOME and only the turn gateway credential. Coding gateway launch receives only its grant token; native-key launch resolves only the selected resource credential (`acp/launch.ts:82`). Native managed credentials are not copied into other runtimes.                                                        |
| B1                   | `contracts/capabilities.ts:61` validates the raw array before normalizing aliases; bridge schema/direct-host submissions retain this boundary.                                                                                                                                                                                                                                                                      |
| B2                   | `engine-gateway/bridge.ts:139` owns monotonic admission state; `dsh-cowork.ts:486` creates it outside the control-restart loop and closes it only when the turn ends.                                                                                                                                                                                                                                               |
| B3                   | `acp/permissions.ts` rejects missing tool provenance and selects only once options; Cowork policy is deny by default, scratch-contained writes plus the two bridge tools. Upstream permission labels do not grant Nexar authority.                                                                                                                                                                                  |
| B4                   | A one-unit grant cannot supply a valid prior review lineage: `bridge.ts:328` enforces the unit limit, `bridge.ts:340` requires `reviewOf` to name an earlier admitted unit of the same grant.                                                                                                                                                                                                                       |
| B5                   | Cowork uses new scratch/home per attempt, closes its grant and removes created state (`dsh-cowork.ts:570`). Coding now uses unique homes with tested cleanup. Both ACP paths issue `session/new`, never `session/resume`. Deferred cleanup limitation described above.                                                                                                                                              |
| B6                   | Existing resource ids, connection metadata, legacy identity schemas and NRC pin selection are unchanged. No id migration or rewriting was introduced.                                                                                                                                                                                                                                                               |
| B7 / Git             | `acp/launch.ts:73` refuses writable workspaces without sandbox isolation and rechecks prepared isolation. Existing engineering harvest/gates/review/owner approval/commitPatch flow remains the authority for applying repository changes.                                                                                                                                                                          |
| B8                   | `sessions/record.ts:129` keeps context@1 fields readable and `:152` retains legacy engine literals. No session deletion or format rewrite was added.                                                                                                                                                                                                                                                                |
| B9                   | `sessions/store.ts:192` acquires the writer lease; mutations require it (`:271`). Project memory writes require the same lease predicate (`project-memory/store.ts:241`).                                                                                                                                                                                                                                           |
| Project memory       | Desktop owner channels alone add/remove entries; `project-memory/store.ts:201` writes source=owner and reads verify the record project id. Operating context uses the canonical session project; mode changes do not transfer grants/approvals. Required memory is a protected system suffix and complete-or-fail block. Actual model-facing context/compaction verification is reported separately under UDSH-08B. |

## Focused verification

Initial focused review run (the subsequent root follow-up is recorded below):

```powershell
pnpm exec vitest run integrations/deepseek-harness/src/acp/acp.test.ts integrations/deepseek-harness/src/acp/gateway.test.ts apps/desktop/src/main/operating.test.ts --maxWorkers=1
```

3 files, **79 tests passed** (40 ACP + 28 gateway + 11 direct-session regressions). New assertions cover
native/custom agent exclusion, model-label spoofing, no bounded candidates, honest forbidden
preference rejection, pi preference and single accounting record, concurrent project overlay
isolation, live 0700/0600 modes, deletion after success/cancel, fresh successive homes, changed
gateway/native models, correct native selection, bounded stalled preparation and eventual cleanup.
All fake native/provider adapters remain offline even if a regression reaches them.

`apps/desktop/src/main/sessions.test.ts` also passed **44 tests** in the immediately preceding focused
four-file run (122 tests total). Later preparation cleanup changes did not alter direct-session
admission. Additional accounting/cleanup verification follows below. Early new-fixture failures (wrong terminal-state and telemetry-event
names) were corrected; they were test-authoring failures rather than acceptance evidence.

The root follow-up regression passed seven files and 116 tests, including accounting integration,
cleanup failure preserving the primary error, and catalog/cache usage. The final source snapshot
passed full `pnpm check` on independently verified Node 22.23.3: 4,229 tests, 160 existing skips,
format, lint, boundary checks, typecheck and production build. Three real-DSH context tests also
passed, including actual automatic compaction and unrelated-project isolation.

Desktop source/package evidence is recorded in the final stabilization report. Real Linux sandbox
acceptance and exact-final-head CI cannot be established on this Windows host. GitHub did not start
the mandatory jobs because account payments failed or the spending limit was reached. Paid
live-provider compatibility was not exercised; offline success does not certify it.

## Approval recommendation

The corrected managed runtime/fallback boundaries are consistent with the DSH-first design. ADR-030
must remain Proposed. Persistent control-call accounting is now corrected; final exact-head
platform/security/packaged CI evidence is still required.
Do not claim the implementation ready for owner approval on focused regressions alone.
