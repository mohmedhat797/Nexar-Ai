# FCR-02 — Opus independent final review

**Date:** 2026-10-12 (Africa/Cairo). **Reviewer:** Claude Opus 5.5 (not delegated).
**Reviewed work:** the FCR-02 engineering verification and R3 correction by GPT-6.1 Sol through
Codex ([handover](../../development/FCR02_Engineering_Verification_Handover.md)).
**Governance:** PR [#41](https://github.com/mohmedhat797/Nexar-Ai/pull/41) stays Draft; ADR-030
stays Proposed; NXR-070 not started. No AppContainer or other isolation experiment was run.

## 1. Source identity

| Item                              | Value                                                                                                  |
| --------------------------------- | ------------------------------------------------------------------------------------------------------ |
| Review branch                     | `fcr02/opus-integration` (local only; not pushed)                                                      |
| Initial SHA (previous Opus state) | `8b084d1b4ece77d9b484f1b7cc1b18a3b59b7e1c`                                                             |
| Tested implementation             | `6bbe26e8600ceb8cb48ab7cb216a2e1419cb45ec`, tree `4f4b8570f201c857f54559102de79f69e5e9ece0`            |
| Codex final head                  | `370b2ba2d63d852b96cd151e00ea8bbc5ed77fbf` (handover document only)                                    |
| This review                       | One documentation commit on top of `370b2ba`                                                           |
| Remote PR #41 head                | `7337aa00b667429834478c719532464b3a81b195`, an ancestor of every SHA above (fast-forward relationship) |

## 2. Scope and method

Previous agent reports were treated as inputs, not proof. The reviewer **independently
re-executed**:

- R3 before/after under both `TEMP` spellings;
- mutation checks of the lease and concurrent-read regressions against the pre-fix
  implementations;
- the installer SHA-256;
- parsing of the raw Windows CI, WSL2 and audit JSON;
- source inspection of the dependency reachability paths.

**Not re-executed:** Windows Full CI, source or packaged E2E, or the WSL2 runs. Their raw reports
were inspected instead.

## 3. Source changes inspected (`8b084d1..370b2ba`)

- **`6bbe26e`** wraps the six fixture `mkdtemp` roots in `realpath` (in `dsh-cowork-path.test.ts`
  and `dsh-cowork.test.ts`) and adds one import. No assertion was changed, removed or relaxed; the
  junction, parent-traversal, deleted-root and concurrency cases keep their expectations.
- **`370b2ba`** adds the handover document only.
- **`git diff 7337aa0..370b2ba`** outside `docs/` and `*.test.ts` is empty, so **no production
  change** exists relative to PR #41. The FCR-01 corrections are byte-identical to the reviewed
  baseline.
- Gitleaks 8.28.0 on the local head: 276 commits, no leaks.

### FCR-01 corrections

| Item                                          | Evidence                                                                                                                                                                                                | Verdict                     |
| --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------- |
| 01/02/03 Cowork policy, standing write, tools | Source review ([FCR02_Independent_Review.md](FCR02_Independent_Review.md)); focused suites pass on Windows and WSL2; real pinned-DSH catalog/broker assertions (`local.real.test.ts`, 6 passed on WSL2) | Verified                    |
| 04 Sandbox credential argv                    | Source review; WSL2 real bubblewrap suite 12 passed                                                                                                                                                     | Verified                    |
| 05 Coding downgrade                           | Pre- and post-`prepare` isolation checks in all write-capable adapters; regressions pass                                                                                                                | Verified                    |
| 06/07 CI report integrity                     | Source review; the actual reports bind start/end commit and tree, show `sourceStable`, and flag the Linux stage separately                                                                              | Verified, with R2 (P3) open |
| 11 Concurrent reads                           | **Mutation check:** both regressions fail against pre-fix `c4df4c8` `store.ts` and pass now                                                                                                             | Verified                    |
| 12 Writer lease                               | **Mutation check:** all three regressions fail against pre-fix `479501e` `store.ts` and pass now; source review found no dual-writer interleaving                                                       | Verified, with R1 (P3) open |
| 09 Host read boundary / 10 TOCTOU             | These were never corrections; they remain open boundaries                                                                                                                                               | Open (see §9)               |

## 4. R3 review

- **Reproduced independently.** The `7337aa0` fixtures under the short-name `TEMP`
  (`C:\Users\MOHAME~1\…`) fail 2 of 8 in `dsh-cowork-path.test.ts`. Codex recorded 3 of 44
  across both files, and the third was confirmed earlier in this session.
- **Corrected fixtures:** 44/44 pass under both the short and the long `TEMP`.
- **What the correction changes:** test fixtures only. Production behaviour is unchanged and
  correct. `runTurn` passes `realpath(scratchBase)`, `newScratch` returns a `realpath`ed
  `mkdtemp`, and `isPhysicalScratchEscape` still rejects any root that is not canonical
  (fail-closed). Short-name paths are therefore handled by canonicalizing, never by relaxing
  the check.
- **Not weakened.** Canonicalizing the fixture roots mirrors production construction. No security
  expectation changed.
- **Minor gap (P3):** no test explicitly asserts that a non-canonical (8.3 alias or linked)
  scratch root is rejected. Before the fix this was exercised only by accident, as failures.
  Adding an explicit negative test is recommended but not required.

**Verdict: `R3_ACCEPTED`.**

## 5. Windows evidence

Raw report `report-2026-10-12T00-19-02-090Z.json`:

- `NEXAR_WINDOWS_FULL_PASS`, start and end `6bbe26e`, clean (`dirtyFingerprint: null`),
  `sourceStable: true`, Node `v22.23.3`, `win32 10.0.26300`, 1,368.87 s.
- 15 required stages PASS; `linux-sandbox` BLOCKED (not required).
- Stage metrics:
  - `test-offline`: **4,451 = 4,285 passed + 162 skipped + 4 pending**, 0 failed;
  - source E2E **22/22**; packaged E2E **22/22**; real DSH context **3/3**.
- The report's aggregate `testsTotal: 4,498` / `testsPassed: 4,332` adds these overlapping suites
  together. It must not be cited as a count of unique tests (labelling only, the same caution
  FCR-01 recorded).

Installer provenance:

- Recomputed SHA-256 `70be82a4a0f518b813e22ea5780c6fa926548f10241265cc309b78dea3e11016` and
  322,009,733 bytes, matching the report.
- Its timestamp (00:37:51Z) lies inside the `desktop-package-win` stage window
  (00:27:45Z–00:38:18Z) of the same `6bbe26e` run, which was followed by packaged E2E.
- Bundled DSH `0.2.0-rc.2`. Authenticode NotSigned (development artifact).

**Verdict: `WINDOWS_EVIDENCE_ACCEPTED`** for `6bbe26e`. The later commits are documentation only.
The two retained failures (§7) are disclosed, not hidden.

## 6. WSL2 evidence

- `wsl-unit.json` (`nexar-plane`, Ubuntu 24.04.5 on a WSL2 kernel, Node 22.23.3):
  **4,451 = 4,429 passed + 22 skipped**, 0 failed. The skips are live/paid opt-ins and
  Windows-only suites.
- Source start and end are both `6bbe26e` / `4f4b857`, the same tree as the Windows run.
- Key suites are present:
  - real bubblewrap launcher 12;
  - sandbox availability 5;
  - lane-engine sandbox and DSH integration 2 + 2;
  - real sandboxed ACP 1;
  - host-local real DSH 6;
  - real context/compaction 3;
  - lease race 3; concurrent read 2;
  - CLI smoke.
- Real Coding fixture `PASS`: three offline model requests, a workspace write, the outside write
  blocked by the sandbox, and no token in argv.
- The first unprepared run (missing build outputs) is retained and is not counted.

This is content-equivalent Linux validation, **not native Ubuntu Full CI**. Linux Electron/Xvfb E2E
and Linux Gitleaks were not executed.

**Verdict: `WSL2_EVIDENCE_ACCEPTED`** (scope as stated).

## 7. Intermittent Windows failures

| #   | Test and time                                                                                                   | Signature                                                                                                                                | Reruns                                                                                          | Classification                                                                                                                                                                                                                                                                                                                                                                                                                  |
| --- | --------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | `control-gateway/server.test.ts` "exits when stdin closes", during `pnpm check` started 02:52 local             | Gateway child exited with code `0x1` before printing its ready line; 1 failed / 4,284 passed                                             | Focused 21/21; complete check 4,285 passed; passed inside both later Full CI unit stages        | **Unresolved intermittent failure.** Exit 1 has three possible sources in `control-gateway/main.ts`: a stdin error, a listen error, or an uncaught exception. The harness spawns the child with `stderr: 'ignore'`, so the evidence cannot tell which. Not a native crash (`0xC0000409`). In production an early exit fails closed (`unavailable()`, bounded restart), so no security impact is indicated.                      |
| 2   | `e2e/providers.e2e.ts` "stores a clipboard key privately…", first Full CI source E2E (stage 00:07:48–00:12:33Z) | After the key is removed, the second turn's result was not seen: `result-text` count 1 instead of 2 after the full 60 s poll (test 76 s) | Focused repro 1/1 in 13.6 s; source E2E 22/22; final Full CI source and packaged E2E 22/22 each | **Unresolved intermittent failure.** The run overlapped the WSL2 validation (WSL unit run started 00:08:01Z), and every stage was about 1.2–1.9× slower. A 60 s miss on a step that normally takes seconds is not explained by that slowdown alone. The failed turn's outcome (error or stall) was not captured, and the fixture state was gone before the probe ran. **A retry-based PASS cannot exclude a real defect here.** |

**Assessment:** neither failure is a confirmed product defect, and neither touches code changed by
FCR-02, since both exercise code identical to PR #41. They do not block integrating the local
changes. They remain open items for PR #41 owner sign-off.

**Corrective requirement before sign-off:**

1. Capture the child's stderr in the gateway test harness, and the turn outcome plus a Playwright
   trace on Providers E2E failure.
2. Repeat the Providers E2E under deliberate background load until the failure either reproduces
   with diagnostics or has a bounded rate.

## 8. DSH dependency assessment

Independently confirmed in the installed runtime. The lock matches the pin.

- **Raw audit:** `npm audit` reports 12 entries (5 high, 7 moderate) from **two** advisories.
  The workspace production tree has 0 of 224.

**MCP SDK OAuth server substitution (GHSA-6qxp-vccf-f47h, high)**

- Affected: `@modelcontextprotocol/client` and `core` **2.0.0** (range `>=2.0.0 <2.2.0`).
- `dsh-mcp-client` builds only `StdioClientTransport` or `StreamableHTTPClientTransport` with
  static `requestInit.headers`, and **no `authProvider`**.
- Nexar mounts only its stdio bridge, in a fresh per-turn `DSH_HOME`.
- No managed path enters the OAuth flow. Custom or authenticated MCP plugins are not certified.
- Re-review if the proposed HTTP-MCP bridge is adopted (header-only auth, still no
  `authProvider`).

**fflate ZIP64 loop (GHSA-px8p-9vwx-vf98, moderate)**

- Affected: nested **0.8.2** under `@deepseek-ai/libreoffice-kit` 0.1.5. Root fflate is 0.8.3.
- `libreoffice-kit/lib/worker.js` imports and calls **`unzipSync`**. FCR-01's statement that the
  consumer imports only `zlibSync` was **inaccurate**, and the handover's correction is confirmed.
- **Reachability in managed profiles:**
  - The ACP app (`dsh-acp-app` over `dsh-base`) mounts neither `office-to-pdf` (web app only)
    nor `skill-office` (SDK app only).
  - Cowork has no shell, so the converter is not reachable from Cowork.
  - Coding's sandboxed shell could invoke the kit CLI explicitly on a hostile document. The
    worst case is a resource-exhaustion denial of service inside the sandbox, bounded by the
    worker's limits and the turn timeout. Those limits were not exercised against a malformed
    archive.

**Remediation:** client/core 2.2.0 and fflate 0.8.3. Both require upstream pin changes (exact
pins in the kit and the MCP plugin), so they are not a local fix.

**Conclusion:** the advisories **do not block the current managed configuration**. They remain
recorded upstream debt with conditional residual risk. The tree is **not** vulnerability-free.

**Verdict: `DEPENDENCY_RISK_REVIEW_COMPLETE`.**

## 9. Confirmed residual risks

1. **Cowork host-local read exposure** (FCR-01-09). A real pinned-DSH synthetic outside read still
   succeeds. Application write controls are verified; OS read isolation is
   **`OS_ISOLATION_NOT_YET_VERIFIED`**. The AppContainer design in
   [FCR02_Architecture_Decision.md](FCR02_Architecture_Decision.md) remains a hypothesis pending
   a separately authorized spike.
2. **Post-grant TOCTOU** (FCR-01-10): bounded by re-checks, not eliminated.
3. **The two unresolved intermittent failures** (§7).
4. **Upstream advisories** (§8), conditional.
5. **Availability and labelling:** R1 (stale lease claim and its message) and R2 (dirty-tree PASS
   label). R3 is corrected.
6. **Missing platform evidence:**
   - native Ubuntu Full CI not executed;
   - Linux Electron/Xvfb and Linux Gitleaks not executed;
   - cross-platform acceptance incomplete.
7. **Unsigned installer.** Development artifact; no public-release certification.

## 10. Owner decisions required

- Cowork: require OS read isolation (authorize the follow-up spike), adopt a restricted release
  policy, or keep it blocked. This review accepts no residual risk.
- Provide a native Ubuntu executor (VM, machine or authorized self-hosted runner) for Linux Full
  CI with Xvfb and Gitleaks.
- Dispose of the two intermittent failures (§7 requirement) before PR #41 sign-off.
- Track or accept the upstream dependency advisories.
- Integrate the local branch into PR #41 (below). ADR-030 acceptance stays yours.

## 11. Integration readiness

The local changes are one test-fixture correction plus documentation. They are reviewed and
verified on exact source, and they fast-forward cleanly from PR #41's head.

Recommended owner-run integration (no force; verify the ancestry first):

```bash
git merge-base --is-ancestor origin/feat/nexar-unified-dsh-runtime fcr02/opus-integration
```

```bash
git push origin fcr02/opus-integration:feat/nexar-unified-dsh-runtime
```

This updates Draft PR #41 to the reviewed head. Full CI evidence remains bound to `6bbe26e`;
everything after it is documentation only. Integrating does not make PR #41 mergeable: §9 and §10
still apply.

**Verdict: `FCR02_LOCAL_CHANGES_READY_FOR_PR_INTEGRATION`.**

## 12. Final independent verdict

| Area                  | Verdict                                        |
| --------------------- | ---------------------------------------------- |
| FCR-01 corrections    | `VERIFIED`                                     |
| R3 implementation     | `R3_ACCEPTED`                                  |
| Windows CI            | `WINDOWS_EVIDENCE_ACCEPTED`                    |
| WSL2                  | `WSL2_EVIDENCE_ACCEPTED`                       |
| Dependency risk       | `DEPENDENCY_RISK_REVIEW_COMPLETE`              |
| Integration readiness | `FCR02_LOCAL_CHANGES_READY_FOR_PR_INTEGRATION` |
| Cowork isolation      | `OS_ISOLATION_NOT_YET_VERIFIED`                |
| Full milestone        | **`FCR02_FINAL_ACCEPTANCE_BLOCKED`**           |
| Next milestone        | `NXR070_PREREQUISITES_NOT_YET_SATISFIED`       |

The milestone is blocked by:

- Cowork OS read isolation not yet verified, which needs an owner decision;
- missing native Ubuntu Full CI;
- the two unresolved intermittent failures.

Local engineering verification is accepted. Full security and platform acceptance is not.
