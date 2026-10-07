// Fake `openworker` executable for supervisor tests. Behaviour knobs arrive through FAKE_OW_* env
// variables that the test's spawn wrapper adds after the supervisor built its (allowlisted) env.
import { appendFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { FakeOpenWorkerServer } from './fake-server.ts';

const argv = process.argv.slice(2);
if (argv[0] === 'version') {
  process.stdout.write(`openworker ${process.env.FAKE_OW_VERSION ?? '0.3.1'}\n`);
  process.exit(0);
}

const state = process.env.COWORKER_STATE_DIR ?? '';
const flag = (name) => argv[argv.indexOf(name) + 1];
const record = (name, value) =>
  state === '' ? undefined : appendFileSync(join(state, name), `${JSON.stringify(value)}\n`);

record('launch.jsonl', {
  argv,
  envKeys: Object.keys(process.env).sort(),
  tokenSeen: (process.env.COWORKER_API_TOKEN ?? '').length,
});

const server = new FakeOpenWorkerServer({
  token: process.env.COWORKER_API_TOKEN ?? '',
  host: flag('--host'),
  port: Number(flag('--port')),
  startDelayMs: Number(process.env.FAKE_OW_START_DELAY_MS ?? 0),
  neverReady: process.env.FAKE_OW_NEVER_READY === '1',
  failProviders: process.env.FAKE_OW_FAIL_PROVIDERS === '1',
  refuseProviders: process.env.FAKE_OW_REFUSE_PROVIDERS === '1',
  onRecord: (entry) => record('records.jsonl', entry),
});
await server.listen();
if (state !== '') writeFileSync(join(state, 'listening'), '1');
setInterval(() => undefined, 60_000);
