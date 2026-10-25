// Fake `agy` CLI for tests; CI must never call the real one.
//
// Control comes from leading `--fake-*` args, which are stripped before the invocation is recorded:
//   --fake-record=FILE     append each invocation (argv, cwd, pid, env) to FILE as JSON
//   --fake-mode=MODE       success | zero-usage | activity | error | exit3 | quota | oauth |
//                          denial | no-result | garbage | hang | bigline
//   --fake-version=X.Y.Z   version printed by `--version` (default 1.2.14)
//   --fake-logged-out      `models` prints "Please sign in to view available models"
//   --fake-models-empty    `models` prints nothing and exits 0
//   --fake-pidfile=FILE    hang/oauth modes write their grandchild's pid here
import { spawn } from 'node:child_process';
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';

const flags = {};
const argv = [];
for (const a of process.argv.slice(2)) {
  const m = /^--fake-([a-z-]+)(?:=(.*))?$/.exec(a);
  if (m) flags[m[1]] = m[2] ?? '1';
  else argv.push(a);
}
const mode = flags.mode ?? 'success';

function record() {
  const file = flags.record;
  if (!file) return;
  const entries = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : [];
  entries.push({ argv, cwd: process.cwd(), pid: process.pid, env: { ...process.env } });
  writeFileSync(file, JSON.stringify(entries));
}

const emit = (event) => process.stdout.write(JSON.stringify(event) + '\n');
const usage = (u) => ({
  input_tokens: 0,
  output_tokens: 0,
  thinking_tokens: 0,
  cache_read_tokens: 0,
  total_tokens: 0,
  ...u,
});
const result = (fields) => ({
  type: 'result',
  conversation_id: 'conv-fake',
  status: 'SUCCESS',
  response: '',
  duration_seconds: 1,
  num_turns: 2,
  ...fields,
});
const init = () =>
  emit({
    type: 'init',
    conversation_id: 'conv-fake',
    cwd: '/work',
    tools: ['run_command'],
    permission_mode: 'bypass',
  });
const printArg = argv.find((a) => a.startsWith('--print='));
const prompt = printArg === undefined ? '' : printArg.slice('--print='.length);

function spawnGrandchild() {
  const grandchild = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
    stdio: 'ignore',
  });
  if (flags.pidfile) {
    const staged = `${flags.pidfile}.${process.pid}.tmp`;
    writeFileSync(staged, String(grandchild.pid));
    renameSync(staged, flags.pidfile);
  }
}

record();

if (argv[0] === '--version') {
  process.stdout.write(`agy ${flags.version ?? '1.2.14'}\n`);
} else if (argv[0] === 'models') {
  if (flags['logged-out']) process.stdout.write('Please sign in to view available models\n');
  else if (!flags['models-empty']) process.stdout.write('gemini-3.1-pro\ngemini-3.8-flash\n');
} else {
  init();
  switch (mode) {
    case 'success':
      emit(
        result({
          response: `ECHO: ${prompt}`,
          usage: usage({
            input_tokens: 100,
            output_tokens: 10,
            thinking_tokens: 5,
            cache_read_tokens: 40,
            total_tokens: 155,
          }),
        }),
      );
      break;
    case 'zero-usage':
      emit(result({ response: 'ok', usage: usage({}) }));
      break;
    case 'activity':
      emit({
        type: 'step_update',
        step_index: 1,
        state: 'ACTIVE',
        step_type: 'tool',
        tool_info: { name: 'run_command', parameters: { command: 'SECRET-COMMAND-TEXT' } },
      });
      emit({
        type: 'step_update',
        step_index: 1,
        state: 'DONE',
        step_type: 'tool',
        tool_info: {
          name: 'run_command',
          parameters: { command: 'SECRET-COMMAND-TEXT' },
          output: 'SECRET-OUTPUT-TEXT',
        },
      });
      emit({
        type: 'step_update',
        step_index: 2,
        state: 'DONE',
        step_type: 'agent_response',
        text_delta: 'SECRET-DELTA',
      });
      emit(
        result({ response: 'final answer', usage: usage({ input_tokens: 1, output_tokens: 2 }) }),
      );
      break;
    case 'error':
      emit(result({ status: 'ERROR', error: 'the model fell over', response: '' }));
      process.exitCode = 1;
      break;
    case 'exit3':
      process.stderr.write('AGY_ERROR: {"status":"ERROR","code":"INTERNAL","retryable":true}\n');
      process.exitCode = 3;
      break;
    case 'quota':
      process.stderr.write(
        'AGY_ERROR: {"status":"ERROR","code":"RESOURCE_EXHAUSTED","retryable":false}\n',
      );
      process.exitCode = 3;
      break;
    case 'oauth':
      spawnGrandchild(); // before the line: the adapter kills the group as soon as it sees it
      process.stderr.write('Print mode: triggering interactive OAuth\n');
      process.on('SIGTERM', () => undefined); // forces the SIGKILL path
      setInterval(() => undefined, 1000);
      break;
    case 'denial':
      process.stderr.write('notice: permission denied for tool run_command (soft-denied)\n');
      process.stderr.write('notice: permission denied for tool write_file (soft-denied)\n');
      emit(result({ response: 'partial', usage: usage({ input_tokens: 1, output_tokens: 1 }) }));
      break;
    case 'no-result':
      break;
    case 'garbage':
      process.stdout.write('not json at all\n');
      process.stdout.write('{broken json\n');
      process.stdout.write('\n');
      process.stdout.write('[1,2,3]\n');
      emit(
        result({ response: 'after garbage', usage: usage({ input_tokens: 1, output_tokens: 1 }) }),
      );
      break;
    case 'bigline':
      process.stdout.write('x'.repeat(1024 * 1024 + 10) + '\n');
      setInterval(() => undefined, 1000);
      break;
    case 'hang':
      spawnGrandchild();
      process.on('SIGTERM', () => undefined); // ignore: forces the SIGKILL path
      setInterval(() => undefined, 1000);
      break;
  }
}
