import { spawn as nodeSpawn } from 'node:child_process';
import type { ChildProcess, SpawnOptions } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:http';
import type { Server, ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { NexarError } from '@nexar/contracts';
import { COWORK_PROFILE } from '../profiles.js';
import { dshLaunchFor } from '../runtime/resolve.js';
import type { DshLaunch } from '../runtime/resolve.js';
import { makeLogger, makeTempDir } from '../test/support.js';
import { runLocalAcpSession } from './local.js';
import type { LocalAcpEvent } from './local.js';

// Opt-in: runs the REAL pinned `dsh --profile acp` through Nexar's own ACP path and records the raw
// bytes of the child's pipes. The "model" is a fake server on loopback: no credentials, no network.
const ENTRY = process.env.NEXAR_DSH_ENTRY;
const TOKEN = 'acp-stdout-fixture-token';
const FOREIGN_TOKEN = 'acp-stdout-foreign-token';
const INITIALIZE_TIMEOUT_MS = 90_000;
const TEST_TIMEOUT_MS = 180_000;
const REASONING = 'REASONING-TEXT-MARKER';
const SIGNED_REASONING = `<signature>SIGNATURE-MARKER</signature>\n${REASONING}`;

// Advertises only the tools capability, which is what made rc.3's SDK write to stdout.
const TOOLS_ONLY_MCP_SERVER = `
import { createInterface } from 'node:readline';
const send = (id, result) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\\n');
createInterface({ input: process.stdin }).on('line', (line) => {
  const { id, method, params } = JSON.parse(line);
  if (id === undefined) return;
  if (method === 'initialize') {
    send(id, {
      protocolVersion: params.protocolVersion,
      capabilities: { tools: {} },
      serverInfo: { name: 'fixture', version: '1.0.0' },
    });
  } else if (method === 'tools/list') {
    send(id, { tools: [] });
  } else {
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, error: { code: -32601, message: 'unsupported' } }) + '\\n');
  }
});
`;

interface ModelRequest {
  readonly authorization: string | undefined;
  readonly hasToolResult: boolean;
}

interface FakeServer {
  readonly baseURL: string;
  readonly origin: string;
  readonly requests: ModelRequest[];
  close(): Promise<void>;
}

type Delta = Record<string, unknown>;
type Respond = (response: ServerResponse, request: ModelRequest) => void;

function sse(response: ServerResponse, frames: readonly (readonly [Delta, string | null])[]): void {
  response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
  for (const [delta, finish] of frames) {
    const chunk = {
      id: 'chatcmpl-stdout',
      object: 'chat.completion.chunk',
      created: 0,
      model: 'nexar-control',
      choices: [{ index: 0, delta, finish_reason: finish }],
    };
    response.write(`data: ${JSON.stringify(chunk)}\n\n`);
  }
}

function finish(response: ServerResponse): void {
  response.end('data: [DONE]\n\n');
}

function toolCallFrame(name: string, args: Record<string, unknown>): Delta {
  return {
    role: 'assistant',
    content: null,
    tool_calls: [
      {
        index: 0,
        id: 'call_1',
        type: 'function',
        function: { name, arguments: JSON.stringify(args) },
      },
    ],
  };
}

async function startServer(respond: Respond): Promise<FakeServer> {
  const requests: ModelRequest[] = [];
  const server: Server = createServer((req, res) => {
    let raw = '';
    req.setEncoding('utf8');
    req.on('data', (chunk: string) => (raw += chunk));
    req.on('end', () => {
      const request = {
        authorization: req.headers.authorization,
        hasToolResult: raw.includes('"role":"tool"'),
      };
      requests.push(request);
      respond(res, request);
    });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = server.address() as AddressInfo;
  const origin = `http://127.0.0.1:${String(port)}`;
  return {
    baseURL: `${origin}/v1`,
    origin,
    requests,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

/** Every stdout line must be one JSON-RPC 2.0 object; a diagnostic line fails the parse. */
function jsonRpcFrames(stdout: readonly string[]): Record<string, unknown>[] {
  const lines = stdout
    .join('')
    .split('\n')
    .filter((line) => line.length > 0);
  return lines.map((line) => {
    const frame = JSON.parse(line) as Record<string, unknown>;
    expect(frame.jsonrpc).toBe('2.0');
    return frame;
  });
}

function updateKinds(frames: readonly Record<string, unknown>[]): string[] {
  return frames.flatMap((frame) => {
    if (frame.method !== 'session/update') return [];
    const params = frame.params as { update?: { sessionUpdate?: string } };
    return params.update?.sessionUpdate === undefined ? [] : [params.update.sessionUpdate];
  });
}

async function exited(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await once(child, 'exit');
}

describe.skipIf(ENTRY === undefined)('dsh ACP protocol stream (real runtime)', () => {
  let launch: DshLaunch;
  let root: string;
  let mcpFixture: string;

  beforeAll(() => {
    root = realpathSync.native(makeTempDir('nexar-dsh-stdout-real-'));
    launch = dshLaunchFor(ENTRY as string, { nodeCommand: process.execPath });
    mcpFixture = join(root, 'tools-only-mcp.mjs');
    writeFileSync(mcpFixture, TOOLS_ONLY_MCP_SERVER);
  });
  afterAll(() => {
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  });

  function session(
    name: string,
    model: FakeServer,
    options: {
      mcpServers?: readonly Record<string, unknown>[];
      signal?: AbortSignal;
      events?: LocalAcpEvent[];
      extraPatch?: string;
    } = {},
  ) {
    const base = join(root, 'base');
    const dir = join(base, name);
    mkdirSync(dir, { recursive: true });
    const stdout: string[] = [];
    const stderr: string[] = [];
    const children: ChildProcess[] = [];
    // Listens beside the client without consuming its stream.
    const recording = ((command: string, args: readonly string[], spawnOptions: SpawnOptions) => {
      const argv =
        options.extraPatch === undefined ? args : [...args, '--patch', options.extraPatch];
      const child = nodeSpawn(command, argv, spawnOptions);
      child.stdout?.on('data', (chunk: Buffer | string) => stdout.push(String(chunk)));
      child.stderr?.on('data', (chunk: Buffer | string) => stderr.push(String(chunk)));
      children.push(child);
      return child;
    }) as typeof nodeSpawn;
    const run = runLocalAcpSession({
      launch,
      profile: COWORK_PROFILE,
      scratchBase: base,
      scratchDir: dir,
      dshHome: join(root, `home-${name}`),
      permissionMode: 'read-only',
      control: { baseURL: model.baseURL, token: TOKEN },
      prompt: 'Run the fixture turn.',
      decide: () => Promise.resolve('allow'),
      ...(options.mcpServers === undefined ? {} : { mcpServers: options.mcpServers }),
      ...(options.events === undefined ? {} : { onEvent: (e) => options.events?.push(e) }),
      parentEnv: process.env,
      signal: options.signal ?? new AbortController().signal,
      timeoutMs: TEST_TIMEOUT_MS - 10_000,
      initializeTimeoutMs: INITIALIZE_TIMEOUT_MS,
      logger: makeLogger(),
      spawn: recording,
    });
    return { run, stdout, stderr, children, dir };
  }

  function expectNoSecrets(stdout: readonly string[], stderr: readonly string[]): void {
    const output = [...stdout, ...stderr].join('');
    expect(output).not.toContain(TOKEN);
    expect(output).not.toContain(FOREIGN_TOKEN);
  }

  it(
    'stays JSON-RPC only when a tools-only MCP server is asked for resources',
    async () => {
      const model = await startServer((response, request) => {
        if (request.hasToolResult) {
          sse(response, [
            [{ role: 'assistant', content: 'LISTED' }, null],
            [{}, 'stop'],
          ]);
        } else {
          sse(response, [
            [toolCallFrame('list_mcp_resources', { server: 'fixture' }), null],
            [{}, 'tool_calls'],
          ]);
        }
        finish(response);
      });
      try {
        const { run, stdout, stderr, children } = session('mcp-resources', model, {
          mcpServers: [{ name: 'fixture', command: process.execPath, args: [mcpFixture], env: [] }],
        });
        const result = await run;
        expect(result.stopReason).toBe('end_turn');
        expect(result.text).toContain('LISTED');
        const frames = jsonRpcFrames(stdout);
        expect(frames[0]?.id).toBeDefined();
        expect(updateKinds(frames)).toContain('tool_call');
        expect(model.requests.map((r) => r.hasToolResult)).toEqual([false, true]);
        expectNoSecrets(stdout, stderr);
        await exited(children[0] as ChildProcess);
      } finally {
        await model.close();
      }
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'keeps reasoning out of the Nexar result and tool events in order',
    async () => {
      const content = '# Draft\n';
      const model = await startServer((response, request) => {
        if (request.hasToolResult) {
          sse(response, [
            [{ role: 'assistant', reasoning_content: SIGNED_REASONING }, null],
            [{ content: 'FINAL-TEXT' }, null],
            [{}, 'stop'],
          ]);
        } else {
          sse(response, [
            [{ role: 'assistant', reasoning_content: SIGNED_REASONING }, null],
            [
              toolCallFrame('write', {
                file_path: 'draft.md',
                content,
                sandbox_permissions: 'workspace-write',
                justification: 'Write the requested draft in scratch.',
              }),
              null,
            ],
            [{}, 'tool_calls'],
          ]);
        }
        finish(response);
      });
      try {
        const events: LocalAcpEvent[] = [];
        const { run, stdout, stderr } = session('reasoning', model, { events });
        const result = await run;
        expect(result.text).toBe('FINAL-TEXT');
        const deltas = events.flatMap((e) => (e.type === 'text-delta' ? [e.text] : []));
        expect(deltas.join('')).toBe('FINAL-TEXT');
        expect(JSON.stringify(events)).not.toContain(REASONING);
        expect(JSON.stringify(events)).not.toContain('SIGNATURE-MARKER');

        const kinds = updateKinds(jsonRpcFrames(stdout));
        const thought = kinds.indexOf('agent_thought_chunk');
        const tool = kinds.indexOf('tool_call');
        const message = kinds.indexOf('agent_message_chunk');
        expect(thought).toBeGreaterThanOrEqual(0);
        expect(thought).toBeLessThan(tool);
        expect(tool).toBeLessThan(message);
        expectNoSecrets(stdout, stderr);
      } finally {
        await model.close();
      }
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'cancels a streaming turn, stays parseable and terminates the runtime',
    async () => {
      const controller = new AbortController();
      const model = await startServer((response) => {
        // Never finishes: the turn can only end through cancellation.
        sse(response, [[{ role: 'assistant', content: 'PARTIAL' }, null]]);
        setTimeout(() => controller.abort(), 500);
      });
      try {
        const { run, stdout, stderr, children } = session('cancel', model, {
          signal: controller.signal,
        });
        const failure: unknown = await run.catch((error: unknown) => error);
        expect(failure).toBeInstanceOf(NexarError);
        expect((failure as NexarError).code).toBe('EXECUTION_CANCELLED');
        jsonRpcFrames(stdout);
        expectNoSecrets(stdout, stderr);
        await exited(children[0] as ChildProcess);
      } finally {
        await model.close();
      }
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'propagates a rejected model request without leaking the credential',
    async () => {
      const model = await startServer((response) => {
        response.writeHead(400, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ error: { message: 'fixture rejected', type: 'invalid' } }));
      });
      try {
        const { run, stdout, stderr, children } = session('model-error', model);
        const outcome: unknown = await run.catch((error: unknown) => error);
        const text = outcome instanceof NexarError ? outcome.message : JSON.stringify(outcome);
        expect(text).not.toContain(TOKEN);
        expect(model.requests.length).toBeGreaterThan(0);
        jsonRpcFrames(stdout);
        expectNoSecrets(stdout, stderr);
        await exited(children[0] as ChildProcess);
      } finally {
        await model.close();
      }
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'never lets a saved upstream credential replace the Nexar-selected one',
    async () => {
      const foreign = await startServer((response) => {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ data: [{ id: 'foreign-model' }] }));
      });
      const model = await startServer((response) => {
        sse(response, [
          [{ role: 'assistant', content: 'SELECTED-ROUTE' }, null],
          [{}, 'stop'],
        ]);
        finish(response);
      });
      try {
        const saved = `${JSON.stringify({
          version: 1,
          records: {
            'deepseek-account-platform/default': {
              kind: 'grant',
              payload: { version: 1, token: FOREIGN_TOKEN, issuer: foreign.origin },
            },
          },
        })}\n`;
        const home = join(root, 'home-saved-credential');
        mkdirSync(home, { recursive: true, mode: 0o700 });
        writeFileSync(join(home, '.credentials.yaml'), saved, { mode: 0o600 });
        mkdirSync(join(root, 'base', 'saved-credential', '.dsh'), { recursive: true });
        writeFileSync(join(root, 'base', 'saved-credential', '.dsh', '.credentials.yaml'), saved, {
          mode: 0o600,
        });

        // Points the upstream account services at the foreign server, so only Nexar's overlay
        // stands between the saved grant and the wire.
        const extraPatch = join(root, 'foreign-account.patch.yml');
        writeFileSync(
          extraPatch,
          `${JSON.stringify([
            {
              id: 'deepseek-account',
              config: {
                platformOrigin: foreign.origin,
                inferenceOrigin: foreign.origin,
                allowLoopbackHttp: true,
              },
            },
            { id: 'llm-deepseek-account', config: { baseURL: `${foreign.origin}/anthropic` } },
          ])}\n`,
        );
        const { run, stdout, stderr } = session('saved-credential', model, { extraPatch });
        const result = await run;
        expect(result.text).toContain('SELECTED-ROUTE');
        expect(model.requests.length).toBeGreaterThan(0);
        for (const request of model.requests) {
          expect(request.authorization).toBe(`Bearer ${TOKEN}`);
        }
        expect(foreign.requests).toEqual([]);
        jsonRpcFrames(stdout);
        expectNoSecrets(stdout, stderr);
      } finally {
        await model.close();
        await foreign.close();
      }
    },
    TEST_TIMEOUT_MS,
  );
});
