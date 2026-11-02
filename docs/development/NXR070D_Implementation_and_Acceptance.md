# NXR-070D′ implementation and acceptance

**Status: automated acceptance passed on the exact implementation commit. Criterion 10, two real accounts, is pending the owner.** The owner has not accepted this work, and nothing is merged. Authority: [readiness package](NXR070D_Implementation_Readiness_Package.md) section G and the owner's assignment.

Companion reports: [installed Plane](NXR070D_Plane_Upgrade_Report.md), [G-14 evidence](NXR070D_G14_Reliability_Evidence.md), [owner handover](NXR070D_Final_Owner_Handover.md).

## Identity

| Item                                 | Value                                                              |
| ------------------------------------ | ------------------------------------------------------------------ |
| Branch                               | `feat/nxr-070d-codex-homes`                                        |
| Baseline `main`                      | `6bc038021b66b8d093bad5a4fbd936794f048da3`                         |
| Tested implementation commit         | `616042f706b7058042226f37b9659ee2ef40a773`                         |
| Tested tree                          | `b1911692ff687b89109f3d0283bd9f951524fe93`                         |
| Installer                            | `Nexar-0.1.0-windows-x64-setup.exe`, 325,793,962 bytes             |
| Installer SHA-256                    | `b278e6ef016bffe8de72fb81748d4c543bcb2c5a5ecda70609f7a78d5127b1dd` |
| Bundled DSH                          | `0.2.1-rc.5`, 27,826 files, 507,342,499 bytes                      |
| Sealed and packaged DSH tree SHA-256 | `ccbd7a129a4c1b831d33de36bc81b764521b8dd230b77196bed9d9131db9520d` |
| DSH lock SHA-256                     | `17b0419f5728bd62f2a0ce2e67b8bb75332e4486a0422e906967aa426d65fb40` |
| Windows Full log SHA-256             | `aaff67a6366cfe70dbbe2488b23d131d2e8f505af2964432c0d0a1fda84cb35c` |
| Draft PR                             | [#51](https://github.com/mohmedhat797/Nexar-Ai/pull/51)            |

The commit that adds these reports changes documentation only. It comes after the tested commit and is not itself covered by Windows Full.

## What was built

| Slice | Commit    | Result                                                                                                                                              |
| ----- | --------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1     | `85490f9` | One owner-edited `ownerConnections` setting. Off hides owner connections and refuses lifecycle actions; nothing stored is deleted or changed        |
| 2     | `8e1473e` | Immutable `openai.subscription.c<id>` identity with a private native-home scope. Saved records are validated strictly                               |
| 3     | `2d8e271` | Home store at a path derived from the id under `<userData>/runtime-homes`, with a marker beside the home. Refuses links and never opens a home file |
| 4     | `656932a` | Adapter runs only with the home the host resolves, including probes and the sandbox bind. No fallback to the parent or vendor default home          |
| 5     | `c326451` | One resource per signed-in connection. The NRC selects with its normal filters and is unchanged                                                     |
| 6     | `c3a7332` | Protected Delete-home, refused with `connection.active` while a process holds the lease                                                             |
| 7     | `95f4921` | Owner-initiated sign-in only. A repeat sign-in needs a same-account assertion; refresh, probe and inventory have no path to it                      |
| 8     | `e65ec9d` | Strict bridge channels for add, sign-in, cancel, status and Delete-home, carrying an opaque id. E2E uses a fake CLI through the real bridge         |
| 9     | `449a91c` | Homes stay on their own host; paths across the WSL boundary are refused, and the Plane and CLI refuse an owner Codex resource                       |

Supporting commits, kept separate for review:

- `2579718`, `01c79c2`, `79be762`: Plane upgrade tooling and its corrections.
- `00f530b`: test fixture no longer fails sign-in when the callback response is reset.
- `82049fd`: Windows packaging limit raised from evidence, described under [packaging](#packaging-limit).
- `616042f`: a stalled Cowork SOW test now prints its last telemetry event types.

## Decisions and deviations

- **Decision A, implemented.** The setting lives in `desktop-settings.json`. Missing means on and damaged means off. Disabling keeps credentials, homes, tombstones, binding records and canonical sessions, and pins fail explicitly. A replacement ChatGPT plan stays available, as the package requires.
- **Decision B, implemented.** Channels, validation and E2E only. **The owner cannot use multiple accounts from the app until H′ lands.**
- **Deviation: no Plane-local home store.** The package listed one. The Plane has no connection authority or connection records, and AD-3 and OD-9 forbid cross-host routing, so the store would be unused code. **Consequence: write-mode lanes need the sandbox, so they cannot use an owner Codex connection on Windows Desktop.**
- **Deviation: no separate inventory source.** For a native Codex resource it would only repeat the adapter's login probe, which already runs under the connection's lease.
- **Deviation from criterion 2: Rotate is refused for owner Codex connections,** because the vendor CLI owns the credential. A verified repeat sign-in is what keeps the id and moves the generation on.
- **Process deviation from ADR-009:** the implementation was written in the orchestrating session, not delegated to Sonnet.

## Architecture and security traceability

| Requirement or rule                      | Implementation                                                                                  | Evidence                                                                       |
| ---------------------------------------- | ----------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| NRC is the only selection authority      | One resource per connection; no file changed under `resource-controller` or `resource-registry` | `git diff` from the baseline; `connection-codex-runtime.test.ts`               |
| Private `CODEX_HOME` per connection      | `codex-home-store.ts`, `ownerCodexSubscription`                                                 | `codex-home-store.test.ts`, `owner-home.test.ts`, sandbox integration test     |
| Immutable identity                       | Id derived at creation, resource id bound to it, tombstones kept                                | `connection-codex.test.ts`, `owner-codex-resource.test.ts`                     |
| No credential read, parse, copy or log   | Store opens only its own marker, which sits outside the home                                    | `never opens a file inside the home`; `sends no home, marker or sign-in time`  |
| No ambient API key                       | Allowlisted child environment                                                                   | `never passes an API key or token to the child`; `does not pass key variables` |
| No cross-connection substitution         | Home resolved per connection; mismatch stops before spawn                                       | `refuses a resource that claims another connection or another home`            |
| No automatic login                       | Sign-in reachable only from the service behind an explicit bridge action                        | `keeps sign-in reachable from nowhere but this service`                        |
| Protected deletion and active processes  | Fixed root, marker, link refusal, rename before removal, lease check                            | `is refused during a process`; `removes one home without following a link`     |
| Built-in `openai.subscription` unchanged | Built-in resolves its own home without the resolver; lifecycle refused                          | `leaves the built-in connection on its own home`; `refuses the built-in`       |
| OD-9, host separation                    | `/mnt` and UNC roots refused; Plane and CLI refuse the resource                                 | `refuses a %s root at %s`, composition tests                                   |
| REQ-38, mutable authentication           | Repeat sign-in moves the generation; an old resource is refused                                 | `refuses an old resource after the generation changes`                         |

Preserved without change: DSH `0.2.1-rc.5`, FileSessionStore, ProjectMemoryStore, Permission Broker and WSL/Bubblewrap isolation. The only change to the startup state guard is that it no longer descends into `runtime-homes`, because vendor links there must not stop the app. It still checks that directory.

## Test and acceptance matrix

All credentials and accounts are synthetic. No paid inference was used, and no real Codex account was signed in.

| #   | Criterion                                 | Tests                                                                                                                                                         | Result on `616042f`                                    |
| --- | ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------ |
| 1   | TST-08, two connections, two homes        | `keeps each connection on its own home`; E2E `signs two connections in`; Bubblewrap `binds only the home of the connection that runs`                         | Passed. Real Bubblewrap test passed in 3 of 3 WSL runs |
| 2   | TST-09, refusal while active              | `is refused during a process`; `refuses while the connection is running something`; `holds the lease while a process runs`; E2E `stays busy during a sign-in` | Passed, with the Rotate deviation above                |
| 3   | TST-14, protected deletion                | Home store refusals (link, hard-linked marker, missing marker, outside root); `refuses the built-in %s`                                                       | Passed on Windows and on Linux                         |
| 4   | TST-17, mismatch stops before spawn       | `refuses a home set on the resource`; `spawns nothing when the host reports %s`; `refuses without a resolver`                                                 | Passed                                                 |
| 5   | TST-18, no key reaches a child            | `never passes an API key or token to the child`; `does not pass key variables to the login process`                                                           | Passed                                                 |
| 6   | TST-19, no login from refresh or probe    | `probes with the resolved home and never starts a login`; `refuses a second sign-in without the same-account assertion`                                       | Passed                                                 |
| 7   | TST-42, Review Diversity                  | `gives two connections distinct review identities`; `earns no connection credit when ... unknown`; existing TST-42 tests                                      | Passed                                                 |
| 8   | Built-ins and `deterministic@1` unchanged | Built-in tests above; existing policy tests, whose package is unchanged                                                                                       | Passed                                                 |
| 9   | Windows Full and WSL on the exact commit  | See below                                                                                                                                                     | Passed, except that stage 17 cannot run on Windows     |
| 10  | Two real accounts stay separate           | Owner-run scenario                                                                                                                                            | **Pending the owner**                                  |

Rollback: `connection-rollback.test.ts` has 10 tests covering absent, off, damaged and back-on settings, explicit pin failure, retained tombstones and an unchanged store. Plane rollback is covered in its own report. Neither has been used on a real owner connection.

## Final Windows acceptance

Run `r11`, Full mode, against the installed Plane: `NEXAR_WINDOWS_FULL_PASS` in 2,955 s, source unchanged throughout.

| Stage | What                                                            | Result                                                 | Seconds |
| ----- | --------------------------------------------------------------- | ------------------------------------------------------ | ------- |
| 1–7   | Lockfile, DSH install and seal, format, lint, boundaries, types | Passed                                                 | 184.3   |
| 8     | Offline tests: 4,770 passed, 171 skipped                        | Passed                                                 | 315.6   |
| 9–11  | Build and CLI smokes                                            | Passed                                                 | 5.9     |
| 12    | Real DSH offline context and compaction                         | Passed                                                 | 20.8    |
| 13    | Real isolated Cowork against the installed Plane                | Passed                                                 | 47.9    |
| 14    | Source Desktop E2E: 36 of 36                                    | Passed                                                 | 398.4   |
| 15    | Installer packaging                                             | Passed                                                 | 1,428.8 |
| 16    | Packaged Desktop E2E, bundled runtime only: 36 of 36            | Passed                                                 | 546.9   |
| 17    | Linux Bubblewrap validation                                     | **Blocked on Windows by design**; covered by WSL below | 0       |
| 18    | Gitleaks, full history                                          | Passed, no leaks                                       | 1.7     |

**Conditions:** the owner's other project was finished and its demo host and simulator kept running at a small steady load. CPU peaked at 82%, free memory fell to 679 MB and paging peaked at 25,758 pages/s, so this was not an idle host.

**Skips:** 18 files are wholly or mostly skipped (77 tests): live tests needing `NEXAR_LIVE_TESTS`, and sandbox, lane-engine and worktree tests needing Bubblewrap, which also run under WSL. The other 94 are individual skips, mostly POSIX-only tests, in files that otherwise ran. A per-file count exists only for `79be762` (175 skipped), and the difference of 4 was not reconciled.

### Every Windows Full attempt

A later pass does not erase these failures.

| Run | Commit    | Outcome                                                                                                           |
| --- | --------- | ----------------------------------------------------------------------------------------------------------------- |
| r1  | `79be762` | Stage 14 timeout at 901 s, under other load                                                                       |
| r2  | `79be762` | Stage 8, 15 s timeout in `tests/no-openworker.test.ts`                                                            |
| r3  | `79be762` | Stage 15, packaging over the 1,500 s limit                                                                        |
| r4  | `79be762` | Stage 14 timeout at 938 s, 29 MB free                                                                             |
| r5  | `79be762` | Stage 8 timeout at 600 s                                                                                          |
| r6  | `79be762` | Stage 14, private-state check took 15,287 ms against 15 s during heavy paging                                     |
| r7  | `79be762` | Stage 8, `plan-binding.test.ts` connection reset on a quiet host; root cause found and fixture fixed in `00f530b` |
| r8  | `00f530b` | Stages 1–14 passed; stage 15 stopped on a stale packaging lock left by r3, reviewed and removed                   |
| r9  | `00f530b` | Stage 14, Cowork SOW turn still running after 60 s with 0 model requests, on a calm host. **Unexplained**         |
| r10 | `00f530b` | Stages 1–14 passed; packaging over the 1,500 s limit                                                              |
| r11 | `616042f` | **Passed**                                                                                                        |

**The r9 hang is not explained.** 20 isolated repeats passed, and it did not recur in r11, source or packaged. The test now prints its last telemetry event types, so a recurrence will show how far the turn got.

### Packaging limit

The limit went from 1,500 s to 3,600 s. With no limit on an otherwise similar host, packaging took 2,763 s, exited 0 and produced a verified installer. Most of that time was first reads of about 28,000 freshly written runtime files: about 25 ms each, against 0.1 ms for a repeat read. That fits on-access scanning, but the scanner is not proven. Integrity checks did not change. r11 took 1,429 s, so the same stage varies by about a factor of two with host conditions. Hosted Windows CI is unaffected.

## Final WSL acceptance

Three runs on `616042f` with the stall monitor, from isolated checkouts of the same tree. Each passed 4,912 tests and skipped 33.

| Run | Start | Duration | Longest fsync |
| --- | ----- | -------- | ------------- |
| 1   | Cold  | 263 s    | 609 ms        |
| 2   | Warm  | 270 s    | 628 ms        |
| 3   | Cold  | 260 s    | 189 ms        |

The 33 skips:

- Windows-only tests: `private-state` 12, `wsl-cowork.real` 5, `native-subscriptions` 4, `claude-code/windows` 2, `codex/process` 2, `wsl-cowork` 2 and `desktop-key-store` 1. The Windows run covers these.
- Live tests needing `NEXAR_LIVE_TESTS`: 5, one each for Antigravity, Claude Code, Codex, DSH and pi. **No run executed these.**

## Hosted CI

Passed on `616042f`: Ubuntu in 8m18s, Windows in 20m37s, secret scan in 6 s. Hosted CI and WSL are not interchangeable: hosted Windows has no installed Plane.

## Known limitations

- **Sign-in callback helper:** the helper exits right after finishing, and a client that stalls for 50 ms or more lost the whole response in 25 of 25 tries. Sign-in itself still succeeds, but an owner's browser could briefly show a connection error. This is not confirmed in a real browser and not fixed; only the test fixture changed.
- **Residual risk R-03:** Nexar cannot detect a login run outside Nexar in a private home. H′ documents this in its UI.
- **Vendor writes outside `CODEX_HOME`:** the package asked for a test with the pinned CLI. It is unverified, because that needs a real sign-in; check it in the owner's scenario.
- **`SubscriptionService.dispose()` for built-ins** can leave a process running after quit. This predates D′ and is out of scope. The owner sign-in service waits for its process.
