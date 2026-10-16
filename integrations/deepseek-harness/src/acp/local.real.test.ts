import { createServer } from 'node:http';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { decideCoworkPermission } from '../cowork-policy.js';
import { COWORK_PROFILE } from '../profiles.js';
import { DSH_PINNED_VERSION } from '../resource.js';
import { dshLaunchFor, probeDshRuntime } from '../runtime/resolve.js';
import type { DshLaunch } from '../runtime/resolve.js';
import { makeLogger, makeTempDir } from '../test/support.js';
import { runLocalAcpSession } from './local.js';
import type { PermissionDecisionInput } from './local.js';

// Opt-in: runs the REAL pinned `dsh --profile acp` host-locally (CI installs it with
// scripts/install-dsh-runtime.mjs and exports NEXAR_DSH_ENTRY). The "model" is a fake Chat Completions
// server on loopback inside this test: no credentials, no network, no paid call.
const ENTRY = process.env.NEXAR_DSH_ENTRY;
const TOKEN = 'real-test-control-token-4f9a1c';
const INITIALIZE_TIMEOUT_MS = 90_000;
const TEST_TIMEOUT_MS = 180_000;
const FORBIDDEN_TOOLS =
  /bash|pwsh|powershell|web_fetch|web_search|subagent|workflow|send_message|list_agents|plugin/i;

interface ModelRequest {
  readonly authorization: string | undefined;
  readonly body: {
    readonly model?: string;
    readonly stream?: boolean;
    readonly messages?: { readonly role: string; readonly content?: unknown }[];
    readonly tools?: { readonly function?: { readonly name?: string } }[];
  };
}

interface FakeModel {
  readonly baseURL: string;
  readonly requests: ModelRequest[];
  close(): Promise<void>;
}

