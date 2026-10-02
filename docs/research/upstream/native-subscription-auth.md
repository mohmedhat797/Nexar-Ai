# Native subscription authentication — 2026-10-03

NXR-052d uses vendor-owned authentication. Nexar reads no credential files, cookies, tokens or
vendor keyrings. A connected row establishes native account authentication, not plan entitlement,
credits or generation permissions. It supplies no credential to pi-ai, DSH or OpenWorker APIs.

| Runtime | Version evidence | Login | Non-generating status | Logout, owner terminal only |
| --- | --- | --- | --- | --- |
| Claude Code | Installed executable public VersionInfo: 2.1.287.0; repository tested 2.1.287; npm latest inspected 2.1.288 | `claude auth login` | `claude --version`, `claude auth status` | `claude auth logout` |
| Codex | Repository tested 0.159.3; current npm/tag inspected 0.160.0; installed executable VersionInfo has no semantic version | `codex login` | `codex --version`, `codex login status` | `codex logout` |
| Google Antigravity | Repository tested 1.2.14; installed executable VersionInfo has no semantic version; upstream changelog version differs | Interactive `agy` supports vendor sign-in; no standalone login command verified | `agy --version` only; no standalone account-status command verified | Interactive `/logout`; no standalone logout verified |

Installed CLI execution was rejected by automatic command review during development. Public executable
metadata and official documentation were inspected instead; the Codex and Antigravity installed
semantic versions remain unverified. Repository tested versions are compatibility evidence, not
claims about this owner's current installation. Production rechecks `--version` through the bounded
runtime port. There were no live authentication attempts.

Claude status is JSON: only `loggedIn: true` with `authMethod: "claude.ai"` and exit 0 means connected.
Explicit `none`/logged-out is not connected; `api_key` and `api_key_helper` are API authentication,
not subscription connection. Injected OAuth tokens and third-party methods remain unknown. Account
identifiers, other JSON fields and diagnostics are discarded. Codex status writes to stderr;
only the exact successful `Logged in using ChatGPT` message means connected. API-key authentication
is distinct; unknown enterprise/auth modes fail closed. An unsuccessful/malformed status result is
unknown rather than a fabricated logged-out result.

Claude and Codex default login commands own the browser interaction and callback. Nexar passes no
API-key/injected-token/session environment, never captures login output and never parses or displays
auth URLs or codes. The child receives null stdio. Windows requests a visible detached console, but
null stdio does **not** create an interactive terminal. POSIX does not acquire a terminal through
detachment. Browser callback flows are supported; browser launch, remote/SSH/WSL manual callbacks,
terminal prompts and device-code entry need owner acceptance. Complete those flows in the vendor's
own terminal and choose Recheck. `--device-auth`, `--console` and undocumented flags are not selected.

Each status command has a ten-second deadline and a combined 16 KiB output cap. Login has a
five-minute deadline and owner cancellation. Exit 0 is followed by a fresh account probe and does
not itself establish connected status. Cancellation terminates the live process tree; an exited
Windows leader's surviving descendants remain the existing Job Object limitation. Nexar creates no
network listener; any OAuth callback listener belongs to the vendor CLI.

Ports use an explicitly resolved executable from absolute PATH entries, fixed argv, `shell: false`,
public OS/browser environment and the owner's home as cwd. Valid absolute `CODEX_HOME` and
`CLAUDE_CONFIG_DIR` are retained as vendor-managed location overrides. These rows describe the
default native CLI profile selected by that environment; separately configured Nexar resources with
different binaries or auth homes require their own resource probe. Nexar does not rewrite resource
credentials or configuration on native sign-in. CLI discovery remains governed by owner config.

Antigravity exposes an interactive flow, so its row remains unknown (or unavailable if absent),
with Sign in disabled. `agy models` can describe metadata but does not establish subscription
authentication or entitlement. Gemini CLI is a different runtime and is not substituted silently.

Primary sources inspected:

- [Claude CLI reference](https://code.claude.com/docs/en/cli-reference) and
  [authentication](https://code.claude.com/docs/en/authentication).
- [Claude npm package metadata](https://registry.npmjs.org/@anthropic-ai/claude-code/latest).
- [Codex authentication](https://learn.chatgpt.com/docs/auth),
  [developer commands](https://learn.chatgpt.com/docs/developer-commands?surface=cli),
  [tagged login implementation](https://raw.githubusercontent.com/openai/codex/rust-v0.160.0/codex-rs/cli/src/login.rs)
  and [npm metadata](https://registry.npmjs.org/@openai/codex/latest).
- [Antigravity installation](https://www.antigravity.google/docs/cli/install/),
  [CLI reference](https://www.antigravity.google/docs/cli/reference/) and
  [changelog](https://www.antigravity.google/docs/changelog/).
- [Node detached child processes](https://nodejs.org/api/child_process.html#optionsdetached) and
  [Windows null-stdio implementation](https://raw.githubusercontent.com/libuv/libuv/v1.x/src/win/process-stdio.c).
