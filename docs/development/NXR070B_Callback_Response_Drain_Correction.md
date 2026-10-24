# NXR-070B′ — Callback Response Completion Correction

Date: 2026-10-24. Engineer: OpenAI Codex.

## Problem and correction

The sign-in callback server published its validated outcome immediately after calling `response.end()`. Its child process exits after forwarding that outcome to stdout. Stdout completion did not establish that the HTTP response had finished, so child exit could race pending HTTP writes.

`integrations/openai-account/src/callback-server.ts` now reserves the first validated callback synchronously, then publishes its outcome on that response's `finish` event. A concurrent callback cannot replace the reserved identity while the first response drains. A response closed before finishing publishes no authorization outcome. Existing child lifetime and cancellation bounds remain in force.

The guarantee is that HTTP data was handed to the operating system before outcome publication; it is not proof that the browser received it. Host, method, path, state, field validation, fixed response bodies and security headers are unchanged. No token, subject or credential is logged or exposed.

## Branch ownership

This is a shared production correction, applied on `feat/nxr-070b-multi-api-connections` from `18c7cd01412a8c2b138ec99baf98751699ae169e`. It must be propagated non-destructively into the stacked C′ branch. It is not buried in C′ test infrastructure. Both PRs remain Draft; no merge into main is authorized.

## Deterministic regression evidence

The tests hold the actual HTTP response's `end` behind an explicit barrier. They require no published outcome until response completion, preserve first-callback reservation during a competing request, and verify fail-closed behavior when the held response is destroyed.

- RED before the production fix: three newly added barrier assertions failed, six existing tests passed. Log: `.nexar/ci/bc-callback-drain-red.log`; SHA256 `0f363673215e5d1372063124e3d7773882c24613f8f72cb2bc97add120e45996`.
- Final focused GREEN: callback server, real callback supervisor and B′ Plan-binding suites: **31 passed, zero failed/skipped/pending**. Raw report: `.nexar/ci/bc-callback-drain-final.json`; SHA256 `7ca4401575f8b0e3a01532697c5e948bbd816cce80b77b737551ae7eb0cf10f4`.
- Command: `pnpm exec vitest run integrations/openai-account/src/callback-server.test.ts apps/desktop/src/main/signin-callback-child.test.ts apps/desktop/src/main/plan-binding.test.ts --maxWorkers=1 --reporter=json --outputFile=.nexar/ci/bc-callback-drain-final.json`.
- Environment: Windows 11 build26300, Node22.23.3, pnpm10.33.0; synthetic identity provider, disposable state and encryption only. No live sign-in or paid inference.

A separate read-only source reviewer confirmed preserved guards, single-outcome reservation and fail-closed cancellation semantics. This is not independent owner acceptance.

The complete B′ `pnpm check` then passed formatting, lint, boundaries, type checking, tests and production build: **4,471 passed, 167 skipped, four pending, zero failed**; test duration229.35s. Log: `.nexar/ci/bc-b-pnpm-check-callback.log`, SHA256 `72ba7d7eca100eb12fbb90e27801dafaa10ef1e9e89e7d1aadb59ff8654be595`. These were pre-commit working-source checks; final clean-source platform evidence must identify its separate commit/tree.

## Limits and follow-up

A C′ offline run separately failed during Plan `connect()` before its expired-token assertions. Its public error did not retain transport-phase evidence. The ordering defect above is established by deterministic regression, but attribution of that particular failure remains unproven. Failure-only tracing on C′ records fixed phases and sanitized error codes without account data.

The original native ACL failure also remains unexplained. This correction does not claim to close it. Complete source-bound Windows/WSL and packaged acceptance are recorded in the combined B′/C′ stabilization reports; focused tests alone are not platform acceptance.
