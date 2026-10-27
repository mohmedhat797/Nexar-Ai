# DSH 0.2.1-rc.3 implementation

Date: 27 October 2026. Branch: `feat/nxr-dsh-021-rc3-upgrade`, based on C′ `f4c73bd6e62b35b4c28ac38531f536e41d6b22a7`. Implementation and acceptance remain in progress.

## Pin and dependency boundary

`integrations/deepseek-harness/dsh-runtime.json` changes only the exact managed target from `0.2.0-rc.2` to `0.2.1-rc.3`. Its npm lock is generated with Node 22.23.3/npm 10.9.9, seeded from the old lock, and validated against the published rc.3 SRI. Candidate lock SHA256: `6f0cdaa5c552f5a78738fc6a5b2f942c1dc9856a897ccc7a130ab4c0bef9cb40`. Workspace `pnpm-lock.yaml` is unchanged. The runtime's dependency closure changes, including upstream pi-ai 1.4.0 and OpenAI SDK 7.19.0; these are inside the managed DSH install, not upgrades of Nexar's separate host provider adapter.

The Phase A staged installer is inherited through the normal B′→C′ merge. It still uses npm-ci lock integrity, exclusive admission, staging, real package/entry/version validation and fail-closed publication. No timeout, integrity or identity check is relaxed. The first actual rc.3 install completed in 98,656 ms, inside the existing 180,000 ms budget.

## Compatibility changes

- `src/resource.ts` retains canonical `deepseek-harness` and its accepted connection/provider metadata; the native built-in model default now matches upstream `deepseek-flash`. Explicit owner model settings are preserved, including old names; there is no hidden alias migration.
- `src/handshake.ts` uses that default only when no explicit model is supplied. ACP server component version is not assumed to equal the CLI package version.
- `src/profiles.ts` disables the new working-directory tool and DeepSeek web backend in both profile overlays. It also disables the upstream credential store and its dependent native sign-in service so saved DSH credentials cannot replace Nexar's selected credential. Existing Cowork tool, shell, native subagent, plugin-manager and remote capability restrictions remain.
- `src/env.ts` and ACP local/sandboxed/Coding launch builders set `DSH_AGENTS_HOME` under the managed private home. Ambient values and credential-reference attempts to overwrite this new reserved variable are refused. Existing private-home mounts and permissions are unchanged.
- Active WSL helper, local-CI runtime and package identity assertions now require rc.3. A validated acceptance-only Linux runtime override allows the candidate to run without replacing the machine's approved `/opt/dsh` install.
- The passive upstream manifest records rc.3 as `EVALUATED`, not accepted or installed globally. Historical approval evidence remains identified as rc.2. Exact target validation rejects other versions; no update discovery or execution is activated.

Tests retain historical version observations and synthetic installer fixtures where they describe rc.2. Active current-version fixtures change deliberately. New tests cover private shared-agent-home isolation, an isolated Linux acceptance runtime, preservation of explicit legacy model options, and actual managed ACP execution over persisted owner connections and the production Registry/NRC/Gateway/credential resolver.

## SDK compatibility follow-up

Final call-graph review also inspected the retained ordinary-task SDK path in `adapter.ts`, which uses `renderPatchOverlay` rather than the ACP profile renderer. The published rc.3 SDK application inherits `dsh-base`, including the new tool/backend rows. The SDK overlay disables those two rows too. It additionally disables `credentials` and `authorization` after actual execution demonstrated that the upstream saved store displaced the explicitly selected key. Exact SDK overlay expectations change for those four denied surfaces; NRC routing golden fixtures remain unchanged.

A new opt-in `sdk.real.test.ts` executes the actual managed SDK against an explicit synthetic provider at `127.0.0.1`, with a private instruction home and a non-secret fixture credential. It verifies model execution, credential delivery, absence of the new working-directory tool and secret-free adapter logs. The first execution timed out at initialization after 60 seconds; a subsequent diagnostic execution passed and offered 24 tools. The diagnostic added no startup correction, so the initial delay is unresolved. Bounded additional attempts and final acceptance are recorded separately; successful reruns are not root-cause closure.

The final test also seeds a valid version1 native credential store with a foreign synthetic key. Actual RED observed that key at the local transport; GREEN after disabling the native store/sign-in services observed the selected key. No native store is deleted or migrated. The first version of that extra fixture omitted its required schema version and failed initialization; it is preserved as a fixture failure, distinct from the valid-store substitution regression and the earlier unexplained initialization delay.

The first Full Windows attempt at `3fa15d4` was deliberately interrupted during stage 4 after this SDK overlay gap was confirmed. It passed dependency verification, runtime installation (141.72 seconds) and formatting, but emitted no aggregate PASS. A complete invocation on the corrected source is still required. The stable managed runtime lives under `.nexar/dsh-runtime`; Desktop's generated `dist` is intentionally cleared by its build and is unsuitable for the persistent acceptance runtime.

## Runtime and ownership

Nexar still initiates a fresh ACP session per turn. DSH's internal private session files remain runtime-local and do not replace FileSessionStore. No resume API or plugin storage migration is enabled. ProjectMemoryStore, Permission Broker, immutable connection identity, host credential resolution, review diversity, delegation limits and sandbox authority are unchanged.

## Rollback design

B′ and C′ retain rc.2 on their own branches and their existing managed/package artifacts. The candidate is independently installed and packaged. Rollback selects the old source, old exact lock and old runtime in disposable state; it does not restore settings backups, rewrite connection IDs, replace credentials, redirect pins, or import rc.3 native sessions. Demonstration results and any limitations must be recorded in the acceptance report before rollback is classified verified.

The [version amendment](../adr/030-version-amendment-dsh-021-rc3.md) records the owner's narrow authorization. Final source/tree IDs, tests, platform results and publication belong in [acceptance](NXR070_DSH_021_RC3_Acceptance.md) and [handover](NXR070_DSH_Upgrade_Final_Owner_Handover.md).
