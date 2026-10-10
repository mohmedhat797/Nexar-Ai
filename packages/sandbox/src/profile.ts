import { NexarError, type LaunchMount } from '@nexar/contracts';

/** Where the workspace appears inside the sandbox. */
export const SANDBOX_WORKSPACE = '/work';
/** Where the per-launch run directory (proxy socket) appears inside the sandbox in proxy mode. */
export const SANDBOX_RUN_DIR = '/run/nexar';
/** The in-sandbox TCP port the socat bridge listens on (loopback only). */
export const SANDBOX_PROXY_PORT = 3128;
export const SANDBOX_HOME = '/home/agent';
/** Where the Nexar services directory (gateway.sock, bridge.sock) appears inside the sandbox. */
export const SANDBOX_SERVICES_DIR = '/run/nexar-services';
/** The in-sandbox loopback port bridged to gateway.sock; distinct from the proxy port. */
export const SANDBOX_GATEWAY_PORT = 3129;
export const SANDBOX_GATEWAY_BASE_URL = `http://127.0.0.1:${SANDBOX_GATEWAY_PORT}/v1`;
/** The bridge endpoint a relay inside the sandbox connects to. */
export const SANDBOX_BRIDGE_ENDPOINT = `${SANDBOX_SERVICES_DIR}/bridge.sock`;
/** Where the bundled bridge relay script appears inside the sandbox. */
export const SANDBOX_RELAY_PATH = '/opt/nexar/bridge-relay.cjs';

/** Optional system files; absent on minimal systems, so bound with `--ro-bind-try`. */
const OPTIONAL_SYSTEM_FILES = [
  '/etc/ld.so.cache',
  '/etc/ssl',
  '/etc/ca-certificates',
  '/etc/alternatives',
] as const;

/**
 * Starts the loopback socat bridges (egress proxy and/or gateway service), waits (bounded) for each
 * to accept, then execs the command. Every user-provided value reaches the shell as a positional
 * argument, never as script text.
 */
export function buildBridgeScript(bridges: {
  readonly proxy: boolean;
  readonly gateway: boolean;
}): string {
  const wanted: { port: number; socket: string }[] = [];
  if (bridges.proxy)
    wanted.push({ port: SANDBOX_PROXY_PORT, socket: `${SANDBOX_RUN_DIR}/proxy.sock` });
  if (bridges.gateway) {
    wanted.push({ port: SANDBOX_GATEWAY_PORT, socket: `${SANDBOX_SERVICES_DIR}/gateway.sock` });
  }
  return [
    ...wanted.map(
      ({ port, socket }) =>
        `socat TCP-LISTEN:${port},bind=127.0.0.1,fork,reuseaddr UNIX-CONNECT:${socket} 2>/dev/null &`,
    ),
    ...wanted.flatMap(({ port }) => [
      'i=0',
      `while [ "$i" -lt 50 ]; do socat -u OPEN:/dev/null TCP:127.0.0.1:${port} 2>/dev/null && break; i=$((i+1)); sleep 0.02; done`,
    ]),
    'exec "$@"',
  ].join('\n');
}

/** The egress-proxy-only script (network mode `proxy`, no services). */
export const PROXY_BRIDGE_SCRIPT = buildBridgeScript({ proxy: true, gateway: false });
export interface BwrapProfileInput {
  /** Canonical host path of the workspace. */
  readonly workspace: string;
  readonly workspaceAccess: 'read-only' | 'read-write';
  /** Re-bind `<workspace>/.git` read-only over `/work/.git`. */
  readonly protectGit: boolean;
  /** Canonical host paths bound read-only at the same path inside. */
  readonly toolchainPaths: readonly string[];
  /** Already validated mounts. */
  readonly mounts: readonly LaunchMount[];
  /** Host run directory holding `passwd`, `group` and (proxy mode) `proxy.sock`. */
  readonly runDir?: string;
  readonly network: 'none' | 'proxy';
  /** Validated Nexar services (dir canonical): mounted read-only; gateway adds its socat bridge. */
  readonly services?: {
    readonly dir: string;
    readonly gateway: boolean;
    readonly bridge: boolean;
    readonly relayScript?: string;
  };
  /** Default false: adds `--disable-userns`. */
  readonly allowNestedUserNamespaces?: boolean;
  /** The final environment; nothing else is visible inside. */
  readonly env: Readonly<Record<string, string>>;
  /** Read environment arguments from this inherited fd rather than exposing values in argv. */
  readonly environmentFd?: number;
  readonly command: string;
  readonly args: readonly string[];
}

