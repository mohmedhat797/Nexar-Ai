# Nexar workspace management

`D:\Nexar-Ai-main` is the canonical repository and checkout of accepted `main`.
Use `git fetch origin` and fast-forward-only updates after checking status and preserving
local branches. Never merge a feature PR to perform maintenance.

## Development worktrees

- Inspect from the canonical checkout. Reuse a matching worktree when safe.
- Create a worktree only when branch isolation is needed. Concurrent agents need separate
  mutable checkouts.
- Use `.nexar/worktrees/<milestone-or-purpose>` for new worktrees and meaningful branch
  names. Maintenance branches use `codex/`. `.nexar/` must remain ignored by Git,
  formatters, linters, test discovery, and package traversal.
- Verify Windows path lengths and all ignore rules before creating deeply nested paths.
  Document a technical exception before using a dedicated sibling worktree directory.
- Existing worktrees may remain at their registered locations when agent sessions,
  junctions, WSL mappings, or absolute paths make relocation unsafe. Do not copy a
  worktree and delete its original. Use `git worktree move` only after consumer checks.
- Avoid duplicate full clones and new top-level `Nexar-*` folders.

## Retirement

Retirement requires a fresh filesystem and Git audit. Verify exact paths, registered
worktrees, open PRs, source revision reachability, unpublished commits, tracked changes,
untracked and ignored files, locks, process references, and inbound dependency links.
Keep every branch and detached commit reachable. A merged PR alone is insufficient proof.

Preserve unknown files. Protect credentials, native account homes, canonical sessions,
Project Memory, settings, owner decisions, and raw acceptance evidence. Do not read secret
contents to perform an audit. Keep metadata and manifests private under
`.nexar/workspace-maintenance/`; never include them in public history.

For retained evidence, record its original path, source association, purpose, and SHA-256.
A worktree HEAD identifies the associated checkout, not automatically the revision tested
by every historical log. Use an artifact's existing provenance for the tested revision.
When copying evidence, verify bytes before removing the original. Preserve installers and
pinned runtime/toolchain binaries until their acceptance and offline requirements are resolved.

## Cleanup utility

`scripts/maintenance/Invoke-NexarWorkspaceCleanup.ps1` supports:

| Mode   | Effect |
| ------ | ------ |
| Audit  | Read-only registered-worktree inventory |
| DryRun | Writes a private SHA/path/revision-bound manifest for an exact allowlist |
| Apply  | Requires the reviewed manifest SHA-256 and revalidates all preconditions |
| Verify | Checks Git connectivity and registered-worktree metadata |

The utility intentionally supports only the exact, audited retirement registry in its
source. Extend that registry through code review after auditing a new candidate. It
refuses unknown ignored files, dirty/untracked work, unpublished commits, open PRs,
locks, process references, inbound dependency links, path aliases, linked ancestors,
stale manifests, changed contents, and changed PR/link state. It uses Git's normal
worktree removal and never force-removes a checkout.

Generated dependencies/build files are removed only from fully retired, verified
worktrees. Links are unlinked as leaves; their targets are never recursively traversed.
An exact pnpm v10 project-registration junction may be unlinked when it points directly
to the retired checkout. Package-store contents remain untouched. Successful repeated
Apply returns without changes; a partial failure requires inspection of its receipt.

Run these commands from the checkout containing the reviewed utility:

```powershell
$cleanup = '.\scripts\maintenance\Invoke-NexarWorkspaceCleanup.ps1'
& $cleanup -Mode Audit
# Supply only audited registry paths; review the resulting private manifest.
& $cleanup -Mode DryRun -Allowlist $auditedPaths -ManifestPath $manifest
& $cleanup -Mode Apply -ManifestPath $manifest -ManifestSha256 $reviewedSha256
& $cleanup -Mode Verify
```

Audit and Verify do not retire worktrees. Apply checks live open PRs through the supported,
authenticated GitHub CLI and fails closed if that lookup is unavailable. It cannot prove
that an idle external agent has no hidden dependency; resolve such uncertainty before
adding a path to the retirement registry.

## Builds, dependencies, and toolchains

Keep active workspace dependencies and global package caches available for offline work.
Do not prune the pnpm store indiscriminately. Identify hard links, junctions, installed
versions, and every shared consumer before reclaiming packages or moving tools. Never
upgrade dependencies during maintenance. Use the repository package-manager pin and
lockfile if a verified relocation requires repair.

Clean reproducible build output only when it is not runtime data, a fixture, required
acceptance evidence, or an active process input. Run `pnpm check` after changes. If legacy
agent checkouts are traversed by a tool, report the aggregate failure and the exact
exclusion used for any supplemental gate; do not silently change accepted source or
claim complete Windows acceptance.

## Monitoring and handover

At each milestone closure, review `git worktree list --porcelain`, current open PRs,
disk free space, dependency installations, and local evidence. Record exact retained and
removed paths and the cleanup manifest hash. Folder logical sizes are estimates:
hard links and pnpm sharing make drive free-space deltas the authoritative observed
capacity change. Other concurrent disk activity can affect that delta.
