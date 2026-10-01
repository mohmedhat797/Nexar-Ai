// Fake Delegate Skills codex relay for tests; CI must never run the real relay or codex.
//
// Control comes from env set by the fake launcher (the real adapter passes no parent env):
//   FAKE_RELAY_SCENARIO  completed | zero-usage | no-events | failed-auth | failed-limit |
//                        failed-other | timeout | aborted | codex-unavailable | malformed |
//                        wrong-schema | bad-types | missing | symlink | hang
//   FAKE_RELAY_RECORD    file that receives {argv, stdin, cwd, pid, env} as JSON
//   FAKE_RELAY_PIDFILE   `hang` writes its grandchild's pid here
import { spawn } from 'node:child_process';
import { symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const scenario = process.env.FAKE_RELAY_SCENARIO ?? 'completed';
const argv = process.argv.slice(2);
const outDir = argv[argv.indexOf('--out-dir') + 1];

function readStdin() {
  return new Promise((resolve) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (c) => (data += c));
    process.stdin.on('end', () => resolve(data));
    process.stdin.on('error', () => resolve(data));
  });
}

const stdin = await readStdin();
if (process.env.FAKE_RELAY_RECORD) {
  writeFileSync(
    process.env.FAKE_RELAY_RECORD,
    JSON.stringify({ argv, stdin, cwd: process.cwd(), pid: process.pid, env: { ...process.env } }),
  );
}

const base = {
  schema: 'delegate-relay.result.v1',
  lane: null,
  workdir: process.cwd(),
  model: null,
  status: 'completed',
  exitCode: 0,
  signal: null,
  finalMessage: 'RELAY-FINAL',
  touchedFiles: [' M a.txt', '?? b.txt'],
  stderrTail: null,
  error: null,
  codexVersion: 'codex-cli 0.159.3',
};
const usage = (u) => ({
  input_tokens: 0,
  cached_input_tokens: 0,
  cache_write_input_tokens: 0,
  output_tokens: 0,
  reasoning_output_tokens: 0,
  ...u,
});
const events = (...lines) => lines.map((l) => JSON.stringify(l)).join('\n') + '\n';
const turn = (u) => ({ type: 'turn.completed', usage: usage(u) });
const result = (extra) =>
  writeFileSync(join(outDir, 'result.json'), JSON.stringify({ ...base, ...extra }));
const failed = (extra) => result({ status: 'failed', exitCode: 1, ...extra });

switch (scenario) {
  case 'completed':
    result({ model: 'gpt-relay' });
    writeFileSync(
      join(outDir, 'events.jsonl'),
      events(
        { type: 'thread.started', thread_id: 't1' },
        turn({ input_tokens: 1, output_tokens: 1 }),
        turn({
          input_tokens: 100,
          cached_input_tokens: 40,
          output_tokens: 7,
          reasoning_output_tokens: 3,
        }),
      ),
    );
    break;
  case 'zero-usage':
    result({});
    writeFileSync(join(outDir, 'events.jsonl'), events(turn({})));
    break;
  case 'no-events':
    result({});
    break;
  case 'failed-auth':
    failed({ error: 'codex exited 1', stderrTail: 'ERROR: 401 Unauthorized, please log in' });
    break;
  case 'failed-limit':
    failed({ error: "You've hit your usage limit.", stderrTail: '' });
    break;
  case 'failed-other':
    failed({ error: 'segfault', stderrTail: 'boom' });
    break;
  case 'timeout':
    result({ status: 'timeout', exitCode: 124 });
    break;
  case 'aborted':
    result({ status: 'aborted', exitCode: 130 });
    break;
  case 'codex-unavailable':
    result({ status: 'codex_unavailable', exitCode: 127 });
    break;
  case 'malformed':
    writeFileSync(join(outDir, 'result.json'), '{ not json');
    break;
  case 'wrong-schema':
    result({ schema: 'delegate-relay.result.v2' });
    break;
  case 'bad-types':
    result({ finalMessage: 42 });
    break;
  case 'missing':
    break;
  case 'symlink':
    symlinkSync(process.argv[1], join(outDir, 'result.json'));
    break;
  case 'hang': {
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
      stdio: 'ignore',
    });
    if (process.env.FAKE_RELAY_PIDFILE) {
      writeFileSync(process.env.FAKE_RELAY_PIDFILE, String(child.pid));
    }
    setInterval(() => {}, 1000);
    await new Promise(() => {});
    break;
  }
  default:
    process.exit(2);
}