/** First request without a tool result: one tool call; once a tool result exists: final text. */
async function startFakeModel(
  toolArguments: Record<string, unknown>,
  finalText: string,
  toolName = 'write',
): Promise<FakeModel> {
  const requests: ModelRequest[] = [];
  const server: Server = createServer((req, res) => {
    let raw = '';
    req.setEncoding('utf8');
    req.on('data', (chunk: string) => (raw += chunk));
    req.on('end', () => {
      const body = JSON.parse(raw) as ModelRequest['body'];
      requests.push({ authorization: req.headers.authorization, body });
      const hasToolResult = body.messages?.some((m) => m.role === 'tool') === true;
      const frames = hasToolResult
        ? [
            { delta: { role: 'assistant', content: finalText }, finish: null },
            { delta: {}, finish: 'stop' },
          ]
        : [
            {
              delta: {
                role: 'assistant',
                content: null,
                tool_calls: [
                  {
                    index: 0,
                    id: 'call_1',
                    type: 'function',
                    function: { name: toolName, arguments: JSON.stringify(toolArguments) },
                  },
                ],
              },
              finish: null,
            },
            { delta: {}, finish: 'tool_calls' },
          ];
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
      for (const frame of frames) {
        const chunk = {
          id: 'chatcmpl-test',
          object: 'chat.completion.chunk',
          created: 0,
          model: 'nexar-control',
          choices: [{ index: 0, delta: frame.delta, finish_reason: frame.finish }],
        };
        res.write(`data: ${JSON.stringify(chunk)}\n\n`);
      }
      res.write(
        `data: ${JSON.stringify({ id: 'chatcmpl-test', object: 'chat.completion.chunk', created: 0, model: 'nexar-control', choices: [], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } })}\n\n`,
      );
      res.end('data: [DONE]\n\n');
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    baseURL: `http://127.0.0.1:${String(port)}/v1`,
    requests,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

describe.skipIf(ENTRY === undefined)('dsh --profile acp (real runtime, host-local)', () => {
  // Built in beforeAll: the suite body still runs (and must not throw) when the suite is skipped.
  let launch: DshLaunch;
  let root: string;
  let home: string;

  beforeAll(() => {
    root = realpathSync.native(makeTempDir('nexar-dsh-local-real-'));
    home = join(root, 'dsh-home');
    launch = dshLaunchFor(ENTRY as string, { nodeCommand: process.execPath });
  });
  afterAll(() => {
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  });

  function scratch(name: string): { base: string; dir: string } {
    const base = join(root, 'base');
    const dir = join(base, name);
    mkdirSync(dir, { recursive: true });
    return { base, dir };
  }

  async function turn(
    name: string,
    model: FakeModel,
    options: { requiredContext?: string; decisions?: string[] } = {},
  ) {
    const { base, dir } = scratch(name);
    const decide = (input: PermissionDecisionInput): Promise<'allow' | 'reject'> => {
      const decision = decideCoworkPermission(input, {
        scratchRoot: dir,
        permission: 'drafts-only',
      });
      options.decisions?.push(`${input.tool}:${decision.decision}:${decision.reason}`);
      return Promise.resolve(decision.decision === 'allow' ? 'allow' : 'reject');
    };
    const result = await runLocalAcpSession({
      launch,
      profile: COWORK_PROFILE,
      scratchBase: base,
      scratchDir: dir,
      dshHome: home,
      permissionMode: 'read-only',
      control: { baseURL: model.baseURL, token: TOKEN },
      ...(options.requiredContext === undefined
        ? {}
        : { requiredContext: options.requiredContext }),
      prompt: 'Write the proposal.',
      decide,
      parentEnv: process.env,
      signal: new AbortController().signal,
      timeoutMs: TEST_TIMEOUT_MS - 10_000,
      initializeTimeoutMs: INITIALIZE_TIMEOUT_MS,
      logger: makeLogger(),
    });
    return { result, dir };
  }

  it('reports the pinned version as ready', async () => {
    await expect(probeDshRuntime(launch, { parentEnv: process.env })).resolves.toEqual({
      state: 'ready',
      version: DSH_PINNED_VERSION,
    });
  }, 60_000);

  it(
    'runs a Cowork turn: write into scratch through the nexar route, no shell or web tools',
    async () => {
      const content = '# Proposal\n\nREAL-TEST-CONTENT\n';
      const model = await startFakeModel(
        {
          file_path: 'proposal.md',
          content,
          sandbox_permissions: 'workspace-write',
          justification: 'Write the requested draft in scratch.',
        },
        'FINAL-TEXT-OK',
      );
      try {
        const decisions: string[] = [];
        const { result, dir } = await turn('write', model, { decisions });

        expect(result.stopReason).toBe('end_turn');
        expect(result.text).toContain('FINAL-TEXT-OK');
        expect(readFileSync(join(dir, 'proposal.md'), 'utf8')).toBe(content);

        expect(model.requests.length).toBeGreaterThanOrEqual(2);
        for (const request of model.requests) {
          expect(request.authorization).toBe(`Bearer ${TOKEN}`);
          expect(request.body.model).toBe('nexar-control');
        }
        const tools = (model.requests[0]?.body.tools ?? []).map((t) => t.function?.name ?? '');
        expect(tools).toContain('write');
        expect(tools.filter((name) => FORBIDDEN_TOOLS.test(name))).toEqual([]);
        // No mutation may silently bypass Nexar's decision.
        expect(decisions.length).toBeGreaterThan(0);
        expect(decisions.every((d) => d.startsWith('write:allow:'))).toBe(true);
      } finally {
        await model.close();
      }
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'denies an ordinary write without the per-call authorization request',
    async () => {
      const model = await startFakeModel({ file_path: 'unasked.md', content: 'DENIED' }, 'DONE');
      try {
        const decisions: string[] = [];
        const { dir } = await turn('unasked', model, { decisions });
        expect(existsSync(join(dir, 'unasked.md'))).toBe(false);
        expect(decisions).toEqual([]);
        expect(JSON.stringify(model.requests.at(-1)?.body.messages)).toContain('sandbox');
      } finally {
        await model.close();
      }
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'documents the host-local read boundary using only a synthetic file outside scratch',
    async () => {
      const outside = join(root, 'synthetic-outside.txt');
      writeFileSync(outside, 'FCR01-SYNTHETIC-HOST-READ');
      const model = await startFakeModel({ file_path: outside }, 'READ-DONE', 'read');
      try {
        const decisions: string[] = [];
        await turn('host-read', model, { decisions });
        expect(JSON.stringify(model.requests.at(-1)?.body.messages)).toContain(
          'FCR01-SYNTHETIC-HOST-READ',
        );
        expect(decisions).toEqual([]);
      } finally {
        await model.close();
      }
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'denies a write that escalates out of scratch',
    async () => {
      const model = await startFakeModel(
        {
          file_path: '../outside.md',
          content: 'ESCAPED',
          sandbox_permissions: 'danger-full-access',
          justification: 'the owner asked for it',
        },
        'DONE-AFTER-DENIAL',
      );
      try {
        const decisions: string[] = [];
        const { result, dir } = await turn('escape', model, { decisions });

        expect(result.stopReason).toBe('end_turn');
        expect(existsSync(join(dir, '..', 'outside.md'))).toBe(false);
        expect(existsSync(join(dir, 'outside.md'))).toBe(false);
        expect(decisions.length).toBeGreaterThan(0);
        expect(decisions.every((d) => d.startsWith('write:reject:'))).toBe(true);
      } finally {
        await model.close();
      }
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'delivers the required context in the system message',
    async () => {
      const model = await startFakeModel(
        {
          file_path: 'a.md',
          content: 'x',
          sandbox_permissions: 'workspace-write',
          justification: 'Write the requested draft in scratch.',
        },
        'CTX-DONE',
      );
      try {
        await turn('context', model, {
          requiredContext: 'REQUIRED-CONTEXT-MARKER-77 {{not-a-var}}',
        });
        const system = (model.requests[0]?.body.messages ?? [])
          .filter((m) => m.role === 'system' || m.role === 'developer')
          .map((m) => JSON.stringify(m.content))
          .join('\n');
        expect(system).toContain('REQUIRED-CONTEXT-MARKER-77');
        expect(system).toContain('{ {not-a-var} }');
        expect(system).not.toContain('{{not-a-var}}');
        expect(system).toMatch(/professional assistant/);
      } finally {
        await model.close();
      }
    },
    TEST_TIMEOUT_MS,
  );
});
