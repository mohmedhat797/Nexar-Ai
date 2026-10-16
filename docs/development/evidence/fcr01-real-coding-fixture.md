# FCR-01 — Reproducible real Coding fixture

This is the actual offline synthetic experiment used in the isolated WSL2 checkout. It imports compiled production launchers and uses pinned DSH, bubblewrap, a private Unix socket model fixture and generated files only. It performs no paid inference. Store the script as .nexar/fcr01-real-coding.mjs and run with Node 22 from the built repository, with the pinned runtime in dist/dsh-runtime and /opt/node mounted. This is launcher/runtime OS evidence; it does not replace the separately tested NRC gateway/plane protocol fixture.

```js
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { SandboxLauncher } from '../packages/sandbox/dist/index.js';
import {
  prepareAcpLaunch,
  spawnPrepared,
} from '../integrations/deepseek-harness/dist/acp/launch.js';
import { deepseekHarnessResource } from '../integrations/deepseek-harness/dist/resource.js';

const base = await realpath(await mkdtemp('/var/tmp/nexar-fcr01-coding-'));
const workspace = join(base, 'workspace');
const state = join(base, 'state');
const services = join(base, 'services');
await Promise.all([
  mkdir(workspace),
  mkdir(state, { mode: 0o700 }),
  mkdir(services, { mode: 0o700 }),
]);
await chmod(services, 0o700);
const outside = join(base, 'outside-synthetic.txt');
await writeFile(outside, 'UNCHANGED-SYNTHETIC');
const token = randomBytes(32).toString('hex');
const marker = 'FCR01-REQUIRED-CODING-CONTEXT';
const requests = [];
const server = createServer(async (req, res) => {
  let raw = '';
  for await (const chunk of req) raw += chunk;
  if (req.headers.authorization !== `Bearer ${token}`) {
    res.writeHead(403);
    res.end();
    return;
  }
  const body = JSON.parse(raw);
  requests.push(body);
  const step = requests.length;
  const args =
    step === 1
      ? {
          file_path: '/work/proof.txt',
          content: 'REAL-SANDBOX-CODING-PROOF',
          sandbox_permissions: 'workspace-write',
          justification: 'Write a synthetic offline test file.',
        }
      : {
          command: `node -e "require('node:fs').writeFileSync('${outside}', 'ESCAPE')"`,
          description: 'Probe the assigned sandbox using a synthetic host path.',
          sandbox_permissions: 'workspace-write',
          justification: 'Synthetic sandbox negative check.',
        };
  const frames =
    step < 3
      ? [
          {
            delta: {
              role: 'assistant',
              tool_calls: [
                {
                  index: 0,
                  id: `call_${step}`,
                  type: 'function',
                  function: {
                    name: step === 1 ? 'write' : 'bash',
                    arguments: JSON.stringify(args),
                  },
                },
              ],
            },
            finish: null,
          },
          { delta: {}, finish: 'tool_calls' },
        ]
      : [
          { delta: { role: 'assistant', content: 'FCR01-CODING-DONE' }, finish: null },
          { delta: {}, finish: 'stop' },
        ];
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  for (const f of frames)
    res.write(
      `data: ${JSON.stringify({ id: 'offline-coding', object: 'chat.completion.chunk', created: 0, model: 'nexar-control', choices: [{ index: 0, delta: f.delta, finish_reason: f.finish }] })}\n\n`,
    );
  res.end('data: [DONE]\n\n');
});
await new Promise((resolve) => server.listen(join(services, 'gateway.sock'), resolve));
const runtime = join(process.cwd(), 'dist/dsh-runtime');
const launcher = new SandboxLauncher({ toolchainPaths: ['/opt/node', runtime], runDirBase: base });
let prepared;
let proc;
let permissions = 0;
try {
  prepared = await prepareAcpLaunch(
    {
      binary: {
        command: '/opt/node/bin/node',
        args: [join(runtime, 'node_modules/@deepseek-ai/dsh/lib/bin.js')],
      },
      workspace: { path: workspace, access: 'read-write', launcher },
      resource: deepseekHarnessResource(),
      dshStateDir: state,
      sources: { env: {} },
      allowHosts: [],
      gateway: { engine: 'dsh', token, services: { dir: services, gateway: true, bridge: false } },
      requiredContext: marker,
    },
    new AbortController().signal,
  );
  assert.equal(prepared.isolation, 'sandbox');
  assert(!JSON.stringify(prepared.args).includes(token));
  proc = spawnPrepared(prepared);
  proc.client.setRequestHandler((req) => {
    if (req.method !== 'session/request_permission') return undefined;
    permissions += 1;
    const option = req.params.options.find((o) => o.kind === 'allow_once');
    return Promise.resolve(
      option
        ? { outcome: { outcome: 'selected', optionId: option.optionId } }
        : { outcome: { outcome: 'cancelled' } },
    );
  });
  assert.equal(
    (
      await proc.client.request(
        'initialize',
        {
          protocolVersion: 1,
          clientCapabilities: {
            fs: { readTextFile: false, writeTextFile: false },
            terminal: false,
          },
        },
        { timeoutMs: 60000 },
      )
    ).protocolVersion,
    1,
  );
  const { sessionId } = await proc.client.request(
    'session/new',
    { cwd: prepared.workspacePath, mcpServers: [] },
    { timeoutMs: 60000 },
  );
  await proc.client.request(
    'session/set_config_option',
    { sessionId, configId: 'model', value: JSON.stringify(['nexar', 'nexar-control']) },
    { timeoutMs: 60000 },
  );
  assert.equal(
    (
      await proc.client.request(
        'session/prompt',
        {
          sessionId,
          prompt: [{ type: 'text', text: 'Execute the synthetic offline coding fixture.' }],
        },
        { timeoutMs: 120000 },
      )
    ).stopReason,
    'end_turn',
  );
  assert.equal(await readFile(join(workspace, 'proof.txt'), 'utf8'), 'REAL-SANDBOX-CODING-PROOF');
  assert.equal(await readFile(outside, 'utf8'), 'UNCHANGED-SYNTHETIC');
  assert.equal(requests.length, 3);
  assert(requests.every((r) => JSON.stringify(r.messages).includes(marker)));
  console.log(
    JSON.stringify({
      tools: requests[0].tools.map((t) => t.function.name),
      syntheticResults: requests[2].messages.filter((m) => m.role === 'tool'),
    }),
  );
  assert(JSON.stringify(requests[2].messages).includes('ENOENT'));
  await proc.client.request('session/close', { sessionId }, { timeoutMs: 30000 });
  console.log(
    JSON.stringify({
      result: 'PASS',
      runtime: 'DSH 0.2.0-rc.2',
      isolation: 'real-bubblewrap',
      model: 'deterministic-offline-fixture',
      modelRequests: requests.length,
      permissions,
      requiredContext: 'present-in-every-model-request',
      workspaceWrite: 'verified',
      outsideWrite: 'blocked',
      credentialsInArgv: false,
    }),
  );
} finally {
  await proc?.stop();
  await prepared?.dispose();
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  await rm(base, { recursive: true, force: true });
}
```
