/* eslint-disable @typescript-eslint/require-await -- injected async seams in tests need no await */
import { mkdtemp, realpath, rm, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { EgressEvent } from '@nexar/contracts';
import { isNexarError } from '@nexar/contracts';
import { isBlockedAddress, parseAllowlist, startEgressProxy, type EgressProxy } from './proxy.js';

let dir: string;
let proxy: EgressProxy | undefined;
let upstream: net.Server;
let upstreamPort: number;
let events: EgressEvent[];
const publicLookup = async () => [{ address: '93.184.216.34', family: 4 }];

beforeEach(async () => {
  dir = await realpath(await mkdtemp(join(tmpdir(), 'nexar-proxy-')));
  events = [];
  upstream = net.createServer((socket) => {
    socket.on('error', () => undefined);
    socket.on('data', (chunk) => socket.write(Buffer.concat([Buffer.from('echo:'), chunk])));
  });
  await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve));
  upstreamPort = (upstream.address() as net.AddressInfo).port;
});
afterEach(async () => {
  await proxy?.close();
  proxy = undefined;
  await new Promise((resolve) => upstream.close(resolve));
  await rm(dir, { recursive: true, force: true });
});

async function start(
  overrides: Partial<Parameters<typeof startEgressProxy>[0]> = {},
): Promise<EgressProxy> {
  proxy = await startEgressProxy({
    socketPath: join(dir, 'p.sock'),
    allowHosts: ['allowed.example', 'other.example:8443'],
    onEgress: (event) => events.push(event),
    lookup: publicLookup,
    connect: () => net.connect(upstreamPort, '127.0.0.1'),
    ...overrides,
  });
  return proxy;
}

/** Sends raw bytes to the proxy socket and returns what comes back until it closes (or `until` matches). */
function exchange(socketPath: string, request: string, until?: RegExp): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = net.connect(socketPath);
    let data = '';
    socket.on('error', reject);
    socket.on('data', (chunk) => {
      data += chunk.toString('utf8');
      if (until?.test(data)) {
        socket.destroy();
        resolve(data);
      }
    });
    socket.on('close', () => resolve(data));
    socket.write(request);
  });
}

const connectRequest = (target: string, tail = ''): string =>
  `CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n\r\n${tail}`;

