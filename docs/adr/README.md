# Architecture Decision Records

Lightweight ADRs. One decision per file, numbered, never deleted — superseded ADRs are marked
`Superseded by ADR-NNN`. Read the relevant ADRs before making an architectural change; write a new
ADR (or amend status) when you change one.

| ADR                                                | Title                                                              | Status                         |
| -------------------------------------------------- | ------------------------------------------------------------------ | ------------------------------ |
| [001](001-monorepo-strategy.md)                    | Nexar monorepo strategy                                            | Accepted                       |
| [002](002-deepseek-harness-execution-kernel.md)    | DeepSeek Harness as primary agent execution kernel                 | Accepted (amended by research) |
| [003](003-pi-ai-multi-provider-layer.md)           | pi-ai as direct multi-provider execution layer                     | Accepted (amended by research) |
| [004](004-openworker-productivity-engine.md)       | OpenWorker as personal productivity and operations engine          | Accepted                       |
| [005](005-resource-controller-ownership.md)        | Nexar Resource Controller ownership and responsibility             | Accepted                       |
| [006](006-local-first.md)                          | Local-first system architecture                                    | Accepted                       |
| [007](007-ai-resource-abstraction.md)              | AI Resource abstraction instead of model-only abstraction          | Accepted                       |
| [008](008-upstream-isolation.md)                   | Upstream isolation and anti-corruption boundaries                  | Accepted                       |
| [009](009-delegate-skills-development-workflow.md) | Delegate Skills development workflow                               | Accepted                       |
| [010](010-github-source-of-truth.md)               | GitHub as durable engineering source of truth                      | Accepted                       |
| [011](011-native-agent-adapters.md)                | Native agent adapters and the v0.1 live execution proof            | Accepted                       |
| [012](012-project-context-and-path-policy.md)      | Project context and realpath path policy                           | Accepted                       |
| [013](013-artifact-store.md)                       | Local artifact store                                               | Accepted                       |
| [014](014-mcp-transport-and-work-bridge-v2.md)     | MCP server over stdio and Work Bridge v2                           | Accepted                       |
| [015](015-client-identity-and-audit.md)            | Client identity, scoped credentials, and request audit             | Accepted                       |
| [016](016-human-approvals.md)                      | Human approval framework (fail-closed, action-bound)               | Accepted                       |
| [017](017-data-driven-workflows.md)                | Data-driven workflows with an untrusted-input boundary             | Accepted                       |
| [018](018-engineering-execution-plane.md)          | Engineering execution plane (Windows → WSL2 → bubblewrap)          | Accepted                       |
| [019](019-engineering-lanes-and-resources.md)      | Engineering lanes, resource selection, Nexar acceptance            | Accepted                       |
| [020](020-resource-intelligence-scheduler.md)      | Resource Intelligence: explainable quota- and cost-aware scheduler | Accepted                       |

Template: Status · Context · Decision · Rationale · Alternatives considered · Consequences · Risks ·
Follow-up work.
