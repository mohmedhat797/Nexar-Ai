# Unified DSH runtime — security threat model

Scope: the Cowork DSH profile (host-local) and the Coding DSH profile (plane sandbox) under
[ADR-030](../../adr/030-unified-dsh-first-agent-runtime.md). Assets: owner credentials, project
files, other projects, approvals/grants, session records, project memory, provider allowance.

## Trust boundaries

| Boundary         | Trusted side                      | Untrusted side                                            |
| ---------------- | --------------------------------- | --------------------------------------------------------- |
| Renderer ↔ main  | Desktop main                      | Renderer (zod-validated channels)                         |
| Main ↔ DSH child | Nexar policy, broker, gateway     | DSH process and the model driving it                      |
| DSH ↔ gateway    | Gateway (token-authenticated)     | Requests from DSH                                         |
| Prompt content   | Owner-confirmed project memory    | Turn text, prior outputs, documents (`<untrusted-input>`) |
| Plane ↔ Desktop  | each side's own registry and keys | the bridge (no credentials cross)                         |

## Threats and controls

| #   | Threat                                                        | Control                                                                                                                                                                   | Test                                                  |
| --- | ------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------- |
| T1  | DSH (prompt-injected model) writes outside the Cowork scratch | `cwd`=scratch, `workspace-write`/`read-only`; broker denies escalations outside scratch and every `danger-full-access`; drafts imported only from scratch                 | A8, UDSH-01 real test, policy unit tests              |
| T2  | DSH runs shell/network                                        | Cowork overlay disables `tool-pwsh`, `tool-bash`, `tool-jobs`, `tool-web`, web services; broker denies any non-listed tool                                                | overlay golden test; real-runtime tool list assertion |
| T3  | DSH calls a model outside NRC                                 | Only `nexar` route registered (DeepSeek rows disabled); token is turn-scoped; gateway pins the control decision; a `config_option_update` to another route fails the turn | A4, UDSH-02 tests                                     |
| T4  | Provider key exposure to DSH                                  | Keys never in the DSH env/overlay; gateway resolves secrets in main; env is an allowlist                                                                                  | spawn-env assertion test                              |
| T5  | Cross-account leakage                                         | Control and unit resources resolved by connection-scoped ids; grant names one resource; no shared native session                                                          | A5                                                    |
| T6  | Grant/approval persistence across turns                       | Per-turn `DSH_HOME` deleted at end; grants revoked at turn end; no `session/resume`                                                                                       | B5 tests                                              |
| T7  | Delegation-limit reset via restart/fallback                   | One `DelegationUnitLimit` per turn spans control restarts                                                                                                                 | B2 regression                                         |
| T8  | Upstream permission mode treated as authority                 | Broker answers every request; `*_always` never selected; policy is Nexar's                                                                                                | B3 regression                                         |
| T9  | Required context dropped by compaction or truncation          | Rendered in `personaSuffix` (system prompt) and `context@2` required block; overflow fails closed                                                                         | A6/A7                                                 |
| T10 | Model output promoted to "required"                           | Only owner channels write project memory; no model path                                                                                                                   | memory tests                                          |
| T11 | Upstream telemetry/session upload                             | `DSH_TELEMETRY_DISABLED=1`; `otel`, `session-telemetry-otel`, `session-log-deepseek` disabled                                                                             | overlay test                                          |
| T12 | Supply chain (DSH npm tree)                                   | Exact pin, version gate at start, lockfile integrity at install, runtime outside asar but inside the signed install                                                       | packaging test                                        |
| T13 | DSH reads project `.env` as credential fallback               | Cowork `cwd` is a fresh scratch; project roots are never the DSH `cwd` on the host                                                                                        | launcher test                                         |
| T14 | Second session writer                                         | Project memory and sessions written only under the sessions lease                                                                                                         | B9 tests                                              |
| T15 | Path echo in errors                                           | Errors leave as `{code, message}` with fixed texts                                                                                                                        | existing channel tests                                |

## Residual risks

- Host-local DSH is not OS-isolated (same class as the supervised OpenWorker it replaces). Its file
  tools enforce path checks in-process; Nexar's tool-surface reduction and deny-by-default broker
  are the boundary. Read access is not confined to scratch (the `read`/`glob`/`grep` tools can read
  files the OS user can read); Cowork therefore runs only with the owner's own projects and the
  model's results are drafts only. Follow-up: a Windows AppContainer or WSL-sandboxed Cowork.
- DSH is a developer preview; overlay row renames would surface as start failures or a changed tool
  list, both caught by the real-runtime CI tests.
