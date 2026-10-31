# DSH rc.5 compatibility and upgrade delta

Date: 31 October 2026. Tested source: `cb4e2bb4d76106144abdf45ea0a96c92702e4bb3`, tree `45827efd71307f9570c98413a83da27e0fe14db2`. After it, only documentation and the adapter's default startup limit changed; see [Real provider check](#real-provider-check). **Verdict: NXR070_DSH_RC5_READY_FOR_INDEPENDENT_ACCEPTANCE.** Nothing was merged, and this is the implementer's own verification.

Authority: [version amendment](../adr/030-version-amendment-dsh-021-rc5.md) and [dependency amendment](../adr/030-dependency-security-amendment-dsh-021-rc5.md). rc.3 was never accepted or released, and its reports stay as history.

## Result

The exact pin is now `@deepseek-ai/dsh@0.2.1-rc.5`. rc.3 really does break Nexar's protocol stream, rc.5 fixes it, and the new test proves both on the real runtimes. Windows Full, WSL Full and rollback pass on the tested commit.

What this does not show:

- **Real provider coverage is narrow.** The acceptance gates used a local fake server. The owner then authorized one real DeepSeek check through the adapter, recorded below. It did not cover `nexar run`, the desktop app or the Cowork gateway route.
- **No clean-machine NSIS install ran.** Installing here would risk your personal Nexar installation.
- **The hosted run for this exact head was still pending when this report was written.** The PR description carries the result.
- **Independent acceptance is still yours.**

## Official changes, rc.3 to rc.5

| Release | Tag commit  | Date       | Stated change                                     |
| ------- | ----------- | ---------- | ------------------------------------------------- |
| rc.3    | `1f81c047…` | Baseline   | Baseline for this delta                           |
| rc.4    | `504a01a9…` | 28 October | "Fix diagnostics leaking into stdout in ACP mode" |
| rc.5    | `b830ec95…` | 30 October | "Improve how thinking content is displayed"       |

All are pre-releases with no release assets, so npm is the only distribution channel used.

## Git diff impact

Compare `v0.2.1-rc.3...v0.2.1-rc.5`: 13 commits ahead, 0 behind. GitHub's compare API stops at 300 files, and the change is mostly version bumps. Review therefore targeted the 13 commits rather than every file.

| Upstream change                                                                                     | Effect on Nexar                                                                                                           |
| --------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `mcp-client/connection.ts` returns empty pages when a server lacks the `resources` capability       | **Fixes a real failure.** On rc.3 the SDK's `console.debug` reached stdout, and Nexar's fail-closed parser ended the turn |
| `llm-deepseek-account` logs its listing message through `console.error`                             | No effect under Nexar: its overlay disables that row, so this path was not exercised                                      |
| `ui-chat` `reasoningText()` strips a leading `<signature>…</signature>` for display; adds `rawText` | No effect: web UI only. Nexar imports no DSH UI code                                                                      |

## npm metadata

| Field                      | Value                                                                                                                                                   |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Integrity                  | `sha512-WkyJZv4zl9sCAxSzRctGm58m0rilGqwR6pniBiLOz5CPDfHfDuAUicg0AAazXI7oj/Cph6/cjNTncA/rpLTXpw==`                                                       |
| Shasum                     | `8e1bfd31869414f7a5ec10c34403a852ac9c3dc7`                                                                                                              |
| Top package                | 20 files, 75,972 bytes unpacked, no `engines`, no `gitHead` in the registry document                                                                    |
| Dist-tags                  | `latest` and `next` are rc.5; `alpha` is `0.2.2-alpha.2`, not adopted                                                                                   |
| `npm audit signatures`     | 564 verified signatures, 62 verified attestations                                                                                                       |
| Managed lock               | SHA-256 `17b0419f5728bd62f2a0ce2e67b8bb75332e4486a0422e906967aa426d65fb40`                                                                              |
| Lock contents              | 636 packages, 296 at rc.5, no leftover rc.3, integrity on all                                                                                           |
| Non-DSH transitive changes | 25 versions moved, none added or removed: `@aws-sdk/*`, `@smithy/*`, `@opentelemetry/semantic-conventions`, `@types/node`, `encodeurl`, `jose`, `tslib` |

There is no `gitHead` to compare, so tag identity rests on the release metadata and tag commit, while artifact identity rests on the npm integrity and signatures. The registry provides no direct link from the tarball to the tag commit.

## Node requirements

The toolchain stays on Node 22.23.3, pnpm 10.33.0, Gitleaks 8.28.0 and Electron 44.5.1. The strictest ranges in the lock are `>=22.19.0` (nine packages) and `>=20 <23` (one), and Node 22.23.3 satisfies both. `0.2.2-alpha.2` requires Node 24.9 or later, which is one more reason it was not adopted.

