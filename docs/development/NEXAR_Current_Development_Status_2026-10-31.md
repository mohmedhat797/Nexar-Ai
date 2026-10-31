# Nexar current development status

**This is the authoritative status as of 31 October 2026, for `main` at `c97136b`.** Older reports stay as history. Where they disagree with this page about the current state, this page applies.

## What each status means

| Status                 | Meaning                                                                           |
| ---------------------- | --------------------------------------------------------------------------------- |
| Implemented            | Code exists                                                                       |
| Merged                 | On `main`                                                                         |
| Tested                 | Passed automated acceptance on `c97136b` with synthetic credentials               |
| Independently accepted | Reviewed and accepted by someone other than the agents that built and verified it |
| Production validated   | Proven with real accounts, on a clean install, in ordinary use                    |
| Planned                | Approved, not started                                                             |
| Deferred               | Held behind a gate or a later decision                                            |

## Capability status

| Capability                             | Implemented | Merged | Tested                         | Independently accepted | Production validated                                             |
| -------------------------------------- | ----------- | ------ | ------------------------------ | ---------------------- | ---------------------------------------------------------------- |
| Engine, CLI, MCP, workflows, approvals | Yes         | Yes    | Yes                            | No                     | No                                                               |
| Engineering sandbox and lanes          | Yes         | Yes    | Yes, on WSL                    | No                     | No                                                               |
| Desktop app                            | Yes         | Yes    | Yes, source and `win-unpacked` | No                     | No                                                               |
| DSH `0.2.1-rc.5` managed runtime       | Yes         | Yes    | Yes                            | No                     | Partly: owner ran real DeepSeek through the adapter on `de270f2` |
| B′ multi-API-key connections (#44)     | Yes         | Yes    | Yes                            | No                     | No                                                               |
| C′ review diversity (#45)              | Yes         | Yes    | Yes                            | No                     | No                                                               |
| Workspace maintenance (#47)            | Yes         | Yes    | Yes                            | No                     | Used on the owner's machine                                      |

The acceptance was carried out by an AI agent that also worked on this stack, so it is not an independent review.

## Planned

| Milestone                                   | Status                                                                         |
| ------------------------------------------- | ------------------------------------------------------------------------------ |
| D′ multiple Codex accounts                  | Next. See the [readiness package](NXR070D_Implementation_Readiness_Package.md) |
| H′ Providers UI v2                          | After D′                                                                       |
| F′ provenance, G′ `resource-intelligence@2` | Approved in the plan                                                           |
| I′ `context@3` and sidecar                  | Approved in the plan                                                           |
| J′ owner acceptance                         | Approved in the plan                                                           |

## Deferred

- Concurrent ChatGPT plan accounts: gate E-1.
- Multiple Claude subscription accounts: gate E-2.
- Native session persistence, resume and fork.
- Default switch to `resource-intelligence@2` (OD-11).
- Host federation and cross-host routing.

## Reports

- [Baseline manifest](NXR070_Post_Merge_Baseline_Manifest.md)
- [Integration acceptance](NXR070_Post_Merge_Integration_Acceptance.md)
- [Security verification](NXR070_Post_Merge_Security_Verification.md)
- [Environment verification](NXR070_Development_Environment_Verification.md)
- [Gap register and owner acceptance matrix](NXR070_Operational_Acceptance_Gap_Register.md)
- [Owner handover](NXR070_Post_Merge_Final_Owner_Handover.md)
