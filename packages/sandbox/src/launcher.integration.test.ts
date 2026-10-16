/* eslint-disable @typescript-eslint/require-await -- injected async seams in tests need no await */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  writeFile,
} from 'node:fs/promises';
import http from 'node:http';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { EgressEvent, LaunchSpec } from '@nexar/contracts';
import { checkSandboxAvailability } from './availability.js';
import { SandboxLauncher } from './launcher.js';
import {
  SANDBOX_BRIDGE_ENDPOINT,
  SANDBOX_GATEWAY_BASE_URL,
  SANDBOX_GATEWAY_PORT,
} from './profile.js';
import { runSandboxSelfTest } from './selftest.js';

const availability = await checkSandboxAvailability();
const realAvailable = availability.available;
const socatAvailable = availability.socatPath !== undefined;
if (!realAvailable) {
  process.stderr.write(`[sandbox integration tests skipped] ${availability.detail}\n`);
}

describe.skipIf(!realAvailable)('SandboxLauncher (real bubblewrap)', () => {
  let root: string;
  let home: string;
  let ws: string;
  let upstream: net.Server;
  let upstreamPort: number;
  let events: EgressEvent[];
  let launcher: SandboxLauncher;

  beforeAll(async () => {
    upstream = net.createServer((socket) => {
      socket.on('error', () => undefined);
      socket.on('data', (chunk) => socket.write(Buffer.concat([Buffer.from('echo:'), chunk])));
    });
    await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve));
    upstreamPort = (upstream.address() as net.AddressInfo).port;
  });
  afterAll(async () => {
    await new Promise((resolve) => upstream.close(resolve));
  });

  beforeEach(async () => {
    root = await realpath(await mkdtemp(join(tmpdir(), 'nexar-int-')));
    home = join(root, 'home');
    ws = join(root, 'ws');
    events = [];
    await mkdir(join(ws, '.git'), { recursive: true });
    await writeFile(join(ws, '.git', 'HEAD'), 'ref: refs/heads/main\n');
    await mkdir(join(home, '.ssh'), { recursive: true });
    await writeFile(join(home, 'canary.txt'), 'secret');
    await mkdir(join(root, 'run'));
    launcher = new SandboxLauncher({
      homeDir: home,
      // A private base, so parallel test files creating run dirs cannot interfere.
      runDirBase: join(root, 'run'),
      onEgress: (event) => events.push(event),
      lookup: async () => [{ address: '93.184.216.34', family: 4 }],
      connect: () => net.connect(upstreamPort, '127.0.0.1'),
    });
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  const sh = (script: string, overrides: Partial<LaunchSpec> = {}): LaunchSpec => ({
    command: '/bin/sh',
    args: ['-c', script, 'sh'],
    env: {},
    workspace: ws,
    workspaceAccess: 'read-write',
    network: { mode: 'none' },
    ...overrides,
  });

  async function run(
    spec: LaunchSpec,
  ): Promise<{ code: number | null; stdout: string; stderr: string }> {
    const prepared = await launcher.prepare(spec, new AbortController().signal);
    try {
      return await new Promise((resolve, reject) => {
        const child = spawn(prepared.command, [...prepared.args], {
          cwd: prepared.cwd,
          env: { ...prepared.env },
        });
        let stdout = '';
        let stderr = '';
        child.stdout.on('data', (c: Buffer) => (stdout += c.toString()));
        child.stderr.on('data', (c: Buffer) => (stderr += c.toString()));
        child.once('error', reject);
        child.once('close', (code) => resolve({ code, stdout, stderr }));
      });
    } finally {
      await prepared.dispose();
    }
  }

  it('writes to /work and the file appears on the host', async () => {
    const result = await run(sh('echo hi > /work/out.txt'));
    expect(result.code).toBe(0);
    expect(await readFile(join(ws, 'out.txt'), 'utf8')).toBe('hi\n');
  });

  it('delivers synthetic credentials through the private fd and closes it before execution', async () => {
    const token = 'synthetic-fcr01-token-with-spaces';
    const result = await run(
      sh('printf "%s" "$SYNTHETIC_TOKEN"; test ! -e /proc/self/fd/3', {
        env: { SYNTHETIC_TOKEN: token },
      }),
    );
    expect(result.code).toBe(0);
    expect(result.stdout).toBe(token);
    expect(await readdir(join(root, 'run'))).toEqual([]);
  });

  it('keeps / read-only and /work/.git read-only (also against mv)', async () => {
    const result = await run(
      sh(
        'touch /rootprobe 2>/dev/null && echo ROOT_WRITABLE; ' +
          'touch /work/.git/probe 2>/dev/null && echo GIT_WRITABLE; ' +
          'mv /work/.git /work/g 2>/dev/null && echo GIT_MOVED; echo done',
      ),
    );
    expect(result.stdout.trim()).toBe('done');
    expect(existsSync(join(ws, '.git', 'probe'))).toBe(false);
    expect(existsSync(join(ws, 'g'))).toBe(false);
  });

  it('hides host files outside the workspace', async () => {
    const result = await run(
      sh(
        `[ -e '${join(home, 'canary.txt')}' ] && echo visible; [ -e '${home}' ] && echo home-visible; echo done`,
      ),
    );
    expect(result.stdout.trim()).toBe('done');
  });

  it('has only the loopback interface', async () => {
    const result = await run(sh('cat /proc/net/dev'));
    const names = result.stdout
      .split('\n')
      .filter((l) => l.includes(':') && !l.includes('|'))
      .map((l) => l.split(':')[0]?.trim());
    expect(names).toEqual(['lo']);
  });

  it('provides a synthetic passwd entry', async () => {
    const result = await run(sh('id -un'));
    expect(result.stdout.trim()).toBe('agent');
  });

  describe.skipIf(!socatAvailable)('proxy mode', () => {
    const proxySpec = (script: string): LaunchSpec =>
      sh(script, { network: { mode: 'proxy', allowHosts: ['allowed.example'] } });
    const connect = (target: string): string =>
      `printf 'CONNECT ${target} HTTP/1.1\\r\\nHost: ${target}\\r\\n\\r\\nping' | socat -t 2 - TCP:127.0.0.1:3128`;

    it('tunnels an allowlisted host to the upstream and denies others', async () => {
      const allowed = await run(proxySpec(connect('allowed.example:443')));
      expect(allowed.stdout).toContain('200 Connection Established');
      expect(allowed.stdout).toContain('echo:ping');
      const denied = await run(proxySpec(connect('evil.example:443')));
      expect(denied.stdout).toMatch(/^HTTP\/1\.1 403/);
      expect(events.map((e) => [e.host, e.outcome])).toEqual([
        ['allowed.example', 'allowed'],
        ['evil.example', 'denied'],
      ]);
    });

    it('removes the run directory after dispose', async () => {
      await run(proxySpec('true'));
      expect(await readdir(join(root, 'run'))).toEqual([]);
    });
  });

  describe.skipIf(!socatAvailable)('Nexar services', () => {
    let svc: string;
    let relay: string;
    let gatewayServer: http.Server;
    let bridgeServer: net.Server;
    let gatewayHits: string[];

    beforeEach(async () => {
      svc = join(root, 'svc');
      relay = join(root, 'relay.cjs');
      gatewayHits = [];
      await mkdir(svc, { mode: 0o700 });
      await chmod(svc, 0o700);
      await writeFile(relay, '// relay');
      gatewayServer = http.createServer((req, res) => {
        gatewayHits.push(`${req.method ?? ''} ${req.url ?? ''} ${req.headers.host ?? ''}`);
        res.setHeader('content-type', 'application/json');
        res.end('{"gateway":"ok"}');
      });
      await new Promise<void>((resolve) =>
        gatewayServer.listen(join(svc, 'gateway.sock'), resolve),
      );
      bridgeServer = net.createServer((socket) => socket.on('error', () => undefined));
      await new Promise<void>((resolve) => bridgeServer.listen(join(svc, 'bridge.sock'), resolve));
    });
    afterEach(async () => {
      gatewayServer.closeAllConnections();
      await new Promise((resolve) => gatewayServer.close(resolve));
      await new Promise((resolve) => bridgeServer.close(resolve));
    });

    const request =
      `printf 'GET /v1/models HTTP/1.1\\r\\nHost: 127.0.0.1:${String(SANDBOX_GATEWAY_PORT)}\\r\\n` +
      `Connection: close\\r\\n\\r\\n' | socat -t 2 - TCP:127.0.0.1:${String(SANDBOX_GATEWAY_PORT)}`;

    for (const network of [
      { mode: 'none' },
      { mode: 'proxy', allowHosts: ['allowed.example'] },
    ] as const) {
      it(`reaches the gateway and bridge sockets in network mode ${network.mode}`, async () => {
        const result = await run(
          sh(
            [
              request,
              `socat -u OPEN:/dev/null UNIX-CONNECT:${SANDBOX_BRIDGE_ENDPOINT} && echo bridge-ok`,
              '[ -r /opt/nexar/bridge-relay.cjs ] && echo relay-ok',
              'echo "env:$NO_PROXY:$no_proxy:$NODE_USE_ENV_PROXY"',
              'echo base:' + SANDBOX_GATEWAY_BASE_URL,
              'touch /run/nexar-services/probe 2>/dev/null && echo SERVICES_WRITABLE',
            ].join('; '),
            { network, services: { dir: svc, gateway: true, bridge: true, relayScript: relay } },
          ),
        );
        expect(result.stdout).toContain('{"gateway":"ok"}');
        expect(result.stdout).toContain('bridge-ok');
        expect(result.stdout).toContain('relay-ok');
        expect(result.stdout).toContain('base:http://127.0.0.1:3129/v1');
        // Node's env proxy (NODE_USE_ENV_PROXY=1 in proxy mode) must skip loopback.
        expect(result.stdout).toContain(
          `env:127.0.0.1:127.0.0.1:${network.mode === 'proxy' ? '1' : ''}`,
        );
        expect(result.stdout).not.toContain('SERVICES_WRITABLE');
        expect(gatewayHits).toEqual([`GET /v1/models 127.0.0.1:${String(SANDBOX_GATEWAY_PORT)}`]);
        expect(events).toEqual([]);
      });
    }
  });

  it('kills background processes when the bwrap process is killed', async () => {
    const marker = `3600.${String(Math.floor(Math.random() * 1e9))}`;
    const prepared = await launcher.prepare(
      sh(`sleep ${marker} & wait`),
      new AbortController().signal,
    );
    const child = spawn(prepared.command, [...prepared.args], {
      cwd: prepared.cwd,
      env: { ...prepared.env },
    });
    const sleeping = async (): Promise<boolean> => {
      for (const entry of await readdir('/proc')) {
        if (!/^\d+$/.test(entry)) continue;
        const cmdline = await readFile(`/proc/${entry}/cmdline`, 'utf8').catch(() => '');
        if (cmdline.split('\0').filter(Boolean).join(' ') === `sleep ${marker}`) return true;
      }
      return false;
    };
    const waitFor = async (expected: boolean): Promise<boolean> => {
      for (let i = 0; i < 100; i += 1) {
        if ((await sleeping()) === expected) return true;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      return false;
    };
    try {
      expect(await waitFor(true)).toBe(true);
      const exited = new Promise((resolve) => child.once('close', resolve));
      child.kill('SIGKILL');
      await exited;
      expect(await waitFor(false)).toBe(true);
    } finally {
      child.kill('SIGKILL');
      await prepared.dispose();
    }
  });

  it('passes the built-in self-test', async () => {
    const results = await runSandboxSelfTest(launcher, { socatAvailable });
    expect(results.filter((r) => !r.passed)).toEqual([]);
    expect(results.length).toBe(socatAvailable ? 6 : 5);
  });
});
