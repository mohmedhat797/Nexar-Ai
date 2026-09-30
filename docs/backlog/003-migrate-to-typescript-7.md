# NXR-003: Migrate to TypeScript 7

**Milestone:** v0.1 — Foundation · **Labels:** tooling, tech-debt · **Depends on:** none

## Summary

Move the monorepo from TypeScript 6.x to TypeScript 7 once `typescript-eslint` supports it.

## Problem

[ADR-001](../adr/001-monorepo-strategy.md) pins TypeScript to 6.x: TypeScript 7 is current, but
`typescript-eslint` refuses to load with it, and the repo's lint step is type-aware. Staying behind
accumulates drift and blocks tooling that assumes 7.

## Objective

`pnpm check` is green on TypeScript 7 with no loss of lint strictness, and ADR-001 is amended to record it.

## Scope

- Watch for a `typescript-eslint` release that declares TypeScript 7 in its supported range.
- Bump `typescript` (exact or tilde, matching current pinning style) and `typescript-eslint` together.
- Fix new compile errors, deprecations and changed `tsc -b` behavior across all workspaces.
- Amend ADR-001 (status note + date) and the README/CLAUDE.md mentions of the TypeScript version.

## Out of scope

- Adopting new language features or restructuring project references.
- Changing the lint rule set beyond what the upgrade forces.
- Replacing `tsc` with a bundler (rejected in ADR-001).

## Technical notes

- Files: root `package.json`, root `tsconfig.json`, per-package `tsconfig.json`, ESLint config.
- Gate: `pnpm check` = format:check → lint → typecheck → test → build; all stages must pass.
- Do not disable type-aware lint rules or use `--force`/peer-dependency overrides to make it load; that
  defeats the reason for waiting.
- Check that Vitest and any other tool reading TypeScript (aliases, transformers) still work; verify
  against each tool's release notes.
- Node floor stays ≥ 22.19 unless TypeScript 7 requires otherwise (verify against upstream).

## Acceptance criteria

- [ ] `typescript-eslint` release supporting TypeScript 7 is identified and linked in the PR.
- [ ] `pnpm install && pnpm check` passes on a clean checkout with TypeScript 7.
- [ ] No lint rule was disabled or downgraded solely to get the upgrade through.
- [ ] Emitted output of `pnpm build` runs: `node apps/cli/dist/main.js doctor` succeeds.
- [ ] ADR-001 is amended to reflect the new version and the pin rationale is updated.

## Testing expectations

No new tests are needed beyond the existing suite, which must pass unchanged. If an upgrade forces a
test change, explain it in the PR. CI stays offline.

## Security considerations

None beyond the standard rules in CLAUDE.md. Review the lockfile diff for unexpected new
transitive packages.
