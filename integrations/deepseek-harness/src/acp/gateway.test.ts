import { createServer } from 'node:http';
import type { Server } from 'node:http';
import { existsSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { InMemoryApprovalStore } from '@nexar/approvals';
import type {
  ExecutionContext,
  ExecutionGateway,
  LaunchSpec,
  Logger,
  PreparedLaunch,
  ProcessLauncher,
  ResourceDescriptor,
} from '@nexar/contracts';
import { DeepSeekHarnessExecutionAdapter } from '../adapter.js';
import { renderPatchOverlay } from '../overlay.js';
import { CODING_PROFILE, renderProfileOverlay } from '../profiles.js';
import { deepseekHarnessResource } from '../resource.js';
import { makeContext, makeTask, makeTempDir } from '../test/support.js';
import type { FakeRecord, LogLine } from '../test/support.js';
import { bridgeToolNames, publicMcpToolName } from './gateway.js';
import { PermissionBroker } from './permissions.js';

const FAKE_ACP = fileURLToPath(new URL('../test/fake-dsh-acp.mjs', import.meta.url));
const TOKEN = 'lane-token-0000';
const PROMPT_MARKER = 'MARKER-PROMPT-71c2';
const FILE_MARKER = 'MARKER-FILE-5d1e';
const DSH_KEY = 'sk-test-key-123';

describe('publicMcpToolName', () => {
  // Literals computed independently from upstream's algorithm (dsh-mcp-client tools.ts, 639ed01).
  it('names the two bridge tools the way DSH does (a hash because "." is replaced)', () => {
    expect(bridgeToolNames()).toEqual([
      'mcp__nexar__nexar_intelligence_submit_e66ce511b6ed',
      'mcp__nexar__nexar_intelligence_status_2bfdff72a6f9',
    ]);
  });

  it('keeps a clean name verbatim and truncates a long one with a hash', () => {
    expect(publicMcpToolName('nexar', 'ok_tool')).toBe('mcp__nexar__ok_tool');
    const long = publicMcpToolName('nexar', 'x'.repeat(100));
    expect(long).toHaveLength(64);
    expect(long).toMatch(/^mcp__nexar__x+_[0-9a-f]{12}$/);
  });
});

describe('renderPatchOverlay: the nexar route', () => {
  it('declares one openai-completions route reading the control token variable', () => {
    expect(renderPatchOverlay({ nexarRoute: { baseURL: 'http://127.0.0.1:3129/v1' } })).toBe(
      [
        '- id: session-log-deepseek',
        '  disabled: true',
        '- id: llm-pi-ai',
        '  config:',
        '    providers:',
        '      "nexar":',
        '        api: "openai-completions"',
        '        baseURL: "http://127.0.0.1:3129/v1"',
        '        apiKeyEnv: "NEXAR_CONTROL_TOKEN"',
        '        models:',
        '          - id: "nexar-control"',
        '',
      ].join('\n'),
    );
  });

  it('puts the route beside other providers in one llm-pi-ai row', () => {
    const text = renderPatchOverlay({
      piAiProviders: { other: { apiKeyEnv: 'OTHER_KEY' } },
      nexarRoute: { baseURL: 'http://127.0.0.1:1/v1' },
    });
    expect(text.match(/- id: llm-pi-ai/g)).toHaveLength(1);
    expect(text).toContain('"other":');
    expect(text).toContain('"nexar":');
  });

  it.each([
    'http://localhost:3129/v1',
    'https://127.0.0.1:3129/v1',
    'http://127.0.0.1:3129/v1/',
    'http://127.0.0.1/v1',
    'http://127.0.0.1:3129/v1"\n- id: evil',
    'http://10.0.0.1:3129/v1',
  ])('refuses the base URL %j', (baseURL) => {
    expect(() => renderPatchOverlay({ nexarRoute: { baseURL } })).toThrow(/baseURL/);
  });

  it('refuses a provider that claims the reserved route name', () => {
    expect(() =>
      renderPatchOverlay({
        piAiProviders: { nexar: { apiKeyEnv: 'K' } },
        nexarRoute: { baseURL: 'http://127.0.0.1:1/v1' },
      }),
    ).toThrow(/reserved/);
  });
});

describe('PermissionBroker: bridge tools', () => {
  const [submit, status] = bridgeToolNames() as [string, string];
  const logger: Logger = {
    debug: () => undefined,
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
    child: () => logger,
  };
  const options = [
    { optionId: 'allow-once', name: 'Allow once', kind: 'allow_once' },
    { optionId: 'reject-once', name: 'Reject', kind: 'reject_once' },
  ];

  async function ask(
    tool: string,
    extra: { bridgeTools?: readonly string[]; mode?: 'ask' | 'deny' },
  ) {
    const store = new InMemoryApprovalStore();
    const broker = new PermissionBroker({
      sessionId: 's',
      policy: { mode: extra.mode ?? 'ask', allowTools: [], ttlMs: 1000 },
      lookupToolCall: () => ({ title: tool, kind: 'other', rawInput: { secret: PROMPT_MARKER } }),
      store,
      logger,
      bridgeTools: extra.bridgeTools,
    });
    const reply = await broker.handle({ sessionId: 's', toolCall: { toolCallId: 'c' }, options });
    return { reply, store };
  }

  const allowed = { result: { outcome: { outcome: 'selected', optionId: 'allow-once' } } };
  const rejected = { result: { outcome: { outcome: 'selected', optionId: 'reject-once' } } };

  it('allows exactly the two bridge tools in gateway mode and records the decision', async () => {
    for (const tool of [submit, status]) {
      const { reply, store } = await ask(tool, { bridgeTools: bridgeToolNames() });
      expect(reply).toEqual(allowed);
      const decisions = await store.list();
      expect(decisions).toHaveLength(1);
      expect(decisions[0]).toMatchObject({ status: 'consumed', decidedBy: 'policy' });
      expect(JSON.stringify(decisions)).not.toContain(PROMPT_MARKER);
    }
  });

  it.each([
    'mcp__nexar__nexar_intelligence_submit',
    'mcp__nexar__other',
    'mcp__other__nexar_intelligence_submit_e66ce511b6ed',
    'bash',
  ])('does not allow %s', async (tool) => {
    const { reply, store } = await ask(tool, { bridgeTools: bridgeToolNames() });
    // No gate: an unlisted tool is rejected, and nothing is recorded as allowed.
    expect(reply).toEqual(rejected);
    expect(await store.list()).toHaveLength(0);
  });

  it('allows nothing without gateway mode', async () => {
    expect((await ask(submit, {})).reply).toEqual(rejected);
  });

  it('keeps an owner deny policy', async () => {
    const { reply } = await ask(submit, { bridgeTools: bridgeToolNames(), mode: 'deny' });
    expect(reply).toEqual(rejected);
  });
});

// --- the adapter in gateway mode -----------------------------------------------------------------

interface GatewayRecord extends FakeRecord {
  mcpEndpoint?: string;
  mcpTokenIsControlToken?: boolean;
  hasControlToken?: boolean;
}

interface Stub {
  readonly baseURL: string;
  readonly requests: { auth: string | undefined; body: Record<string, unknown> }[];
  close(): Promise<void>;
}

/** A Chat Completions endpoint: turn 1 asks for `write_file`, turn 2 answers. `status` forces an error. */
async function stubGateway(status = 200): Promise<Stub> {
  const requests: Stub['requests'] = [];
  const server: Server = createServer((req, res) => {
    let raw = '';
    req.setEncoding('utf8');
    req.on('data', (chunk: string) => (raw += chunk));
    req.on('end', () => {
      requests.push({ auth: req.headers.authorization, body: JSON.parse(raw) as never });
      if (status !== 200 || req.headers.authorization !== `Bearer ${TOKEN}`) {
        res.writeHead(status === 200 ? 401 : status, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'no' } }));
        return;
      }
      const chunk = (delta: unknown, finish: string | null) =>
        `data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      if (requests.length === 1) {
        const call = {
          index: 0,
          id: 'call_1',
          type: 'function',
          function: {
            name: 'write_file',
            arguments: JSON.stringify({ path: 'out/new.txt', content: FILE_MARKER }),
          },
        };
        res.write(chunk({ role: 'assistant', content: '' }, null));
        res.write(chunk({ tool_calls: [call] }, null));
        res.write(chunk({}, 'tool_calls'));
      } else {
        res.write(chunk({ role: 'assistant', content: 'finished' }, null));
        res.write(chunk({}, 'stop'));
      }
      res.end('data: [DONE]\n\n');
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as { port: number };
  return {
    baseURL: `http://127.0.0.1:${String(port)}/v1`,
    requests,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  };
}

type Reported = NonNullable<PreparedLaunch['services']>;

/** A launcher that reports what the sandbox would, and delivers `spec.env` to the process it spawns. */
class GatewayLauncher implements ProcessLauncher {
  readonly isolation = 'sandbox' as const;
  specs: LaunchSpec[] = [];
  disposed = 0;
  constructor(
    private readonly workspacePath: string,
    private readonly reported: Reported | undefined,
  ) {}
  prepare(spec: LaunchSpec): Promise<PreparedLaunch> {
    this.specs.push(spec);
    const mount = spec.mounts?.[0];
    // Sandbox paths in arguments map back to the mount's host path, as the real mount would resolve them.
    const args = spec.args.map((a) =>
      mount !== undefined && a.startsWith(`${mount.sandboxPath}/`)
        ? mount.hostPath + a.slice(mount.sandboxPath.length)
        : a,
    );
    return Promise.resolve({
      command: spec.command,
      args,
      env: { PATH: process.env.PATH ?? '', ...spec.env },
      cwd: this.workspacePath,
      workspacePath: this.workspacePath,
      isolation: 'sandbox',
      ...(this.reported === undefined ? {} : { services: this.reported }),
      dispose: () => {
        this.disposed++;
        return Promise.resolve();
      },
    });
  }
}

const stubs: Stub[] = [];
afterEach(async () => {
  await Promise.all(stubs.splice(0).map((s) => s.close()));
});

interface Setup {
  bridge?: boolean;
  /** What the launcher reports for the mounted services; default: everything requested. */
  reported?: (base: string) => Reported | undefined;
  gatewayStatus?: number;
  flags?: Record<string, string>;
  auth?: ResourceDescriptor['auth'];
  command?: string;
  nodeCommand?: string;
  gateway?: boolean;
  requiredContext?: string;
}

async function setup(o: Setup = {}) {
  const dir = makeTempDir();
  const recordPath = join(dir, 'record.json');
  const workspacePath = join(dir, 'ws');
  const stateDir = join(dir, 'state');
  mkdirSync(workspacePath);
  const stub = await stubGateway(o.gatewayStatus);
  stubs.push(stub);
  const bridge = o.bridge ?? false;
  const reported =
    o.reported === undefined
      ? {
          gatewayBaseUrl: stub.baseURL,
          ...(bridge
            ? {
                bridgeEndpoint: '/run/nexar-services/bridge.sock',
                relayPath: '/opt/nexar/relay.cjs',
              }
            : {}),
        }
      : o.reported(stub.baseURL);
  const launcher = new GatewayLauncher(workspacePath, reported);
  const flags = Object.entries({ record: recordPath, unit: '0', ...o.flags }).map(
    ([k, v]) => `--fake-${k}=${v}`,
  );
  const adapter = new DeepSeekHarnessExecutionAdapter({
    binary: { command: o.command ?? process.execPath, args: [FAKE_ACP, ...flags] },
    stateDir,
    env: { PATH: process.env.PATH, DEEPSEEK_API_KEY: DSH_KEY },
    initializeTimeoutMs: 5000,
    defaultTimeoutMs: 20_000,
    ...(o.nodeCommand === undefined ? {} : { nodeCommand: o.nodeCommand }),
  });
  const resource = deepseekHarnessResource({
    ...(o.auth === undefined ? {} : { auth: o.auth }),
  });
  const gateway: ExecutionGateway = {
    engine: 'dsh',
    services: {
      dir: join(dir, 'svc'),
      gateway: true,
      bridge,
      ...(bridge ? { relayScript: '/x' } : {}),
    },
    token: TOKEN,
    model: 'nexar-control',
    controlResourceId: 'control-model',
    controlDecisionId: 'dec-1',
  };
  const events: Parameters<NonNullable<ExecutionContext['onEvent']>>[0][] = [];
  const logs: LogLine[] = [];
  const base = makeContext({ events, logs });
  const context: ExecutionContext = {
    ...base,
    workspace: { path: workspacePath, access: 'read-write', launcher },
    ...(o.gateway === false ? {} : { gateway }),
    ...(o.requiredContext === undefined ? {} : { requiredContext: o.requiredContext }),
  };
  const task = makeTask({ workingDirectory: dir });
  const run = () =>
    adapter.execute(
      { task: { ...task, input: { ...task.input, prompt: PROMPT_MARKER } }, resource },
      context,
    );
  return { dir, recordPath, workspacePath, stateDir, stub, launcher, run, events, logs, resource };
}

const readRecord = (path: string): GatewayRecord =>
  JSON.parse(readFileSync(path, 'utf8')) as GatewayRecord;

describe('DSH ACP in gateway mode', () => {
  it('runs the loop on the nexar route without any DSH credential', async () => {
    const t = await setup({
      // A keystore credential that is not stored: the own-credential assertion must be skipped.
      auth: { mode: 'api-key', credential: { source: 'keystore', name: 'dsh-key' } },
    });
    const result = await t.run();

    expect(result.text).toBe('working. finished');
    expect(result.resolved).toEqual({
      provider: 'nexar',
      model: 'nexar-control',
      runtimeVersion: 'dsh-acp',
    });
    // The file the model asked for was written in the workspace by the (fake) engine.
    expect(readFileSync(join(t.workspacePath, 'out', 'new.txt'), 'utf8')).toBe(FILE_MARKER);

    // Two streamed turns, bearer = lane token, model nexar-control, the loop's tool offered.
    expect(t.stub.requests.map((r) => r.auth)).toEqual([`Bearer ${TOKEN}`, `Bearer ${TOKEN}`]);
    expect(t.stub.requests[0]?.body).toMatchObject({ model: 'nexar-control', stream: true });
    expect(JSON.stringify(t.stub.requests[0]?.body.messages)).toContain(PROMPT_MARKER);

    const [spec] = t.launcher.specs;
    expect(spec?.services).toEqual({ dir: join(t.dir, 'svc'), gateway: true, bridge: false });
    expect(spec?.env).toEqual({
      DSH_HOME: '/home/agent/.dsh',
      DSH_TELEMETRY_DISABLED: '1',
      NEXAR_CONTROL_TOKEN: TOKEN,
    });
    expect(spec?.args.slice(-4)).toEqual([
      '--profile',
      'acp',
      '--patch',
      '/home/agent/.dsh/nexar.patch.yml',
    ]);
    expect(spec?.network).toMatchObject({ mode: 'proxy' });

    const record = readRecord(t.recordPath);
    expect(record.envKeys).toContain('NEXAR_CONTROL_TOKEN');
    expect(record.envKeys).not.toContain('DEEPSEEK_API_KEY');
    expect(record.overlay).toBe(
      renderProfileOverlay({
        profile: CODING_PROFILE,
        route: { kind: 'nexar', baseURL: t.stub.baseURL },
      }),
    );
    const methods = record.requests.map((r) => r.method);
    expect(methods).toEqual([
      'initialize',
      'session/new',
      'session/set_config_option',
      'session/prompt',
      'session/close',
    ]);
    // The ACP model value is DSH's opaque JSON pair; the route has no reasoning option.
    expect(record.requests[2]?.params).toEqual({
      sessionId: 'sess-1',
      configId: 'model',
      value: '["nexar","nexar-control"]',
    });
    expect(record.requests[1]?.params).toEqual({ cwd: t.workspacePath, mcpServers: [] });
    expect(t.launcher.disposed).toBe(1);

    const overlayPath = join(t.stateDir, 'acp', String(t.resource.id), 'nexar.patch.yml');
    if (process.platform !== 'win32') expect(statSync(overlayPath).mode & 0o777).toBe(0o600);
    expect(existsSync(overlayPath)).toBe(true);
  });

  it('offers exactly one stdio `nexar` MCP server when the bridge is mounted', async () => {
    const t = await setup({ bridge: true });
    await t.run();
    const record = readRecord(t.recordPath);
    expect(record.requests[1]?.params).toEqual({
      cwd: t.workspacePath,
      mcpServers: [
        {
          name: 'nexar',
          command: process.execPath,
          args: ['/opt/nexar/relay.cjs'],
          env: [{ name: 'NEXAR_BRIDGE_ENDPOINT' }, { name: 'NEXAR_BRIDGE_TOKEN' }],
        },
      ],
    });
    expect(record.mcpEndpoint).toBe('/run/nexar-services/bridge.sock');
    expect(record.mcpTokenIsControlToken).toBe(true);
  });

  it('uses an explicitly configured node for the relay', async () => {
    const node = process.platform === 'win32' ? 'C:\\toolchain\\node.exe' : '/opt/node/bin/node';
    const t = await setup({ bridge: true, nodeCommand: node });
    await t.run();
    const entry = (
      readRecord(t.recordPath).requests[1]?.params as { mcpServers: { command: string }[] }
    ).mcpServers[0];
    expect(entry?.command).toBe(node);
  });

  it('refuses before spawning when a requested service is not mounted', async () => {
    const cases: Setup[] = [
      { reported: () => undefined },
      { reported: () => ({}) },
      { bridge: true, reported: (base) => ({ gatewayBaseUrl: base }) },
      { bridge: true, reported: (base) => ({ gatewayBaseUrl: base, bridgeEndpoint: '/b' }) },
    ];
    for (const c of cases) {
      const t = await setup(c);
      await expect(t.run()).rejects.toMatchObject({ code: 'INTEGRATION_UNAVAILABLE' });
      expect(existsSync(t.recordPath)).toBe(false);
      expect(t.launcher.disposed).toBe(1);
    }
  });

  it('offers no bridge (and allows no bridge tool) when no in-sandbox Node is known', async () => {
    // A relative Node names no in-sandbox path; dsh would roll back a session whose MCP server
    // cannot start, so the lane runs on the gateway without the bridge.
    const t = await setup({ bridge: true, nodeCommand: 'node' });
    await t.run();
    const created = readRecord(t.recordPath).requests[1]?.params as { mcpServers: unknown[] };
    expect(created.mcpServers).toEqual([]);
  });

  it('turns a gateway HTTP error into a provider failure that never shows the token', async () => {
    const t = await setup({ gatewayStatus: 502 });
    const error = await t.run().then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(error).toMatchObject({ code: 'PROVIDER_ERROR' });
    expect(JSON.stringify([String(error), t.logs, t.events])).not.toContain(TOKEN);
    expect(t.launcher.disposed).toBe(1);
  });

  it('never logs the token or the prompt', async () => {
    const t = await setup({ bridge: true });
    await t.run();
    const everything = JSON.stringify([t.logs, t.events]);
    expect(everything).not.toContain(TOKEN);
    expect(everything).not.toContain(PROMPT_MARKER);
  });

  it('renders the required context into the gateway overlay and never anywhere else', async () => {
    const t = await setup({ requiredContext: 'REQUIRED-CONTEXT-MARKER-42' });
    await t.run();
    const record = readRecord(t.recordPath);
    expect(record.overlay).toBe(
      renderProfileOverlay({
        profile: CODING_PROFILE,
        route: { kind: 'nexar', baseURL: t.stub.baseURL },
        requiredContext: 'REQUIRED-CONTEXT-MARKER-42',
      }),
    );
    expect(JSON.stringify([t.logs, t.events])).not.toContain('REQUIRED-CONTEXT-MARKER-42');
    expect(JSON.stringify(t.stub.requests.map((r) => r.body.messages))).not.toContain(
      'REQUIRED-CONTEXT-MARKER-42',
    );
  });

  it('leaves a run without a gateway on the resource credential (resource route overlay, no services)', async () => {
    const t = await setup({ gateway: false });
    // Without a gateway the fake has no route: it takes its normal permission scenario (rejected, no gate).
    const result = await t.run();
    expect(result.text).toBe('working. permission:reject-once');
    expect(result.resolved).toMatchObject({ provider: 'deepseek-official' });
    const [spec] = t.launcher.specs;
    expect(spec?.services).toBeUndefined();
    expect(spec?.env).toEqual({
      DSH_HOME: '/home/agent/.dsh',
      DSH_TELEMETRY_DISABLED: '1',
      DEEPSEEK_API_KEY: DSH_KEY,
    });
    expect(spec?.args.slice(-2)).toEqual(['--patch', '/home/agent/.dsh/nexar.patch.yml']);
    expect(readRecord(t.recordPath).overlay).toBe(
      renderProfileOverlay({ profile: CODING_PROFILE, route: { kind: 'resource' } }),
    );
    expect(t.stub.requests).toHaveLength(0);
  });
});
