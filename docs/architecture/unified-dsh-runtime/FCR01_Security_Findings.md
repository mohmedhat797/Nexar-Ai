# FCR-01 — Independent Security Findings

**Source:** `723ae706f38d8de65e639b6401ee5fab69705b07`.
**Verdict:** `SECURITY_REVIEW_BLOCKED`. No P0 was identified. This review does not accept residual risk for the owner.

## Cowork filesystem and host boundary

Cowork remains host-local under the desktop user's operating-system identity. A real pinned DSH read of a synthetic file outside scratch succeeded without an ACP permission request. The reduced tool catalog and Nexar write broker are application policy, not an OS filesystem or network sandbox. HOME, cwd and DSH_HOME provide private state placement, not an effective read boundary. Dependencies or owner-selected runtime code have that OS identity's filesystem rights. Required-context selection excludes other projects, but their underlying files are not protected from the host-local DSH identity by these application checks.

Every Cowork session now starts read-only. Supported mutators are the pinned DSH write/edit tools with a single file_path; they must explicitly request workspace-write. Unknown mutation shapes fail closed. Scratch paths are checked lexically and physically, all links/junctions and hard-linked files are denied, failures deny authorization, and checks repeat after approval and policy persistence. This closes the reproduced fail-open and standing-write bypass. It does not make the check atomic with upstream filesystem use: a host process can replace a path after the final grant. Replacement while approval is pending is covered and denied. No generic Windows reparse-point certification or OS race elimination is claimed.

Safe intended use is owner-controlled projects/content, trusted pinned runtime dependencies, drafts only, and a selected provider allowed to receive that project's content. That restriction has not been accepted on the owner's behalf. Untrusted documents/prompts can direct the retained read tools toward user-readable files; those contents may reach the selected model route. Unrestricted or untrusted Cowork release is blocked until the owner chooses a supported release policy or real OS read isolation is implemented.

### Filesystem cases and demonstrated policy

| Case                                                           | Result                                                                               |
| -------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| Regular scratch write / nested nonexistent target              | Allowed only by the selected Nexar write policy; real DSH broker path exercised      |
| Missing/deleted/non-directory scratch root                     | Denied                                                                               |
| Root or ancestor EACCES / invalid canonical lookup             | Denied (synthetic deterministic lookup failures)                                     |
| Parent traversal / absolute outside path                       | Denied                                                                               |
| External directory symlink or NTFS junction                    | Denied; Windows junction fixture supported on this host                              |
| Internal directory link                                        | Conservatively denied                                                                |
| Existing multi-link regular file                               | Denied; synthetic outside-file hard-link alias regression                            |
| Windows drive-relative / UNC outside root / device paths / ADS | Existing lexical policy denies; no generic network-share compatibility certification |
| Directory beginning with two dots                              | Valid ordinary contained directory allowed                                           |
| Unknown mutation path/target/multiple/structured patch shape   | Denied; pinned write/edit schemas use one file_path                                  |
| Replacement during pending owner approval                      | Denied after final revalidation; outside fixture remains unchanged                   |
| Replacement after final grant, before DSH syscall              | Remaining race; no atomic enforcement claim                                          |
| Repeated/concurrent checks and requests                        | Separate decisions; existing concurrency and single-use approval tests retained      |
| Host-readable outside file through read                        | Real pinned DSH succeeds; proves missing OS read confinement                         |

The helper recognizes supported Windows junctions through Node lstat/realpath. This is not a blanket guarantee for every Windows reparse-point type or concurrently changing host filesystem. Owner approval cannot turn an unknown mutation schema or outside path into a permitted operation. Failure to persist the policy decision also rejects the operation.

FCR-01 decision record — unresolved, owner authority required: a Windows restricted identity alone needs correctly provisioned filesystem ACLs and still shares host resources; AppContainer needs token/capability creation, path ACLs, Node/Electron compatibility and broker transport validation; existing WSL2/bubblewrap infrastructure provides real namespace enforcement for Engineering, but moving Cowork requires explicit placement, desktop/plane transport, path mapping, lifecycle, memory/artifact and provider compatibility work. None is a safe one-boolean change. No privileged global OS changes or persistent runners were installed. The minimal in-scope corrections harden application policy while preserving the exposure and blocking unrestricted acceptance. The owner must choose whether a restricted trusted-content release policy is acceptable or require a separately scoped OS-isolated Cowork implementation before approval. This review makes neither decision for the owner.

## Effective DSH profile

The pinned runtime's Cordis rows and actual tool schemas were inspected. Disabling only tool-subagent and tool-subagent-control was insufficient: fork, list-agents and workflow remained model-visible. They are now disabled too. Actual pinned-runtime requests verify the reduced Cowork catalog, shell/web/plugin restrictions, broker-mediated writes and denial of unasked writes. ACP cannot start Cowork with standing workspace-write, and permission requests do not enable a disabled row. Goal/todo/private runtime metadata remain distinct from arbitrary project-file mutation. Custom owner-selected DSH entries/plugins and future upstream versions are not certified by these pinned-runtime tests.

