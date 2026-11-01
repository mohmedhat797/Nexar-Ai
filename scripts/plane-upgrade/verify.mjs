// Checks the installed Plane against the release it should now be: the launcher Desktop starts, the
// pinned runtime, the sandbox and both protocols. Starts no vendor CLI and makes no paid call.
import { spawn, spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const release = process.argv[2];
if (release === undefined) throw new Error('usage: verify.mjs <release>');
const LAUNCHER = '/usr/local/bin/nexar';
const load = (path) => import(pathToFileURL(join(release, path)).href);
const { PLANE_PROTOCOL } = await load('packages/plane-protocol/dist/index.js');
const { COWORK_HELPER_PROTOCOL, DSH_PINNED_VERSION } = await load(
  'integrations/deepseek-harness/dist/index.js',
);

function check(name, ok) {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}`);
  if (!ok) process.exitCode = 1;
}

/** Sends one line and returns the first line back, then stops the helper. */
function exchange(args, frame) {
  return new Promise((resolve) => {
    const child = spawn(LAUNCHER, args, { stdio: ['pipe', 'pipe', 'ignore'] });
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      resolve(undefined);
    }, 60_000);
    let text = '';
    child.stdout.on('data', (chunk) => {
      text += chunk.toString();
      const end = text.indexOf('\n');
      if (end < 0) return;
      clearTimeout(timer);
      child.kill();
      try {
        resolve(JSON.parse(text.slice(0, end)));
      } catch {
        resolve(undefined);
      }
    });
    child.once('error', () => {
      clearTimeout(timer);
      resolve(undefined);
    });
    child.stdin.write(`${JSON.stringify(frame)}\n`);
  });
}

const launcher = readFileSync(LAUNCHER, 'utf8');
check(
  'the launcher starts this release',
  launcher.includes(join(release, 'apps/cli/dist/main.js')),
);
check(
  'the launcher keeps its Plane config',
  launcher.includes('NEXAR_CONFIG_PATH:=/home/nexar/validation/nexar.config.json'),
);
const dsh = spawnSync('/usr/local/bin/dsh', ['--version'], { encoding: 'utf8' });
check(`the runtime is ${DSH_PINNED_VERSION}`, dsh.stdout.includes(DSH_PINNED_VERSION));
const selftest = spawnSync(LAUNCHER, ['sandbox', 'selftest'], { encoding: 'utf8' });
check('the Bubblewrap selftest passes', selftest.status === 0);
const plane = await exchange(['plane', 'serve', '--stdio'], {
  type: 'initialize',
  protocol: PLANE_PROTOCOL,
});
// `ready` is only sent once the existing config has loaded.
check(`the Plane loads its config and answers ${PLANE_PROTOCOL}`, plane?.type === 'ready');
const cowork = await exchange(['cowork', 'serve', '--stdio'], {
  jsonrpc: '2.0',
  id: 1,
  method: 'cowork/hello',
});
check(
  `Cowork answers ${COWORK_HELPER_PROTOCOL}`,
  cowork?.result?.protocol === COWORK_HELPER_PROTOCOL,
);
check('Cowork runs the pinned runtime', cowork?.result?.version === DSH_PINNED_VERSION);
check('Cowork reports the Bubblewrap isolation', cowork?.result?.isolation === 'WSL2_BUBBLEWRAP');
