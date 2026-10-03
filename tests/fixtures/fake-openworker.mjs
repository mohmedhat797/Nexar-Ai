// Fake `openworker` for Desktop tests (NEXAR_DESKTOP_TEST_OPENWORKER). Selectors arrive as
// NEXAR_FAKE_OPENWORKER_* variables: VERSION, SCENARIO, NEVER_READY, FAIL_PROVIDERS.
// Loads the adapter's fake server directly with Node's type stripping.
import { appendFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { FakeOpenWorkerServer } from '../../integrations/openworker/src/test/fake-server.ts';

const argv = process.argv.slice(2);
const env = process.env;
if (argv[0] === 'version') {
  process.stdout.write(`openworker ${env.NEXAR_FAKE_OPENWORKER_VERSION ?? '0.3.0'}\n`);
  process.exit(0);
}

const state = env.COWORKER_STATE_DIR ?? '';
const flag = (name) => argv[argv.indexOf(name) + 1];
const record = (name, value) =>
  state === '' ? undefined : appendFileSync(join(state, name), `${JSON.stringify(value)}\n`);

const server = new FakeOpenWorkerServer({
  token: env.COWORKER_API_TOKEN ?? '',
  host: flag('--host'),
  port: Number(flag('--port')),
  neverReady: env.NEXAR_FAKE_OPENWORKER_NEVER_READY === '1',
  failProviders: env.NEXAR_FAKE_OPENWORKER_FAIL_PROVIDERS === '1',
  writeDraft: true,
  onRecord: (entry) => record('records.jsonl', entry),
});
server.scenario = env.NEXAR_FAKE_OPENWORKER_SCENARIO ?? 'normal';
await server.listen();
if (state !== '') writeFileSync(join(state, 'listening'), '1');
setInterval(() => undefined, 60_000);