Host-local environment construction allowlists startup variables and supplies only the per-turn gateway token, private HOME/DSH_HOME and telemetry-disable setting. Provider credentials are resolved in Nexar's gateway; owner provider keys, GH tokens and NODE_OPTIONS are not inherited by Cowork. Per-turn state and grants are removed/revoked; DSH's host identity remains trusted.

## Coding sandbox and credential handling

Writable Engineering workspaces require sandbox isolation both before preparation and in the prepared launch. DSH and Codex already enforced both checks; the Claude compatibility adapter now does too. Desktop Coding is a plane/WSL path; native Windows PlaneLaneEngine refuses availability rather than falling back to a writable host process. Read-only and legacy native specialist resources remain a separate declared host-trust policy, not an OS-isolation guarantee.

The real WSL2 bubblewrap suite exercises user/mount/PID/network namespaces, read-only toolchain, workspace containment, .git protection, allowlisted egress and authenticated service relays. An additional actual pinned DSH Coding prompt used production prepareAcpLaunch and SandboxLauncher with a deterministic socket model fixture: initialize/new/model-select/prompt/close succeeded, a workspace file was written, a Bash/Node host-path write returned ENOENT, the synthetic host file remained unchanged, and required context appeared in all three model requests. Coding ordinary writes used standing workspace permission inside the sandbox (zero ACP approval requests); this does not imply Git commit/push authorization. Existing owner-authorized commit/patch workflows remain Nexar-owned. The PlaneLaneEngine integration fixture uses fake DSH and a controlled launcher; its real gateway/bridge assertions are useful protocol evidence, not proof of actual DSH OS isolation. Actual sandbox, actual DSH prompt and full engine protocol evidence are explicitly distinguished.

Sandbox environment values now enter bubblewrap through --args 3 and a private short-lived file, not argv. Tests prove synthetic token delivery, FD closure and disposal. This removes argv exposure without weakening sandbox flags. The host same-user identity can still inspect its private files/process environment and remains trusted; no credential protection from a compromised host identity is claimed.

## FCR-01-12 — Single-writer lease acquisition (P1, CONFIRMED — corrected)

Two independently reproduced interleavings granted two stores writer authority: a rival observed the initially empty exclusively created lease and treated it as stale; two rivals replaced the same dead-process lease. The compiled production Linux baseline printed both holders true. Three deterministic barrier regressions failed on the old implementation.

An exclusive `.lease.claim` now serializes creation, stale-owner inspection and replacement. Unreadable/empty leases fail closed instead of being overwritten; valid dead-PID leases still recover. Claim cleanup runs in finally before session recovery, preserving normal release/restart behavior. Windows focused session tests passed 108 with one platform skip; WSL2 passed all 109. Full final gates include these regressions. See `packages/sessions/src/store.ts`, `store-lease-race.test.ts` and the corrected unreadable-lease test.

A process killed during the short acquisition critical section may leave an acquisition claim. The next process refuses writer authority; no automatic deletion/stealing is performed. Recovery requires the owner/operator to stop all Nexar writers, verify no live writer, preserve/back up the state and then repair only the abandoned claim or unverifiable lease. Normal dead-process leases without an acquisition claim recover automatically. This is a bounded startup-availability tradeoff, not a claim that filesystem locks are OS-enforced against a malicious same-user process.

**Commit:** `723ae706f38d8de65e639b6401ee5fab69705b07`.

## NRC authority and session/memory integrity

NRC remains authoritative. Control selection validates eligibility and pinned policy before allocation; gateway grants bind engine, lineage and one resource. A DSH route/model-change request cannot silently choose another provider. Existing gateway tests account each actual provider attempt, failed retries and restarts, stamp provider/resource identity, reject invalid grants without accounting and propagate cancellation without retry. Accounting is outside the successful provider-call retry block and catches sink failure; the existing regression proves one successful call despite a throwing telemetry sink. Failure to persist telemetry can lose an accounting record, but cannot replay the completed paid call. Native specialist resources keep their declared identity and credential scope; they do not become a second primary Cowork runtime.

Project Memory is Nexar-owned, owner-channel confirmed, lease-gated and project-scoped in context assembly. Model output has no write/confirmation authority. Existing tests cover persistence/restoration, mode transitions, concurrent mutations, legacy records, oversized required blocks and permission independence. Actual pinned DSH offline context tests inspect the model-facing request and force automatic compaction; required constraints remain in the protected system block and overflow refuses execution. Fresh per-turn DSH homes are removed, grants revoked and native sessions are not resumed. The concurrency defect found during final Windows CI is corrected by sharing the existing session queue with get/list, preserving strict corruption/link checks. A separate store/process reading a changing file may still fail closed on an identity race; no cross-process snapshot protocol is introduced. Context assembly isolation is not OS read isolation for Cowork.

