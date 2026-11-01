# DSH rc.5 / Electron runtime coupling investigation

Date: 2026-11-01. Scope: isolated compatibility tests and source inspection following the owner's explicit runtime-decoupling request. No loader, DSH pin, lock, overrides, credentials or installed application were changed for these probes.

## Finding and decision

**Standalone Node 24.22.2 works. Electron 44.10.1's embedded Node/V8 fingerprint is rejected in both Electron main-process and RunAsNode contexts.** The failure is not a blanket Node 24 rejection and is not limited to `ELECTRON_RUN_AS_NODE=1`.

The existing adapter supports an absolute selected Node command. A dedicated Node process completed a real rc.5 ACP turn, but this establishes execution feasibility, not packaged-Desktop acceptance. Current packaging has no standalone Node binary, Node artifact manifest, executable integrity verifier or lifecycle policy. Secure distribution therefore requires the [separate implementation proposal](NXR_DSH_Electron_Runtime_Decoupling_Implementation_Proposal.md), rather than an environment-variable workaround in this milestone.

Under the owner's fallback rule, retain accepted Electron 44.5.1 temporarily, qualify the Node 24 migration against every current path, and mark the Electron security upgrade **BLOCKED**. No intentionally failing 44.10.1 dependency remains in the final candidate. Its failed tests and source commits remain diagnostic evidence.

## Controlled evidence matrix

| Host and actual executable                                                                                        | Observed runtime                                          | Probe                                                                                                                                                                              | Result and permitted conclusion                                                                                                                                                                                                       |
| ----------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `D:\Nexar-Toolchains\node-v24.22.2-win-x64\node.exe`                                                              | Node 24.22.2; official binary SHA-256 in toolchain report | Existing `dshLaunchFor(entry, {nodeCommand: process.execPath})` plus `runLocalAcpSession`, private home/scratch, loopback SSE model server, no MCP servers, per-call reject policy | **Passed:** real ACP initialized, selected the Nexar route, made exactly one synthetic model call, returned `NODE24-SYNTHETIC-PROBE` with `end_turn`, and its owned child was settled. No loader bypass or Electron environment flag. |
| `D:\Nexar-Ai-main\.nexar\node24-migration\virtual-store\electron@44.10.1\node_modules\electron\dist\electron.exe` | Electron 44.10.1; Node 24.22.1; V8 15.2.124.45-electron.0 | `ELECTRON_RUN_AS_NODE=1`, actual version query and `dsh --version`                                                                                                                 | Both succeed. This proves version reporting, not profile initialization.                                                                                                                                                              |
| Same Electron executable                                                                                          | Same embedded runtime                                     | The same isolated ACP turn through Electron RunAsNode                                                                                                                              | **Rejected:** child exited 1 before any model call; zero loopback requests.                                                                                                                                                           |
| Same Electron executable                                                                                          | Same embedded runtime, actual main process PID 4676       | Minimal Electron main script, no BrowserWindow, disposable profile, genuine `requireBuiltin('internal/modules/esm/loader')`, no RunAsNode flag                                     | **Rejected:** the same unsupported fingerprint. The main-process context also fails; it is not merely a RunAsNode environment issue.                                                                                                  |
| `/opt/node-v24.22.2-linux-x64/bin/node` in `nexar-plane`                                                          | Standalone Node 24.22.2                                   | Current candidate build/runtime installation, real WSL kernel/ACP/containment tests from Windows, and separate Linux acceptance                                                    | The installation/build/real WSL gate passed. Full Linux outcomes, including any independent setup failures, remain separately reported; this row does not turn partial acceptance into a Full PASS.                                   |

The Windows Node probe used the already pinned rc.5 files at `D:\Nexar-Ai-main\.nexar\node24-migration\state\dsh-runtime\node_modules\@deepseek-ai\dsh\lib\bin.js`. Probes used newly created synthetic homes and scratch directories. Their parent environment is reduced by the existing adapter's allowlist; no native provider homes or account credentials are supplied. The inactive `deepseek-account` plugin reported that it was waiting for credentials/authorization. No real provider inference occurred.

