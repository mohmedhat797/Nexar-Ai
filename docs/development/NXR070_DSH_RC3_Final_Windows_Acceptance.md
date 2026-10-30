# DSH rc.3 final Windows acceptance

Date: 30 October 2026. **Verdict: NXR070_DSH_RC3_WINDOWS_FULL_CI_PASSED.** This supersedes the 27 October Windows verdict for this implementation; the earlier failed reports remain valid history.

## Source identity

| Item              | Value                                                                                                              |
| ----------------- | ------------------------------------------------------------------------------------------------------------------ |
| Commit            | `ab1dddae4f9147932a91d60fc49085b82d808b8b`                                                                         |
| Tree              | `87a8c0eeffde132029561f762ceb17f69846d52b`                                                                         |
| State             | Clean before and after; stable through the run                                                                     |
| Toolchain         | Node 22.23.3, pnpm 10.33.0, Gitleaks 8.28.0, Electron 44.5.1                                                       |
| DSH               | `@deepseek-ai/dsh@0.2.1-rc.3`, lock `7d2dbdc2a97a…`                                                                |
| Command           | `runner.mjs --mode=full --profile=windows --workers=2`, with `--node-bin` and `--gitleaks-bin`                     |
| Started; duration | 2026-10-30T13:31:43Z; 2,761,657 ms                                                                                 |
| Report            | `report-2026-10-30T13-31-43-722Z.json`, SHA-256 `b77e468a6170b764e4294df96bdecbb12e97ee5ec80cfea5aec767cf49d6d0b8` |
| Recorder log      | SHA-256 `a8c70c0ee47214731a2ef512c804c52009eb5e056c6a502cfb2c7ebc52bb023f`                                         |

## Stages: one complete invocation, `NEXAR_WINDOWS_FULL_PASS`

| Stage                | Result  | Time   | Tests                                          |
| -------------------- | ------- | ------ | ---------------------------------------------- |
| dependencies         | PASS    | 2 s    |                                                |
| dsh-install          | PASS    | 47 s   |                                                |
| dsh-artifact-seal    | PASS    | 11 s   |                                                |
| format-check         | PASS    | 17 s   |                                                |
| lint                 | PASS    | 37 s   |                                                |
| boundaries           | PASS    | 1 s    |                                                |
| typecheck            | PASS    | 16 s   |                                                |
| test-offline         | PASS    | 273 s  | 4,629 passed, 0 failed, 169 skipped, 4 pending |
| build                | PASS    | 3 s    |                                                |
| cli-smoke-resources  | PASS    | 1 s    |                                                |
| cli-smoke-run        | PASS    | 1 s    |                                                |
| dsh-context-real     | PASS    | 22 s   | 3/3                                            |
| cowork-isolation-wsl | PASS    | 51 s   | 8/8                                            |
| desktop-e2e-source   | PASS    | 444 s  | 33/33                                          |
| desktop-package-win  | PASS    | 1324 s | Mode A, verified artifact                      |
| desktop-e2e-packaged | PASS    | 505 s  | 33/33, bundled runtime only                    |
| linux-sandbox        | BLOCKED | 0 s    | Not applicable on Windows; see WSL             |
| gitleaks-scan        | PASS    | 2 s    | Full history                                   |

## Installer and runtime identity

| Item                           | Value                                                              |
| ------------------------------ | ------------------------------------------------------------------ |
| Installer SHA-256              | `cc15c940d8143dac88a1915641c5998f27681e270f6917d5eb019ae9641f793e` |
| Installer size                 | 326,112,595 bytes                                                  |
| Seal and packaged tree digest  | `d40e76a3a03d87ec760892c86c8672560832390f00849b110ebb2a834c996ce9` |
| Files and bytes                | 27,872; 510,046,703                                                |
| Free space on the build volume | 40.21 GB before, 39.66 GB after                                    |

The packaged runtime digest equals the seal, and a separately installed tree has the same digest.

## WSL and sandbox, exact commit

WSL Full on a Linux checkout of `ab1ddda`: **4,772 passed, 30 skipped, zero failed or pending**, source stable, execution receipt SHA-256 `2628b972ed210436432b8e8f5b3ab9a41766caca7de966800cbcb3d7609b04c1`. Real Bubblewrap launcher 12/12, sandboxed ACP 2/2. The five Windows-only `wsl-cowork` tests skip there and passed from Windows in `cowork-isolation-wsl`. The global WSL runtime was not changed. WSL2 is not native Ubuntu acceptance.

## Preserved boundaries

- **Credential isolation:** the real SDK test seeds a foreign native credential store and proves the selected key is delivered. `connection-authority` and `connection-runtime` tests cover connection-to-key binding. Both upstream credential services remain disabled in ACP and SDK overlays.
- **NRC and review diversity:** no file under `packages/resource-controller` changed since C′; its strategy and diversity tests pass in `test-offline`.
- **Sessions and memory:** no file under `packages/sessions` or `packages/project-memory`, nor the connection, settings or key stores, changed since C′. Native resume stays disabled.
- **Rollback:** real ACP 3/3 on each of rc.2→rc.3→rc.2. Disposable state rollback kept identical connection, resource, session and memory digests. Native-database downgrade is not certified.
- No paid inference, real credentials or owner profile were used; test profiles are disposable. The owner's installation was not touched.

## Remaining limitations

- Hosted CI on GitHub has been blocked by the Actions budget and is not claimed as passing.
- Independent owner review is pending; this is the implementing agent's own verification.
- No clean-machine NSIS installation, and the NSIS payload was not independently extracted. See the [packaging report](NXR070_DSH_Verified_Runtime_Packaging_Architecture.md).
- The package stage's 1,324 s leaves limited margin under the 1,500 s envelope, and one standalone run took 1,692 s.
- The historical 180-second cause is correlated with low disk space but not demonstrated.
- The commit after this run changes documentation only; its `pnpm check` result is in the publication record of PR #46.