/** Builds the bwrap argument vector. Pure: no IO, deterministic. */
export function buildBwrapArgs(input: BwrapProfileInput): string[] {
  if (input.network === 'proxy' && input.runDir === undefined) {
    throw new NexarError('CONFIGURATION_ERROR', 'Proxy network mode requires a run directory');
  }
  const a: string[] = [
    '--unshare-user',
    '--unshare-ipc',
    '--unshare-pid',
    '--unshare-net',
    '--unshare-uts',
    '--unshare-cgroup',
  ];
  if (input.allowNestedUserNamespaces !== true) {
    a.push('--disable-userns');
  }
  a.push('--die-with-parent', '--new-session', '--cap-drop', 'ALL');

  a.push('--ro-bind', '/usr', '/usr');
  for (const dir of ['bin', 'lib', 'lib64', 'sbin']) {
    a.push('--symlink', `usr/${dir}`, `/${dir}`);
  }
  for (const file of OPTIONAL_SYSTEM_FILES) {
    a.push('--ro-bind-try', file, file);
  }
  if (input.runDir !== undefined) {
    a.push('--ro-bind', `${input.runDir}/passwd`, '/etc/passwd');
    a.push('--ro-bind', `${input.runDir}/group`, '/etc/group');
  }

  a.push('--proc', '/proc', '--dev', '/dev', '--tmpfs', '/tmp', '--tmpfs', SANDBOX_HOME);
  // After the tmpfs mounts, so a toolchain under /tmp (or the home path) is not hidden by them.
  for (const path of input.toolchainPaths) {
    a.push('--ro-bind', path, path);
  }

  a.push(
    input.workspaceAccess === 'read-write' ? '--bind' : '--ro-bind',
    input.workspace,
    SANDBOX_WORKSPACE,
  );
  if (input.protectGit) {
    a.push('--ro-bind', `${input.workspace}/.git`, `${SANDBOX_WORKSPACE}/.git`);
  }
  for (const mount of input.mounts) {
    a.push(
      mount.access === 'read-write' ? '--bind' : '--ro-bind',
      mount.hostPath,
      mount.sandboxPath,
    );
  }
  if (input.network === 'proxy' && input.runDir !== undefined) {
    a.push('--ro-bind', input.runDir, SANDBOX_RUN_DIR);
  }

  if (input.services !== undefined) {
    a.push('--ro-bind', input.services.dir, SANDBOX_SERVICES_DIR);
    if (input.services.relayScript !== undefined) {
      a.push('--ro-bind', input.services.relayScript, SANDBOX_RELAY_PATH);
    }
  }

  a.push('--remount-ro', '/', '--chdir', SANDBOX_WORKSPACE, '--clearenv');
  if (input.environmentFd !== undefined) {
    if (!Number.isSafeInteger(input.environmentFd) || input.environmentFd < 3) {
      throw new NexarError('CONFIGURATION_ERROR', 'Environment argument fd is invalid');
    }
    a.push('--args', String(input.environmentFd));
  } else {
    for (const key of Object.keys(input.env).sort()) {
      a.push('--setenv', key, input.env[key] ?? '');
    }
  }

  a.push('--');
  const proxy = input.network === 'proxy';
  const gateway = input.services?.gateway === true;
  if (proxy || gateway) {
    a.push(
      '/bin/sh',
      '-c',
      buildBridgeScript({ proxy, gateway }),
      'sh',
      input.command,
      ...input.args,
    );
  } else {
    a.push(input.command, ...input.args);
  }
  return a;
}
