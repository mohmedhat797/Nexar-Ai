# DSH 0.2.2-alpha.2 Node prerequisite readiness

Research-only future candidate; **no alpha package installed, enabled or deployed**. Nexar's managed package and overrides/lock stay at **0.2.1-rc.5**.

Official tag `dsh-v0.2.2-alpha.2` resolves to `f3803c96974ad4a94195fb97e5c637e9c2a3afe3`. Its [source package.json](https://github.com/deepseek-ai/deepseek-harness/blob/f3803c96974ad4a94195fb97e5c637e9c2a3afe3/package.json) declares Node `>=24.9.0` and **pnpm 11.28.5** for upstream source development. The [published runtime metadata](https://registry.npmjs.org/@deepseek-ai%2Fdsh/0.2.2-alpha.2) independently declares Node `>=24.9.0`. It does not require Nexar to adopt the source workspace's pnpm.

Selected development Node 24.22.2 and the expected Electron embedded Node 24.22.1 satisfy that engine prerequisite. Actual current-runtime acceptance is separate. Nexar retains pnpm 10.33.0 because its own frozen install/build/tests work and runtime installation uses the existing npm-based managed installer.

The future package moves its Cordis family to alpha versions and adds/changes bundles, including CUA/official bundles and experimental integrations. ACP and SDK entry packages remain distinct. Metadata existence is not wire/session/tool/credential compatibility. Native optional dependencies, plugin lifecycle, model adapters, subprocess/home behavior, WSL/bubblewrap and security corrections require source and actual artifact evaluation in a separate upgrade assignment.

Future gates: exact source/artifact and complete transitive lock identity; engine/native prerequisites; ACP protocol and SDK contract replay; credential-resolution and API-key-substitution regressions; per-turn homes and session boundaries; tool/permission/cancellation provenance; synthetic models; Windows source and packaged E2E; WSL isolation; independent review; owner approval. No new Resource Controller, native takeover, experimental plugin activation or session persistence follows from this report.

Verdict is **Node prerequisite only**, to be finalized against the actual installed Node/runtime evidence. Full alpha compatibility remains **UNVERIFIED** and alpha deployment unauthorized.
