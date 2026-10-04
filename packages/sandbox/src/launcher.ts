import { lstat, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, posix } from 'node:path';
import {
  NexarError,
  type EgressEvent,
  type LaunchMount,
  type LaunchSpec,
  type PreparedLaunch,
  type ProcessLauncher,
} from '@nexar/contracts';
import { checkSandboxAvailability, type SandboxAvailability } from './availability.js';
import {
  validateHostPath,
  validateMounts,
  validateToolchainPaths,
  type ValidatedMount,
} from './mounts.js';
import {
  buildBwrapArgs,
  SANDBOX_BRIDGE_ENDPOINT,
  SANDBOX_GATEWAY_BASE_URL,
  SANDBOX_HOME,
  SANDBOX_PROXY_PORT,
  SANDBOX_RELAY_PATH,
  SANDBOX_WORKSPACE,
} from './profile.js';
import { startEgressProxy, type EgressProxy, type ResolvedAddress } from './proxy.js';
import { createRunDir, type RunDir } from './run-dir.js';
import { validateServices } from './services.js';
import type net from 'node:net';

export interface SandboxLauncherOptions {
  /** Host toolchain directories (for example `/opt/node22`), bound read-only at the same path. */
  readonly toolchainPaths?: readonly string[];
  /** Default `os.homedir()`. */
  readonly homeDir?: string;
  /** Base for per-launch run directories. Default `os.tmpdir()`. */
  readonly runDirBase?: string;
  readonly bwrapPath?: string;
  readonly socatPath?: string;
  /** Default false: nested user namespaces are disabled inside the sandbox. */
  readonly allowNestedUserNamespaces?: boolean;
  readonly onEgress?: (event: EgressEvent) => void;
  /** Test seam: replaces the availability probe. */
  readonly availability?: () => Promise<SandboxAvailability>;
  /** Test seams for the egress proxy. */
  readonly lookup?: (host: string) => Promise<readonly ResolvedAddress[]>;
  readonly connect?: (address: string, port: number) => net.Socket;
}

const ENV_KEY = /^[A-Za-z_][A-Za-z0-9_]*$/;
const PROXY_URL = `http://127.0.0.1:${SANDBOX_PROXY_PORT}`;
const PROXY_VARS = [
  'HTTPS_PROXY',
  'HTTP_PROXY',
  'https_proxy',
  'http_proxy',
  'ALL_PROXY',
  'all_proxy',
  'NODE_USE_ENV_PROXY',
  'NO_PROXY',
  'no_proxy',
] as const;
const SYSTEM_COMMAND_PREFIXES = ['/usr', '/bin', '/sbin', '/lib', '/lib64'] as const;
const DEFAULT_PATH_SUFFIX = ['/usr/local/bin', '/usr/bin', '/bin'] as const;

function isSameOrUnder(path: string, base: string): boolean {
  return path === base || path.startsWith(`${base}/`);
}

function cancelled(): NexarError {
  return new NexarError('EXECUTION_CANCELLED', 'Sandbox launch was cancelled');
}

function unavailable(detail: string): NexarError {
  return new NexarError('SANDBOX_UNAVAILABLE', `Sandbox unavailable: ${detail}`, {
    retryable: false,
  });
}

/** Wraps commands in the Nexar bubblewrap profile, fail closed (ADR-018). */
export class SandboxLauncher implements ProcessLauncher {
  readonly isolation = 'sandbox' as const;
  private availabilityPromise: Promise<SandboxAvailability> | undefined;

  constructor(private readonly options: SandboxLauncherOptions = {}) {}

