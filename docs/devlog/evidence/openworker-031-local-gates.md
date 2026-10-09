# OpenWorker 0.3.1 compatibility gates (2026-10-07)

Bounded maintenance after `c68c7bd`, on `feat/nexar-resource-orchestration`, draft PR #39.
[Source review](../../research/upstream/openworker-0.3.1-compatibility.md) preceded code changes.
This record documents the commands and evidence boundary; final new-head gate results, full SHA,
CI run and actual Windows/plane preparation receipts are recorded in the final handoff.
No prior head's CI substitutes for this maintenance head.

## Local gates

Use Node **22.23.3**, pnpm **10.33.0**, live tests disabled:

```powershell
npx --yes --package=node@22.23.3 --package=pnpm@10.33.0 -- pnpm exec vitest run integrations/openworker apps/desktop/src/main/cowork.test.ts
npx --yes --package=node@22.23.3 --package=pnpm@10.33.0 -- pnpm check
npx --yes --package=node@22.23.3 --package=pnpm@10.33.0 -- pnpm desktop:e2e
npx --yes --package=node@22.23.3 --package=pnpm@10.33.0 -- pnpm desktop:package:win
$env:NEXAR_DESKTOP_EXECUTABLE = 'D:\Nexar-Ai-main\release\desktop\win-unpacked\Nexar.exe'
npx --yes --package=node@22.23.3 --package=pnpm@10.33.0 -- pnpm desktop:e2e
Remove-Item Env:NEXAR_DESKTOP_EXECUTABLE
```

Run redacted pinned Gitleaks 8.28.0 history/staged scans and inspect the diff. CI uses only local
fake OpenWorker/provider fixtures; it neither installs nor executes the real runtime. Full CI must
pass Ubuntu, Windows and secret scan, source E2E, Windows package, packaged E2E and artifact upload
on the exact pushed head before environment preparation. Record failures honestly and investigate
within this maintenance scope.

## Pre-commit results

On 2026-10-07, focused integration/Desktop Cowork tests **257/257 passed** across 8 files;
full `pnpm check` **passed**, **3,977 tests passed / 158 skipped** across 195 passed / 16 skipped
test files (Windows lacks bubblewrap; live tests remain disabled). Source Desktop E2E
**22/22 passed**; Windows installer/SHA256 build **passed**; packaged Desktop E2E **22/22 passed**.
Explicit documentation formatting, command syntax, local links and `git diff --check` passed.
Redacted Gitleaks history scan passed (223 commits); staged scan is required before commit.

An initial lint run included the ignored research checkout; it was relocated beneath an existing
`dist` exclusion and the full gate rerun passed, without changing gate configuration. An initial
focused run exposed the Desktop shared fixture's old version; it was aligned with 0.3.1 and the
complete focused run passed. No live runtime/provider was used for these gates.

## Contract coverage

- Version range `>=0.3.1 <0.4.0`: 0.2.9 / 0.3.0 / 0.4.0 / 1.0.0 refused before server spawn;
  0.3.1 / 0.3.2 / 0.3.9 accepted. Malformed, prerelease, trailing text and noncanonical numeric
  output fail closed. Official CLI's canonical version output remains supported.
- Public health is distinct from token-authenticated provider/MCP/root mutations and session WS.
  Token travels in the header / WS subprotocol, not URL or argv. Existing environment/token
  secrecy, provider profile removal and loopback-only gateway tests remain.
- MCP/root HTTP-200 refusal and malformed success responses reject with a fixed public error;
  a refused read-only root never opens the session or sends a model turn.
- Ready's added sandbox metadata remains compatible with `{type,data}` events. The new network
  approval tool is denied; host arguments never enter public progress. Existing turn completion,
  cancellation, policy, bridge relay/delegation and recursion regressions remain exercised.

## Owner boundary

After exact-head CI, install a **separate** official-source-pinned 0.3.1 runtime, preserve 0.3.0,
verify version/help and supervised private health, rebuild matching Desktop/plane and use an
isolated Desktop profile. Preserve plane config, root-owned launcher, validation repository,
credential mounts and hardening. **No owner profile launch, provider login/catalog refresh,
native SDK metadata initialization, headless task, SOW/Code or inference** is part of these gates.
NXR-066b live acceptance remains pending; see the [owner runbook](nxr-066-live-acceptance-runbook.md).
