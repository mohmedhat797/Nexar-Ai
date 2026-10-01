import { NexarError, type LaunchMount } from '@nexar/contracts';

/** Where the workspace appears inside the sandbox. */
export const SANDBOX_WORKSPACE = '/work';
/** Where the per-launch run directory (proxy socket) appears inside the sandbox in proxy mode. */
export const SANDBOX_RUN_DIR = '/run/nexar';
/** The in-sandbox TCP port the socat bridge listens on (loopback only). */
export const SANDBOX_PROXY_PORT = 3128;
export const SANDBOX_HOME = '/home/agent';

/** Optional system files; absent on minimal systems, so bound with `--ro-bind-try`. */
const OPTIONAL_SYSTEM_FILES = [
  '/etc/ld.so.cache',
  '/etc/ssl',
  '/etc/ca-certificates',
  '/etc/alternatives',
] as const;

/**
 * Starts the loopback bridge to the proxy socket, waits (bounded) for it to accept, then execs the
 * command. Every user-provided value reaches the shell as a positional argument, never as script text.
 */
export const PROXY_BRIDGE_SCRIPT = [
  `socat TCP-LISTEN:${SANDBOX_PROXY_PORT},bind=127.0.0.1,fork,reuseaddr UNIX-CONNECT:${SANDBOX_RUN_DIR}/proxy.sock 2>/dev/null &`,
  'i=0',
  `while [ "$i" -lt 50 ]; do socat -u OPEN:/dev/null TCP:127.0.0.1:${SANDBOX_PROXY_PORT} 2>/dev/null && break; i=$((i+1)); sleep 0.02; done`,
  'exec "$@"',
].join('\n');

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
  /** Default false: adds `--disable-userns`. */
  readonly allowNestedUserNamespaces?: boolean;
  /** The final environment; nothing else is visible inside. */
  readonly env: Readonly<Record<string, string>>;
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

  a.push('--remount-ro', '/', '--chdir', SANDBOX_WORKSPACE, '--clearenv');
  for (const key of Object.keys(input.env).sort()) {
    a.push('--setenv', key, input.env[key] ?? '');
  }

  a.push('--');
  if (input.network === 'proxy') {
    a.push('/bin/sh', '-c', PROXY_BRIDGE_SCRIPT, 'sh', input.command, ...input.args);
  } else {
    a.push(input.command, ...input.args);
  }
  return a;
}
