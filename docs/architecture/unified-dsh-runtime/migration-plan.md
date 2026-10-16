# Unified DSH runtime — migration plan

Order: **build DSH replacement → verify parity → remove OpenWorker → regression**. No owner data is
deleted or rewritten at any step.

| Step | Change                                                                                                      | Owner-visible effect                                         | Data                                                                                     |
| ---- | ----------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------ | ---------------------------------------------------------------------------------------- |
| 1    | UDSH-01 runtime foundation (profiles, overlay, host-local ACP, version gate, installer script, CI runtime)  | none                                                         | none                                                                                     |
| 2    | UDSH-02/03 `DshCoworkService` wired as the Cowork lane; OpenWorker service no longer constructed            | Cowork runs on DSH; Settings shows "DeepSeek Harness" status | Sessions unchanged; new turns record `engine: 'dsh'`, fallback `dsh-control-unavailable` |
| 3    | UDSH-04 Coding overlay                                                                                      | none (same lanes)                                            | none                                                                                     |
| 4    | UDSH-05 project memory + `context@2`                                                                        | "Project memory" panel; pinned constraints in every turn     | new `<state>/.nexar/project-memory/<projectId>.json`                                     |
| 5    | Parity gate: Cowork E2E (proposal → saved draft), approvals, cancel, read-only, delegation, control restart | —                                                            | —                                                                                        |
| 6    | UDSH-06 OpenWorker removal; Work Bridge v2 → `@nexar/work-bridge`                                           | OpenWorker settings disappear                                | `desktop-settings.json` legacy `cowork.openworker*` keys ignored on read, never deleted  |
| 7    | UDSH-07 packaging with bundled DSH                                                                          | Installer includes runtime                                   | none                                                                                     |

## Compatibility rules

- **Sessions (B8):** schema keeps reading `engine: 'openworker'`, fallback reasons
  `openworker-unavailable` / `openworker-control-unavailable`, `TaskOrigin.source: 'openworker'`.
  Renderer maps them to "OpenWorker (retired)". New code never writes them.
- **Resource ids and pins (B6):** unchanged. Control-resource pins in
  `orchestration.cowork.controlResource` keep their meaning (they name NRC resources, not engines).
- **Approvals:** existing records untouched; Cowork decisions are recorded with action type
  `agent.tool` (ACP broker) instead of OpenWorker's type; listing handles both.
- **Private OpenWorker state** (`%LOCALAPPDATA%\Nexar\Runtime\openworker`) is left in place; Nexar
  stops launching it. The owner may delete it manually (documented).
- **Context:** `context@1` manifests on old turns stay valid; new turns record `context@2`.

## Rollback

- Before step 6: revert the UDSH-03 wiring commit to restore the OpenWorker Cowork lane.
- After step 6: revert the removal commit (and step 2 wiring). Project memory files are ignored by
  older builds. No persisted format is migrated in place, so rollback needs no data conversion.
