# AI usage log

Observed usage only. Figures come from tool output (e.g. `claude-delegate` `result.json`
`totalCostUsd`); where a figure is unavailable it says so. Never fabricate numbers.

Budget context: ~$100 of seed credit. Efficiency reviews at cumulative ~$25 / $50 / $75 / $90 when
usage data is available; keep ~$10 reserve.

| Date       | Session / unit                   | Model                            | Work                                                                         | Observed usage                                     | Outcome                                        |
| ---------- | -------------------------------- | -------------------------------- | ---------------------------------------------------------------------------- | -------------------------------------------------- | ---------------------------------------------- |
| 2026-09-30 | Orchestrator session (v0.1)      | Opus 5.5                         | Inspection, research synthesis, architecture, ADRs, briefs, reviews, commits | Not exposed to the session                         | See v0.1 foundation report                     |
| 2026-09-30 | Delegate probe                   | Sonnet 5.5 (`claude-sonnet-5-5`) | Verify relay + model id                                                      | $0.0148 (relay `result.json`)                      | Model id verified                              |
| 2026-09-30 | Research ×4 (native subagents)   | Sonnet                           | DSH, pi-ai, OpenWorker, Delegate Skills notes                                | Tokens only: 130k–192k per agent; cost not exposed | 4 research notes                               |
| 2026-09-30 | Delegate 01 — monorepo bootstrap | Sonnet 5.5                       | Tooling scaffold (install blocked by sandbox; orchestrator installed deps)   | $0.254, 29 turns                                   | Accepted with fixes (TS 6 pin, ESLint project) |
| 2026-09-30 | Delegate 02 — contracts          | Sonnet 5.5                       | `@nexar/contracts` + tests                                                   | $0.539, 26 turns                                   | Accepted                                       |
