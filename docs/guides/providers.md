# Desktop Providers

Settings → Providers separates **Subscription**, **API Key** and **Local / Custom** connections.
Claude Code and Codex offer **Sign in**, **Recheck** and cancellation while sign-in is running.
The vendor CLI owns the browser flow. Nexar discards login output and rechecks native account status
after the command finishes. **Connected** means a recognized vendor account; it does not verify a
paid plan. API-key authentication shows separately and does not count as a subscription connection.
Antigravity has no verified standalone sign-in/status command, so its Sign in control is unavailable.

These rows describe the default CLI profile on Desktop's PATH and public vendor location overrides.
Use the vendor's own terminal if browser callbacks require interactive/manual code entry, then
choose Recheck. Nexar's browser launcher has null stdio and cannot accept terminal prompts. Real
browser sign-in remains owner acceptance; details and version evidence are in the
[authentication research](../research/upstream/native-subscription-auth.md).

Settings → Providers supports encrypted API-key storage for Anthropic, OpenAI, Google / Gemini,
DeepSeek, OpenRouter, Groq, Mistral and xAI. Copy a key, then choose **Save from clipboard** for that
provider. The main process reads the clipboard; the renderer has no key input or clipboard access.
Nexar clears the clipboard after storage only if its text has not changed during the operation.

**Saved** means stored. Model counts describe the discovered static pi-ai catalog, not the key's
model access. Choose **Check key** to request the provider's documented metadata endpoint.
**Metadata access verified** means that endpoint accepted authentication; **Authentication rejected**
means HTTP 401. Restrictions, billing/quota errors, malformed responses and timeouts show
**Check unavailable**. Checks generate no model output and do not establish credits or generation
permissions. Saving/removing a key and restarting Desktop reset the network result to **Not checked**.
Endpoint and security details are in the
[metadata-check research](../research/upstream/provider-key-checks.md).

Saving enables that provider in `discovery.sources.piCatalog.providers` and selects
`discovery.credentialSource: "keystore"` for discovered API resources, including DeepSeek Harness.
Other discovery choices, projects and routing preferences are retained. Configured pi/DeepSeek Harness
API resources with that credential name also switch to a keystore reference. The default for headless configurations
remains `env`. There is no environment fallback from a keystore reference. Owners using environment
keys for other discovered providers should save those keys here before running their resources.

The encrypted file is `<userData>/credentials.json` (`%APPDATA%\Nexar\credentials.json` on Windows).
It contains ciphertext and a four-character suffix, with fixed provider credential names; the config
contains references only. Windows uses Electron `safeStorage` through DPAPI. Linux needs a real
keyring backend: unavailable encryption, missing backend reporting and `basic_text` are refused.
There is no plaintext encryption fallback. A corrupt, linked, oversized or replaced file fails closed.
Do not edit the encrypted file by hand or copy it between machines.

Choose **Remove** to delete the stored credential. References stay explicit, so subsequent requests
need a newly saved key. Removal cannot retract a credential already handed to an in-flight request.
Saving/removing reloads the engine without recreating the conversation service or deciding approvals.
If reloading fails, the config rolls back and the prior engine remains; the encrypted save/removal
may already have completed. Refresh Providers to see the stored state and retry setup after repairing
the config. File writes serialize within the Desktop process; independent Desktop instances writing
the same credential file are outside this guarantee.

Subscriptions remain owned by their native vendor runtimes. Nexar does not extract their tokens for
pi-ai or DeepSeek Harness provider APIs.

**Local / Custom servers** supports owner-listed keyless Ollama and OpenAI-compatible servers.
Choose the server type and public address, then Save server. Edit keeps its server id stable; Remove
deletes only that endpoint. Saving or Refresh models reruns discovery against listed addresses;
there is no host scanning. Ollama takes a server root; compatible servers accept a root or `/v1` API
base (including a tenant prefix). Discovery and generation use the same API base.

Addresses cannot contain credentials, query strings, fragments or control characters. Keyed custom
servers keep their existing explicit resource/config credential path; this form has no key field.
Listed model counts are cached discovery candidates, not authentication or proof that generation
will succeed. A zero count does not establish that the server is offline. Only pi-ai uses these
keyless endpoint candidates; the form does not configure DSH or export vendor subscriptions.
Changes and rediscovery share the config mutation queue; failed reload restores the prior config
and engine, preserving projects, routing, credentials, sessions and approvals.

Tests cover fake encryption, call-time resolution, strict IPC metadata, malformed input, linked and
corrupt state, unavailable backends, concurrent writes, clipboard changes, config rollback and session
and approval preservation. Electron E2E uses an inert sentinel with Windows encryption, offline echo
turns and relaunch; Linux without a secure backend verifies refusal. No real API key is needed.