  async prepare(spec: LaunchSpec, signal: AbortSignal): Promise<PreparedLaunch> {
    if (signal.aborted) {
      throw cancelled();
    }
    const availability = await this.checkAvailability();
    if (!availability.available || availability.bwrapPath === undefined) {
      throw unavailable(availability.detail);
    }
    const proxyMode = spec.network.mode === 'proxy';
    if (proxyMode && availability.socatPath === undefined) {
      throw unavailable('socat is required for proxy network mode');
    }
    if (spec.services?.gateway === true && availability.socatPath === undefined) {
      throw unavailable('socat is required for the gateway service');
    }
    // Before any per-launch state exists: a bad services spec spawns and creates nothing.
    const services =
      spec.services === undefined ? undefined : await validateServices(spec.services);

    const homeDir = this.options.homeDir ?? homedir();
    const hostRules = { homeDir };
    const workspace = await validateWorkspace(spec.workspace, hostRules);
    const protectGit = (await inspectGit(workspace)) && spec.workspaceAccess === 'read-write';
    const mounts = await validateMounts(spec.mounts ?? [], hostRules);
    const toolchainPaths = await validateToolchainPaths(
      this.options.toolchainPaths ?? [],
      hostRules,
    );
    const env = buildEnv(spec, toolchainPaths, services?.gateway === true);
    const command = translateCommand(spec.command, workspace, toolchainPaths, mounts);

    let runDir: RunDir | undefined;
    let proxy: EgressProxy | undefined;
    let disposed: Promise<void> | undefined;
    const dispose = (): Promise<void> =>
      (disposed ??= (async () => {
        signal.removeEventListener('abort', onAbort);
        await proxy?.close().catch(() => undefined);
        await runDir?.remove().catch(() => undefined);
      })());
    const onAbort = (): void => {
      void dispose();
    };

    try {
      runDir = await createRunDir(
        this.options.runDirBase === undefined ? {} : { base: this.options.runDirBase },
      );
      if (spec.network.mode === 'proxy') {
        proxy = await startEgressProxy({
          socketPath: runDir.socketPath,
          allowHosts: spec.network.allowHosts,
          ...(this.options.onEgress === undefined ? {} : { onEgress: this.options.onEgress }),
          ...(this.options.lookup === undefined ? {} : { lookup: this.options.lookup }),
          ...(this.options.connect === undefined ? {} : { connect: this.options.connect }),
        });
      }
      if (signal.aborted) {
        throw cancelled();
      }
      const args = buildBwrapArgs({
        workspace,
        workspaceAccess: spec.workspaceAccess,
        protectGit,
        toolchainPaths,
        mounts,
        runDir: runDir.path,
        network: proxyMode ? 'proxy' : 'none',
        ...(services === undefined ? {} : { services }),
        allowNestedUserNamespaces: this.options.allowNestedUserNamespaces ?? false,
        env,
        command,
        args: spec.args,
      });
      signal.addEventListener('abort', onAbort, { once: true });
      return {
        command: availability.bwrapPath,
        args,
        env: { PATH: '/usr/bin:/bin' },
        cwd: workspace,
        workspacePath: SANDBOX_WORKSPACE,
        isolation: 'sandbox',
        ...(services === undefined
          ? {}
          : {
              services: {
                ...(services.gateway ? { gatewayBaseUrl: SANDBOX_GATEWAY_BASE_URL } : {}),
                ...(services.bridge ? { bridgeEndpoint: SANDBOX_BRIDGE_ENDPOINT } : {}),
                ...(services.relayScript === undefined ? {} : { relayPath: SANDBOX_RELAY_PATH }),
              },
            }),
        dispose,
      };
    } catch (error) {
      await dispose();
      throw error;
    }
  }

  private checkAvailability(): Promise<SandboxAvailability> {
    this.availabilityPromise ??=
      this.options.availability?.() ??
      checkSandboxAvailability({
        ...(this.options.bwrapPath === undefined ? {} : { bwrapPath: this.options.bwrapPath }),
        ...(this.options.socatPath === undefined ? {} : { socatPath: this.options.socatPath }),
        ...(this.options.runDirBase === undefined ? {} : { tmpBase: this.options.runDirBase }),
        allowNestedUserNamespaces: this.options.allowNestedUserNamespaces ?? false,
      });
    return this.availabilityPromise;
  }
}

