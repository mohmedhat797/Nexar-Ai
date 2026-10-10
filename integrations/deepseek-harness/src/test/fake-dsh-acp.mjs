// Protocol-faithful fake of `dsh --profile acp` (ACP v1, newline-delimited JSON-RPC) for offline tests.
//
// The adapter launches the agent with an explicit allowlisted env, so behaviour is chosen with
// leading `--fake-<name>=<value>` argv entries. Every received message is recorded to
// `--fake-record=<path>`.
//
//   --fake-protocol=1|2        protocolVersion answered by `initialize` (default 1)
//   --fake-scenario=<name>     normal (default) | unknown-call | no-reject | hang | hang-permission |
//                              rpc-error | probe-fs | no-input | model-change; with a `nexar` route in
//                              the overlay only `normal` runs the gateway loop, any other name asks
//                              one permission question (host-local tests use `ask`)
//   --fake-ignore-cancel=1     never answer the prompt after `session/cancel` (forces a kill)
//   --fake-tool=<name>         tool name used as the `tool_call` title (default `bash`)
//   --fake-input=<json>        `rawInput` of the tool call (default {"command":"ls"})
//   --fake-ids=scrambled       option ids that do not hint at their kind
//   --fake-stop=<reason>       stopReason of the prompt response (default end_turn)
//   --fake-rpc-message=<text>  error message for the rpc-error scenario
//   --fake-unit-capability=<c> capability the gateway session's bridge unit asks for (default `unit`)
//   --fake-exit-once=<path>    exit (code 3) mid-turn unless <path> exists; creates it first
//   --fake-unit=0|1            run the bridge unit when an `nexar` MCP server was offered (default 1)
//
// Gateway mode: when the `--patch <overlay>` file declares the pi-ai route `nexar`, `session/prompt`
// runs a real streaming Chat Completions loop against that `baseURL` with the bearer
// `$NEXAR_CONTROL_TOKEN` (turn 1 expects a `write_file` tool call, turn 2 the final text) and, when
// `session/new` offered an `mcpServers` entry `nexar`, runs one unit through that stdio MCP server.
// The token and prompt text are never recorded.
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, resolve, sep } from 'node:path';
import { createInterface } from 'node:readline';

const argv = process.argv.slice(2);

function setting(name, fallback) {
  const prefix = `--fake-${name}=`;
  const hit = argv.find((a) => a.startsWith(prefix));
  return hit === undefined ? fallback : hit.slice(prefix.length);
}

const protocol = Number(setting('protocol', '1'));
const scenario = setting('scenario', 'normal');
const ignoreCancel = setting('ignore-cancel', '0') === '1';
const tool = setting('tool', 'bash');
const input = JSON.parse(setting('input', '{"command":"ls"}'));
const scrambled = setting('ids', 'plain') === 'scrambled';
const stopReason = setting('stop', 'end_turn');
const rpcMessage = setting('rpc-message', 'upstream exploded');
const recordPath = setting('record', undefined);
const unitCapability = setting('unit-capability', 'unit');
const exitOnce = setting('exit-once', undefined);

const patchAt = argv.indexOf('--patch');
const overlay = patchAt === -1 ? undefined : readFileSync(argv[patchAt + 1], 'utf8');
const nexarBaseUrl =
  overlay === undefined ? undefined : /"nexar":[\s\S]*?baseURL: "([^"]+)"/.exec(overlay)?.[1];
const NEXAR_MODEL_VALUE = JSON.stringify(['nexar', 'nexar-control']);
let mcpServers = [];

