// Fake `claude` CLI for tests; CI must never call the real one.
//
// Env controls:
//   FAKE_CLAUDE_RECORD      file to which each invocation (argv, stdin, env, pid) is appended as JSON
//   FAKE_CLAUDE_ENV_KEYS    comma-separated env names whose values are recorded (names of all are too)
//   FAKE_CLAUDE_MODE        success | error | garbage | hang | auth   (for print-mode runs)
//   FAKE_CLAUDE_LOGGED_OUT  "1" makes `auth status` report loggedIn:false
//   FAKE_CLAUDE_OMIT_USAGE  "1" drops usage/cost/turns from the success result
//   With `--output-format stream-json` in argv the fake emits stream events (an init line, an
//   assistant line with tool_use blocks whose input is TOOL-INPUT-SENTINEL, then the result line):
//   FAKE_CLAUDE_TOOLS       comma-separated tool names to emit as tool_use (default "Read,Bash")
//   FAKE_CLAUDE_DENIALS     number of permission_denials entries to put in the result
//   FAKE_CLAUDE_NO_RESULT   "1" omits the final result line
import { existsSync, readFileSync, writeFileSync } from 'node:fs';

const argv = process.argv.slice(2);
const mode = process.env.FAKE_CLAUDE_MODE ?? 'success';

function readStdin() {
  return new Promise((resolve) => {
    if (process.stdin.isTTY) {
      resolve('');
      return;
    }
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (c) => (data += c));
    process.stdin.on('end', () => resolve(data));
    process.stdin.on('error', () => resolve(data));
  });
}

function record(stdin) {
  const file = process.env.FAKE_CLAUDE_RECORD;
  if (!file) return;
  const keys = (process.env.FAKE_CLAUDE_ENV_KEYS ?? '').split(',').filter(Boolean);
  const entries = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : [];
  entries.push({
    argv,
    stdin,
    cwd: process.cwd(),
    pid: process.pid,
    envNames: Object.keys(process.env),
    env: Object.fromEntries(keys.map((k) => [k, process.env[k]])),
  });
  writeFileSync(file, JSON.stringify(entries));
}

const streaming = argv.includes('stream-json');

function emit(result) {
  if (!streaming) {
    process.stdout.write(JSON.stringify(result) + '\n');
    return;
  }
  const tools = (process.env.FAKE_CLAUDE_TOOLS ?? 'Read,Bash').split(',').filter(Boolean);
  process.stdout.write(JSON.stringify({ type: 'system', subtype: 'init' }) + '\n');
  process.stdout.write(
    JSON.stringify({
      type: 'assistant',
      message: {
        content: [
          { type: 'text', text: 'working' },
          ...tools.map((name, i) => ({
            type: 'tool_use',
            id: `tu-${i}`,
            name,
            input: { command: 'TOOL-INPUT-SENTINEL' },
          })),
        ],
      },
    }) + '\n',
  );
  const denials = Number(process.env.FAKE_CLAUDE_DENIALS ?? 0);
  if (denials > 0) {
    result.permission_denials = Array.from({ length: denials }, () => ({
      tool_name: 'Bash',
      tool_input: { command: 'DENIED-SENTINEL' },
    }));
  }
  if (process.env.FAKE_CLAUDE_NO_RESULT !== '1')
    process.stdout.write(JSON.stringify(result) + '\n');
}

function modelFromArgs() {
  const i = argv.indexOf('--model');
  return i >= 0 ? argv[i + 1] : 'claude-fake-default';
}

if (argv[0] === '--version') {
  record('');
  process.stdout.write('9.9.9 (Claude Code fake)\n');
} else if (argv[0] === 'auth' && argv[1] === 'status') {
  record('');
  const loggedIn = process.env.FAKE_CLAUDE_LOGGED_OUT !== '1';
  process.stdout.write(JSON.stringify({ loggedIn }) + '\n');
  if (!loggedIn) process.exitCode = 1;
} else {
  const stdin = await readStdin();
  record(stdin);
  switch (mode) {
    case 'success': {
      const result = {
        type: 'result',
        subtype: 'success',
        is_error: false,
        duration_ms: 1200,
        num_turns: 1,
        result: `ECHO: ${stdin}`,
        session_id: 'fake-session',
      };
      if (process.env.FAKE_CLAUDE_OMIT_USAGE !== '1') {
        result.total_cost_usd = 0.0123;
        result.usage = {
          input_tokens: 10,
          output_tokens: 5,
          cache_read_input_tokens: 3,
          cache_creation_input_tokens: 2,
        };
      }
      result.modelUsage = { [modelFromArgs()]: { inputTokens: 10, outputTokens: 5 } };
      emit(result);
      break;
    }
    case 'error':
      emit({
        type: 'result',
        subtype: 'error_during_execution',
        is_error: true,
        api_error_status: 529,
        result: 'overloaded',
      });
      process.stderr.write('upstream exploded\n');
      process.exitCode = 1;
      break;
    case 'garbage':
      process.stdout.write('this is not json\n');
      break;
    case 'auth':
      process.stderr.write('Not logged in. Run `claude auth login`.\n');
      process.exitCode = 1;
      break;
    case 'hang':
      setInterval(() => undefined, 1000);
      break;
    default:
      process.stderr.write(`unknown FAKE_CLAUDE_MODE ${mode}\n`);
      process.exitCode = 2;
  }
}
