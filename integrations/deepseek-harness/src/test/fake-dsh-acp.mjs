// Protocol-faithful fake of `dsh --profile acp` (ACP v1, newline-delimited JSON-RPC) for offline tests.
//
// The adapter launches the agent with an explicit allowlisted env, so behaviour is chosen with
// leading `--fake-<name>=<value>` argv entries. Every received message is recorded to
// `--fake-record=<path>`.
//
//   --fake-protocol=1|2        protocolVersion answered by `initialize` (default 1)
//   --fake-scenario=<name>     normal (default) | unknown-call | no-reject | hang | hang-permission |
//                              rpc-error | probe-fs | no-input
//   --fake-ignore-cancel=1     never answer the prompt after `session/cancel` (forces a kill)
//   --fake-tool=<name>         tool name used as the `tool_call` title (default `bash`)
//   --fake-input=<json>        `rawInput` of the tool call (default {"command":"ls"})
//   --fake-ids=scrambled       option ids that do not hint at their kind
//   --fake-stop=<reason>       stopReason of the prompt response (default end_turn)
//   --fake-rpc-message=<text>  error message for the rpc-error scenario
import { renameSync, writeFileSync } from 'node:fs';
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

const record = {
  argv,
  envKeys: Object.keys(process.env).sort(),
  dshHome: process.env.DSH_HOME,
  cwd: process.cwd(),
  pid: process.pid,
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

async function runPrompt(id, sessionId) {
  update(sessionId, {
    sessionUpdate: 'agent_message_chunk',
    content: { type: 'text', text: 'working. ' },
  });

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
  record.requests.push({ method: msg.method, params: msg.params });
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
      send({ id: msg.id, result: { sessionId: 'sess-1', configOptions: [] } });
      break;
    case 'session/set_config_option':
      send({ id: msg.id, result: { configOptions: [] } });
      break;
    case 'session/prompt':
      void runPrompt(msg.id, msg.params.sessionId);
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