## ACP compatibility

New test: `integrations/deepseek-harness/src/acp/stdout-integrity.real.test.ts`. It runs the real runtime through `runLocalAcpSession` and records the raw child streams. The Nexar parser itself is unchanged.

| Result on real runtime | rc.3                                     | rc.5 |
| ---------------------- | ---------------------------------------- | ---- |
| New test file          | 4/5; MCP resources test fails as below   | 5/5  |
| Failure                | `dsh sent a line that is not valid JSON` | None |

| Required check               | Result | Evidence                                                                  |
| ---------------------------- | ------ | ------------------------------------------------------------------------- |
| Stdout is protocol only      | PASS   | Every raw line recorded in all five tests is parsed                       |
| No diagnostics contamination | PASS   | A tools-only MCP server plus `list_mcp_resources`, the exact rc.3 failure |
| Handshake                    | PASS   | All tests initialize and open a session                                   |
| Event streaming              | PASS   | Order `agent_thought_chunk` before `tool_call` before message             |
| Tool-call serialization      | PASS   | MCP tool call and result complete through ACP                             |
| Error handling               | PASS   | Model 400 fails the turn, with parseable stdout                           |
| Cancellation                 | PASS   | `EXECUTION_CANCELLED`, stream still parseable                             |
| Process termination          | PASS   | Child exits after cancellation                                            |
| No secrets in diagnostics    | PASS   | Synthetic credential absent from stdout, stderr and the error             |
| Parser compatibility         | PASS   | `src/acp/` production code is unchanged; only the new test was added      |

**Limit:** this proves the path that actually failed. It does not prove that no other diagnostic in the runtime can ever reach stdout. Nexar's parser still fails closed if one does.

## rc.5 reasoning compatibility

| Area                          | Result                                                                                                                     |
| ----------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| Message schemas               | Real runtime accepted `reasoning_content` that contains `<signature>`                                                      |
| Reasoning handling            | Excluded from Nexar's result text and events, including the signature                                                      |
| Tool ordering                 | Thought, then tool call, then message                                                                                      |
| Conversation rendering        | No change. Renderer never sees reasoning, and it never renders model output as HTML                                        |
| Error propagation             | Model 400 maps to a Nexar error                                                                                            |
| Canonical session persistence | Not tested directly with reasoning. Nexar persists from the result, which excludes it, and session-store code is unchanged |
| DSH native UI                 | Not imported                                                                                                               |

**Limit:** the signature format came from the upstream code, not from a real DeepSeek response. The real check below does not change that.

## Real provider check

On 31 October 2026 the owner ran a real check from their own terminal with their DeepSeek key, on the rc.5 runtime in this checkout and the `deepseek-v4-flash` model. A script drove `DeepSeekHarnessExecutionAdapter` directly with the SDK profile. A pass-through recorder kept frame shapes only, never content. The script and reports stay in the git-ignored `.nexar/real-provider-test`. The source was `de270f2`, before the startup limit changed.

| Turn                     | First run                        | Rerun                                                |
| ------------------------ | -------------------------------- | ---------------------------------------------------- |
| Plain reply              | Timed out on `initialize`, 15 s  | PASS, 3.1 s                                          |
| Reasoning effort `high`  | Timed out on `initialize`, 15 s  | PASS, 3.3 s                                          |
| File read, effort `high` | PASS, 12.9 s, used the read tool | PASS, 4.6 s, used the read tool                      |
| Tokens across the run    | 9,841 in, 72 out, 9,472 cached   | 8,646 in, 96 out, 29,824 cached; DSH reports no cost |

| Check                   | Result in the rerun                                                                                |
| ----------------------- | -------------------------------------------------------------------------------------------------- |
| Stdout is protocol only | 74 frames across the three turns, zero non-JSON lines                                              |
| Reasoning events        | Parsed without error on every turn; a `reasoning-chunks` event appeared on the reasoning turn only |
| Reasoning in the result | Result text held only the answer                                                                   |
| Reasoning saved         | None in the saved session or session cache. The session file holds only its header                 |
| Key exposure            | Absent from logs, results and saved files, including the decompressed sessions                     |

What this settles: real traffic works through the overridden undici and Zod for these three turns, including one tool round trip.

What it does not settle:

- **Reasoning content:** the recorder kept no text sizes or signatures, and output token counts were low. A signed `reasoning_content` round trip is still proven only against the local fake.
- **Other routes:** on the Cowork route, the runtime talks to Nexar's local gateway, and Nexar makes the provider call. That route had no real traffic.
- **Other runtimes:** Claude, Codex and Antigravity sign-ins were not exercised.

### Startup limit

