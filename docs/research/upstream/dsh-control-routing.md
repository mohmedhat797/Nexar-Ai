# DSH control routing spike (NXR-064)

| Field            | Value                                                                                         |
| ---------------- | --------------------------------------------------------------------------------------------- |
| Date             | 2026-10-04                                                                                    |
| Upstream         | [deepseek-ai/deepseek-harness](https://github.com/deepseek-ai/deepseek-harness)               |
| Inspected commit | `639ed015397290b3745d163aafe02ffee4aa3f84` (`dsh-v0.2.0-rc.2`, the version Nexar pins)        |
| Method           | Source reading (sparse checkout); no live DSH run. Claims not confirmed in source are marked. |

Question: can a Code lane's DSH run its agent loop on a Nexar-chosen resource (the plane's Control
Model Gateway) and delegate units to Nexar, without `DEEPSEEK_API_KEY` and without weakening the
sandbox? Decision: [ADR-027 §9b](../../adr/027-resource-orchestration-architecture.md).

## 1. Control loop → an OpenAI-compatible base URL

- `packages/llm/llm-pi-ai/src/config.ts` (`PiAiProviderProfile`): a route key need not name an
  installed pi-ai provider; then the profile is the whole declaration. Fields used: `api` (wire
  protocol; required for a non-catalog route), `baseURL`, `models` (explicit list; each entry needs
  only `id`), `apiKeyEnv` (credential reference resolved per request). Unset model sizes default to
  262,144 context / 32,768 output; input modalities default to text only.
- `provider.ts`: `openai-completions` is a supported protocol (`supportedProtocols()`).
- So a route `nexar` with `api: openai-completions`, `baseURL: http://127.0.0.1:<port>/v1`,
  `models: [{ id: nexar-control }]`, `apiKeyEnv: NEXAR_CONTROL_TOKEN` is a complete declaration,
  rendered by Nexar's existing patch overlay (`integrations/deepseek-harness/src/overlay.ts`). The
  bearer the route sends is the lane's grant token; the translator forwards it as the bridge token
  (same as Cowork, NXR-063).
- Request shape: pi-ai's `openai-completions` client streams (`stream: true`); the 063a translator
  answers SSE. Extra request fields (`tool_choice`, `strict`, `store`, `stream_options`) are ignored
  by the translator; image parts are refused (400), consistent with the text-only default.
  UNVERIFIED until the 064 E2E: pi-ai's acceptance of one tool-call delta carrying complete
  `arguments`.

## 2. Network inside the sandbox

- Code lanes run with network mode `proxy`: the launcher sets `HTTP(S)_PROXY` to the in-sandbox
  socat bridge and `NODE_USE_ENV_PROXY=1`, and strips any caller `NO_PROXY`
  (`packages/sandbox/src/launcher.ts`). Node's env proxy would therefore send
  `http://127.0.0.1:<port>` to the egress proxy, which allows only allowlisted CONNECT targets and
  denies it. The launcher must set `NO_PROXY=127.0.0.1` exactly when the gateway service is mounted.
- DSH sets no global dispatcher of its own in `llm-pi-ai` (no proxy/dispatcher code in the package);
  a repository-wide search was not completed (UNVERIFIED), so the 064 E2E must exercise the path.
- The proxy pattern already relays a host unix socket (`proxy.sock` in the per-launch run dir) to a
  loopback TCP port inside the network namespace with socat (`profile.ts`). The gateway reuses it:
  `gateway.sock` → `127.0.0.1:<in-sandbox port>`. The translator's Host-header guard must accept that
  in-sandbox port (the server itself listens on a unix socket).

## 3. Units → the Intelligence Bridge (ACP vs MCP config)

- `packages/acp/acp/README.md`: `session/new` accepts stdio (and Streamable HTTP) MCP servers,
  validated before the session is published; stdio entries authorize their absolute command and
  environment. Tools surface as `mcp__<server>__<tool>`; MCP tools only (no resources/prompts).
- Nexar's lane already drives DSH over ACP (`integrations/deepseek-harness/src/acp/run.ts` sends
  `session/new` with `mcpServers: []`). Mounting the relay there is per session, needs no patch row,
  and ends with the session. Chosen over a patch-overlay MCP row.
- The model selection is pinned per prompt turn (README: "A prompt snapshots that selection … and
  pins it across every model step in that turn"), matching ADR-027 §8 (never switch mid-loop).

## 4. What remains a resource question, not a transport one

Plane `model-turn` resources are pi catalog models with plane API keys and owner-declared local
endpoints with `toolCalling`. Subscription CLIs (Claude Code, Codex) are native agents and are not
control resources; with none configured, Code lanes keep the native executor (NXR-055 path,
recorded `executor: native`) until NXR-067's experimental subscription model adapters.
