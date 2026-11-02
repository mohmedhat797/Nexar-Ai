# NXR-070D′ final owner handover

Date: 2026-11-02. Engineer: Claude Opus 5.5.

**NXR-070D′ passed automated acceptance on `616042f`, but it can't be called accepted until you run the two-account check.** [Draft PR #51](https://github.com/mohmedhat797/Nexar-Ai/pull/51) is not merged.

## What you get

Nexar can now keep several Codex accounts apart, each with its own private `CODEX_HOME`, and the NRC selects between them. **You can't use this from the app yet:** the screens are in H′, which comes next. Today it is reachable only through the bridge and tests.

## Results

| Gate                                   | Result on `616042f`                                         |
| -------------------------------------- | ----------------------------------------------------------- |
| Windows Full, installed Plane          | Passed in 2,955 s, on the 11th attempt across three commits |
| Source Desktop E2E                     | 36 of 36                                                    |
| Packaged Desktop E2E                   | 36 of 36                                                    |
| WSL Full and real Bubblewrap           | 3 of 3 runs, 4,912 passed, 33 skipped                       |
| Installed Plane                        | 9 of 9 checks, rollback and re-activation worked            |
| Isolation, lifecycle, Review Diversity | Passed with synthetic accounts                              |
| Gitleaks and hosted CI                 | Passed                                                      |
| Two real accounts                      | **Not run; needs you**                                      |
| Live tests                             | **Not run**, by design, because they can cost money         |

Details: [implementation and acceptance](NXR070D_Implementation_and_Acceptance.md), [Plane](NXR070D_Plane_Upgrade_Report.md), [G-14](NXR070D_G14_Reliability_Evidence.md).

## Still open

1. **G-14 is not resolved.** WSL Full failed 3 of 15 runs on the 5-second limit. Failures line up with disk stalls in the VM, whose cause is unknown. The limit is unchanged.
2. **One Cowork SOW hang is unexplained.** It happened once in r9 on a calm host, and did not recur in 20 isolated repeats or in r11. The test now reports how far a stalled turn got.
3. **Sign-in callback.** A browser could briefly show a connection error while sign-in succeeds. It is not confirmed in a real browser, and only the test fixture changed.
4. **The r11 host was not idle.** Your demo kept running, and memory fell to 679 MB free at one point.

## Decisions you should know about

- **No Plane-local home store.** The package listed one, but the Plane has no connection authority. As a result, write-mode lanes can't use an owner Codex connection on Windows Desktop.
- **Windows packaging limit raised to 3,600 s.** The stage took 1,429 s in r11 and 2,763 s at worst. A packaging run was exceeding 1,500 s mostly because of first reads of about 28,000 fresh files, which fits antivirus scanning but isn't proven. Excluding the folder from scanning would be your decision; I didn't change it.
- **Rotate is refused for these connections,** because Codex owns the credential. A repeat sign-in with your same-account assertion takes its place.

## What needs you

1. **Revoke the exposed DeepSeek key,** and confirm it. It stays treated as compromised until you do.
2. **Check two real accounts** once you're ready. You start each login yourself. Confirm the accounts stay separate, and check whether Codex writes anything outside its `CODEX_HOME`, which was not testable without a real sign-in.
3. **Review and decide on PR #51.** I won't merge it.
4. **Know what's on your Plane.** It now runs the unmerged commit `616042f`. To go back: close Nexar, then run this:

```bash
wsl -d nexar-plane -u root --exec sh /home/nexar/plane-upgrade.sh rollback
```

After a merge, upgrade to the merged commit with the [Plane guide](../guides/plane-upgrade.md).

## Rollback

- **Owner connections:** close Nexar, add `"ownerConnections": { "enabled": false }` to `desktop-settings.json`, and start it again. Nothing is deleted, and pins fail explicitly. The built-ins keep working.
- **Code:** reverting is safe, because saved definitions fail closed to built-ins. No rollback deletes a home or changes a session.

## Next

H′ (Providers UI) should follow D′. H′, F′, G′ and I′ were not started.
