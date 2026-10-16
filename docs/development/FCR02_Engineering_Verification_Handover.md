# FCR-02 — Engineering Verification Handover

**Date:** 2026-10-12 (Africa/Cairo). **Engineering verdict:** `FCR02_ENGINEERING_VERIFICATION_PASS`.
**Scope:** independent FCR-01 regression revalidation, Windows Full Local CI, approved WSL2 validation, dependency review and local corrective engineering. This verdict does not accept Cowork OS isolation or ADR-030.

## A. Initial Repository State

- Repository: `mohmedhat797/Nexar-Ai`; existing Draft PR [#41](https://github.com/mohmedhat797/Nexar-Ai/pull/41).
- Authorized local worktree: `D:/Nexar-Ai-main/.claude/worktrees/vigorous-elion-299bbc`; branch `fcr02/opus-integration`.
- Initial SHA: `8b084d1b4ece77d9b484f1b7cc1b18a3b59b7e1c`; Git tree: `6df636b36a73057e3aaa45258eff09daafe4063a`; clean, exactly one documentation commit ahead of remote baseline.
- Independently checked remote implementation HEAD: `7337aa00b667429834478c719532464b3a81b195`; remote main: `677eefd282fb240cb9583dead80ae100bdeab176`.
- Primary checkout remained on `feat/nexar-resource-orchestration`, `9e71014979db7a7619bb6ac909b8418a0d198573`. Other registered worktrees were preserved.
- Exact clean source used for Windows Full CI and WSL2: `6bbe26e8600ceb8cb48ab7cb216a2e1419cb45ec`; Git tree: `4f4b8570f201c857f54559102de79f69e5e9ece0`; dirty fingerprint `null`. Windows start/end source identities match. WSL2 clone came from a verified Git bundle of that same commit and stayed clean.
- This handover follows that source as documentation only. It does not claim Full CI was run on its own later documentation commit; obtain the final local SHA with `git rev-parse HEAD`. Production code and regression tests are unchanged after the tested commit.

All required FCR-01/FCR-02 documents, ADR-030, the local CI guide, stage manifest and reporting/preflight/process/source-binding code were inspected. No required document was missing. The two Opus FCR-02 documents remain unchanged, including their historical spike narrative; this mission neither repeats nor independently certifies those experiments. The reported `.nexar/fcr02-spike` directory was absent in the authorized worktree. Its only intake delta against the remote baseline was those two documents; no production AppContainer implementation was present in that delta.

## B. FCR-01 Regression Results

The existing suites below ran through the actual full offline commands. Counts are assertion attempts within the indicated files, with overlap between rows; do not sum them into a unique-test total. Every mapped file was present in both JSON reports.

| Area                            | Production paths inspected                                                                  | Existing regression files                                                                                                   | Windows passed / skipped | WSL2 passed / skipped |
| ------------------------------- | ------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- | ------------------------ | --------------------- |
| Cowork filesystem permissions   | `integrations/deepseek-harness/src/cowork-policy.ts`, `apps/desktop/src/main/dsh-cowork.ts` | `cowork-policy.test.ts`, `dsh-cowork.test.ts`                                                                               | 72 / 0                   | 72 / 0                |
| Scratch containment             | `dsh-cowork.ts` canonical scratch creation, permission rechecks and physical path helper    | `dsh-cowork-path.test.ts`, `dsh-cowork.test.ts`                                                                             | 44 / 0                   | 44 / 0                |
| Effective DSH restrictions      | `integrations/deepseek-harness/src/profiles.ts`, `acp/local.ts`                             | `profiles.test.ts`, `acp/local.real.test.ts`                                                                                | 40 / 0                   | 40 / 0                |
| ACP permission enforcement      | DSH `acp/local.ts`, permission broker and engineering ACP client                            | `acp/acp.test.ts`, `acp/local.test.ts`                                                                                      | 63 / 0                   | 63 / 0                |
| Sandbox credential delivery     | `packages/sandbox/src/launcher.ts`, `profile.ts`, DSH `acp/launch.ts`                       | sandbox `launcher.test.ts`, `profile.test.ts`                                                                               | 15 / 23                  | 38 / 0                |
| Coding downgrade rejection      | DSH `acp/launch.ts`, Claude Code engineering launcher                                       | DSH `acp/acp.test.ts`, Claude Code `engineering.test.ts`                                                                    | 61 / 0                   | 61 / 0                |
| Session read/write concurrency  | `packages/sessions/src/store.ts` read/write queues                                          | `store-concurrent-read.test.ts`, sessions `store.test.ts`                                                                   | 28 / 1                   | 29 / 0                |
| Single-writer lease acquisition | sessions `store.ts` exclusive acquisition claim                                             | `store-lease-race.test.ts`                                                                                                  | 3 / 0                    | 3 / 0                 |
| Project Memory                  | `packages/project-memory/src/store.ts`, rendering, Desktop owner IPC/context pipeline       | memory `store.test.ts`, `render.test.ts`, Desktop `project-memory.test.ts`, `dsh-cowork.context.real.test.ts`               | 47 / 1                   | 48 / 0                |
| NRC routing/accounting          | `packages/engine-gateway/src/gateway.ts`, `select-control.ts`, runtime telemetry sink       | `gateway.test.ts`, `select-control.test.ts`, integration `control-accounting.test.ts`, Desktop `dsh-cowork.control.test.ts` | 35 / 0                   | 35 / 0                |
| Local CI reporting              | `scripts/local-ci/`                                                                         | `tests/local-ci.test.ts`, `tests/local-ci-security.test.ts`                                                                 | 32 / 0                   | 32 / 0                |

The assertions were reviewed for behavior, not just overlay strings. Six `acp/local.real.test.ts` assertions execute the pinned DSH against an offline model server: actual model-facing shell/web/plugin/subagent/workflow restrictions, broker-authorized scratch writing, refusal of unrequested/outside writes, protected context, and the remaining synthetic host read exposure. The real context suite forces compaction, tests forged owner instructions and project separation, and refuses persisted required-context overflow before ACP/model execution. Lease tests deterministically pause acquisition and dead-lease replacement, exercise concurrent contenders, and preserve abandoned claims. Read tests pause inspection and verify a queued writer cannot replace the record mid-read.

Sandbox tests inspect the private 0600 argument file, cleared environment, synthetic token exclusion from argv and disposal; WSL2 also exercises actual bubblewrap. Coding regressions reject both a declared non-sandbox launcher and a prepared launch downgrade before spawning and require disposal. Gateway regressions attribute every provider attempt, enforce selection/fallback/route authority, persist accounting once per attempt, and prove telemetry failure cannot retry a completed model call. Local CI negatives reject missing mandatory stages, interruption, failed preflight, stale/changed source, stale packages, missing Gitleaks and unsupported Node; WSL reports cannot certify native Ubuntu.

Exact focused Cowork commands, executed under both normal and short-name TEMP:

```powershell
pnpm.cmd exec vitest run apps/desktop/src/main/dsh-cowork-path.test.ts apps/desktop/src/main/dsh-cowork.test.ts --reporter=json --outputFile=.nexar/fcr02/cowork-long-before.json
pnpm.cmd exec vitest run apps/desktop/src/main/dsh-cowork-path.test.ts apps/desktop/src/main/dsh-cowork.test.ts --reporter=json --outputFile=.nexar/fcr02/cowork-short-before.json
pnpm.cmd exec vitest run apps/desktop/src/main/dsh-cowork-path.test.ts apps/desktop/src/main/dsh-cowork.test.ts --reporter=json --outputFile=.nexar/fcr02/cowork-short-after.json
pnpm.cmd exec vitest run apps/desktop/src/main/dsh-cowork-path.test.ts apps/desktop/src/main/dsh-cowork.test.ts --reporter=json --outputFile=.nexar/fcr02/cowork-long-after.json
```

Normal TEMP was `C:/Users/Mohamed Medhat/AppData/Local/Temp`; the verified short alias was `C:/Users/MOHAME~1/AppData/Local/Temp`, resolving to the same directory. Both are outside the repository. Before correction: normal 44 PASS; short alias 41 PASS / 3 FAIL. After correction: each 44 PASS / 0 FAIL/SKIPPED/PENDING. No actual owner credentials or documents were used as fixtures.

## C. Windows Full CI

**Verdict:** `NEXAR_WINDOWS_FULL_PASS`. OS `win32 10.0.26300 x64`; Node `22.23.3`; pnpm `10.33.0`; pinned DSH `0.2.0-rc.2`; Gitleaks `8.28.0`. The active Node binary was verified before every official acceptance run; system Node `24.15.0` was not used. Host Node support remains 22; Electron `44.5.1` has its own embedded runtime, whose bounded Desktop evidence does not certify system Node 24.

Exact Full runner command after verified Node 22 PATH selection and normal TEMP/TMP:

```powershell
node scripts/local-ci/runner.mjs --mode=full --workers=2 --gitleaks-bin="D:/Nexar-Ai-main/.nexar/gitleaks-8.28.0/gitleaks.exe"
```

The final source-start JSON records the full executable path, clean SHA/tree and unchanged Opus document hashes. No live/paid inference opt-in was enabled. Frozen installs, normal supported worker limits, all security checks and existing timeouts were retained.

| Stage                | Status  | Duration (s) | Exit code |
| -------------------- | ------- | ------------ | --------- |
| dependencies         | PASS    | 0.96         | 0         |
| dsh-install          | PASS    | 43.14        | 0         |
| format-check         | PASS    | 14.49        | 0         |
| lint                 | PASS    | 36.80        | 0         |
| boundaries           | PASS    | 0.52         | 0         |
| typecheck            | PASS    | 15.07        | 0         |
| test-offline         | PASS    | 215.45       | 0         |
| build                | PASS    | 2.33         | 0         |
| cli-smoke-resources  | PASS    | 0.79         | 0         |
| cli-smoke-run        | PASS    | 0.73         | 0         |
| dsh-context-real     | PASS    | 17.75        | 0         |
| desktop-e2e-source   | PASS    | 174.03       | 0         |
| desktop-package-win  | PASS    | 633.57       | 0         |
| desktop-e2e-packaged | PASS    | 209.33       | 0         |
| linux-sandbox        | BLOCKED | 0.00         | 0         |
| gitleaks-scan        | PASS    | 1.62         | 0         |

The optional Linux-only stage on Windows is classified separately; it is not a successful Linux execution. Unit JSON reconciles **4,451 = 4,285 PASS + 162 SKIPPED + 4 PENDING**, with zero FAIL/TODO/unclassified. The four pending assertions are nested bubblewrap proxy/service cases unavailable on Windows, not four missing successes. Source E2E: **22 PASS / 0 FAIL / 0 SKIPPED**; packaged E2E: **22 PASS / 0 FAIL / 0 SKIPPED**; standalone real DSH context stage: **3 PASS**. These overlap the full suite and each other; no unique-test union is claimed.

- Raw final CI report: `.nexar/ci/reports/report-2026-10-12T00-19-02-090Z.json`.
- Raw full assertions: `.nexar/ci/test-offline.json`; regression-file breakdown: `.nexar/fcr02/windows-regression-counts.json`.
- Installer: `Nexar-0.1.0-windows-x64-setup.exe`, **322009733 bytes**, SHA-256 **`70be82a4a0f518b813e22ea5780c6fa926548f10241265cc309b78dea3e11016`**.
- Bundled DSH: `0.2.0-rc.2`; installer hash matches actual bytes; installer and unpacked executable freshness were checked against packaging-stage start. Signature: `NotSigned`. This is local packaged-code QA, not a signed public-release certification.

### Retained unsuccessful and diagnostic attempts

1. An initial `pnpm check` formatting failure was corrected by applying Prettier to the changed import. The first complete check then reported one gateway child startup exit `1`; focused gateway 21/21 and the unchanged complete check subsequently passed. No `0xC0000409` native crash was observed. Its root cause remains **UNVERIFIED**; no production fix is claimed.
2. First Full CI on the same clean source: `NEXAR_WINDOWS_FULL_FAIL`, 11 stages PASS, source E2E **21 PASS / 1 FAIL**, four following stages SKIPPED; no installer produced. Providers expected the second response but saw one at its existing poll deadline. Focused Providers passed unchanged; a complete source E2E rerun passed **22/22** before the complete orchestrator rerun. This is a retained intermittent acceptance failure with **UNVERIFIED** cause, not a timeout or assertion relaxation.
3. First failed Full raw report: `.nexar/fcr02/windows-full-first-report.json`; its unit JSON is preserved separately. Standalone source rerun JSON: `apps/desktop/.nexar/fcr02-source-e2e-retry.json`. All stage logs remain under `.nexar/ci/logs/`.

## D. Linux WSL2

**Verdict for the executed scope:** `LINUX_WSL2_VALIDATION_PASS`. Both `Ubuntu` and `nexar-plane` are registered WSL2 distributions, not native Ubuntu executors. Validation used existing `nexar-plane` as unprivileged user `nexar` (UID 1000), Ubuntu `24.04.5 LTS`, kernel `6.18.33.2-microsoft-standard-WSL2`, Node `22.23.3`, pnpm `10.33.0`, bubblewrap `0.9.0`, socat `1.8.0.0`.

Fresh owned checkout: `/var/tmp/nexar-fcr02-verification-20261012/repo`, cloned from the verified local Git bundle; no prior checkout was reset or overwritten. `pnpm install --offline --frozen-lockfile` and the committed DSH runtime installer with `NPM_CONFIG_OFFLINE=true` succeeded from existing caches. No global security settings or privileged isolation were changed.

Exact commands used after `PATH=/opt/node/bin:/usr/local/bin:/usr/bin:/bin`, `TMPDIR=/tmp`, live tests unset, and `NEXAR_DSH_ENTRY`, `NEXAR_DSH_BIN`, `NEXAR_DSH_TOOLCHAIN` pointing at the freshly installed pinned runtime and `/opt/node`:

```sh
pnpm typecheck
pnpm test --maxWorkers=1 --reporter=default --reporter=json --outputFile=.nexar/fcr02/wsl-unit.json
pnpm exec tsc -b
pnpm --filter @nexar/cli build
node apps/cli/dist/main.js resources
node apps/cli/dist/main.js run --kind general 'ci smoke'
node .nexar/fcr02-real-coding.mjs
```

- Full offline unit/integration: **4,451 = 4,429 PASS + 22 SKIPPED**, zero FAIL/PENDING/TODO/unclassified; 222 files passed / 7 skipped, **206.39 s**. Typecheck, referenced build and both CLI smokes PASS.
- Required lease and session concurrency regressions PASS. Sandbox launcher/profile credential rows: **38 PASS**. Sandbox availability and real bubblewrap suites: **5 + 12 PASS**, zero skips; real plane gateway/socat integration: **2 PASS**; handshake suite: **3 PASS** (two fake-runtime regressions and one real host handshake); real sandbox ACP open/close: **1 PASS**. These are subsets of the full run.
- Existing offline real Coding fixture reused byte-for-byte (SHA-256 `4f7755e693a62f4931752a1f6a7e34a816c0f6300d58f359f0bae20f1882a30e`) against the new compiled source. Actual DSH inside bubblewrap made three deterministic model requests, wrote `/work/proof.txt`, failed an outside synthetic host write with `ENOENT`, retained required context in every request, and excluded the synthetic gateway token from argv. Ordinary sandbox workspace writes needed zero ACP approval callbacks in this fixture; containment was enforced by the OS sandbox, rather than claimed from a fake launcher.
- First unprepared attempt: 10 suite failures from missing compiled workspace exports (including teardown errors), **4,307 PASS / 143 SKIPPED / 1 FAIL**. Corrected the QA command order to run the existing typecheck/build preparation first, as Full CI does. Source/tests stayed unchanged. Both raw attempts are preserved; the first is not counted as acceptance.
- WSL raw JSON, logs, source identities and SHA-256 manifest exported to `.nexar/fcr02/wsl/`; per-file counts in `.nexar/fcr02/wsl-regression-counts.json`. Fresh WSL source remained clean with identical start/end SHA/tree.
- Linux Electron/Xvfb and Linux Gitleaks: **NOT EXECUTED**, executables unavailable in that WSL environment. Matching-source Windows Gitleaks is separate evidence. Native Ubuntu Full CI: **NOT EXECUTED / UNRESOLVED**; no native executor was available. Do not report `NATIVE_UBUNTU_FULL_CI_PASS` or cross-platform full acceptance.

## E. Dependency Audit

`pnpm.cmd audit --prod --json`: 224 workspace production dependencies, zero reported advisories. `npm.cmd audit --omit=dev --json --prefix dist/dsh-runtime`: 12 affected package entries (5 high, 7 moderate), representing **two distinct advisories with propagated dependants**, not twelve independent vulnerabilities. Raw reports remain in `.nexar/fcr02/`. Installed runtime manifest versions match the committed runtime lock; lock SHA-256 `9e5b56472319976f021fe21d3ccdedd896e65a032b8309870041a84c5f893c41`. No advisory suppression or dependency/runtime upgrade was performed.

| Advisory                                                                                               | Confirmed installed component/API                                                                                                                                                 | Managed reachability and remaining risk                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | Available remediation                                                                                                                                                                                                                                  |
| ------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| [MCP OAuth authorization-server substitution](https://github.com/advisories/GHSA-6qxp-vccf-f47h), high | `@modelcontextprotocol/client` and `core` **2.0.0**. OAuth over HTTP with held credentials is affected.                                                                           | DSH's inspected transport factory uses stdio or Streamable HTTP with explicit headers, without `authProvider`; managed Nexar bridge uses stdio. No managed `withOAuth`, `auth`, `fetchToken`, or retained MCP OAuth credential path was found. Current managed exploitation is **not demonstrated**; arbitrary/custom authenticated plugins are not certified.                                                                                                                                                                                             | Client/core **2.2.0**, with issuer-bound credentials and `expectedIssuer` where applicable. The upstream MCP plugin exactly pins 2.0.0; same-major patch availability does not establish compatibility or eliminate issuer configuration requirements. |
| [fflate malformed ZIP64 loop](https://github.com/advisories/GHSA-px8p-9vwx-vf98), moderate             | Nested **fflate 0.8.2** under `@deepseek-ai/libreoffice-kit` **0.1.5**; root fflate 0.8.3 is patched. Installed `lib/worker.js` calls **`unzipSync`** during document inspection. | This corrects the earlier compression-only interpretation: the vulnerable API exists in the shipped tree. The converter has input/archive limits, a separate worker, timeout/abort and joined worker termination, mitigating lifetime but not repairing the parser. Managed ACP base does not mount `office-to-pdf`; Coding shell can explicitly invoke the optional converter. An end-to-end managed exploit and timeout under that malformed input were **not reproduced**. Treat hostile Office conversion as a conditional residual availability risk. | **fflate 0.8.3**. Kit exactly pins 0.8.2, so remediation needs an upstream change or deliberate override plus compatibility and malformed-input regression checks.                                                                                     |

Recommendations: preserve current managed transport restrictions, avoid introducing OAuth credential reuse or untrusted plugin/converter paths without review, and validate targeted upstream/transitive fixes while preserving the DSH runtime architecture. These are risk-assessment recommendations; this verification does not accept residual dependency risk for the owner or certify untested upgrades.

## F. Corrections

**CONFIRMED, P3 — FCR02-R3:** synthetic containment fixtures passed raw `mkdtemp` roots, which may use a Windows 8.3 alias. Production `newScratch()` already canonicalizes its root with `realpath`; the containment helper correctly rejects unverifiable/redefined authority. Three positive fixture assertions therefore failed under the short-name TEMP. The correction canonicalizes the existing fixture roots in `apps/desktop/src/main/dsh-cowork-path.test.ts` and `dsh-cowork.test.ts`, matching production construction. Existing 44 assertions establish the regression before/after; no security checks were weakened and no duplicate suite was added.

Local corrective commit: **`6bbe26e8600ceb8cb48ab7cb216a2e1419cb45ec`**, `test(cowork): canonicalize scratch fixtures for Windows short paths`. `pnpm check` passed before commit; diff reviewed. No production code correction was justified by reproduced behavior in this recovery run. The two Windows transient failures above remain unverified rather than being silently labelled resolved.

## G. Remaining Architecture Decisions

- **Owner decision required:** Cowork remains host-local with the user's OS identity. The application write broker and fail-closed scratch checks do not prevent arbitrary OS-readable host files from being read. A real DSH synthetic outside-read test still passes by reading that file. Project-specific context assembly is verified; it is not OS protection for another project's files. Post-grant filesystem TOCTOU remains bounded by checks, not eliminated.
- No AppContainer production integration or feasibility validation was implemented in this mission. No alternative privileged isolation experiment, ancestor ACL change, global AppArmor/namespace/security change, privileged container provisioning or persistent runner registration occurred. Existing Opus architectural decisions were preserved, without accepting their residual risk on the owner's behalf.
- **Accepted design limitation requiring recovery guidance, P3 — R1:** an abandoned acquisition claim or unreadable lease remains fail-closed and can require owner-controlled repair. The Desktop conflict wording is overly generic. Existing regression preserves the claim; no unsafe dead-claim stealing was introduced.
- **Bounded acceptance-report limitation, P3 — R2:** a stable dirty source may still receive a single-platform PASS with its fingerprint. Cross-platform aggregation rejects dirty evidence. This mission uses clean committed sources and explicitly recorded source identities; no dirty run is used as clean acceptance.
- **Supported-runtime limitation:** official Windows host acceptance uses Node 22.23.3. System Node 24 is unsupported; historical native worker crash cause is not claimed solved. The two retained Windows intermittent failures warrant Opus follow-up if they recur; no observed failure here is classified as a reproduced 0xC0000409 crash.
- Native Ubuntu Full CI and the owner's Cowork trust/isolation release decision remain outstanding. ADR-030 stays **Proposed**, PR #41 stays **Draft**. No main modification, push, merge, release, deployment, paid Nexar inference, or NXR-070 implementation occurred.

## H. Final Acceptance Recommendation

- Engineering validation: **`FCR02_ENGINEERING_VERIFICATION_PASS`** for the commands and source identities above.
- Windows: **`NEXAR_WINDOWS_FULL_PASS`**; current source and packaged E2E evidence and installer belong to the recorded tested commit, not an older FCR-01 package.
- WSL2: **`LINUX_WSL2_VALIDATION_PASS`** for full offline tests, real ACP/Coding sandbox, gateway/socat, context, leases and CLI scope.
- Native Ubuntu: **UNRESOLVED / NOT EXECUTED**. Cross-platform full acceptance: **INCOMPLETE**.
- Cowork OS read isolation: **UNRESOLVED — OWNER DECISION REQUIRED**. This report does not certify final security isolation, public release readiness or ADR-030 acceptance.
- Local branch is ready for **Opus independent review** of the focused correction, retained failures, dependency assessment and complete evidence. Review/adoption and subsequent publication of the local branch remain owner-controlled; it was not pushed automatically.
- **`NXR070_PREREQUISITES_NOT_YET_SATISFIED`**. No NXR-070 work is part of this handover.
