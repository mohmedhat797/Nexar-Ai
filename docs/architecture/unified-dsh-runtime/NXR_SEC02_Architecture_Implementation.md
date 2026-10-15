# NXR-SEC-02 — isolated Cowork implementation

Date: 2026-10-16. ADR-030 remains **Proposed**. No AppContainer work or NXR-070 implementation.

Implementation commit `3b3e26a3ab641f5273ad43ddce6de0ca4065f847` matches the frozen tested tree.
Windows Full CI passed all 16 required gates, including actual WSL execution and 25/25 source plus
25/25 packaged Desktop tests. See [acceptance identities and scope](../../development/NXR_SEC02_Windows_WSL_Acceptance.md).
The owner's NXR-SEC-02 assignment authorizes interim WSL2 implementation/validation; permanent
support policy, production integration and ADR acceptance still require the owner. Existing
installed Windows/WSL applications were preserved rather than replaced by this local work.

## Execution and trust boundaries

Desktop main selects `WslCoworkBackend` for production Cowork. It invokes the absolute Windows
`wsl.exe`, with fixed arguments selecting the owner-configured distro and CLI command. The helper
is `nexar cowork serve --stdio`; its newline JSON-RPC protocol is `nexar-cowork@1`.
The explicit Desktop user-data override together with `NEXAR_DESKTOP_TEST_LOCAL_COWORK=1` retains
the old host-local offline fixture path; a user-data override alone does not change placement.
Acceptance tests set `NEXAR_DESKTOP_TEST_WSL_COWORK=1` to exercise the production backend. Normal production
has no host-local Cowork fallback. `DshCoworkService.available()` keeps production requests routed
to the Cowork service; its readiness check blocks execution rather than selecting a direct resource.

The Linux helper checks pinned DSH `0.2.0-rc.2`, hardened WSL configuration, bubblewrap and socat.
Each helper accepts one run. It creates mode-0700 private scratch, input, home and services directories.
`runSandboxedCoworkSession` reuses `SandboxLauncher`, `spawnPrepared`, the existing ACP conversation,
Cowork profile, overlay renderer, permission translator and cancellation implementation.
It rejects missing/downgraded isolation; it never substitutes a local launcher.

| Mount or resource                                          | Access and purpose                                                |
| ---------------------------------------------------------- | ----------------------------------------------------------------- |
| `/work`                                                    | Per-turn scratch, read/write; not the project root                |
| `/inputs/cowork`                                           | Private copied input files, read-only                             |
| `/home/agent/.dsh`                                         | Fresh per-turn runtime state, read/write                          |
| Managed Node and DSH dependency roots                      | Read-only toolchain mounts                                        |
| Minimum system directories and private proc/dev/tmp        | Existing SandboxLauncher profile                                  |
| Per-turn service sockets and relay                         | Existing services mount, read-only directory                      |
| Windows drives, WSL user home, project roots, Nexar stores | Not mounted                                                       |
| Network                                                    | New namespace, `network.mode=none`; controlled gateway relay only |

The helper and Windows main remain trusted. This boundary isolates DSH from host resources; it does
not defend against an administrator, compromised kernel, compromised helper, or modified managed
runtime installation. The distro user and toolchain must be owner-controlled and non-root.

## Gateway, delegation and permissions

The sandbox gateway socket accepts only authenticated `POST /v1/chat/completions`. Windows forwards
the bounded body to the existing turn's fixed loopback Control Model Gateway with its exact token.
The isolated process cannot select another URL, header set or provider credential. NRC retains
resource selection, connection identity, fallback decisions, usage and accounting. Responses are
buffered up to 8 MiB; streaming UI deltas can consequently arrive after the model response finishes.

The sandbox MCP relay uses its private bridge socket. Windows accepts only `submit` and `status`
under the existing token, grant, correlation, budget and monotonic unit limit. Document references
are rejected at this boundary: units may use only supplied bounded text. Standalone `reviewOf`
restrictions preserve existing normalization. Desktop's Cowork executor excludes native agents and
all adapters except reviewed `pi`/`echo` model bindings, including mislabelled descriptors. Coding's
native executor remains unchanged. This closes a host-execution escape through delegated work.

Write/edit approvals map virtual `/work` paths into the Windows turn's private mirror for existing
broker policy and durable approval recording. The Linux helper separately checks the physical
scratch path before and after the approval round trip. The OS mount boundary remains authoritative
against reads/writes outside allowed mounts; broker refusal alone is not isolation evidence.

## Inputs, artifacts and continuity

`loadCoworkInputs` stages the owner-configured project's `documentSets.cowork` and the same canonical
session's most recent preceding successful draft turn. Cross-project sessions are rejected.
Original project paths are never mounted. Inputs are copied under generated flat names; DSH is told
their virtual directory. There is no new attachment picker or automatic whole-project ingestion.

Transfers accept at most 32 regular flat files, 2 MiB per file and 4 MiB total. Strict base64,
SHA-256, safe names, duplicate detection, no-follow opens, file identity rechecks and hardlink/symlink
rejection apply. Output extraction selects top-level `.md`, `.txt`, `.json`, `.csv`, validates bytes,
then stages them in Windows scratch for the existing artifact importer. Artifact records, paths,
canonical sessions and Project Memory remain Nexar-owned. Binary/large/nested output is not supported.
Owner policy can still deny all writes or require approval.

The helper tears down sockets, sandbox services and private directories in `finally`; stdio closure
aborts active work. Desktop cancellation cancels the helper and terminates its own WSL child. Existing
service cleanup revokes grants and removes the Windows mirror/home. Unexpected process death needs
the same acceptance scrutiny as normal cancellation; see the security matrix for evidence scope.

## Source map

- `apps/desktop/src/main/wsl-cowork.ts`: transport and host relay validation.
- `apps/cli/src/commands/cowork.ts`: trusted Linux helper and lifecycle.
- `integrations/deepseek-harness/src/acp/sandboxed.ts`: prepared Cowork ACP placement.
- `integrations/deepseek-harness/src/cowork-files.ts`: bounded transfer validation.
- `integrations/deepseek-harness/src/cowork-containment.ts`: Linux physical path checks.
- `apps/desktop/src/main/cowork-inputs.ts`: approved input selection.
- `apps/desktop/src/main/cowork-executor.ts`: bounded delegated-resource enforcement.

The existing Coding `SandboxLauncher`, network restrictions, engineering pipeline and session
ownership contracts are reused without changing their production implementation.