The two first-run timeouts did not recur. Nine later `initialize` timings with no credential took about 1.5 s each, including fresh homes. A slow first load from cold disk fits this, but the cause is **not proven** because that state could not be recreated. The 15 s limit dates from the adapter's first commit, so rc.5 did not introduce it.

The adapter's default is now 90 s, matching the local ACP path's default. Ordinary tasks and engineering lanes both use it, so a hung runtime now takes up to 90 s to fail at startup, instead of 15 s. Windows Full, WSL Full and the real check were not repeated for this one constant. `pnpm check` and hosted CI cover it, and the PR description carries their result.

## Credential security

The native saved-credential substitution was revalidated on the real rc.5 runtime, and it **still exists upstream**. Nexar's overlay is what prevents it.

- **Control, without Nexar's overlay:** a seeded grant in `DSH_HOME` made the runtime call the foreign server's `GET /models` with that token. This proves the seed works.
- **With Nexar's overlay:** grants were seeded in both `DSH_HOME/.credentials.yaml` and `scratch/.dsh/.credentials.yaml`, with a patch pointing account services at the foreign server. The model request carried the selected credential, and the foreign server received zero requests.

The overlay disables `credentials`, `authorization`, `session-log-deepseek`, `tool-working-directory` and `web-deepseek-api`, unchanged from the rc.3 work. Only synthetic values were used.

## Preserved boundaries

`packages/resource-controller`, `approvals`, `sandbox`, `worktrees` and `engineering` have no diff against C′ `f8fde29`. Among connection, session, memory, permission, settings and credential paths, the only changed file is one test, `connection-runtime.test.ts`. Review Diversity, immutable connection identity and execution leases therefore rest on unchanged code and the passing suite. They were not given new rc.5-specific tests.

## Dependency advisories

**Correction to the rc.3 report.** It recorded six unique advisories. The same audit data has **eleven**: five more undici advisories, published 27 October, three days before that report. Undici 8.11.2 was in rc.3 too, so rc.3's register was incomplete. The corrected version 8.12.3 fixes all of them, so the clean audit on rc.3 stays true. The `196` count hid this because npm counts per affected package.

Comparison, using the 31 October advisory data:

| Runtime                | Audit records              | Unique advisories |
| ---------------------- | -------------------------- | ----------------- |
| rc.5 without overrides | 196 (189 high, 7 moderate) | 11                |
| rc.5 with overrides    | 0                          | 0                 |
| Sealed installed rc.5  | 0, re-run 31 October       | 0                 |

A lower count is not itself the evidence. Each override below was dropped alone, and the audit re-run:

| Override                             | Locked without it | Result when dropped alone | Decision                      |
| ------------------------------------ | ----------------- | ------------------------- | ----------------------------- |
| `zod` 4.6.7                          | 4.4.3, 50 copies  | 188 records, 1 advisory   | Keep                          |
| `undici` 8.12.3                      | 8.11.2            | 59 records, 8 advisories  | Keep                          |
| `fflate` 0.8.3                       | 0.8.2             | 8 records, 1 advisory     | Keep                          |
| `@modelcontextprotocol/client` 2.3.1 | 2.2.0             | 5 records, 1 advisory     | Keep                          |
| `@modelcontextprotocol/core` 2.3.1   | Not needed        | 0; identical lock tree    | **Removed**, no longer needed |

Reachability of the five advisories missing from the rc.3 register. This is a static search of the affected undici importers (`dsh-http-proxy`, `dsh-web-fetch-http`, one installed copy), not a runtime trace. All five are corrected by version, so none depends on this review.

| Advisory            | Severity | Issue                                   | Exposure before correction                                                                                                              |
| ------------------- | -------- | --------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| GHSA-2m5v-pch6-74hx | High     | TLS options dropped in `Agent`          | The proxy module builds `Agent` and `ProxyAgent` and can set the global dispatcher. It sets no custom TLS options that the search found |
| GHSA-qrxm-fqhp-jwvm | High     | TLS 1.2 renegotiation denial of service | Possible on any TLS connection through undici; needs a malicious endpoint; availability only                                            |
| GHSA-4w7w-5xrc-9h26 | High     | Cache poisoning across redirects        | No cache interceptor found in the proxy module; web fetch is disabled in both profiles                                                  |
| GHSA-9fm3-97px-rjf6 | Moderate | WebSocket PONG buffering                | No WebSocket use found in the proxy module                                                                                              |
| GHSA-55wc-3pg8-jfw6 | Moderate | Decompress interceptor exception        | No interceptor use found in the proxy module                                                                                            |

The other six stand as assessed in the [rc.3 assessment](NXR070_DSH_RC3_Dependency_Security_Assessment.md).

## Packaging impact