const record = {
  overlay,
  argv,
  envKeys: Object.keys(process.env).sort(),
  dshHome: process.env.DSH_HOME,
  cwd: process.cwd(),
  pid: process.pid,
  // Host-local sessions: what the child saw, never the token itself.
  envHome: process.env.HOME,
  envUserProfile: process.env.USERPROFILE,
  envPermissionMode: process.env.DSH_PERMISSION_MODE,
  envTelemetryDisabled: process.env.DSH_TELEMETRY_DISABLED,
  tokenLeakedInto: Object.entries(process.env)
    .filter(
      ([name, value]) =>
        name !== 'NEXAR_CONTROL_TOKEN' &&
        process.env.NEXAR_CONTROL_TOKEN !== undefined &&
        String(value).includes(process.env.NEXAR_CONTROL_TOKEN),
    )
    .map(([name]) => name),
  requests: [],
  notifications: [],
  clientReplies: [],
};

function save() {
  if (recordPath === undefined) return;
  // The test polls while the agent runs: publish complete snapshots without truncating its reader.
  const temporary = `${recordPath}.tmp`;
  writeFileSync(temporary, JSON.stringify(record, null, 2));
  const deadline = Date.now() + 1000;
  for (;;) {
    try {
      renameSync(temporary, recordPath);
      return;
    } catch (error) {
      // Windows readers can briefly hold a sharing lock on the previously published snapshot.
      if (
        process.platform !== 'win32' ||
        !['EPERM', 'EACCES', 'EBUSY'].includes(error.code) ||
        Date.now() >= deadline
      )
        throw error;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
    }
  }
}

/** Request params as recorded: MCP server environment values (the lane token) are never kept. */
function redacted(params) {
  if (!Array.isArray(params?.mcpServers)) return params;
  const mcp = params.mcpServers.map((s) => ({
    ...s,
    env: (s.env ?? []).map((e) => ({ name: e.name })),
  }));
  return { ...params, mcpServers: mcp };
}

function send(message) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`);
}

function update(sessionId, body) {
  send({ method: 'session/update', params: { sessionId, update: body } });
}

const waiting = new Map();
let nextAgentId = 1000;
let cancelled = false;
let cancelWaiters = [];

function askClient(method, params) {
  const id = nextAgentId++;
  send({ id, method, params });
  return new Promise((resolve) => waiting.set(id, resolve));
}

function permissionOptions() {
  const ids = scrambled
    ? ['q-1', 'q-2', 'q-3', 'q-4']
    : ['allow-always', 'reject-always', 'allow-once', 'reject-once'];
  const options = [
    { optionId: ids[0], name: 'Always allow', kind: 'allow_always' },
    { optionId: ids[1], name: 'Always reject', kind: 'reject_always' },
    { optionId: ids[2], name: 'Allow once', kind: 'allow_once' },
    { optionId: ids[3], name: 'Reject', kind: 'reject_once' },
  ];
  return scenario === 'no-reject' ? options.filter((o) => o.kind !== 'reject_once') : options;
}

function waitForCancel() {
  if (cancelled) return Promise.resolve();
  return new Promise((resolve) => cancelWaiters.push(resolve));
}

// --- gateway mode ---------------------------------------------------------------------------------

/** One streamed Chat Completions turn against the route's baseURL; HTTP errors throw. */
async function completion(messages, tools) {
  const response = await fetch(`${nexarBaseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${process.env.NEXAR_CONTROL_TOKEN}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: 'nexar-control',
      stream: true,
      stream_options: { include_usage: true },
      messages,
      tools,
    }),
  });
  if (!response.ok) throw new Error(`gateway answered HTTP ${response.status}`);
  let text = '';
  let finish;
  const calls = [];
  for (const frame of (await response.text()).split('\n\n')) {
    const data = frame.startsWith('data: ') ? frame.slice(6) : undefined;
    if (data === undefined || data === '[DONE]') continue;
    const choice = JSON.parse(data).choices?.[0];
    if (choice === undefined) continue;
    text += choice.delta?.content ?? '';
    for (const call of choice.delta?.tool_calls ?? []) {
      const into = (calls[call.index ?? 0] ??= {
        id: '',
        type: 'function',
        function: { name: '', arguments: '' },
      });
      into.id += call.id ?? '';
      into.function.name += call.function?.name ?? '';
      into.function.arguments += call.function?.arguments ?? '';
    }
    finish = choice.finish_reason ?? finish;
  }
  return { text, calls, finish };
}

