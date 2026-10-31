# NXR-070B′ — Shared Acceptance Infrastructure Backport

Date: 2026-10-24. Engineer: OpenAI Codex.

The callback response-completion correction introduced a new B′ production revision. Combined C′ acceptance exercises its exact code, but does not replace a standalone, source-bound B′ Windows acceptance run. B′ therefore receives the shared test/CI infrastructure already validated on C′ commit `1c584208c8580ef3d9ba94e510fb30c58d88796d`.

The eleven ported files are byte-identical Git blobs to that C′ revision. They cover isolated connection workflows; owned-process exit/cleanup; native-state test diagnostics and stale-marker coverage with the fresh-root case first; clean commit/tree identity; and source/packaged suite and packaging envelopes. Existing assertions, individual case deadlines, the production ACL guard and mandatory stages are preserved.

No C′ review-diversity feature is copied into B′. Connection authority, credentials, routing policy, canonical sessions, Project Memory, DSH0.2.0-rc.2 and Windows/WSL security boundaries are unchanged by this backport. The B′ production callback fix remains separately identified in its correction report.

The historical native ACL failure's underlying cause is still unproven. Better diagnostics and later passes are not root-cause closure. The prior package timeout remains failed evidence; its larger outer envelope does not suppress package identity or E2E checks.

Standalone B′ source identities, commands, raw report hashes, platform results and limitations are recorded in the combined B′/C′ stabilization and owner-handover reports on [PR45](https://github.com/mohmedhat797/Nexar-Ai/pull/45). This description is not an acceptance verdict. Both PRs remain Draft pending independent owner review; no merge or history rewrite is authorized.
