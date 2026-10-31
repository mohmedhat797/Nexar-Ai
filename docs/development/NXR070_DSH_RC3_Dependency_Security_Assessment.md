# DSH rc.3 dependency security assessment

**Correction, 31 October 2026:** this register lists six advisories, but the data held eleven. Five undici advisories published on 27 October are missing here. Undici 8.12.3 fixes them, so the clean audit stands. See the [rc.5 delta report](NXR070_DSH_RC5_Compatibility_and_Upgrade_Delta.md). The text below is unchanged history, for a runtime that was never accepted.

Date: 30 October 2026. Lock SHA-256 `7d2dbdc2a97aacfcb9b1ff72755db15fabd29f46115de29ba3be9f4acfcfe60e`. **Verdict: NEXAR_DSH_RC3_DEPENDENCY_RISKS_DISPOSITIONED.** Authorized by the [dependency security amendment](../adr/030-dependency-security-amendment-dsh-021-rc3.md).

## Result

The audit's 196 records (189 high, seven moderate) were **six unique advisories**; the high count came from 50 nested copies of one Zod version plus their dependents. Exact overrides correct all six. `npm audit` on the installed corrected runtime exited 0 with no records, using advisory data available on 30 October. Only three packages changed version (undici and the two MCP packages); 50 nested Zod copies and one nested fflate were removed.

## Risk register

"Reachability" below is **static review of the installed code and Nexar's overlays**, not a runtime module-load trace. Because every advisory is corrected by version, none relies on a reachability argument to remain acceptable.

| Advisory            | Package and severity | Installed → fixed | Path                                   | Affected function                                                       |
| ------------------- | -------------------- | ----------------- | -------------------------------------- | ----------------------------------------------------------------------- |
| GHSA-mrhx-c7xc-m3w5 | zod, high            | 4.4.3 → 4.6.7     | 50 `@deepseek-ai/*` exact dependencies | Array parse accumulates an issue per failing element; memory exhaustion |
| GHSA-xjj6-f33q-929c | undici, high         | 8.11.2 → 8.12.3   | dsh-http-proxy, dsh-web-fetch-http     | `fetch()` crash on over-limit content codings with early close          |
| GHSA-4qv8-2p9j-2685 | undici, moderate     | 8.11.2 → 8.12.3   | As above                               | `EventSource` parser unbounded memory                                   |
| GHSA-f72v-6w45-q472 | undici, moderate     | 8.11.2 → 8.12.3   | As above                               | SRI bypass with non-lowercase algorithm tokens                          |
| GHSA-6prh-2h8m-c8cw | MCP client, moderate | 2.2.0 → 2.3.1     | dsh-mcp-client                         | HTTP and OAuth transports re-send headers and bodies across origins     |
| GHSA-px8p-9vwx-vf98 | fflate, moderate     | 0.8.2 → 0.8.3     | libreoffice-kit                        | `unzipSync` infinite loop on malformed ZIP64                            |

| Advisory            | Exposure before correction                                                                                                                | Existing mitigation                                                            | Status    |
| ------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ | --------- |
| GHSA-mrhx-c7xc-m3w5 | **Reachable.** Active modules parse model and tool data with Zod. Needs an oversized array; availability only, ending the turn's process  | WSL/Bubblewrap isolation contains the process; it does not prevent the failure | Corrected |
| GHSA-xjj6-f33q-929c | Web fetch is disabled in both Nexar profiles. The proxy module's use applies when proxy variables exist; a malicious endpoint is required | `web-fetch-http` disabled; egress default-deny in isolated execution           | Corrected |
| GHSA-4qv8-2p9j-2685 | No active `EventSource` to an untrusted peer found in Nexar's configuration                                                               | As above                                                                       | Corrected |
| GHSA-f72v-6w45-q472 | No Nexar use of response SRI metadata found                                                                                               | None needed                                                                    | Corrected |
| GHSA-6prh-2h8m-c8cw | The `streamable-http` transport exists in dsh-mcp-client. Nexar's sessions pass its stdio bridge, and stdio clients are unaffected        | ADR-014 stdio-only boundary                                                    | Corrected |
| GHSA-px8p-9vwx-vf98 | Office utilities are optional; a crafted archive would have to reach them                                                                 | Cowork permission boundary; no autonomous plugin installation                  | Corrected |

## Correction method

Five exact entries in the pin's `overrides`, reflected in a lock generated by pinned npm 10.9.9 and then normalized to the repository's indentation. The diff is limited to the removed nested entries, the two MCP package bumps, undici, and one transitive range text. The installer rejects non-exact overrides as `INVALID_PIN`. No `npm audit fix` was run.

**Side effect:** materialized files fell from 63,785 to 27,872 and bytes from 738 MB to 510 MB.

## Compatibility evidence

All on exact commit `ab1ddda`, against the corrected runtime:

- Windows Full: 4,629 passed, zero failed, 169 skipped, four pending; real DSH context 3/3; Windows-to-WSL 8/8; source and packaged Desktop 33/33 each.
- WSL Full: 4,772 passed, 30 skipped, zero failed or pending; real Bubblewrap launcher 12/12; real sandboxed ACP 2/2.
- Real ACP/SDK/Cowork: passed, including the saved-foreign-credential regression.
- Rollback rc.2→rc.3→rc.2: ACP 3/3 at each step; connection, resource, session and memory digests stable.

## Residual risk

1. **Live provider paths are unexercised by policy.** No paid inference ran, so undici 8.12.3 and Zod 4.6.7 against real provider traffic are covered only by synthetic transports. Upstream pins exact older versions, so this is Nexar's verified combination, not one upstream tested. Recommendation: a monitored first real use.
2. **The audit is a point in time.** New advisories can appear; re-run it at each dependency change.
3. **Static reachability review.** It covered the affected packages and Nexar's overlays, not every call path through the bundle.
4. **Future upgrades.** Each override must be re-evaluated and removed where upstream has moved past it.

No integration blocker is confirmed. No owner risk acceptance is assumed or required for the six corrected advisories; owner review of the override decision remains part of independent acceptance.
