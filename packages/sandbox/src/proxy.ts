import { chmod, unlink } from 'node:fs/promises';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { promises as dns } from 'node:dns';
import net from 'node:net';
import type { Duplex } from 'node:stream';
import { NexarError, type EgressEvent } from '@nexar/contracts';

export const DEFAULT_MAX_TUNNELS = 32;
export const DEFAULT_IDLE_TIMEOUT_MS = 5 * 60 * 1000;

export interface ResolvedAddress {
  readonly address: string;
  readonly family?: number;
}

export interface EgressProxyOptions {
  /** The only place the proxy listens. Never a TCP port. */
  readonly socketPath: string;
  /** `host` (port 443) or `host:port`; exact names only. */
  readonly allowHosts: readonly string[];
  /** One call per decision. Host and port only; never payload. */
  readonly onEgress?: (event: EgressEvent) => void;
  /** Test seam. Default: `dns.promises.lookup(host, { all: true })`. */
  readonly lookup?: (host: string) => Promise<readonly ResolvedAddress[]>;
  /** Test seam. Receives the vetted IP, never the hostname. Default: `net.connect`. */
  readonly connect?: (address: string, port: number) => net.Socket;
  /** Default 32. */
  readonly maxTunnels?: number;
  /** Default 5 minutes. */
  readonly idleTimeoutMs?: number;
}

export interface EgressProxy {
  readonly socketPath: string;
  /** The listening address: the socket path (a string), never a TCP address. */
  address(): ReturnType<net.Server['address']>;
  /** Idempotent. */
  close(): Promise<void>;
}

const HOSTNAME_LABEL = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;

function isValidHostname(host: string): boolean {
  if (host.length === 0 || host.length > 253) {
    return false;
  }
  return host.split('.').every((label) => HOSTNAME_LABEL.test(label));
}

/** Anything that is, or could be parsed by a resolver as, a numeric address. */
function looksLikeIpLiteral(host: string): boolean {
  return net.isIP(host) !== 0 || /^[0-9.]+$/.test(host) || /^0x[0-9a-f]*(\.|$)/.test(host);
}

function normalizeHost(host: string): string {
  const lower = host.toLowerCase();
  return lower.endsWith('.') ? lower.slice(0, -1) : lower;
}

function parsePort(text: string): number | undefined {
  if (!/^[0-9]{1,5}$/.test(text)) {
    return undefined;
  }
  const port = Number(text);
  return port >= 1 && port <= 65535 ? port : undefined;
}

type Target =
  | { readonly kind: 'host'; readonly host: string; readonly port: number }
  | { readonly kind: 'ip-literal'; readonly host: string; readonly port: number }
  | { readonly kind: 'malformed' };

