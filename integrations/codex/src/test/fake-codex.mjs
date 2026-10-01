// Fake `codex` CLI for tests; CI must never call the real one.
//
// Control comes from leading `--fake-*` args (the adapter does not pass its env through, so env
// would not survive), which are stripped before the invocation is recorded:
//   --fake-record=FILE     append each invocation (argv, stdin, cwd, pid, env) to FILE as JSON
//   --fake-mode=MODE       success | zero-usage | activity | auth | limit | reconnect | garbage |
//                          hang | bigline | fail
//   --fake-version=X.Y.Z   version printed by `--version` (default 0.159.3)
//   --fake-logged-out      `login status` reports "Not logged in"
//   --fake-pidfile=FILE    hang mode writes its grandchild's pid here
import { spawn } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';

const flags = {};
const argv = [];
for (const a of process.argv.slice(2)) {
  const m = /^--fake-([a-z-]+)(?:=(.*))?$/.exec(a);
  if (m) flags[m[1]] = m[2] ?? '1';
  else argv.push(a);
}
const mode = flags.mode ?? 'success';

function readStdin() {
  return new Promise((resolve) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (c) => (data += c));
    process.stdin.on('end', () => resolve(data));
    process.stdin.on('error', () => resolve(data));
  });
}

function record(stdin) {
  const file = flags.record;
  if (!file) return;
  const entries = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : [];
  entries.push({
    argv,
    stdin,
    cwd: process.cwd(),
    pid: process.pid,
    env: { ...process.env },
  });
  writeFileSync(file, JSON.stringify(entries));
}

const emit = (event) => process.stdout.write(JSON.stringify(event) + '\n');
const usage = (u) => ({
  input_tokens: 0,
  cached_input_tokens: 0,
  cache_write_input_tokens: 0,
  output_tokens: 0,
  reasoning_output_tokens: 0,
  ...u,
});
const message = (text) => ({
  type: 'item.completed',
  item: { id: 'item_1', type: 'agent_message', text },
});

if (argv[0] === '--version') {
  record('');
  process.stdout.write(`codex-cli ${flags.version ?? '0.159.3'}\n`);
} else if (argv[0] === 'login' && argv[1] === 'status') {
  record('');
  process.stdout.write(flags['logged-out'] ? 'Not logged in\n' : 'Logged in using ChatGPT\n');
} else {
  const stdin = await readStdin();
  record(stdin);
  emit({ type: 'thread.started', thread_id: 'thread-fake' });
  emit({ type: 'turn.started' });
  switch (mode) {
    case 'success':
      emit(message(`ECHO: ${stdin}`));
      emit({
        type: 'turn.completed',
        usage: usage({
          input_tokens: 100,
          cached_input_tokens: 40,
          cache_write_input_tokens: 7,
          output_tokens: 10,
          reasoning_output_tokens: 5,
        }),
      });
      break;
    case 'zero-usage':
      emit(message('ok'));
      emit({ type: 'turn.completed', usage: usage({}) });
      break;
    case 'activity':
      emit({ type: 'item.started', item: { id: 'item_0', type: 'command_execution' } });
      emit({
        type: 'item.completed',
        item: {
          id: 'item_0',
          type: 'command_execution',
          command: 'SECRET-COMMAND-TEXT',
          exit_code: 0,
          status: 'completed',
        },
      });
      emit({
        type: 'item.completed',
        item: {
          id: 'item_2',
          type: 'file_change',
          changes: [
            { path: 'a.txt', kind: 'add' },
            { path: 'b.txt', kind: 'update' },
          ],
          status: 'completed',
        },
      });
      emit(message('first'));
      emit(message('final answer'));
      emit({ type: 'turn.completed', usage: usage({ input_tokens: 1, output_tokens: 2 }) });
      break;
    case 'auth':
      emit({ type: 'error', message: 'Reconnecting... 1/5' });
      emit({ type: 'turn.failed', error: { message: '401 Unauthorized: please log in' } });
      process.exitCode = 1;
      break;
    case 'limit':
      emit({ type: 'error', message: "You've hit your usage limit. Try again later." });
      emit({ type: 'turn.failed', error: { message: "You've hit your usage limit." } });
      process.exitCode = 1;
      break;
    case 'reconnect':
      emit({ type: 'error', message: 'Reconnecting... 1/5 (stream disconnected)' });
      emit({ type: 'error', message: 'Reconnecting... 2/5 (stream disconnected)' });
      emit(message('recovered'));
      emit({ type: 'turn.completed', usage: usage({ input_tokens: 3, output_tokens: 4 }) });
      break;
    case 'garbage':
      process.stdout.write('not json at all\n');
      process.stdout.write('{broken json\n');
      process.stdout.write('\n');
      emit(message('after garbage'));
      process.stdout.write('[1,2,3]\n');
      emit({ type: 'turn.completed', usage: usage({ input_tokens: 1, output_tokens: 1 }) });
      break;
    case 'fail':
      process.stderr.write('boom happened\n');
      process.exitCode = 3;
      break;
    case 'bigline':
      process.stdout.write('x'.repeat(1024 * 1024 + 10) + '\n');
      setInterval(() => undefined, 1000);
      break;
    case 'hang': {
      const grandchild = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
        stdio: 'ignore',
      });
      if (flags.pidfile) writeFileSync(flags.pidfile, String(grandchild.pid));
      process.on('SIGTERM', () => undefined); // ignore: forces the SIGKILL path
      setInterval(() => undefined, 1000);
      break;
    }
  }
}
