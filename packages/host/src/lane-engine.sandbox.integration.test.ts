import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  measured,
  type EgressEvent,
  type LaunchSpec,
  type Logger,
  type ModelTurnPortRequest,
} from '@nexar/contracts';
import { createNexarWithProjects, parseConfig } from '@nexar/core';
import { deepseekHarnessResource } from '@nexar/integration-deepseek-harness';
import { EchoExecutionAdapter } from '@nexar/integration-echo';
import { piModelResource } from '@nexar/integration-pi';
import {
  SANDBOX_BRIDGE_ENDPOINT,
  SANDBOX_GATEWAY_BASE_URL,
  SANDBOX_RELAY_PATH,
  SandboxLauncher,
  checkSandboxAvailability,
} from '@nexar/sandbox';
import { PlaneLaneEngine } from './lane-engine.js';

const availability = await checkSandboxAvailability();
const runnable =
  process.platform !== 'win32' && availability.available && availability.socatPath !== undefined;
if (!runnable) {
  process.stderr.write(`[sandbox gateway smoke test skipped] ${availability.detail}\n`);
}

const logger: Logger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  child: () => logger,
};

const LANE = {
  engineeringTaskId: 'eng-0123456789ab',
  laneId: 'feature',
  role: 'feature',
  round: 0,
  projectId: 'demo',
  access: 'read-write',
} as const;

/** Prints one JSON line: what a Node process inside the sandbox sees of the Nexar services. */
const PROBE = `
const http = require('node:http');
const net = require('node:net');
const fs = require('node:fs');
const [base, endpoint, relay] = process.argv.slice(2);
const token = process.env.PROBE_TOKEN;
const out = {
  proxyEnv: process.env.NODE_USE_ENV_PROXY ?? '',
  noProxy: process.env.NO_PROXY ?? '',
  relay: fs.existsSync(relay),
};
function post() {
  return new Promise((resolve) => {
    const url = new URL(base + '/chat/completions');
    const body = JSON.stringify({ model: 'nexar-control', messages: [{ role: 'user', content: 'hi' }] });
    const req = http.request(url, { method: 'POST', headers: {
      authorization: 'Bearer ' + token,
      'content-type': 'application/json',
      'content-length': Buffer.byteLength(body),
    } }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (c) => (text += c));
      res.on('end', () => resolve({ status: res.statusCode, text }));
    });
    req.on('error', (e) => resolve({ error: e.code }));
    req.end(body);
  });
}
function bridge() {
  return new Promise((resolve) => {
    const socket = net.connect(endpoint);
    let text = '';
    socket.setEncoding('utf8');
    socket.on('data', (c) => {
      text += c;
      if (text.includes('\\n')) { socket.destroy(); resolve(JSON.parse(text)); }
    });
    socket.on('error', (e) => resolve({ error: e.code }));
    socket.on('connect', () => socket.write(JSON.stringify({ v: 1, id: 's1', token, op: 'status', jobId: 'unknown-job' }) + '\\n'));
  });
}
(async () => {
  out.gateway = await post();
  out.bridge = await bridge();
  process.stdout.write(JSON.stringify(out) + '\\n');
})();
`;

