# NXR-055 owner live validation (2026-10-03)

Owner machine, Windows 11 Pro 10.0.26300, run by Claude Code (Opus 5.5) with owner-authorized
Computer Use. Nexar source: PR #36 head `8949339` (`feat/nexar-operating-layer`). Sanitized: no
tokens, keys or credential contents were read or recorded.

## Environment

| Item | Value |
| --- | --- |
| WSL | 2.7.14.0, kernel 6.18.33.2-2, default version 2; NAT networking and firewall by default (no `%UserProfile%\.wslconfig`, left untouched) |
| Other distros | `Ubuntu`, `docker-desktop`: not modified |
| Plane distro | `nexar-plane`, Ubuntu 24.04.5 LTS (`wsl --install -d Ubuntu-24.04 --name nexar-plane --no-launch`) |
| Plane user | `nexar` (uid 1000), groups `nexar` only: no sudo |
| `/etc/wsl.conf` | exactly the runbook's hardened file (systemd on; automount, interop, Windows PATH and GPU off; default user `nexar`) |
| AppArmor | `kernel.apparmor_restrict_unprivileged_userns` does not exist on this kernel: no profile needed |
| Packages | bubblewrap 0.9.0, socat 1.8.0.0, git 2.43.0, ca-certificates, curl |
| Node / pnpm | Node v22.23.3 (nodejs.org tarball, SHA-256 verified, `/opt/node`), pnpm 10.33.0 via corepack |
| Nexar | built in `/home/nexar/src/Nexar-Ai` from a git bundle of `8949339` (no GitHub credential in the plane; the clone has no GitHub remote); root-owned launcher `/usr/local/bin/nexar` sets `NEXAR_CONFIG_PATH` to the plane config |
| Runtimes (root-owned `/opt`) | Claude Code 2.1.286 (signed in with the vendor flow, `claude.ai` subscription); Codex 0.159.3 (installed, sign-in not completed); DSH 0.2.0-rc.2 (installed; not configured: model runs need an opt-in DeepSeek key) |
| Validation project | `nxr055-validation`: the shipped `examples/engineering-demo` library at `/home/nexar/validation/repo` (`main @ 40f02fb`), gate `node --test`, `ownerApproval: always`, `reviewDiversity: preferred`, Claude Code credential file declared as the only sandbox mount |

Setup notes: the first boot (before hardening) left empty `/mnt/c` and `/mnt/d` mount points; they
were verified unmounted and empty, then removed, so A2 reports "No such file or directory". One
`noble-updates/universe` index had a mirror hash mismatch during `apt-get update`; the required
packages come from `main` and installed normally.

## Acceptance A1–A6 (run as `nexar`)

| Check | Command | Result | Status |
| --- | --- | --- | --- |
| A1 | `nexar doctor` | `bwrap: 0.9.0 (functional probe passed)`; `wsl.conf automount.enabled: false`, `interop.enabled: false`, `interop.appendwindowspath: false`, `boot.systemd: true` | PASS |
| A2 | `ls /mnt/c` | `No such file or directory` | PASS |
| A3 | `cmd.exe /c ver` | `cmd.exe: command not found` | PASS |
| A4 | runbook bwrap command | `ok` | PASS |
| A5 | `nexar sandbox selftest` | 7/7: bwrap works; `/work` writable; root read-only; `/work/.git` read-only and immovable; host files invisible; loopback only; proxy denies non-allowlisted CONNECT (exit 0) | PASS |
| A6 | `uname -r` | `6.18.33.2-microsoft-standard-WSL2` | recorded |

## Desktop → plane (Computer Use, source Desktop build at `8949339`)

| Step | Evidence | Status |
| --- | --- | --- |
| Project added | native folder dialog, `Documents\NXR-055 validation` | PASS |
| Readiness before mapping | Code banner "This project is not mapped to an engineering plane project" (real plane reached over `wsl.exe`) | PASS |
| Id-only mapping | Settings in the Code banner: plane project id `nxr055-validation` | PASS |
| Plane ready | "Ready · Engineering plane ready · Plane version 0.1.0" | PASS |
| Report-only review | Task kind `review`; task `eng-be46d6ee399c`, plan `repository-report`, status `reported`, lane `report` on `claude-code` (23.7 s); six findings about `src/slugify.js` and tests; no branch, patch, approval or commit; repo still `main @ 40f02fb` | PASS |
| Engineering write | Task kind `coding`; task `eng-7b64bb1aff49`, plan `implement-review`; lanes `feature` and `review` on `claude-code`; patch 1 file / 385 bytes, valid (`df002d6c…`); gate `test` exit 0; review `approve` (0/0/0/0) | PASS |
| Diff shown in Desktop | `README.md` only: adds a "Validation" section | PASS |
| Desktop approval | Approvals view: `engineering.commit`, fingerprint `df002d6ca4c9`, Approve → "Yes, approve" → nothing pending; record `approved` | PASS |
| Local commit | branch `nexar/eng-7b64bb1aff49`, commit `e15a379` (author Nexar), `README.md | 4 ++++`; `main` unchanged | PASS |
| No push | repository has no remote (`git remote` empty); only `refs/heads/main` and the result branch exist | PASS |
| Cancellation | task `eng-bd56538a05aa` cancelled from Desktop: status `cancelled`, "Nothing was committed", no bwrap or claude process left | PASS |
| Session | all turns in one persistent conversation; Desktop remained usable | PASS |

## Findings

1. **Intent classification (fixed in the same branch):** "Review this repository and summarize …"
   under Task "Auto" fell through to `analysis` and ran direct (honestly recorded:
   "Only engineering requests run on the engineering plane"). `review.repository` now includes the
   verb "review"; the live runs used the explicit Task kind.
2. **Commit subject (open):** the plane goal is the whole context@1 prompt, so `commitSubject()`
   takes its first line: `nexar: Session policy: mode=code; lane=code; project=…`. The commit is
   correct; the subject should come from the owner's request.
3. **Not exercised live:** DSH (no DeepSeek key, paid opt-in), Codex (sign-in not completed), review
   diversity across different resources (Claude Code reviewed its own change, allowed by
   `reviewDiversity: preferred`).