| Required case              | Existing executable/source evidence                                         | Conclusion                                                                              |
| -------------------------- | --------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| A: valid selected resource | engine-gateway/gateway.test.ts; control-accounting.test.ts JSONL/quota test | One record per actual call; selected identity preserved                                 |
| B: unavailable resource    | select-control and dsh-cowork.control tests                                 | Declared fallback policy governs                                                        |
| C: forbidden resource      | eligibility/select-control and bounded operating fallback tests             | Rejected before execution                                                               |
| D: gateway model change    | ACP/local route guard tests and pinned nexar route                          | Change fails; no silent provider switch                                                 |
| E: provider retry          | gateway attempt/restart test                                                | Every attempt attributed; failed usage remains unavailable when not reported            |
| F: telemetry failure       | gateway throwing sink regression                                            | Successful provider call executes once; no automatic replay                             |
| G: native resource         | ACP own-resource credential tests; native execution/core accounting paths   | Declared identity and own credential scope retained; no duplicate model charge asserted |

| Invariant | Evidence and platform limit                                                                                                   |
| --------- | ----------------------------------------------------------------------------------------------------------------------------- |
| B1        | Capability validation tests pass before allocation                                                                            |
| B2        | Monotonic delegation limit, concurrent admission and fallback/restart tests pass                                              |
| B3        | Nexar permission/bridge authority tests pass; new per-call Cowork restriction verified                                        |
| B4        | Standalone reviewOf exclusions pass                                                                                           |
| B5        | Fresh per-turn homes/grants, no resume, cancellation/cleanup and concurrent Coding overlays pass                              |
| B6        | Stable resource/connection identity tests pass                                                                                |
| B7        | Writable launch guards and real WSL2 namespaces/egress tests pass; native Ubuntu Full CI missing                              |
| B8        | Legacy/readable sessions and new get/list race regressions pass                                                               |
| B9        | Fresh-lease/stale-takeover race regressions, unreadable lease and abandoned-claim denial, and Project Memory lease tests pass |

These mappings refer to the final full unit runs and the separate real runtime/sandbox evidence. They do not turn a skipped Windows Linux-only test into a PASS or establish Cowork OS read isolation.

## Secret scanning and dependencies

Gitleaks 8.28.0 full history and synthetic positive controls were run with redaction. Existing generic-key allowlists combine narrow paths and exact synthetic values; a synthetic GitHub token at the actual tests/local-ci.test.ts path is still detected. The one historical ignored fingerprint refers to a known fake redaction-test fixture at commit 8ca639f; no new ignore or blanket suppression was introduced.

The workspace production pnpm audit reported zero advisories across 224 dependencies. The separately installed pinned DSH npm tree reported 12 affected package entries derived from two advisories; it is not described as clean:

- High [MCP SDK OAuth authorization-server substitution](https://github.com/advisories/GHSA-6qxp-vccf-f47h): reviewed managed DSH transport supplies request headers, not authProvider/stored OAuth handling. Its vulnerable OAuth flow is not reached by the inspected managed bridge/stdio paths. This is a source-based reachability inference, not certification of arbitrary MCP/plugin configurations.
- Moderate [fflate ZIP64 unzipSync denial of service](https://github.com/advisories/GHSA-px8p-9vwx-vf98): the reviewed DSH libreoffice consumer imports zlibSync, not unzipSync. No reachable vulnerable unzip route was demonstrated.

No broad dependency upgrade was made; exact DSH pin/lock integrity is preserved. The upstream advisories remain recorded nonblocking debt for the reviewed managed configuration, with unverified reachability for other configurations.

## Residual risk and release policy

- **Blocking / owner decision required — Host-local Cowork read access and post-grant filesystem race:** Require real OS read isolation for untrusted use or an explicit owner-approved trusted-content release restriction; no acceptance by this review.
- **Blocking / external environment — Native Ubuntu Full CI:** Provide a safe isolated native Ubuntu executor or restore Actions availability. WSL2 is separately useful, and cannot substitute for this gate.
- **Supported-runtime limitation — Node.js 24 worker fail-fast history:** Node 22.23.3 is the validated host CI toolchain; standalone Node 24/Vitest remains unsupported. Pinned Electron 44.5.1 embeds Node 24.21.0 and its managed child path is separately exercised by E2E. Historical 0xC0000409 has no established Electron root cause.
- **Deferred nonblocking technical debt in managed configuration — Pinned DSH dependency advisories:** Two upstream advisories, reviewed vulnerable OAuth/unzip APIs not reached by managed paths; arbitrary plugin/runtime configurations remain unverified.
- **Public release requirement — Unsigned development installer:** Current package is NotSigned; internal testing is not publisher authenticity or public release certification.
- **Bounded reliability limitation — Separate-process file identity races:** Public reads now share this store's mutation queue; another process can still encounter a fail-closed identity race. No corruption or data loss demonstrated.

Confirmed corrections and commit references are in [FCR01_Independent_Engineering_Review.md](FCR01_Independent_Engineering_Review.md); execution counts and installer provenance are in [FCR01_Final_Verification.md](../../development/FCR01_Final_Verification.md). No security guarantee in this report overrides the demonstrated host read exposure or missing native platform evidence.

An abandoned acquisition claim is a bounded startup availability limitation: confirm no live writers and preserve state before operator repair. Automatic claim stealing is intentionally unsupported.
