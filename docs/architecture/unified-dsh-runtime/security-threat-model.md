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
| T1  | DSH (prompt-injected model) writes outside the Cowork scratch | Cowork starts read-only; per-call write/edit requests pass fail-closed physical checks and policy rechecks; every danger-full-access denies; final grant/use race remains | A8, UDSH-01 real test, policy unit tests              |
| T2  | DSH runs shell/network                                        | Cowork overlay disables shell/web/plugin/delegation/fork/workflow rows; actual catalog tested; this is application tool policy, not OS network isolation                  | overlay golden test; real-runtime tool list assertion |
| T3  | DSH calls a model outside NRC                                 | Only `nexar` route registered (DeepSeek rows disabled); token is turn-scoped; gateway pins the control decision; a `config_option_update` to another route fails the turn | A4, UDSH-02 tests                                     |
| T4  | Provider key exposure to DSH                                  | Keys never in the DSH env/overlay; gateway resolves secrets in main; env is an allowlist                                                                                  | spawn-env assertion test                              |
| T5  | Cross-account leakage                                         | Control and unit resources resolved by connection-scoped ids; grant names one resource; no shared native session                                                          | A5                                                    |
| T6  | Grant/approval persistence across turns                       | Per-turn `DSH_HOME` deleted at end; grants revoked at turn end; no `session/resume`                                                                                       | B5 tests                                              |
| T7  | Delegation-limit reset via restart/fallback                   | One `DelegationUnitLimit` per turn spans control restarts                                                                                                                 | B2 regression                                         |
| T8  | Upstream permission mode treated as authority                 | Broker answers every request; `*_always` never selected; policy is Nexar's                                                                                                | B3 regression                                         |
| T9  | Required context dropped by compaction or truncation          | Rendered in `personaSuffix` (system prompt) and `context@2` required block; overflow fails closed                                                                         | A6/A7                                                 |
| T10 | Model output promoted to "required"                           | Only owner channels write project memory; no model path                                                                                                                   | memory tests                                          |
| T11 | Upstream telemetry/session upload                             | `DSH_TELEMETRY_DISABLED=1`; `otel`, `session-telemetry-otel`, `session-log-deepseek` disabled                                                                             | overlay test                                          |
| T12 | Supply chain (DSH npm tree)                                   | Exact pin, version gate at start, lockfile integrity at install, runtime outside asar inside the packaged installation; signing is not evidenced                          | packaging test                                        |
| T13 | DSH reads project `.env` as credential fallback               | Fresh scratch avoids implicit project cwd loading, but retained read/glob/grep can read user-readable project files explicitly; OS read boundary unresolved               | launcher test                                         |
| T14 | Second session writer                                         | Sessions and Project Memory require the writer lease; exclusive acquisition claim serializes create/stale takeover; unreadable lease/abandoned claim deny                 | B9 tests                                              |
| T15 | Path echo in errors                                           | Errors leave as `{code, message}` with fixed texts                                                                                                                        | existing channel tests                                |

## Residual risks

- Host-local DSH is not OS-isolated (same class as the supervised OpenWorker it replaces). Its file
  tools enforce application checks in-process. Nexar's broker governs recognized mutations; read access is not confined to scratch. Actual pinned DSH read a synthetic outside file without broker approval. Other-project files accessible to the OS identity are also exposed. Owner-controlled trusted-content/drafts-only use is a proposed restriction, not owner risk acceptance. Untrusted content can direct these reads into the selected model request. OS isolation or an explicit owner release-policy decision is blocking; see [FCR-01](FCR01_Security_Findings.md). The final grant/use filesystem race remains. The proposed Windows-native OS boundary (per-turn AppContainer, host-side brokers, fail-closed launcher) and its unverified status are in [NXR-SEC-01](NXR_SEC01_Architecture_Design.md) and [its threat model](NXR_SEC01_Isolation_Threat_Model.md).
- A killed process can leave a short-lived acquisition claim or an unverifiable lease. Startup then fails closed; owner/operator repair requires confirming no live writers and preserving state. Normal known dead-PID lease recovery is retained.
- DSH is a developer preview; overlay row renames would surface as start failures or a changed tool
  list, both caught by the real-runtime CI tests.
- Desktop direct session fallback permits only reviewed bounded `pi`/`echo` model bindings. Native
  agents, DSH SDK and unreviewed adapters are excluded before NRC selection. Before UDSH-08 this
  restriction was absent; see the independent review and `operating.test.ts` regressions.
- Coding ACP homes and overlays are now unique per run and removed after settlement. If a launcher
  ignores cancellation and never settles preparation, execution returns after a bounded cleanup
  grace period; its random private directory is retained until preparation settles. Cleanup failures
  emit fixed diagnostic codes, never paths or credentials. Such an orphan is not resumed by later
  turns. No automatic deletion of pre-existing native-session data is introduced.
- The current Windows package disables code signing (`signAndEditExecutable: false` and
  `CSC_IDENTITY_AUTO_DISCOVERY=false`). Version checks and lockfile integrity are verified controls;
  this report does not claim a signed installer or publisher authenticity.