## Exact rejection and dependency chain

The direct ACP probe captured:

```text
dsh: host preparation failed: node-addon-require-builtin unsupported:
Unsupported/no-context (unsupported Electron runtime fingerprint:
Node 24.22.1, V8 15.2.124.45-electron.0
(supported Electron versions: 43.0.0, 44.0.0, 44.7.0, 45.0.0-alpha.6))
```

The captured stack reaches `node-addon-native-custom-loader@0.1.9` (`lib/index.js`, `requireBuiltin`), `node-addon-require-builtin@0.1.9` (`lib/index.js`), then `@deepseek-ai/dsh-app-boot@0.2.1-rc.5` (`internalModules`, `installRuntimeInterception`, profile boot). Actual code rejected the genuine runtime fingerprint. No spoofed `process.versions`, renamed binary, patched hook, environment bypass or dependency override was used.

Corroborating primary evidence: [upstream support matrix pinned at a58d3599a2e551d7d706d1ff796c9fd4bbaff63c](https://github.com/deepseek-ai/dsh-node-addon-require-builtin/blob/a58d3599a2e551d7d706d1ff796c9fd4bbaff63c/docs/support-matrix.md), [published loader 0.1.9 metadata](https://registry.npmjs.org/node-addon-native-custom-loader/0.1.9), and the unchanged Nexar runtime lock. npm metadata did not expose a `gitHead`; the matrix's current commit is not asserted to be the exact published npm source identity. The installed pinned package and direct failures are the decisive evidence.

[Electron 44.7.0](https://releases.electronjs.org/release/v44.7.0) shares Node 24.21.0 / V8 15.2.124.28 with accepted 44.5.1; later maintenance releases change that fingerprint. 44.7.0 is therefore not a substitute for the requested October embedded-Node security fixes. Neither a newer Electron major nor a DSH alpha upgrade is authorized as a shortcut.

## Coupling in current Nexar source

At failed candidate `c797e544fa754626f528579703289fe8fe25dec7`:

- `integrations/deepseek-harness/src/runtime/resolve.ts::dshLaunchFor` already supports an absolute `nodeCommand`; script entries are passed as arguments without a shell. `allowlistedEnv` preserves the existing credential boundary.
- Ordinary SDK tasks are already external processes: `integrations/deepseek-harness/src/adapter.ts` calls `spawnRuntime`, and `sdk.real.test.ts` exercises `binary: { command: process.execPath, args: [entry] }`. That real SDK test passed under standalone Node 24 in the fallback Full attempts. Decoupling Desktop does not require inventing an in-process SDK architecture.
- `apps/desktop/src/main/dsh-runtime-path.ts::dshLaunchForEntry` deliberately chooses `process.execPath` and `ELECTRON_RUN_AS_NODE=1`. This is the Desktop coupling, separate from the adapter's capability.
- `packagedDshEntry` verifies the contained rc.5 package entry and manifest. Its contract returns an entry, not a separately attested executable.
- `apps/desktop/electron-builder.json` ships DSH files through `extraResources`; no standalone Node binary is present in the managed runtime tree. The retained Builder config and `scripts/package-win.mjs` also explicitly pin 44.5.1, so a future Electron change must reconcile all packaging authorities together.
- `scripts/dsh-runtime/artifact.mjs` seals the locked DSH package tree. Adding Node inside that tree would alter its meaning and is not the approved mechanism. A separate runtime artifact is needed.

Changing a single launch argument to a development/global Node path would not satisfy packaged integrity, availability or provenance requirements. Shipping a new executable without runtime verification would introduce an unapproved trust boundary. This is why a working standalone probe is not treated as a minimal production correction.

## Evidence retention and limits

Ignored evidence includes `node24-standalone-acp-probe.log`, `node24-electron-acp-probe.log`, `node24-electron-main-probe.log`, `node24-source-runtime-e2e.log`, and `node24-windows-full-attempt4.json/.log`. Final acceptance records their hashes and tested source IDs. The probes are diagnostics, not substitutes for Full acceptance, delegation/credential tests or packaged execution. No upstream support request or code change was sent automatically.
