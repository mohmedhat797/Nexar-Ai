# FCR-02 — Independent review of FCR-01 corrections (in progress)

**Date:** 2026-10-12 (Africa/Cairo). **Reviewed baseline:** `7337aa00b667429834478c719532464b3a81b195`
(FCR-01 implementation `723ae706f38d8de65e639b6401ee5fab69705b07` plus its documentation commit).
**Status:** partial source review. No code was changed. FCR-01 conclusions are neither accepted
nor overturned wholesale; each item below is classified separately.

## Verified by source review

| FCR-01 item     | Area                                                                   | Result                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| --------------- | ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| FCR-01-12       | Single-writer lease (`packages/sessions/src/store.ts`)                 | **Verified.** `.lease.claim` is created with `wx` (exclusive). Stale-lease inspection and replacement happen only while the claim is held, and replacement requires a dead holder PID. Unreadable or empty leases and abandoned claims fail closed. A process killed at any point leaves either a valid lease, which is recovered only once its PID is dead, or a claim/unverifiable lease that blocks acquisition. No interleaving was found that grants two writers. Out of scope, as documented: tampering by a same-user process. |
| FCR-01-11       | Session reads (`store.ts`)                                             | **Verified.** `get`/`list` reads go through the per-session mutation queue. No mutation calls back into a public read, so the queue has no re-entrancy deadlock.                                                                                                                                                                                                                                                                                                                                                                      |
| FCR-01-04       | Sandbox credentials (`packages/sandbox/src/launcher.ts`, `profile.ts`) | **Verified.** Values move from argv into a `wx`, 0600 `environment.args` file inside the 0700 run folder. `/bin/sh` opens it as fd 3 and `exec`s bubblewrap with `--args 3`, placed after `--clearenv`. The file is removed when the run folder is disposed. The host identity remains trusted, as documented.                                                                                                                                                                                                                        |
| FCR-01-05       | Engineering isolation                                                  | **Verified.** Write-capable paths in the DSH ACP launch, the Codex, Claude Code, Antigravity and delegate-skills adapters, engineering commands and the worktree harvest refuse when isolation is missing, both before `prepare` and on the prepared launch.                                                                                                                                                                                                                                                                          |
| FCR-01-01/02/03 | Cowork application policy                                              | **Reviewed, consistent with FCR-01's claims.** Lexical policy (`cowork-policy.ts`), physical checks (`isPhysicalScratchEscape`), and re-checks after approval and after the policy is recorded. These remain application-level controls; see [FCR02_Architecture_Decision.md](FCR02_Architecture_Decision.md).                                                                                                                                                                                                                        |
| FCR-01-06/07    | CI source binding                                                      | **Reviewed.** Start and end commit plus dirty-content fingerprint must match (`sourceIdentityMatches`). Missing or blocked required stages cannot pass. WSL kernels cannot produce a native-Linux verdict. A git-identity failure (for example output above the `execFileSync` buffer) makes the run ineligible, which fails closed.                                                                                                                                                                                                  |

Remaining FCR-02A work (not yet done):

- An executable re-run of the focused FCR-01 regressions on this baseline.
- A pinned-runtime effective-tool-catalog check.
- A CI cancellation and stale-artifact exercise.

## P3 observations (recorded separately; not fixed in FCR-02)

These are outside FCR-02's isolation scope. They are recorded so they are not lost, and they are
fixed only if acceptance comes to depend on them.

### FCR02-R1 — Stale writer-lease claim needs manual recovery and is misreported

- **Severity:** P3 (availability and diagnostics; no integrity impact).
- **Status:** CONFIRMED by source review.
- **Evidence:**
  - A crash or power loss inside the short acquisition window can leave `.lease.claim`, an empty
    `.lease`, or both.
  - `acquireLease` then throws `CONFLICT` with reason `lease-acquisition-held` or
    `lease-unverifiable` on every start until someone deletes the files by hand. This is
    intended: FCR-01 chose fail-closed.
  - Desktop (`apps/desktop/src/main/main.ts`, around line 241) catches every `CONFLICT` and logs
    "sessions are open in another Nexar process". That is misleading in the stale-claim case.
    The renderer only sees sessions as unavailable and gets no recovery guidance.
- **Suggested correction (owner to schedule):**
  - Log and surface the conflict reason.
  - Give a fixed, path-free recovery message: stop all Nexar instances, back up the sessions
    folder, then remove the stale claim.
  - Optionally record the claimant's PID inside the claim, so that a claim whose owner is
    verifiably dead can be recovered automatically. This must not weaken the "never steal a live
    claim" rule.
- **Regression test:** a stale claim produces a distinct, non-misleading diagnostic, and sessions
  stay unavailable (fail-closed is kept).

### FCR02-R2 — Single-platform local CI can report PASS on a dirty worktree

- **Severity:** P3 (evidence labelling).
- **Status:** CONFIRMED by source review.
- **Evidence:**
  - `generateReports` (`scripts/local-ci/report.mjs`) requires a stable source identity, but not
    a clean one. A run that starts and ends with the same dirty fingerprint can still be reported
    as `NEXAR_WINDOWS_FULL_PASS` / `NEXAR_LINUX_*_PASS`.
  - The report records `isDirty` and the fingerprint, and cross-platform aggregation rejects
    dirty trees. The single-platform verdict string still does not.
- **Suggested correction:** either require a clean tree for a PASS verdict, or use a distinct
  verdict (for example `…_PASS_DIRTY`) that acceptance policy treats as non-certifying.
- **Regression test:** a dirty but stable run cannot produce the plain PASS verdict.
- **Current mitigation:** FCR evidence must be taken from clean-tree runs only.

### FCR02-R3 — Cowork path-check tests depend on a canonical `TEMP`

- **Severity:** P3 (test robustness; no product impact).
- **Status:** CONFIRMED by execution on 2026-10-12.
- **Evidence:**
  - With `TEMP` set to the 8.3 short-name form (`C:\Users\MOHAME~1\…`), three tests fail
    deterministically: `dsh-cowork-path.test.ts` ("directory beginning with two dots",
    "repeated concurrent checks") and `dsh-cowork.test.ts` ("allows normal regular files…").
    With the long-name `TEMP`, all 44 tests in those files pass.
  - `isPhysicalScratchEscape` intentionally fails closed when the given root differs from its
    `realpath`. Production always passes a canonical root (`newScratch` returns the
    `realpath`ed `mkdtemp`), so the product is not affected.
- **Suggested correction:** make the fixtures `realpath` their temporary roots, so the suite does
  not depend on how `TEMP` is spelled.
- **Current mitigation:** run CI with a long-name `TEMP`, as FCR-01 already notes.
