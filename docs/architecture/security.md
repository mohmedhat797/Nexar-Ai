# Nexar security model and threat assumptions

Nexar will handle source code, client documents, email, calendars, OAuth sessions, API keys, and
subscription logins. Security is an architectural requirement, not a later feature.

## Assets

| Asset                                                 | Where it lives                                   | Nexar's rule                                                                                              |
| ----------------------------------------------------- | ------------------------------------------------ | --------------------------------------------------------------------------------------------------------- |
| Provider API keys                                     | Owner's environment (`.env`, shell, OS keychain) | Referenced by env var _name_ in config; injected only into the runtime that needs it                      |
| Subscription / OAuth sessions (Claude Code, Codex, …) | Each runtime's own credential store              | Never read, copied, or extracted by Nexar; used only through the runtime's supported CLI/SDK              |
| Source code, documents                                | Owner's filesystem                               | Passed to a resource only when the task requires it; `local-only` tasks never reach third-party resources |
| Telemetry, sessions                                   | `.nexar/` (git-ignored), file mode 0600          | Contains prompts' metadata, never credentials                                                             |

## Trust boundaries

1. **Nexar process ↔ external runtimes** (dsh, claude, future codex/agy): separate processes,
   launched with a scrubbed, explicit environment and an isolated state directory. Runtime output is
   untrusted input to Nexar.
2. **Nexar ↔ model providers**: third-party data processors. Routing respects
   `requirements.privacy = 'local-only'` by rejecting resources whose `dataLocality` is
   `third-party`.
3. **OpenWorker ↔ Nexar** (v0.2): OpenWorker is a separate application; requests arriving over the
   Work Bridge are authenticated and treated as untrusted task input.
4. **Repository ↔ local machine**: nothing machine-specific (tokens, session DBs, `.nexar/`, `.env`)
   is ever committed. CI scans for secrets.

## Threat assumptions (v0.1)

- The owner's machine and OS account are trusted. Nexar does not defend against a compromised host.
- Model output and agent actions are **not** trusted: agents can be prompt-injected by repository
  content, documents, or email. Mitigations: least-privilege tool surfaces per adapter, read-only
  modes where available, future human approval for destructive actions, and audit records.
- Upstream runtimes are fast-moving pre-1.0 projects (DeepSeek Harness declares "no security
  audit"). Mitigations: exact version pins, isolation via subprocesses, contract tests, deliberate
  upgrades.
- Third-party telemetry in upstream runtimes is disabled where documented (e.g. DSH
  `session-log-deepseek` upload).

## Mandatory rules

- No credential, token, cookie, or session database is committed. `.env.example` only.
- Config schema rejects inline secrets: credentials are `{ source: 'env', name }` or
  `{ source: 'runtime-managed' }`.
- Logs pass through key-based redaction (`api_key`, `token`, `secret`, `password`,
  `authorization`, `cookie`, `credential`).
- Adapters must not log prompts at `info` level or above (prompts may contain client data).
- Probes are side-effect free and never make paid calls.
- Live/paid tests are opt-in (`NEXAR_LIVE_TESTS=1`) and never run in CI.
- Destructive or outward-facing actions (sending email, pushing code, deleting files) will require
  explicit human approval once Nexar performs them (v0.2+). v0.1 performs none.

## Known gaps (tracked in the backlog)

- No OS-level sandbox around agent runtimes yet (relies on each runtime's own permission model).
- No authenticated local API yet (none exists to authenticate in v0.1).
- No encryption at rest for `.nexar/` telemetry.