Artifact reuse from the rc.3 work is unchanged: packaging consumes the sealed runtime, hashes every byte and verifies the packaged tree against the seal. No deadline changed.

| Field                      | Value                                                                                         |
| -------------------------- | --------------------------------------------------------------------------------------------- |
| Seal tree                  | `ccbd7a129a4c1b831d33de36bc81b764521b8dd230b77196bed9d9131db9520d`                            |
| Runtime                    | 27,826 files, 507,342,499 bytes                                                               |
| Installer (unsigned)       | SHA-256 `075dd0741b9df2425cee68eec650273a33e876411b86e9471d8dafb58e52f3f8`, 325,785,072 bytes |
| Packaged tree matches seal | Yes; bundled version is rc.5                                                                  |
| Package stage              | 1,388 s against the 1,500 s envelope                                                          |

**Risk:** the margin is 7.5%, and an earlier rc.3 run reached 1,692 s. A slow run can still exceed the envelope, which would be a real failure rather than something to raise the limit for.

## Test results

| Gate                            | Result on `cb4e2bb`                                                                               |
| ------------------------------- | ------------------------------------------------------------------------------------------------- |
| `pnpm check`                    | 4,634 passed, 169 skipped, zero failed                                                            |
| Windows Full                    | `NEXAR_WINDOWS_FULL_PASS`, 46.7 minutes                                                           |
| Windows offline stage           | 4,634 passed, 169 skipped, 4 pending, zero failed                                                 |
| Real DSH context                | 3/3                                                                                               |
| Windows-to-WSL Cowork isolation | 8/8                                                                                               |
| Source Desktop E2E              | 33/33                                                                                             |
| Packaged Desktop E2E            | 33/33, bundled runtime only                                                                       |
| `linux-sandbox` stage           | **BLOCKED** on Windows, as designed; covered by the WSL row below                                 |
| WSL Full                        | 4,777 passed, 30 skipped, zero failed. Log SHA-256 `0eae481b27993b4f…`                            |
| Real Bubblewrap launcher        | 12/12 in WSL; real sandboxed ACP 2/2                                                              |
| Runtime rollback rc.2→rc.5→rc.2 | Real ACP 3/3 at each step                                                                         |
| State rollback rc.2→rc.5→rc.2   | Connection, resource, session and memory digests identical; credential matches; native resume off |
| Gitleaks 8.28.0                 | PASS                                                                                              |
| Hosted CI on `f7be98f`          | Green on Linux, Windows and secret scan, rc.3-pinned parent of this work                          |

Rollback ran in disposable state against rc.2 (`f8fde29`), because rc.3 was never an accepted target. Real user state was not modified. WSL2 is not native Ubuntu.

## Storage

| Item                                  | Reclaimed                         |
| ------------------------------------- | --------------------------------- |
| rc.3 negative-control runtime on `D:` | 528 MiB, measured on the drive    |
| Three superseded WSL candidates       | 2,002 MiB inside the virtual disk |

- **The WSL space stays inside the virtual disk.** `ext4.vhdx` is still 14.13 GiB on `C:`, because shrinking it needs a WSL shutdown, which was not done.
- **`D:` free is 39.23 GiB, against 42.1 GiB before the rc.5 acceptance.** The fresh runtime, build and packaged artifacts account for the difference, so this amendment is a net cost on `D:`.
- **`C:` free is 18.72 GiB**, against 19.68 GiB before that acceptance.
- **`D:\Nexar-Ai-nxr070` was already gone.**
- **Kept:** the accepted rc.5 candidate and the two rc.3 candidates with committed evidence. No extra clones or upstream worktrees were added.

## Remaining risks

1. Overridden undici and Zod have met real provider traffic only in the three adapter turns above. Recommendation: monitor first use through `nexar run` and the desktop app.
2. `reasoning_content` with a signature has not been confirmed from a real provider.
3. rc.5 is a pre-release, and its native credential mechanism still needs Nexar's overlay.
4. The package stage has a thin margin.
5. No clean-machine NSIS install, no code signing, no native Ubuntu run.
6. The branch name still says `rc3`. It stays that way so the stack keeps its ancestry and PR.

## Future research: `0.2.2-alpha.2`, not adopted

Record only. Any adoption needs a new owner decision. Points to assess: Node 24.9 or later; expanded SDK and Session APIs; revised tool execution; model routing changes, which touch NRC's authority; experimental Codex and Claude delegation; Git worktrees, which touch Nexar's worktree and sandbox rules; plugin lifecycle; Web Fetch network changes, which touch default-deny egress.

## Final source

Tested source: `cb4e2bb4d76106144abdf45ea0a96c92702e4bb3`. The commits on top are named in the PR description, since a file cannot contain its own commit hash.
