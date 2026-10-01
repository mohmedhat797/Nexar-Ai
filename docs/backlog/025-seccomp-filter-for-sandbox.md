# NXR-025: Seccomp filter for the sandbox

**Milestone:** v0.3.x · **Labels:** security, sandbox · **Depends on:** [NXR-024](024-os-level-sandbox-for-agent-runtimes.md)

## Summary

Add a syscall filter (seccomp-bpf) to the bubblewrap profile used for engineering lanes, so a
compromised or prompt-injected agent has a smaller kernel attack surface inside the sandbox.

## Problem

The v0.3 sandbox ([ADR-018](../adr/018-engineering-execution-plane.md)) isolates with namespaces, a
read-only root and an egress proxy, but applies **no seccomp filter**. The profile only passes
`--disable-userns` (bubblewrap 0.8+) to stop nested user namespaces. Everything else the kernel
exposes to an unprivileged process stays reachable. See the known gaps in the
[security model](../architecture/security.md).

## Objective

Every sandboxed launch runs under a Nexar-owned seccomp filter that denies syscalls the supported
runtimes do not need, without breaking Claude Code, Codex, DSH or the toolchains used by gates.

## Scope

- A filter definition owned by `@nexar/sandbox`, generated or checked in as data, with a documented rationale per denied group (for example `ptrace`, `bpf`, `keyctl`, `mount`-family, `io_uring`, `perf_event_open`).
- Passing the compiled filter to bubblewrap through its seccomp file-descriptor option (verify the flag against the installed bwrap manual).
- A per-launch opt-out for gates only if a real toolchain needs it, recorded and owner-controlled, never an agent-controlled setting.
- `nexar sandbox selftest` gains a check that a denied syscall fails.
- Keep `--disable-userns` as defense in depth.

## Out of scope

- A per-runtime custom filter, macOS/Windows backends, and replacing the mount-namespace boundary.
- Changing the egress proxy or credential-mount rules.

## Technical notes

- Test against the runtimes actually used (Claude Code, Codex, DSH, Node under `/opt/node22`); start with a denylist of high-risk syscalls rather than a strict allowlist, then tighten.
- The filter must be architecture-aware (x86_64 first; document aarch64).
- Failure to load the filter is `SANDBOX_UNAVAILABLE`; there is no unfiltered fallback.

## Acceptance criteria

- [ ] A probe process inside the sandbox gets `EPERM` (or is killed) for each denied syscall group.
- [ ] The two live E2E scenarios from v0.3 still pass under the filter.
- [ ] A missing or unloadable filter fails closed.
- [ ] `nexar sandbox selftest` reports the filter check.

## Testing expectations

Probe-binary tests skip with a reason when bwrap is unavailable; unit tests cover filter generation
deterministically. No paid calls; the live E2E re-run is owner-run.

## Security considerations

Defense in depth, not a replacement for the sandbox, gates or owner approval. Review each denied
group for runtimes that legitimately use it, and document any exception in the security model.
