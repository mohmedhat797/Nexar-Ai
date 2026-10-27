import { chmod, realpath, writeFile } from 'node:fs/promises';
import { isAbsolute, join, relative, sep } from 'node:path';
import { NexarError, type LaunchServices, type ProcessLauncher } from '@nexar/contracts';
import { COWORK_PROFILE, renderProfileOverlay } from '../profiles.js';
import { NEXAR_CONTROL_TOKEN_ENV } from '../overlay.js';
import { bridgeMcpServer, bridgeToolNames } from './gateway.js';
import {
  runPreparedCoworkSession,
  type LocalAcpSessionOptions,
  type LocalAcpResult,
} from './local.js';

const HOME = '/home/agent/.dsh';
const OVERLAY = 'nexar.patch.yml';

export interface SandboxedCoworkOptions extends LocalAcpSessionOptions {
  readonly launcher: ProcessLauncher;
  readonly services: LaunchServices;
  /** Canonical Node path visible in the read-only toolchain mount. */
  readonly nodeCommand: string;
  /** Private copied inputs, never the owner's source directory. */
  readonly inputDir?: string;
  readonly standalone?: boolean;
}

/** Cowork placement over the existing launcher; never inherits Coding permissions or egress. */
export async function runSandboxedCoworkSession(
  options: SandboxedCoworkOptions,
): Promise<LocalAcpResult> {
  if (
    options.launcher.isolation !== 'sandbox' ||
    options.profile.id !== 'cowork' ||
    options.permissionMode !== 'read-only' ||
    process.platform === 'win32'
  ) {
    throw new NexarError('SANDBOX_UNAVAILABLE', 'Cowork sandbox is unavailable');
  }
  const [scratch, home] = await Promise.all([
    realpath(options.scratchDir),
    realpath(options.dshHome),
  ]);
  const base = await realpath(options.scratchBase);
  const inside = (parent: string, child: string): boolean => {
    const rel = relative(parent, child);
    return rel !== '' && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
  };
  if (!inside(base, scratch) || home === scratch || inside(scratch, home)) {
    throw new NexarError('POLICY_REJECTED', 'Cowork private workspace is invalid');
  }
  const prepared = await options.launcher.prepare(
    {
      command: options.launch.command,
      args: [...options.launch.args, '--profile', 'acp', '--patch', `${HOME}/${OVERLAY}`],
      env: {
        DSH_HOME: HOME,
        DSH_AGENTS_HOME: `${HOME}/agents`,
        DSH_PERMISSION_MODE: 'read-only',
        DSH_TELEMETRY_DISABLED: '1',
        [NEXAR_CONTROL_TOKEN_ENV]: options.control.token,
      },
      workspace: scratch,
      workspaceAccess: 'read-write',
      network: { mode: 'none' },
      mounts: [
        { hostPath: home, sandboxPath: HOME, access: 'read-write' },
        ...(options.inputDir === undefined
          ? []
          : [
              {
                hostPath: options.inputDir,
                sandboxPath: '/inputs/cowork',
                access: 'read-only' as const,
              },
            ]),
      ],
      services: options.services,
    },
    options.signal,
  );
  try {
    if (
      prepared.isolation !== 'sandbox' ||
      prepared.workspacePath !== '/work' ||
      prepared.services?.gatewayBaseUrl === undefined ||
      options.signal.aborted
    ) {
      throw new NexarError('SANDBOX_UNAVAILABLE', 'Cowork isolation preparation failed');
    }
    await writeFile(
      join(home, OVERLAY),
      renderProfileOverlay({
        profile: COWORK_PROFILE,
        route: { kind: 'nexar', baseURL: prepared.services.gatewayBaseUrl },
        requiredContext: options.requiredContext,
      }),
      { flag: 'wx', mode: 0o600 },
    );
    await chmod(join(home, OVERLAY), 0o600);
    const endpoint = prepared.services.bridgeEndpoint;
    const relay = prepared.services.relayPath;
    if (options.services.bridge && (endpoint === undefined || relay === undefined)) {
      throw new NexarError('SANDBOX_UNAVAILABLE', 'Cowork bridge is unavailable');
    }
    const mcp =
      endpoint === undefined || relay === undefined
        ? undefined
        : bridgeMcpServer(
            options.nodeCommand,
            { endpoint, relayPath: relay },
            options.control.token,
          );
    if (mcp !== undefined && options.standalone === true) {
      (mcp.env as { name: string; value: string }[]).push({
        name: 'NEXAR_BRIDGE_STANDALONE_ONLY',
        value: '1',
      });
    }
    return await runPreparedCoworkSession(
      {
        ...options,
        scratchDir: '/work',
        dshHome: HOME,
        mcpServers: mcp === undefined ? [] : [mcp],
        bridgeTools: options.services.bridge ? bridgeToolNames() : [],
      },
      prepared,
    );
  } finally {
    await prepared.dispose();
  }
}
