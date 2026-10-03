# Provider metadata checks

Verified against official documentation on 2026-10-02 for NXR-052c. The pi integration owns
these fixed endpoints; Desktop main resolves one stored key per explicit check. No generation,
request body, query-string credential, retries or pagination is used.

| Provider | GET URL | Authentication | Official source |
| --- | --- | --- | --- |
| Anthropic | `https://api.anthropic.com/v1/models` | `x-api-key`, `anthropic-version: 2023-06-01` | [Models](https://platform.claude.com/docs/en/api/models/list) |
| OpenAI | `https://api.openai.com/v1/models` | Bearer | [List models](https://developers.openai.com/api/reference/resources/models/methods/list) |
| Google | `https://generativelanguage.googleapis.com/v1beta/models` | `x-goog-api-key` | [Models](https://ai.google.dev/api/models), [header authentication](https://ai.google.dev/gemini-api/docs/api-key) |
| DeepSeek | `https://api.deepseek.com/models` | Bearer | [List models](https://api-docs.deepseek.com/api/list-models/) |
| OpenRouter | `https://openrouter.ai/api/v1/key` | Bearer | [Current key](https://openrouter.ai/docs/api/api-reference/api-keys/get-current-api-key) |
| Groq | `https://api.groq.com/openai/v1/models` | Bearer | [API reference](https://console.groq.com/docs/api-reference) |
| Mistral | `https://api.mistral.ai/v1/models` | Bearer | [Models](https://docs.mistral.ai/api/endpoint/models) |
| xAI | `https://api.x.ai/v1/models` | Bearer | [Models](https://docs.x.ai/developers/rest-api-reference/inference/models) |

OpenRouter uses authenticated key information because a public catalog alone cannot establish
credential authentication. Returned usage, labels, model IDs and raw errors are discarded.

`valid` means HTTP 200 with the expected metadata shape; it does not prove credits, model
generation rights or pricing. `invalid` means the endpoint rejected authentication with HTTP 401.
Other errors, permissions restrictions (including HTTP 403), billing/quota failures, malformed
responses and timeouts return `unavailable`. Unsupported providers and missing/locally invalid
keys return `unchecked` without an HTTP request. No claim of unrestricted or free future generation
is made. See [OpenAI error codes](https://developers.openai.com/api/docs/guides/error-codes) and
[DeepSeek error codes](https://api-docs.deepseek.com/quick_start/error_codes/).

Requests reject redirects and use a five-second deadline spanning headers and body. Tests can
shorten the deadline; it never exceeds ten seconds. UTF-8 JSON is capped at 64 KiB of actual stream
bytes as well as declared length. One bounded first page is inspected; its count is separate from
the Desktop static discovery model count. All network tests use loopback HTTP fixtures through a
transport seam; production exposes no endpoint override. Live provider credentials remain untested.