/** Strict `host:port` parsing of a CONNECT request target. */
function parseTarget(raw: string): Target {
  const bracketed = /^\[([^\]]+)\]:([0-9]+)$/.exec(raw);
  if (bracketed !== null) {
    const port = parsePort(bracketed[2] ?? '');
    const ip = bracketed[1] ?? '';
    return port !== undefined && net.isIPv6(ip)
      ? { kind: 'ip-literal', host: ip.toLowerCase(), port }
      : { kind: 'malformed' };
  }
  const plain = /^([^:\s[\]/@?#]+):([0-9]+)$/.exec(raw);
  if (plain === null) {
    return { kind: 'malformed' };
  }
  const port = parsePort(plain[2] ?? '');
  const host = normalizeHost(plain[1] ?? '');
  if (port === undefined) {
    return { kind: 'malformed' };
  }
  if (looksLikeIpLiteral(host)) {
    return { kind: 'ip-literal', host, port };
  }
  return isValidHostname(host) ? { kind: 'host', host, port } : { kind: 'malformed' };
}

function invalidAllowlist(rule: string): NexarError {
  return new NexarError('CONFIGURATION_ERROR', `Invalid egress allowlist: ${rule}`, {
    details: { rule },
  });
}

/** Validates and normalizes allowlist entries into a set of `host:port`. */
export function parseAllowlist(entries: readonly string[]): ReadonlySet<string> {
  const result = new Set<string>();
  for (const entry of entries) {
    if (typeof entry !== 'string' || entry.includes('*')) {
      throw invalidAllowlist('wildcards are not allowed');
    }
    const separator = entry.lastIndexOf(':');
    const rawHost = separator === -1 ? entry : entry.slice(0, separator);
    const port = separator === -1 ? 443 : parsePort(entry.slice(separator + 1));
    if (port === undefined) {
      throw invalidAllowlist('port must be 1-65535');
    }
    const host = normalizeHost(rawHost);
    if (looksLikeIpLiteral(host) || rawHost.includes('[') || rawHost.includes(':')) {
      throw invalidAllowlist('IP literals are not allowed');
    }
    if (!isValidHostname(host)) {
      throw invalidAllowlist('invalid host name');
    }
    result.add(`${host}:${port}`);
  }
  return result;
}

function buildBlockList(): net.BlockList {
  const list = new net.BlockList();
  const v4: readonly (readonly [string, number])[] = [
    ['0.0.0.0', 8],
    ['10.0.0.0', 8],
    ['100.64.0.0', 10],
    ['127.0.0.0', 8],
    ['169.254.0.0', 16],
    ['172.16.0.0', 12],
    ['192.168.0.0', 16],
    ['224.0.0.0', 4],
    ['240.0.0.0', 4],
  ];
  for (const [network, prefix] of v4) {
    list.addSubnet(network, prefix, 'ipv4');
  }
  const v6: readonly (readonly [string, number])[] = [
    ['::', 96], // unspecified, loopback and IPv4-compatible forms

    ['fc00::', 7],
    ['fe80::', 10],
    ['ff00::', 8],
    ['64:ff9b::', 96],
  ];
  for (const [network, prefix] of v6) {
    list.addSubnet(network, prefix, 'ipv6');
  }
  return list;
}

const BLOCKED = buildBlockList();

/** The IPv4 inside an IPv4-mapped IPv6 address (`::ffff:a.b.c.d` or `::ffff:aabb:ccdd`), if any. */
function unmapIPv4(address: string): string | undefined {
  const dotted = /^::ffff:([0-9.]+)$/i.exec(address);
  if (dotted !== null) {
    return dotted[1];
  }
  const hex = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i.exec(address);
  if (hex === null) {
    return undefined;
  }
  const high = parseInt(hex[1] ?? '', 16);
  const low = parseInt(hex[2] ?? '', 16);
  return `${high >> 8}.${high & 255}.${low >> 8}.${low & 255}`;
}

/** True if connecting to this address could reach a local, private or otherwise non-public host. */
export function isBlockedAddress(address: string): boolean {
  if (address.includes('%')) {
    return true;
  }
  const family = net.isIP(address);
  if (family === 0) {
    return true;
  }
  if (family === 4) {
    return BLOCKED.check(address, 'ipv4');
  }
  const mapped = unmapIPv4(address);
  if (mapped !== undefined) {
    return net.isIPv4(mapped) ? BLOCKED.check(mapped, 'ipv4') : true;
  }
  return BLOCKED.check(address, 'ipv6');
}

const RESPONSES: Readonly<Record<number, string>> = {
  400: 'Bad Request',
  403: 'Forbidden',
  502: 'Bad Gateway',
  503: 'Service Unavailable',
};

function refuse(socket: Duplex, status: number): void {
  socket.end(`HTTP/1.1 ${status} ${RESPONSES[status] ?? 'Error'}\r\nConnection: close\r\n\r\n`);
}

/** Starts the allowlisting CONNECT proxy on a unix socket (mode 0600). */
export async function startEgressProxy(options: EgressProxyOptions): Promise<EgressProxy> {
  const allowed = parseAllowlist(options.allowHosts);
  const lookup =
    options.lookup ??
    (async (host: string): Promise<readonly ResolvedAddress[]> => dns.lookup(host, { all: true }));
  const connect =
    options.connect ??
    ((address: string, port: number): net.Socket => net.connect({ host: address, port }));
  const maxTunnels = options.maxTunnels ?? DEFAULT_MAX_TUNNELS;
  const idleTimeoutMs = options.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;
  const emit = (
    host: string,
    port: number,
    outcome: EgressEvent['outcome'],
    reason?: string,
  ): void => {
    options.onEgress?.(
      reason === undefined ? { host, port, outcome } : { host, port, outcome, reason },
    );
  };
  const tunnels = new Set<net.Socket>();
  let active = 0;

  const server = createServer((_req: IncomingMessage, res: ServerResponse) => {
    res.writeHead(405, { Allow: 'CONNECT', Connection: 'close' });
    res.end();
  });

  server.on('connect', (req: IncomingMessage, clientStream: Duplex, head: Buffer) => {
    const client = clientStream as net.Socket;
    client.on('error', () => client.destroy());
    const target = parseTarget(req.url ?? '');
    if (target.kind === 'malformed') {
      emit('', 0, 'denied', 'malformed-target');
      refuse(client, 400);
      return;
    }
    if (target.kind === 'ip-literal') {
      emit(target.host, target.port, 'denied', 'ip-literal');
      refuse(client, 403);
      return;
    }
    const { host, port } = target;
    if (!allowed.has(`${host}:${port}`)) {
      emit(host, port, 'denied', 'not-allowlisted');
      refuse(client, 403);
      return;
    }
    if (active >= maxTunnels) {
      emit(host, port, 'denied', 'connection-limit');
      refuse(client, 503);
      return;
    }
    active += 1;
    let released = false;
    let upstream: net.Socket | undefined;
    const release = (): void => {
      if (!released) {
        released = true;
        active -= 1;
      }
      client.destroy();
      upstream?.destroy();
      if (upstream !== undefined) {
        tunnels.delete(upstream);
      }
    };
    client.on('close', release);
    client.setTimeout(idleTimeoutMs, release);

    void (async () => {
      let addresses: readonly ResolvedAddress[];
      try {
        addresses = await lookup(host);
      } catch {
        emit(host, port, 'denied', 'resolution-failed');
        refuse(client, 502);
        return;
      }
      const usable = addresses.find((entry) => !isBlockedAddress(entry.address));
      if (usable === undefined) {
        emit(host, port, 'denied', 'private-address');
        refuse(client, 403);
        return;
      }
      if (client.destroyed) {
        return;
      }
      emit(host, port, 'allowed');
      const socket = connect(usable.address, port);
      upstream = socket;
      tunnels.add(socket);
      socket.setTimeout(idleTimeoutMs, release);
      let established = false;
      socket.on('error', () => {
        if (!established) {
          refuse(client, 502);
          socket.destroy();
          return;
        }
        release();
      });
      socket.on('close', release);
      socket.once('connect', () => {
        established = true;
        client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
        if (head.length > 0) {
          socket.write(head);
        }
        socket.pipe(client);
        client.pipe(socket);
      });
    })();
  });
  server.on('clientError', (_error, socket) => socket.destroy());

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.socketPath, () => {
      server.off('error', reject);
      resolve();
    });
  }).catch((error: unknown) => {
    throw new NexarError('INTERNAL_ERROR', 'Egress proxy could not listen on its unix socket', {
      cause: error,
    });
  });
  try {
    await chmod(options.socketPath, 0o600);
  } catch (error) {
    server.close();
    throw new NexarError('INTERNAL_ERROR', 'Egress proxy socket permissions could not be set', {
      cause: error,
    });
  }

  let closed: Promise<void> | undefined;
  const close = async (): Promise<void> => {
    const done = new Promise<void>((resolve) => server.close(() => resolve()));
    for (const socket of tunnels) {
      socket.destroy();
    }
    server.closeAllConnections();
    await done;
    await unlink(options.socketPath).catch(() => undefined);
  };
  return {
    socketPath: options.socketPath,
    address: () => server.address(),
    close: () => (closed ??= close()),
  };
}