// ADR-018: the egress proxy uses a POSIX Unix socket inside the Linux/WSL engineering plane.
describe.skipIf(process.platform === 'win32')('startEgressProxy', () => {
  it('listens only on a 0600 unix socket and removes it on close', async () => {
    const p = await start();
    expect(p.address()).toBe(join(dir, 'p.sock'));
    expect((await stat(join(dir, 'p.sock'))).mode & 0o777).toBe(0o600);
    await p.close();
    await p.close();
    expect(existsSync(join(dir, 'p.sock'))).toBe(false);
  });

  it('tunnels bytes for an allowlisted host, including bytes sent with the CONNECT head', async () => {
    const p = await start();
    const response = await exchange(
      p.socketPath,
      connectRequest('Allowed.Example.:443', 'hello'),
      /echo:hello/,
    );
    expect(response).toMatch(/^HTTP\/1\.1 200 Connection Established\r\n\r\n/);
    expect(response).toContain('echo:hello');
    expect(events).toEqual([{ host: 'allowed.example', port: 443, outcome: 'allowed' }]);
  });

  it('honours host:port allowlist entries exactly', async () => {
    const p = await start();
    expect(await exchange(p.socketPath, connectRequest('other.example:8443'), /\r\n\r\n/)).toMatch(
      /^HTTP\/1\.1 200/,
    );
    expect(await exchange(p.socketPath, connectRequest('other.example:443'))).toMatch(
      /^HTTP\/1\.1 403/,
    );
    expect(await exchange(p.socketPath, connectRequest('allowed.example:8443'))).toMatch(
      /^HTTP\/1\.1 403/,
    );
  });

  it('denies hosts that are not allowlisted', async () => {
    const p = await start();
    expect(await exchange(p.socketPath, connectRequest('evil.example:443'))).toMatch(
      /^HTTP\/1\.1 403/,
    );
    expect(events).toEqual([
      { host: 'evil.example', port: 443, outcome: 'denied', reason: 'not-allowlisted' },
    ]);
  });

  it('denies IP literals', async () => {
    const p = await start();
    for (const target of [
      '1.1.1.1:443',
      '[2606:4700::1111]:443',
      '127.0.0.1:443',
      '2130706433:443',
    ]) {
      expect(await exchange(p.socketPath, connectRequest(target))).toMatch(/^HTTP\/1\.1 403/);
    }
    expect(events.map((e) => e.reason)).toEqual([
      'ip-literal',
      'ip-literal',
      'ip-literal',
      'ip-literal',
    ]);
  });

  it('answers 400 to malformed targets without echoing them', async () => {
    const p = await start();
    for (const target of [
      'nohostport',
      'a.example:0',
      'a.example:99999',
      'bad_host.example:443',
      '[::1:443',
    ]) {
      expect(await exchange(p.socketPath, connectRequest(target))).toMatch(/^HTTP\/1\.1 400/);
    }
    expect(
      events.every(
        (e) => e.outcome === 'denied' && e.host === '' && e.reason === 'malformed-target',
      ),
    ).toBe(true);
  });

  it('answers 405 to non-CONNECT requests', async () => {
    const p = await start();
    expect(
      await exchange(
        p.socketPath,
        'GET http://allowed.example/ HTTP/1.1\r\nHost: allowed.example\r\n\r\n',
      ),
    ).toMatch(/^HTTP\/1\.1 405/);
  });

  it('blocks when every resolved address is private, and by default blocks loopback', async () => {
    const p = await start({
      lookup: async () => [
        { address: '10.0.0.5', family: 4 },
        { address: '::1', family: 6 },
      ],
    });
    expect(await exchange(p.socketPath, connectRequest('allowed.example:443'))).toMatch(
      /^HTTP\/1\.1 403/,
    );
    expect(events).toEqual([
      { host: 'allowed.example', port: 443, outcome: 'denied', reason: 'private-address' },
    ]);
  });

  it('connects to the vetted IP, skipping private addresses', async () => {
    const seen: string[] = [];
    const p = await start({
      lookup: async () => [
        { address: '192.168.1.1', family: 4 },
        { address: '93.184.216.34', family: 4 },
      ],
      connect: (address) => {
        seen.push(address);
        return net.connect(upstreamPort, '127.0.0.1');
      },
    });
    await exchange(p.socketPath, connectRequest('allowed.example:443'), /\r\n\r\n/);
    expect(seen).toEqual(['93.184.216.34']);
  });

  it('answers 502 when the upstream cannot be reached or resolved', async () => {
    const p = await start({ lookup: async () => Promise.reject(new Error('nxdomain')) });
    expect(await exchange(p.socketPath, connectRequest('allowed.example:443'))).toMatch(
      /^HTTP\/1\.1 502/,
    );
    await p.close();
    const refused = await start({ connect: () => net.connect(1, '127.0.0.1') });
    expect(await exchange(refused.socketPath, connectRequest('allowed.example:443'))).toMatch(
      /^HTTP\/1\.1 502/,
    );
  });

  it('caps concurrent tunnels with 503', async () => {
    const p = await start({ maxTunnels: 1 });
    const first = net.connect(p.socketPath);
    await new Promise<void>((resolve) => {
      first.on('data', (chunk) => chunk.toString().includes('200') && resolve());
      first.write(connectRequest('allowed.example:443'));
    });
    expect(await exchange(p.socketPath, connectRequest('allowed.example:443'))).toMatch(
      /^HTTP\/1\.1 503/,
    );
    expect(events.at(-1)).toEqual({
      host: 'allowed.example',
      port: 443,
      outcome: 'denied',
      reason: 'connection-limit',
    });
    first.destroy();
  });

  it('destroys idle tunnels', async () => {
    const p = await start({ idleTimeoutMs: 50 });
    const response = await exchange(p.socketPath, connectRequest('allowed.example:443'));
    expect(response).toMatch(/^HTTP\/1\.1 200/);
  });

  it('close destroys open tunnels', async () => {
    const p = await start();
    const client = net.connect(p.socketPath);
    await new Promise<void>((resolve) => {
      client.on('data', () => resolve());
      client.write(connectRequest('allowed.example:443'));
    });
    const closed = new Promise((resolve) => client.on('close', resolve));
    await p.close();
    await closed;
  });

  it('rejects invalid allowlists at start', async () => {
    for (const bad of [
      '*.example.com',
      '1.2.3.4',
      '[::1]',
      'a.example:0',
      'a.example:70000',
      'bad host',
      '',
      'a.example:x',
    ]) {
      const error = await startEgressProxy({
        socketPath: join(dir, 'bad.sock'),
        allowHosts: [bad],
      }).then(
        () => undefined,
        (e: unknown) => e,
      );
      expect(isNexarError(error) && error.code === 'CONFIGURATION_ERROR', bad).toBe(true);
    }
  });
});

describe('address policy', () => {
  it('blocks local, private and special-use addresses including mapped forms', () => {
    for (const address of [
      '127.0.0.1',
      '10.1.2.3',
      '172.16.0.1',
      '172.31.255.255',
      '192.168.0.1',
      '169.254.169.254',
      '100.64.0.1',
      '224.0.0.1',
      '0.0.0.0',
      '255.255.255.255',
      '::1',
      '::',
      'fc00::1',
      'fd12::1',
      'fe80::1',
      'ff02::1',
      '::ffff:127.0.0.1',
      '::ffff:7f00:1',
      '::ffff:10.0.0.1',
      '::ffff:a9fe:a9fe',
      'not-an-ip',
      'fe80::1%eth0',
    ]) {
      expect(isBlockedAddress(address), address).toBe(true);
    }
  });

  it('allows public addresses', () => {
    for (const address of [
      '93.184.216.34',
      '8.8.8.8',
      '172.32.0.1',
      '100.128.0.1',
      '2606:4700::1111',
      '::ffff:8.8.8.8',
      '203.0.113.9',
    ]) {
      expect(isBlockedAddress(address), address).toBe(false);
    }
  });

  it('normalizes the allowlist', () => {
    expect([...parseAllowlist(['API.Example.com', 'a.example:8080'])].sort()).toEqual([
      'a.example:8080',
      'api.example.com:443',
    ]);
  });
});
