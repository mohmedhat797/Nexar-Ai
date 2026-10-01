# Upstream research: official TypeScript MCP SDK

| Field | Value |
| --- | --- |
| Source | https://github.com/modelcontextprotocol/typescript-sdk (npm: `@modelcontextprotocol/server`, `@modelcontextprotocol/client`, legacy `@modelcontextprotocol/sdk`) |
| Version inspected | `@modelcontextprotocol/server@2.2.0` + `@modelcontextprotocol/client@2.2.0` (git tag `v2.2.0`, `dd22ba25ddbe7cd8822e1fe9c738a974996a28f6`, 2026-09-28); `main` HEAD `433eb413dc305ebeb93b8ebcde0095a8fc0d5fa0` (2026-09-30) |
| Inspected | 2026-09-30 (npm registry, cloned repo, installed and executed in a scratch dir) |
| Verdict | **Use v2 split packages.** Exact-pin `@modelcontextprotocol/server@2.2.0` (+ `client@2.2.0` as a devDependency for tests). |

## 1. Which package is current

- Two lines are published **in parallel, both maintained, neither deprecated on npm**:
  - **v2 (stable line, "released alongside the 2026-07-28 spec")**: `@modelcontextprotocol/server` and `@modelcontextprotocol/client`, both `latest = 2.2.0` (`main` README: "v2 is the stable release line"; `README.md` top banner).
  - **v1 (maintenance)**: `@modelcontextprotocol/sdk`, `latest = 1.31.0` (2026-09-28). Repo README: v1.x "continues to receive bug fixes and security updates for at least 6 months after v2's release" (v2.0.0 = 2026-07-27, so v1 support is promised to about 2027-01-27 at minimum). Branch `v1.x` exists.
- Only `@modelcontextprotocol/server-legacy@2.2.0` carries an npm `deprecated` flag (frozen v1 SSE transport and OAuth AS helpers, "planned for removal in v3"). Nexar does not need it.
- Maintainers (npm): `jspahrsummers`, `pcarleton`, `fweinberger`, `thedsp`, `ochafik-ant`, `cliffhall`; package author "Anthropic, PBC"; GitHub org `modelcontextprotocol`.
- Group versioning: `core`, `client`, `server`, `server-legacy`, `codemod` release as one fixed-version group (`VERSIONING.md`). `@modelcontextprotocol/core` is pulled in automatically as a dependency (do not import it directly).

## 2. Metadata

| | `@modelcontextprotocol/server` 2.2.0 | `@modelcontextprotocol/sdk` 1.31.0 |
| --- | --- | --- |
| Published | 2026-09-28T19:09Z | 2026-09-28T18:59Z |
| License (npm tarball) | MIT | MIT |
| License (repo `main`) | Apache-2.0 in `package.json`; `LICENSE` describes an MIT to Apache-2.0 transition | n/a |
| Node engines | `>=20` (client too) | `>=18` |
| zod | dependency `zod ^4.2.0` (no peer dep); Nexar's `^4.6.5` dedupes to one copy (verified: `npm ls` shows a single `zod@4.6.5`) | peer + dep `^3.25 \|\| ^4.0` |
| Module format | ESM and CJS dual (`exports` map has `import` and `require`) | ESM and CJS |
| Install footprint | about 18 packages total for server+client+zod | about 163 lines in `npm ls --all` (express, hono, ajv, cors, jose, etc.) |
| Protocol | legacy era `2024-10-07`..`2025-11-25` **and** modern era `2026-07-28` | up to `2025-11-25` only (`LATEST_PROTOCOL_VERSION = '2025-11-25'`, verified in installed `types.js`) |

Release cadence (versions published 2026-07-02 to 2026-09-30, the last 90 days): `server`/`client` 7 (2.0.0-beta.2..beta.5, 2.0.0 on 07-27, 2.1.0 on 09-23, 2.2.0 on 09-28); `sdk` 3 (1.30.0 07-27, 1.30.1 09-23, 1.31.0 09-28). Earlier 2026: 1.26.0 (02-04), 1.27.x (02-16/24), 1.28.0 (03-25), 1.29.0 (03-30), then a 4-month gap to 1.30.0. v2 went alpha (2026-04-01) to GA (2026-07-27) in under four months; two minors since GA in five weeks. Expect continued minor churn; `VERSIONING.md` promises semver, deprecation for at least one minor, and a codemod (`@modelcontextprotocol/codemod`).
Note: 2.2.0 is only 2 days old; 2.1.0 (2026-09-23) is the conservative fallback if Nexar applies a release-age cooldown. Only 2.2.0 was executed here.