async function validateWorkspace(
  workspace: string,
  options: { readonly homeDir: string },
): Promise<string> {
  const canonical = await validateHostPath(workspace, 'workspace', options);
  const info = await stat(canonical).catch(() => undefined);
  if (info === undefined || !info.isDirectory()) {
    throw new NexarError('CONFIGURATION_ERROR', 'Workspace must be a directory', {
      details: { rule: 'workspace must be a directory' },
    });
  }
  return canonical;
}

/** True when `<workspace>/.git` is a real directory. A file or symlink is rejected (fail closed). */
async function inspectGit(workspace: string): Promise<boolean> {
  const info = await lstat(`${workspace}/.git`).catch(() => undefined);
  if (info === undefined) {
    return false;
  }
  if (info.isDirectory()) {
    return true;
  }
  throw new NexarError(
    'POLICY_REJECTED',
    'Workspace .git must be a directory (linked worktrees are not supported)',
    { details: { reason: 'GIT_NOT_DIRECTORY' } },
  );
}

function buildEnv(
  spec: LaunchSpec,
  toolchainPaths: readonly string[],
  gatewayService: boolean,
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(spec.env)) {
    if (!ENV_KEY.test(key)) {
      throw new NexarError('CONFIGURATION_ERROR', 'Environment variable name is invalid', {
        details: { rule: 'env key syntax' },
      });
    }
    if (typeof value !== 'string' || value.includes('\0')) {
      throw new NexarError('CONFIGURATION_ERROR', 'Environment variable value is invalid', {
        details: { rule: 'env value must be a string without NUL', key },
      });
    }
    env[key] = value;
  }
  env['PATH'] ??= [...toolchainPaths.map((path) => `${path}/bin`), ...DEFAULT_PATH_SUFFIX].join(
    ':',
  );
  Object.assign(env, {
    HOME: SANDBOX_HOME,
    TMPDIR: '/tmp',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_TERMINAL_PROMPT: '0',
  });
  for (const name of PROXY_VARS) {
    delete env[name];
  }
  if (spec.network.mode === 'proxy') {
    Object.assign(env, {
      HTTPS_PROXY: PROXY_URL,
      HTTP_PROXY: PROXY_URL,
      https_proxy: PROXY_URL,
      http_proxy: PROXY_URL,
      NODE_USE_ENV_PROXY: '1',
    });
  }
  if (gatewayService) {
    // Node's env proxy would otherwise send the loopback gateway calls to the egress proxy (which
    // denies them) or, in network mode none, nowhere. Only the gateway service sets this.
    Object.assign(env, { NO_PROXY: '127.0.0.1', no_proxy: '127.0.0.1' });
  }
  return env;
}

/** An absolute command must be visible inside the sandbox; host paths are translated to sandbox paths. */
function translateCommand(
  command: string,
  workspace: string,
  toolchainPaths: readonly string[],
  mounts: readonly ValidatedMount[],
): string {
  if (typeof command !== 'string' || command === '' || command.includes('\0')) {
    throw new NexarError('CONFIGURATION_ERROR', 'Command is invalid', {
      details: { rule: 'command syntax' },
    });
  }
  if (!isAbsolute(command)) {
    return command;
  }
  const normalized = posix.normalize(command);
  if (SYSTEM_COMMAND_PREFIXES.some((prefix) => isSameOrUnder(normalized, prefix))) {
    return normalized;
  }
  if (toolchainPaths.some((path) => isSameOrUnder(normalized, path))) {
    return normalized;
  }
  const translations: readonly LaunchMount[] = [
    ...mounts,
    { hostPath: workspace, sandboxPath: SANDBOX_WORKSPACE, access: 'read-only' },
  ];
  for (const mount of translations) {
    if (isSameOrUnder(normalized, mount.hostPath)) {
      return `${mount.sandboxPath}${normalized.slice(mount.hostPath.length)}`;
    }
  }
  throw new NexarError('CONFIGURATION_ERROR', 'Command is not visible inside the sandbox', {
    details: { rule: 'command must be under /usr, a toolchain path or a mount' },
  });
}