describe.skipIf(!runnable)('the real sandbox and a lane engine session', () => {
  let base: string;
  let events: EgressEvent[];
  const turns: ModelTurnPortRequest[] = [];

  beforeEach(async () => {
    base = await realpath(await mkdtemp(join(tmpdir(), 'nexar-sbx-smoke-')));
    events = [];
    turns.length = 0;
  });
  afterEach(async () => {
    await rm(base, { recursive: true, force: true });
  });

  /** The Node toolchain directory, or none when Node is already a system command (under /usr). */
  async function nodeToolchain(): Promise<string[]> {
    const node = await realpath(process.execPath);
    return node.startsWith('/usr/') ? [] : [dirname(dirname(node))];
  }

  async function open() {
    const pi = piModelResource({
      id: 'control-model',
      provider: 'anthropic',
      model: 'm',
      capabilities: ['text-generation', 'reasoning', 'knowledge-work', 'model-turn'],
    });
    const config = parseConfig(
      {
        version: 1,
        resources: [deepseekHarnessResource(), pi],
        routing: { policy: 'deterministic' },
      },
      'test',
      { baseDir: base },
    );
    const runtime = await createNexarWithProjects(config, {
      adapters: [new EchoExecutionAdapter()],
      logger,
    });
    const relay = join(base, 'bridge-relay.cjs');
    await writeFile(relay, '// relay');
    const engine = new PlaneLaneEngine({
      runtime,
      io: { env: {}, cwd: base },
      logger,
      stateDir: join(base, 'plane'),
      ttlMs: 60_000,
      relayScript: relay,
      ports: () => ({
        turn: (request) => {
          turns.push(request);
          return Promise.resolve({
            text: 'from-the-control-resource',
            toolCalls: [],
            finishReason: 'stop',
            usage: { inputTokens: measured(3), outputTokens: measured(1) },
          });
        },
      }),
    });
    const session = await engine.open(LANE);
    if ('unavailable' in session) throw new Error(`unavailable: ${session.unavailable}`);
    return session;
  }

  for (const network of [
    { mode: 'none' },
    { mode: 'proxy', allowHosts: ['allowed.example'] },
  ] as const) {
    it(`reaches the translator and the bridge from a Node process (network mode ${network.mode})`, async (ctx) => {
      const toolchainPaths = await nodeToolchain();
      const workspace = join(base, 'ws');
      await mkdir(join(workspace, '.git'), { recursive: true });
      await writeFile(join(workspace, '.git', 'HEAD'), 'ref: refs/heads/main\n');
      await writeFile(join(workspace, 'probe.cjs'), PROBE);
      await mkdir(join(base, 'run'));
      const launcher = new SandboxLauncher({
        homeDir: join(base, 'home'),
        runDirBase: join(base, 'run'),
        toolchainPaths,
        onEgress: (event) => events.push(event),
      });
      const session = await open();
      try {
        const run = async (args: string[], services = true) => {
          const spec: LaunchSpec = {
            command: process.execPath,
            args,
            env: { PROBE_TOKEN: session.gateway.token },
            workspace,
            workspaceAccess: 'read-write',
            network,
            ...(services ? { services: session.gateway.services } : {}),
          };
          const prepared = await launcher.prepare(spec, new AbortController().signal);
          try {
            return await new Promise<{ code: number | null; stdout: string }>((resolve, reject) => {
              const child = spawn(prepared.command, [...prepared.args], {
                cwd: prepared.cwd,
                env: { ...prepared.env },
              });
              let stdout = '';
              child.stdout.on('data', (c: Buffer) => (stdout += c.toString()));
              child.once('error', reject);
              child.once('close', (code) => resolve({ code, stdout }));
            });
          } finally {
            await prepared.dispose();
          }
        };

        // Node must be visible in the sandbox (a toolchain mount, never a weaker sandbox) to go on.
        const visible = await run(['-e', '0'], false).catch(() => ({ code: 1, stdout: '' }));
        if (visible.code !== 0) {
          process.stderr.write(
            '[sandbox gateway smoke test skipped] node is not visible in the sandbox\n',
          );
          ctx.skip();
        }

        const result = await run([
          '/work/probe.cjs',
          SANDBOX_GATEWAY_BASE_URL,
          SANDBOX_BRIDGE_ENDPOINT,
          SANDBOX_RELAY_PATH,
        ]);
        expect(result.code).toBe(0);
        const seen = JSON.parse(result.stdout.trim()) as {
          proxyEnv: string;
          noProxy: string;
          relay: boolean;
          gateway: { status?: number; text?: string; error?: string };
          bridge: { ok?: boolean; code?: string; error?: string };
        };
        // The translator answered with the control resource's turn.
        expect(seen.gateway.status).toBe(200);
        expect(seen.gateway.text).toContain('from-the-control-resource');
        expect(turns).toHaveLength(1);
        // The bridge endpoint accepted the lane token: the failure is about the job, not authentication.
        expect(seen.bridge.error).toBeUndefined();
        expect(seen.bridge.code).not.toBe('AUTH_REQUIRED');
        expect(seen.relay).toBe(true);
        // Node's env proxy (on in proxy mode) must skip loopback, and nothing reached the egress proxy.
        expect(seen.proxyEnv).toBe(network.mode === 'proxy' ? '1' : '');
        expect(seen.noProxy).toBe('127.0.0.1');
        expect(events).toEqual([]);
      } finally {
        await session.close();
      }
    }, 60_000);
  }
});