function writeWorkspaceFile(path, content) {
  const root = process.cwd();
  const target = resolve(root, path);
  if (!target.startsWith(`${root}${sep}`)) throw new Error('path escapes the workspace');
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, content);
}

/** DSH's `mcp__<server>__<tool>` public name (dsh-mcp-client tools.ts `publicToolName`). */
function publicToolName(server, raw) {
  const joined = `mcp__${server}__${raw}`;
  const normalized = joined.replace(/[^A-Za-z0-9_-]/g, '_');
  if (normalized === joined && normalized.length <= 64) return normalized;
  const hash = createHash('sha256').update(`${server}\0${raw}`).digest('hex').slice(0, 12);
  return `${normalized.slice(0, 51)}_${hash}`;
}

/** A minimal MCP client over a stdio child: newline-delimited JSON-RPC. */
function mcpConnect(entry) {
  const env = { PATH: process.env.PATH };
  for (const { name, value } of entry.env ?? []) env[name] = value;
  const child = spawn(entry.command, entry.args ?? [], { env, stdio: ['pipe', 'pipe', 'ignore'] });
  const pending = new Map();
  let nextId = 1;
  createInterface({ input: child.stdout }).on('line', (line) => {
    const message = JSON.parse(line);
    pending.get(message.id)?.(message);
    pending.delete(message.id);
  });
  const request = (method, params) =>
    new Promise((resolveRequest, reject) => {
      const id = nextId++;
      const timer = setTimeout(() => reject(new Error(`mcp ${method} timed out`)), 30_000);
      pending.set(id, (message) => {
        clearTimeout(timer);
        if (message.error !== undefined) reject(new Error(`mcp ${method} failed`));
        else resolveRequest(message.result);
      });
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    });
  const notify = (method) => child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method })}\n`);
  return { request, notify, close: () => child.kill('SIGKILL') };
}

let nextToolCall = 1;

/** Announces one MCP tool call, asks the client's permission for it, and fails unless allowed once. */
async function permitted(sessionId, name, input) {
  const toolCallId = `mcp-${nextToolCall++}`;
  update(sessionId, {
    sessionUpdate: 'tool_call',
    toolCallId,
    title: publicToolName('nexar', name),
    kind: 'other',
    status: 'in_progress',
    rawInput: input,
  });
  const reply = await askClient('session/request_permission', {
    sessionId,
    toolCall: { toolCallId },
    options: permissionOptions(),
  });
  const optionId = reply?.result?.outcome?.optionId;
  (record.mcpPermissions ??= []).push(optionId ?? 'none');
  save();
  if (optionId !== 'allow-once') throw new Error('permission was not granted');
  update(sessionId, { sessionUpdate: 'tool_call_update', toolCallId, status: 'completed' });
}

/** submit, then poll status (at most 30 s); returns the unit's text. */
async function runUnit(sessionId, entry) {
  const mcp = mcpConnect(entry);
  try {
    await mcp.request('initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'fake-dsh', version: '0.0.1' },
    });
    mcp.notify('notifications/initialized');
    const listed = await mcp.request('tools/list', {});
    record.mcpTools = listed.tools.map((tool) => tool.name).sort();
    const call = async (name, args) => {
      await permitted(sessionId, name, args);
      const result = await mcp.request('tools/call', { name, arguments: args });
      if (result.isError === true) throw new Error(`${name} failed`);
      return JSON.parse(result.content[0].text);
    };
    const { jobId } = await call('nexar.intelligence_submit', {
      unitId: 'unit-1',
      capabilities: [unitCapability],
      input: 'UNIT-INPUT-TEXT',
      access: 'draft',
    });
    const deadline = Date.now() + 30_000;
    for (;;) {
      const status = await call('nexar.intelligence_status', { jobId });
      if (status.state === 'done') {
        record.mcpUnit = {
          outcome: status.result.outcome,
          resourceId: status.result.resourceId,
          errorCode: status.result.errorCode,
          textLength: status.result.text?.length,
        };
        save();
        if (status.result.outcome !== 'succeeded') throw new Error('unit did not succeed');
        return status.result.text;
      }
      if (Date.now() > deadline) throw new Error('unit did not finish');
      await new Promise((r) => setTimeout(r, 50));
    }
  } finally {
    mcp.close();
  }
}

async function runGatewayPrompt(id, sessionId, promptText) {
  try {
    const tools = [
      {
        type: 'function',
        function: {
          name: 'write_file',
          description: 'Write a file in the workspace',
          parameters: {
            type: 'object',
            properties: { path: { type: 'string' }, content: { type: 'string' } },
            required: ['path', 'content'],
          },
        },
      },
    ];
    const messages = [{ role: 'user', content: promptText }];
    const first = await completion(messages, tools);
    if (first.calls.length === 0) throw new Error('turn 1 returned no tool call');
    messages.push({ role: 'assistant', content: first.text || null, tool_calls: first.calls });
    for (const call of first.calls) {
      const args = JSON.parse(call.function.arguments);
      writeWorkspaceFile(args.path, args.content);
      messages.push({ role: 'tool', tool_call_id: call.id, content: 'ok' });
    }
    const second = await completion(messages, tools);
    if (second.calls.length > 0) throw new Error('turn 2 returned another tool call');
    let answer = second.text;
    const entry = mcpServers.find((s) => s.name === 'nexar');
    if (entry !== undefined && setting('unit', '1') === '1')
      answer += ` | unit: ${await runUnit(sessionId, entry)}`;
    update(sessionId, {
      sessionUpdate: 'agent_message_chunk',
      content: { type: 'text', text: answer },
    });
    send({ id, result: { stopReason } });
  } catch (error) {
    send({ id, error: { code: -32603, message: String(error.message).slice(0, 120) } });
  }
}

async function runPrompt(id, sessionId, promptText) {
  update(sessionId, {
    sessionUpdate: 'agent_message_chunk',
    content: { type: 'text', text: 'working. ' },
  });
  if (exitOnce !== undefined && !existsSync(exitOnce)) {
    // Crash mid-turn the first time only (the marker survives for the next process).
    writeFileSync(exitOnce, 'x');
    process.exit(3);
  }
  if (nexarBaseUrl !== undefined && scenario === 'normal') {
    return runGatewayPrompt(id, sessionId, promptText);
  }

  if (scenario === 'model-change') {
    update(sessionId, {
      sessionUpdate: 'config_option_update',
      configOptions: [{ id: 'model', currentValue: JSON.stringify(['deepseek-official', 'x']) }],
    });
    await waitForCancel();
    send({ id, result: { stopReason: 'cancelled' } });
    return;
  }
  if (scenario === 'hang') {
    await waitForCancel();
    if (ignoreCancel) return;
    send({ id, result: { stopReason: 'cancelled' } });
    return;
  }
  if (scenario === 'rpc-error') {
    send({ id, error: { code: -32603, message: rpcMessage } });
    return;
  }
  if (scenario === 'probe-fs') {
    for (const method of ['fs/read_text_file', 'terminal/create', 'something/unknown']) {
      await askClient(method, { sessionId, path: '/etc/passwd' });
    }
    send({ id, result: { stopReason: 'end_turn' } });
    return;
  }

  const toolCallId = scenario === 'unknown-call' ? 'never-announced' : 'call-1';
  if (scenario !== 'unknown-call') {
    update(sessionId, {
      sessionUpdate: 'tool_call',
      toolCallId,
      title: tool,
      kind: 'execute',
      status: 'in_progress',
      ...(scenario === 'no-input' ? {} : { rawInput: input }),
    });
  }
  const pending = askClient('session/request_permission', {
    sessionId,
    toolCall: { toolCallId },
    options: permissionOptions(),
  });

  if (scenario === 'hang-permission') {
    await waitForCancel();
    const reply = await pending;
    record.permissionReply = reply;
    save();
    if (ignoreCancel) return;
    send({ id, result: { stopReason: 'cancelled' } });
    return;
  }

  const reply = await pending;
  record.permissionReply = reply;
  const outcome = reply?.result?.outcome;
  const label =
    reply?.error !== undefined
      ? 'error'
      : outcome?.outcome === 'selected'
        ? outcome.optionId
        : (outcome?.outcome ?? 'none');
  record.permissionLabel = label;
  save();
  update(sessionId, { sessionUpdate: 'tool_call_update', toolCallId, status: 'completed' });
  update(sessionId, {
    sessionUpdate: 'agent_message_chunk',
    content: { type: 'text', text: `permission:${label}` },
  });
  update(sessionId, {
    sessionUpdate: 'usage_update',
    used: 1234,
    size: 100000,
    cost: { amount: 0.5, currency: 'USD' },
  });
  send({ id, result: { stopReason } });
}

const rl = createInterface({ input: process.stdin });
rl.on('line', (line) => {
  const msg = JSON.parse(line);
  if (msg.method === undefined) {
    // A reply to something this agent asked the client.
    record.clientReplies.push(msg);
    waiting.get(msg.id)?.(msg);
    waiting.delete(msg.id);
    save();
    return;
  }
  if (msg.id === undefined) {
    record.notifications.push({ method: msg.method, params: msg.params });
    if (msg.method === 'session/cancel') {
      cancelled = true;
      for (const wake of cancelWaiters.splice(0)) wake();
    }
    save();
    return;
  }
  record.requests.push({ method: msg.method, params: redacted(msg.params) });
  save();
  switch (msg.method) {
    case 'initialize':
      send({
        id: msg.id,
        result: {
          protocolVersion: protocol,
          agentInfo: { name: 'deepseek-harness-acp', version: '0.0.1' },
          agentCapabilities: { sessionCapabilities: { close: {}, list: {}, resume: {} } },
          authMethods: [],
        },
      });
      break;
    case 'session/new':
      mcpServers = msg.params.mcpServers ?? [];
      {
        const env = Object.fromEntries((mcpServers[0]?.env ?? []).map((e) => [e.name, e.value]));
        record.mcpEndpoint = env.NEXAR_BRIDGE_ENDPOINT;
        record.mcpTokenIsControlToken =
          env.NEXAR_BRIDGE_TOKEN !== undefined &&
          env.NEXAR_BRIDGE_TOKEN === process.env.NEXAR_CONTROL_TOKEN;
        record.hasControlToken = process.env.NEXAR_CONTROL_TOKEN !== undefined;
        save();
      }
      send({ id: msg.id, result: { sessionId: 'sess-1', configOptions: [] } });
      break;
    case 'session/set_config_option':
      if (
        nexarBaseUrl !== undefined &&
        msg.params.configId === 'model' &&
        msg.params.value !== NEXAR_MODEL_VALUE
      ) {
        send({ id: msg.id, error: { code: -32602, message: 'unknown model option' } });
        break;
      }
      send({ id: msg.id, result: { configOptions: [] } });
      break;
    case 'session/prompt':
      void runPrompt(msg.id, msg.params.sessionId, msg.params.prompt?.[0]?.text ?? '');
      break;
    case 'session/close':
      send({ id: msg.id, result: {} });
      break;
    default:
      send({ id: msg.id, error: { code: -32601, message: 'Method not found' } });
  }
});
rl.on('close', () => {
  if (!ignoreCancel) process.exit(0);
});
process.on('SIGTERM', () => {
  if (!ignoreCancel) process.exit(0);
});
