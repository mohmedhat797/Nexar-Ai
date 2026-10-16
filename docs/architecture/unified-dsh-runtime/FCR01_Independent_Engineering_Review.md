# FCR-01 — Independent Engineering Review

**Date:** 2026-10-11 (Africa/Cairo). **Recommendation:** `NEXAR_FCR01_BLOCKED_BY_EXTERNAL_DEPENDENCY`.
**Milestone:** Unified DeepSeek Harness Runtime + Local CI Infrastructure.
**Governance:** PR [#41](https://github.com/mohmedhat797/Nexar-Ai/pull/41) remains Draft; ADR-030 remains Proposed. Do not start NXR-070.

## Repository intake and source identity

- Requested branch: `feat/nexar-unified-dsh-runtime`; actual remote intake HEAD: `5430a5dadce4043a4e71c61dfb1fec8acd2a13ad`.
- Primary checkout was clean on `feat/nexar-resource-orchestration`, HEAD `9e71014979db7a7619bb6ac909b8418a0d198573`. An existing implementation worktree was occupied, so review/corrections used isolated `codex/fcr01-audit`.
- PR base was `main`, `677eefd282fb240cb9583dead80ae100bdeab176`. No main edits, reset, force-push or merge were performed; existing worktrees and data were preserved.
- Clean corrective code revision: `723ae706f38d8de65e639b6401ee5fab69705b07`; Git tree: `6a5759f8cb1a1aa2ae8a71d65d82120f476e4951`.
- Full Windows CI is bound to that clean revision and confirms start/end source stability. The final documentation commit follows the tested code; its diff is restricted to documentation/evidence, and does not claim a new implementation was exercised.
- No pending review comments were returned at intake. Hosted Ubuntu/Windows/secret jobs did not start because GitHub reported failed payments or the spending limit; no repeated hosted reruns or persistent runner registrations were made.

## Independent review scope

The review inventoried the full PR #41 change set against origin/main (236 changed files at intake) and traced its security-sensitive production paths: desktop main/preload/IPC and operating-mode dispatch; DSH profiles, ACP clients, lifecycle, environment construction and gateway route; NRC selection, native resources, fallback and accounting; EngineeringRunner, plane engine, worktrees, owner Git approval and all native compatibility launchers; bubblewrap mounts, namespaces, proxy and relay; canonical sessions, leases, context assembly and Project Memory; package installation/lockfiles, Electron packaging, source/packaged E2E and every local CI orchestrator file. Configuration, lockfiles and all requested architecture, stabilization, final closure and CI reports were reviewed. Existing tests were retained where adequate; new regressions address demonstrated gaps. This is a source-and-executable audit, not a claim that offline fixtures certify real providers or every possible hostile host state.

Architecture review confirms DSH is the primary managed agent runtime, Cowork and Coding are profiles, active OpenWorker execution is removed, NRC owns selection/accounting, and Nexar owns sessions, memory and approvals. Retained NRC native specialist resources and compatibility launchers are declared execution paths; DSH is not described as the only executable adapter in the repository. Direct desktop fallback is restricted to bounded reviewed pi/echo model bindings.

## Verified findings and corrections

### FCR-01-01 — Cowork containment

**P1; CONFIRMED — corrected.** Commit/evidence: `17374842fefc8b8fa38faa0061744d953a2b08a8`.

**Root cause:** An unresolved scratch root returned false (safe); approval could outlive a target replacement; hard links were accepted.

**Correction or retained boundary:** Require a valid canonical directory, deny lookup errors, links/junctions and multi-link files, verify root identity within each check, and recheck after owner approval and policy recording.

**Files:** `apps/desktop/src/main/dsh-cowork.ts; dsh-cowork-path.test.ts; dsh-cowork.test.ts`.

**Regression/evidence:** Missing/deleted roots, EACCES root/ancestor, traversal, nested nonexistent targets, junctions (including internal links), hard links, root replacement, concurrent checks and replacement while approval is pending.

### FCR-01-02 — Cowork standing permissions

**P1; CONFIRMED — corrected.** Commit/evidence: `17374842fefc8b8fa38faa0061744d953a2b08a8`.

**Root cause:** Pinned DSH workspace-write permits ordinary filesystem writes without an ACP permission request, including its temporary-directory allowance.

**Correction or retained boundary:** Start every Cowork ACP session read-only; require explicit workspace-write permission for each write/edit; fail closed on unrecognized mutation inputs. Real runtime regressions assert the broker is called and unasked writes fail.

**Files:** `integrations/deepseek-harness/src/acp/local.ts; cowork-policy.ts; profiles.ts; acp/local.real.test.ts; apps/desktop/src/main/dsh-cowork.real.test.ts`.

**Regression/evidence:** Unknown mutation schemas and elevation modes deny; real pinned DSH write calls reach the broker; unasked writes fail; ordinary valid drafts still import.

### FCR-01-03 — Effective Cowork tools

**P1; CONFIRMED — corrected.** Commit/evidence: `17374842fefc8b8fa38faa0061744d953a2b08a8`.

**Root cause:** Disabling subagent and subagent-control left fork, list-agents and workflow capabilities in the actual pinned model tool catalog.

**Correction or retained boundary:** Disable those additional pinned rows; verify the effective catalog with actual DSH and deterministic model responses.

**Files:** `integrations/deepseek-harness/src/profiles.ts; acp/local.real.test.ts`.

**Regression/evidence:** The actual pinned runtime model catalog excludes shell/web/plugin, subagent/fork/control/list and workflow capabilities in Cowork.

### FCR-01-04 — Sandbox credential argv

**P1; CONFIRMED — corrected.** Commit/evidence: `ebf33c76e3928e5441c27c8b18ff57690608fcea`.

**Root cause:** bubblewrap --setenv serialized provider credentials and gateway tokens in process arguments.

**Correction or retained boundary:** Pass the cleared explicit environment through a private 0600 NUL-delimited argument file, read by bubblewrap --args 3; preserve namespaces and remove the file during disposal/abort.

**Files:** `packages/sandbox/src/launcher.ts; profile.ts; launcher.test.ts; launcher.integration.test.ts; integrations/deepseek-harness/src/acp/launch.ts`.

**Regression/evidence:** Synthetic keys/tokens are absent from argv, delivered in the sandbox, FD 3 is closed, and private argument files are removed; namespace/egress tests retained.

### FCR-01-05 — Claude compatibility launcher

**P1; CONFIRMED contract defect — corrected.** Commit/evidence: `8f40af5652abb08c1e3832bf31a3e60d4cf5e017`.

**Root cause:** The compatibility adapter checked the launcher's advertised isolation but accepted a prepared read-write launch reporting none.

**Correction or retained boundary:** Check prepared isolation before spawn and dispose rejected preparations. A synthetic downgrade reproduces the contract defect; no production downgrade was observed.

**Files:** `integrations/claude-code/src/adapter.ts; engineering.test.ts`.

**Regression/evidence:** A launcher advertising sandbox but returning prepared isolation none rejects before invocation and disposes; this regression failed on the old adapter.

### FCR-01-06 — Acceptance evidence

**P1; CONFIRMED — corrected.** Commit/evidence: `c4df4c8ef7aa964b05720e21ece2e5cecc5f20a4`.

**Root cause:** Weak dirty-tree fingerprints, Full Node waivers, incomplete cancellation/source checks and WSL aggregation could misstate acceptance; console statistics omit nested pending assertions.

**Correction or retained boundary:** Bind reports to exact commit and complete dirty contents, enforce Node policy and mandatory gates, classify pending/todo from raw assertions, refuse interrupted/stale results and require native Linux evidence for cross-platform PASS.

**Files:** `scripts/local-ci/{platform,preflight,process-util,stages,report,runner}.mjs; tests/local-ci-security.test.ts; tests/local-ci.test.ts`.

**Regression/evidence:** Missing mandatory stages, preflight failure, unsupported Node, stale artifacts/reports, dirty nested files, cancellation/signals and WSL impersonating native Linux cannot certify acceptance; raw assertion counts reconcile.

### FCR-01-12 — Single-writer lease acquisition (P1, CONFIRMED — corrected)

Two independently reproduced interleavings granted two stores writer authority: a rival observed the initially empty exclusively created lease and treated it as stale; two rivals replaced the same dead-process lease. The compiled production Linux baseline printed both holders true. Three deterministic barrier regressions failed on the old implementation.

An exclusive `.lease.claim` now serializes creation, stale-owner inspection and replacement. Unreadable/empty leases fail closed instead of being overwritten; valid dead-PID leases still recover. Claim cleanup runs in finally before session recovery, preserving normal release/restart behavior. Windows focused session tests passed 108 with one platform skip; WSL2 passed all 109. Full final gates include these regressions. See `packages/sessions/src/store.ts`, `store-lease-race.test.ts` and the corrected unreadable-lease test.

A process killed during the short acquisition critical section may leave an acquisition claim. The next process refuses writer authority; no automatic deletion/stealing is performed. Recovery requires the owner/operator to stop all Nexar writers, verify no live writer, preserve/back up the state and then repair only the abandoned claim or unverifiable lease. Normal dead-process leases without an acquisition claim recover automatically. This is a bounded startup-availability tradeoff, not a claim that filesystem locks are OS-enforced against a malicious same-user process.

**Commit:** `723ae706f38d8de65e639b6401ee5fab69705b07`.

### FCR-01-07 — Windows CI launch

**P2; CONFIRMED — corrected.** Commit/evidence: `c4df4c8ef7aa964b05720e21ece2e5cecc5f20a4`.

**Root cause:** Windows Path/PATH aliases could remove the inherited command search path when building stage environments, causing cmd.exe ENOENT.

**Correction or retained boundary:** Preserve the inherited path and normalize case aliases before Windows launches and toolchain probes.

**Files:** `scripts/local-ci/stages.mjs; platform.mjs; process-util.mjs; tests/local-ci-security.test.ts`.

**Regression/evidence:** A Windows environment containing Path/PATH aliases retains command lookup; actual Quick CI passed after correction.

### FCR-01-08 — Linux lifecycle regression fixture

**P2; CONFIRMED — corrected.** Commit/evidence: `ebf33c76e3928e5441c27c8b18ff57690608fcea`.

**Root cause:** A test inspected the ACP home after production had correctly removed it.

**Correction or retained boundary:** Assert its 0700 mode during preparation and assert removal after settlement.

**Files:** `integrations/deepseek-harness/src/acp/acp.test.ts`.

**Regression/evidence:** The state directory is 0700 while prepared and absent after settlement; corrected Linux full suite passes.

### FCR-01-11 — Concurrent canonical session reads

**P2; CONFIRMED — corrected.** Commit/evidence: `479501e303249eea2fc741687152d472bdc5c3e2`.

**Root cause:** A get/list read could lstat an old file while the same store atomically replaced it, then open the replacement and report a corrupt record. Full Windows CI reproduced the failure under Node 22.

**Correction or retained boundary:** Serialize public per-session reads with the existing mutation queue. Preserve file identity, bounds, regular-file and single-link checks. Deterministic get/list regressions reproduce the old interleaving and verify coherent snapshots.

**Files:** `packages/sessions/src/store.ts; store-concurrent-read.test.ts`.

**Regression/evidence:** The new deterministic get/list regressions both fail on the old implementation; focused Windows 44 pass/1 skip and WSL2 45 pass; final full suites include them.

### FCR-01-09 — Host OS read boundary

**P1 for unrestricted/untrusted Cowork; CONFIRMED — blocking owner decision.** Commit/evidence: `17374842fefc8b8fa38faa0061744d953a2b08a8`.

**Root cause:** Cowork inherits the owner's OS identity; read/glob/grep and runtime dependencies can access files that identity can read.

**Correction or retained boundary:** No OS read sandbox was added. A real pinned-runtime synthetic outside-scratch read proves the remaining exposure. Safe release policy or real isolation requires an owner decision.

**Files:** `integrations/deepseek-harness/src/acp/local.real.test.ts; apps/desktop/src/main/dsh-cowork.ts`.

**Regression/evidence:** Actual pinned DSH reads a synthetic outside-scratch file. This is proof of remaining access, not a test that isolation passes.

### FCR-01-10 — Filesystem TOCTOU

**P2; CONFIRMED — mitigation boundary remains.** Commit/evidence: `17374842fefc8b8fa38faa0061744d953a2b08a8`.

**Root cause:** Nexar's final path check and upstream DSH filesystem operation are separate calls.

**Correction or retained boundary:** Replacement during pending approval is rejected. Replacement after the final grant remains a race; no atomic or OS-enforced containment claim is made.

**Files:** `apps/desktop/src/main/dsh-cowork.ts; dsh-cowork.test.ts`.

**Regression/evidence:** Replacement during owner approval is deterministically denied; the final-grant-to-upstream-operation interval remains outside atomic Nexar enforcement.

The first clean-code Full Windows run at `c4df4c8` failed in the Project Memory channel test (one failure), revealing FCR-01-11. It was not certified. A separate fixture typecheck failure during correction was fixed before the passing repository check and commit. An initial WSL2 full run also found the obsolete post-cleanup mode assertion (FCR-01-08); its failed result is retained in local evidence. Testing with a temporary directory under a Git checkout caused unrelated ACL/non-repository fixture failures; normal Windows TEMP reruns passed without weakening assertions.

## Investigated claims that were not reproduced as defects

| Concern                                                                         | Classification                            | Evidence                                                                                                             |
| ------------------------------------------------------------------------------- | ----------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| Native Windows writable Coding silently runs without a sandbox                  | NOT A DEFECT in the traced supported path | Plane availability and pre/post prepared-isolation guards refuse execution; Claude contract gap separately corrected |
| NRC repeats a completed paid call when telemetry storage fails                  | NOT A DEFECT                              | Existing gateway regression and successful-call accounting outside the retry block                                   |
| Model output approves its own Project Memory                                    | NOT A DEFECT                              | Owner-only, lease-gated channels; no model confirmation/write route                                                  |
| Context assembly selects another project's required memory                      | NOT A DEFECT                              | Project-scoped context tests and actual model-facing fixtures; host OS read access is a different confirmed exposure |
| Node 22 reproduces the historical 0xC0000409 native worker crash                | UNVERIFIED / not observed                 | Supported Node 22 runs pass after the session-read correction; historical Node 24 root cause unresolved              |
| WSL2 constitutes native Ubuntu Full CI                                          | NOT A VALID ACCEPTANCE CLAIM              | Microsoft WSL kernel and missing native headless/scanner environment; classified partial                             |
| Arbitrary plugins or future DSH versions preserve the pinned profile guarantees | UNVERIFIED                                | Only managed fresh-home pinned 0.2.0-rc.2 is tested                                                                  |

## Security and runtime conclusions

NRC remains authoritative. Control selection validates eligibility and pinned policy before allocation; gateway grants bind engine, lineage and one resource. A DSH route/model-change request cannot silently choose another provider. Existing gateway tests account each actual provider attempt, failed retries and restarts, stamp provider/resource identity, reject invalid grants without accounting and propagate cancellation without retry. Accounting is outside the successful provider-call retry block and catches sink failure; the existing regression proves one successful call despite a throwing telemetry sink. Failure to persist telemetry can lose an accounting record, but cannot replay the completed paid call. Native specialist resources keep their declared identity and credential scope; they do not become a second primary Cowork runtime.

Project Memory is Nexar-owned, owner-channel confirmed, lease-gated and project-scoped in context assembly. Model output has no write/confirmation authority. Existing tests cover persistence/restoration, mode transitions, concurrent mutations, legacy records, oversized required blocks and permission independence. Actual pinned DSH offline context tests inspect the model-facing request and force automatic compaction; required constraints remain in the protected system block and overflow refuses execution. Fresh per-turn DSH homes are removed, grants revoked and native sessions are not resumed. The concurrency defect found during final Windows CI is corrected by sharing the existing session queue with get/list, preserving strict corruption/link checks. A separate store/process reading a changing file may still fail closed on an identity race; no cross-process snapshot protocol is introduced. Context assembly isolation is not OS read isolation for Cowork.

Writable Engineering workspaces require sandbox isolation both before preparation and in the prepared launch. DSH and Codex already enforced both checks; the Claude compatibility adapter now does too. Desktop Coding is a plane/WSL path; native Windows PlaneLaneEngine refuses availability rather than falling back to a writable host process. Read-only and legacy native specialist resources remain a separate declared host-trust policy, not an OS-isolation guarantee.

The real WSL2 bubblewrap suite exercises user/mount/PID/network namespaces, read-only toolchain, workspace containment, .git protection, allowlisted egress and authenticated service relays. An additional actual pinned DSH Coding prompt used production prepareAcpLaunch and SandboxLauncher with a deterministic socket model fixture: initialize/new/model-select/prompt/close succeeded, a workspace file was written, a Bash/Node host-path write returned ENOENT, the synthetic host file remained unchanged, and required context appeared in all three model requests. Coding ordinary writes used standing workspace permission inside the sandbox (zero ACP approval requests); this does not imply Git commit/push authorization. Existing owner-authorized commit/patch workflows remain Nexar-owned. The PlaneLaneEngine integration fixture uses fake DSH and a controlled launcher; its real gateway/bridge assertions are useful protocol evidence, not proof of actual DSH OS isolation. Actual sandbox, actual DSH prompt and full engine protocol evidence are explicitly distinguished.

Sandbox environment values now enter bubblewrap through --args 3 and a private short-lived file, not argv. Tests prove synthetic token delivery, FD closure and disposal. This removes argv exposure without weakening sandbox flags. The host same-user identity can still inspect its private files/process environment and remains trusted; no credential protection from a compromised host identity is claimed.

Detailed Cowork trust boundaries and the unresolved isolation decision are in [FCR01_Security_Findings.md](FCR01_Security_Findings.md).

## Verification and acceptance integrity

Current results, commands, counts, source fingerprints, installer hash and stage evidence are in [FCR01_Final_Verification.md](../../development/FCR01_Final_Verification.md). A sanitized machine-readable evidence record is committed alongside it; complete raw logs remain local and ignored.

The historical Windows report at report-2026-10-10T16-16-54-591Z.json records a3fd0250142a18c3ad2f5478faae4b37e861f216 with dirty fingerprint 27b1c2252e306426, duration 1,775.18s, 15 PASS stages and one BLOCKED Linux-only stage. The later documentation's ed2ded5 source label and 16/16-executed claim do not match that raw report. Its old unit-statistics parser returned zero counts, so manually reported 4,417 collected / 4,244 passed / 169 skipped remains unreconciled by four historical outcomes; no archived raw assertion report for that exact run was found in the inspected CI report directory. Current raw Vitest assertions demonstrate four nested pending bubblewrap cases omitted by the console summary. Those current identities are not retroactively asserted to be the original four.

Focused orchestrator tests and real-context tests also run within the full unit suite. Source and packaged E2E repeat the same identities under different application builds, and platform runs repeat common tests. Per-suite counts are execution attempts, not a computed unique-test population. The old 4,498 'distinct tests' total is withdrawn. Historical installer SHA256 9571845014f0b101b26560d65613a33fbf4f7d90875ceeed28ea891908ef1517 and unsigned status are retained as historical packaging evidence, not proof of this corrected implementation. No old PASS can certify changes made after it.

No current report claims unique tests by adding repeated suites. WSL2 is not native Ubuntu; an unsigned package is not publicly release-certified; offline model fixtures are not real-provider certification; a configured self-hosted workflow is not an executed runner job.

## Remaining owner decisions and recommendation

FCR-01 decision record — unresolved, owner authority required: a Windows restricted identity alone needs correctly provisioned filesystem ACLs and still shares host resources; AppContainer needs token/capability creation, path ACLs, Node/Electron compatibility and broker transport validation; existing WSL2/bubblewrap infrastructure provides real namespace enforcement for Engineering, but moving Cowork requires explicit placement, desktop/plane transport, path mapping, lifecycle, memory/artifact and provider compatibility work. None is a safe one-boolean change. No privileged global OS changes or persistent runners were installed. The minimal in-scope corrections harden application policy while preserving the exposure and blocking unrestricted acceptance. The owner must choose whether a restricted trusted-content release policy is acceptable or require a separately scoped OS-isolated Cowork implementation before approval. This review makes neither decision for the owner.

The other blocker is native Ubuntu Full CI on the corrected source, including headless Electron/Xvfb and secret scanning in that environment. Existing WSL2 validation was completed without privileged OS modifications, but does not provide this missing evidence. Restore existing Actions availability or provide an authorized isolated native Ubuntu executor; no purchase or personal credentialed runner is assumed.

The subsequent independent lease audit reproduced dual-writer acquisition on the compiled production store. Three baseline regressions failed; the exclusive acquisition claim and unreadable-lease denial were verified on both platforms before commit `723ae706`. This strengthens B9 without automatically stealing abandoned claims.

No P0 was identified. Reproduced in-scope implementation defects were corrected; unrestricted Cowork security acceptance and mandatory native Ubuntu evidence remain unresolved. ADR-030 must stay Proposed, PR #41 Draft, and `NXR070_PREREQUISITES_NOT_YET_SATISFIED`.

## Toolchain scope clarification

Node 22.23.3 is the validated host CI toolchain; standalone Node 24/Vitest remains unsupported. Pinned Electron 44.5.1 embeds Node 24.21.0 and its managed child path is separately exercised by E2E. Historical 0xC0000409 has no established Electron root cause.
