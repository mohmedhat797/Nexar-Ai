// Protocol-faithful fake of `dsh --profile sdk` for offline tests.
//
// Behavior is chosen by `FAKE_DSH_MODE`. The adapter launches the runtime with an explicit
// allowlisted env, so tests can also pass settings as `--fake-<name>=<value>` argv entries
// (e.g. `--fake-mode=success`); argv wins over env.
import { readFileSync, writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline';

const argv = process.argv.slice(2);

function setting(name, fallback) {
  const prefix = `--fake-${name.toLowerCase()}=`;
  const fromArgv = argv.find((a) => a.startsWith(prefix));
  if (fromArgv !== undefined) return fromArgv.slice(prefix.length);
  return process.env[`FAKE_DSH_${name.toUpperCase()}`] ?? fallback;
}

const mode = setting('mode', 'success');
const version = setting('version', '0.2.0-rc.2');
const recordPath = setting('record', undefined);
const stderrText = setting('stderr', 'fatal: fake runtime crashed');

const record = {
  argv,
  envKeys: Object.keys(process.env).sort(),
  dshHome: process.env.DSH_HOME,
  cwd: process.cwd(),
  requests: [],
};

function save() {
  if (recordPath === undefined) return;
  writeFileSync(recordPath, JSON.stringify(record, null, 2));
}

function send(message) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`);
}

function notify(method, params) {
  send({ method, params });
}

function sessionEvent(sessionId, event) {
  notify('session.event', { sessionId, event });
}

function assistant(sessionId, text, usage) {
  sessionEvent(sessionId, {
    type: 'assistant/message',
    data: {
      message: { role: 'assistant', content: [{ type: 'text', text }] },
      ...(usage === undefined ? {} : { usage }),
    },
  });
}

function turnEnd(sessionId, reason) {
  sessionEvent(sessionId, { type: 'turn/end', data: { reason } });
}

if (argv.includes('--version')) {
  process.stdout.write(`${version}\n`);
  process.exit(0);
}

// Capture the overlay the adapter generated so tests can assert on it.
const patchIndex = argv.indexOf('--patch');
if (patchIndex !== -1 && argv[patchIndex + 1] !== undefined) {
  record.overlayPath = argv[patchIndex + 1];
  try {
    record.overlay = readFileSync(record.overlayPath, 'utf8');
  } catch {
    record.overlay = null;
  }
}
save();

if (mode === 'crash-on-init') {
  process.stderr.write(`${stderrText}\n`);
  process.exit(1);
}

function runTurn(sessionId, messageId) {
  const receipt = () =>
    sessionEvent(sessionId, {
      type: 'agent/inbox/spliced',
      data: { inserted: [{ id: messageId }] },
    });

  if (mode === 'crash-after-prompt') {
    receipt();
    process.stderr.write(`${stderrText}\n`);
    process.exit(3);
  }

  // Noise that must be ignored: another session, and an idle before our receipt.
  sessionEvent('other-session', {
    type: 'assistant/message',
    data: { message: { content: [{ type: 'text', text: 'NOT MINE' }] } },
  });
  notify('session.status', { sessionId: sessionId, status: 'idle' });
  receipt();
  notify('session.status', { sessionId, status: 'running' });

  if (mode === 'hang') return;

  if (mode === 'success') {
    sessionEvent(sessionId, {
      type: 'tool/call',
      data: { name: 'read_file', input: { path: 'a.txt' } },
    });
    assistant(sessionId, 'thinking…', { inputTokens: 10, outputTokens: 5, cacheReadTokens: 2 });
    assistant(sessionId, 'final answer', {
      inputTokens: 20,
      outputTokens: 7,
      cacheReadTokens: 1,
      cacheWriteTokens: 4,
    });
    turnEnd(sessionId, { kind: 'completed' });
  } else if (mode === 'no-usage') {
    assistant(sessionId, 'no usage here');
    turnEnd(sessionId, { kind: 'completed' });
  } else if (mode === 'aborted-turn') {
    turnEnd(sessionId, { kind: 'aborted' });
  } else if (mode === 'error-turn') {
    turnEnd(sessionId, { kind: 'error', error: { message: setting('error', 'model exploded') } });
  } else if (mode === 'max-tokens') {
    assistant(sessionId, 'partial answ', { inputTokens: 3, outputTokens: 4 });
    turnEnd(sessionId, { kind: 'max-tokens' });
  } else if (mode === 'max-tokens-empty') {
    turnEnd(sessionId, { kind: 'max-tokens' });
  } else if (mode === 'no-turn-end') {
    assistant(sessionId, 'text without turn end');
  } else if (mode === 'no-turn-end-empty') {
    // nothing
  } else if (mode === 'garbage-line') {
    process.stdout.write('this is not json\n');
    return;
  }
  notify('session.status', { sessionId, status: 'idle' });
}

const rl = createInterface({ input: process.stdin });
rl.on('line', (line) => {
  if (line.trim() === '') return;
  const message = JSON.parse(line);
  record.requests.push(message);
  save();

  if (message.method === 'initialize') {
    if (mode === 'garbage-line') {
      process.stdout.write('this is not json\n');
      return;
    }
    const name = mode === 'wrong-identity' ? 'some-other-runtime' : 'deepseek-harness-sdk-runtime';
    send({ id: message.id, result: { serverInfo: { name, version } } });
  } else if (message.method === 'session/prompt') {
    const { sessionId } = message.params;
    const messageId = `msg-${sessionId}`;
    if (setting('early_receipt', '') === '1') {
      // Receipt before the response: the client must buffer until it knows the message id.
      runTurn(sessionId, messageId);
      send({ id: message.id, result: { messageId } });
    } else {
      send({ id: message.id, result: { messageId } });
      runTurn(sessionId, messageId);
    }
  } else if (message.method === 'shutdown') {
    send({ id: message.id, result: {} });
    setTimeout(() => process.exit(0), 10);
  }
});
rl.on('close', () => process.exit(0));