**Spec version**: current revision is `2026-07-28` (https://modelcontextprotocol.io/specification/2026-07-28): stateless requests, per-request capability negotiation, no `initialize`, `server/discover` instead, Tasks/Apps/Skills as extensions. The SDK's `docs/protocol-versions.md` calls this the "modern" era and `2024-10-07`..`2025-11-25` the "legacy" era; one `serveStdio` factory serves both. `2025-11-25` is the newest legacy revision.

## 3. Verified runnable example (Node 22.22.2, TS 6.0.3, zod 4.6.5, no network at runtime)

Install: `npm i --save-exact @modelcontextprotocol/server@2.2.0 @modelcontextprotocol/client@2.2.0 zod@4.6.5`. Scratch project: `v2demo/` (server.mjs, test-inmem.mjs, test-stdio.mjs, raw.mjs). `tsc --strict --module NodeNext --noUncheckedIndexedAccess --exactOptionalPropertyTypes --verbatimModuleSyntax` passes on a `.ts` port (needs `"types": ["node"]`, per the package README for TS >= 6).

Server (factory exported for tests; stdio only when run as entrypoint):

```ts
import { McpServer } from '@modelcontextprotocol/server';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import * as z from 'zod/v4';

export function createServer(): McpServer {
  const server = new McpServer({ name: 'nexar', version: '0.2.0' });
  server.registerTool(
    'nexar.route',                                   // dotted names are accepted
    {
      description: 'Explain which resource would execute a task',
      inputSchema: z.object({ task: z.string().min(1), budget: z.number().optional() }),
      outputSchema: z.object({ resource: z.string(), reason: z.string() }),
    },
    async ({ task }) => {
      const out = { resource: 'fake-local', reason: `chose for: ${task}` };
      return { content: [{ type: 'text', text: JSON.stringify(out) }], structuredContent: out };
    },
  );
  return server;
}
// entrypoint: serveStdio(createServer); console.error('listening');   // stderr only
```

In-process test (no sockets, no child process):

```ts
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
const [clientT, serverT] = InMemoryTransport.createLinkedPair();
const server = createServer();
const client = new Client({ name: 't', version: '1' });
await server.connect(serverT);
await client.connect(clientT);
await client.listTools();                                        // { tools: [...] }
await client.callTool({ name: 'nexar.route', arguments: { task: 'hi' } });
await client.close(); await server.close();
```

Real stdio test (spawns the actual binary; this is the path OpenWorker uses):

```ts
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
const t = new StdioClientTransport({ command: process.execPath, args: ['dist/mcp-main.js'], stderr: 'pipe', env: { PATH: process.env.PATH!, NEXAR_CLIENT_TOKEN: 'x' } });
const c = new Client({ name: 'stdio-test', version: '1' });
await c.connect(t);                   // era: c.getProtocolEra() === 'legacy' by default
```

### Verified results (actual output)

- `listTools` returns `inputSchema` as JSON Schema 2020-12 derived from zod (`{"type":"object","properties":{"task":{"type":"string","minLength":1},...},"required":["task"],"$schema":"https://json-schema.org/draft/2020-12/schema"}`) and `outputSchema` (with `additionalProperties:false`). Server capabilities advertise `{"tools":{"listChanged":true}}`.
- Success: `{"content":[{"type":"text","text":"{...}"}],"structuredContent":{"resource":"fake-local","reason":"..."}}`.
- Bad arguments (`task: 5`): **not thrown**; resolves as `{"content":[{"type":"text","text":"Input validation error: Invalid arguments for tool nexar.route: task: Invalid input: expected string, received number"}],"isError":true}`. Validation runs before the handler.
- Handler `throw new Error('kaboom')`: resolves as `{"content":[{"type":"text","text":"kaboom"}],"isError":true}` (message leaks to the model; throw only safe messages). Explicit `return { content, isError: true }` gives the same shape; `outputSchema` validation is skipped on `isError` results (`docs/servers/errors.md`).
- Unknown tool: **throws** `ProtocolError` code `-32602`, `Tool nope not found` (protocol error, not a tool result).
- Schema declaration: `inputSchema`/`outputSchema` take any **Standard Schema** object (zod 4, valibot, arktype). Raw zod shapes (`{ task: z.string() }`, the v1 style) are deprecated and zod 3 values throw at registration. Plain JSON Schema: wrap with `fromJsonSchema<T>(schema)` exported from `@modelcontextprotocol/server` (`docs/advanced/schema-libraries.md`; wrapper signature in `packages/server/src/fromJsonSchema.ts`). Not executed here.
- Import paths that worked: `@modelcontextprotocol/server` (`McpServer`, `ProtocolError`, `ProtocolErrorCode`, `fromJsonSchema`, `createMcpHandler`), `@modelcontextprotocol/server/stdio` (`serveStdio`), `@modelcontextprotocol/client` (`Client`, `InMemoryTransport`, `StreamableHTTPClientTransport`), `@modelcontextprotocol/client/stdio` (`StdioClientTransport`). `zod/v4` or `zod` both fine on zod 4.6.5 (docs use `zod/v4`).
- Negotiation over raw stdio (`raw.mjs`): client `initialize` with 2024-11-05, 2025-03-26, 2025-06-18, 2025-11-25 each echoed back; an unknown future version `2099-01-01` was answered with `2025-11-25`. A modern client (`versionNegotiation: { mode: 'auto' }`) connected to the same stdio server and reported `era modern`. So one v2 server works for both old and new MCP clients. Default `Client` (no options) speaks legacy `initialize`.
- In v1 (1.31.0) the equivalent API is `McpServer.registerTool(name, {inputSchema: <raw shape>}, cb)` + `new StdioServerTransport()` + `server.connect()`, `@modelcontextprotocol/sdk/inMemory.js` `InMemoryTransport.createLinkedPair()`. Verified working with a tiny stdio server+client too, but v1 cannot speak 2026-07-28.

## 4. Does the SDK write to stdout on its own?

- **No.** Empirical: for five `initialize` versions, stdout before any input was empty, and after a full handshake + `tools/call` every stdout line parsed as JSON (2 lines: init result, call result); process exited 0 on stdin EOF. Startup/ready messages are only what our code prints (`console.error` -> stderr).
- Source check: `grep console.log|process.stdout.write` over `server/dist`, `core/dist` finds only JSDoc examples; the only runtime console call in server/core src is `console.warn` (stderr) in `packages/server/src/server/mcp.ts:1400` (invalid `x-mcp-header` schema) and `createMcpHandler.ts:710`.
- Docs warn the other direction: one stray `console.log` in our code corrupts the channel (`docs/serving/stdio.md`, "Log to stderr, never stdout"). Nexar's telemetry already logs to stderr; add a lint/test guard (spawn the real binary, assert every stdout line is JSON-RPC).
- EOF handling: closing stdin tears down the connection; in-flight requests are aborted (`docs/serving/stdio.md`). Release timers/pools on `server.server.onclose` so the process can exit.

## Implications for Nexar v0.2

1. Pin `@modelcontextprotocol/server` **2.2.0** exactly (and `client` 2.2.0 as devDependency for contract tests); `zod` stays `^4.6.5` (single copy, no peer conflict). Node >=22.19 satisfies `>=20`.
2. Put the MCP server in its own package (e.g. `apps/mcp` or `packages/mcp-server`); it is an inbound adapter, not an upstream adapter, but keep `@modelcontextprotocol/*` imports confined to that package so ADR-008 isolation holds and the SDK can be swapped. Export `createServer(deps)` (injectable engine/clock/ids) and a thin `main.ts` calling `serveStdio`.
3. Tests: fast contract tests via `InMemoryTransport.createLinkedPair()` (legacy era); one real-spawn stdio test (`StdioClientTransport`) asserting stdout is JSON-RPC only, and one `mode: 'auto'` test for the modern era. All offline and deterministic.
4. Return both `content` (JSON text) **and** `structuredContent` with an `outputSchema` from zod. `content` text is mandatory for OpenWorker (see `openworker-recheck.md`: it only forwards text blocks). Use `isError: true` for expected domain failures (policy denial, unknown resource) with a `NexarError` code in the text; do not throw internals.
5. Map `NexarError` to tool results in one helper; never put prompts or secrets in error text (CLAUDE.md: do not log prompts at info+).
6. Write an ADR: "MCP SDK = v2 split packages, exact-pinned; v1 `@modelcontextprotocol/sdk` rejected because it stops at protocol 2025-11-25 and pulls express/hono".

## Open questions

- Release churn: two minors in five weeks post-GA. Decide a bump policy (for example, weekly Renovate with a 7-day cooldown, as the SDK itself uses `minimumReleaseAge`).
- Licence: npm tarballs say MIT; `main` says Apache-2.0 (mid-transition). Both permissive; record in `docs/research` and re-check before each bump. UNVERIFIED which licence the next release will carry.
- Modern-era behaviours on stdio (per-request `_meta` envelope, `server/discover`) were only smoke-tested with a trivial tool. Not tested: Tasks extension (may suit long `nexar.submit_work`), elicitation, progress/cancellation against OpenWorker.
- `fromJsonSchema` path is documented but not executed here.
- 2026-07-28 spec deprecates MCP logging (SEP-2577); do not rely on `notifications/message`.

## Sources

- Repo at `v2.2.0`: https://github.com/modelcontextprotocol/typescript-sdk/tree/dd22ba25ddbe7cd8822e1fe9c738a974996a28f6
- README banner + packages: https://github.com/modelcontextprotocol/typescript-sdk/blob/dd22ba25ddbe7cd8822e1fe9c738a974996a28f6/README.md
- Versioning policy: https://github.com/modelcontextprotocol/typescript-sdk/blob/dd22ba25ddbe7cd8822e1fe9c738a974996a28f6/VERSIONING.md
- First server / stdio / testing / errors / tools / protocol versions docs: `.../blob/dd22ba25ddbe7cd8822e1fe9c738a974996a28f6/docs/{get-started/first-server,serving/stdio,testing,servers/errors,servers/tools,protocol-versions}.md`
- Migration from v1: `.../docs/migration/upgrade-to-v2.md`
- npm: https://www.npmjs.com/package/@modelcontextprotocol/server, https://www.npmjs.com/package/@modelcontextprotocol/client, https://www.npmjs.com/package/@modelcontextprotocol/sdk (registry JSON via `curl https://registry.npmjs.org/<pkg>`)
- Spec: https://modelcontextprotocol.io/specification/2026-07-28
- Local evidence (scratchpad `v02-research/`): `v2demo/server.mjs`, `test-inmem.mjs`, `test-stdio.mjs`, `test-auto.mjs`, `raw.mjs`, `v1demo/`
