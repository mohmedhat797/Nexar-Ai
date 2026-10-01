import { spawn } from 'node:child_process';
import { chmod, mkdir } from 'node:fs/promises';
import { NexarError } from '@nexar/contracts';
import type {
  EngineeringWorkspace,
  LaunchSpec,
  PreparedLaunch,
  ResourceDescriptor,
} from '@nexar/contracts';
import { credentialEnvName } from '../env.js';
import { RuntimeProcess } from '../runtime-process.js';
import type { BinarySpec } from '../runtime-process.js';

/** Where the per-resource DSH state directory appears inside the sandbox. */
export const SANDBOX_DSH_HOME = '/home/agent/.dsh';

export interface AcpLaunchOptions {
  readonly binary: BinarySpec;
  readonly workspace: EngineeringWorkspace;
  readonly resource: ResourceDescriptor;
  /** Host directory for this resource's DSH state; created 0700. Must not be inside the workspace. */
  readonly dshStateDir: string;
  /** The adapter's environment; only the resource's own credential variable is read from it. */
  readonly env: NodeJS.ProcessEnv;
  readonly allowHosts: readonly string[];
}

/**
 * Builds the sandbox launch spec for `dsh --profile acp` and asks the launcher to wrap it.
 *
 * KNOWN GAP: the launcher passes `spec.env` to bubblewrap as `--setenv` arguments, so the values
 * (including the API key, when one is configured) are visible in the argv of the bwrap process to
 * the owner's other processes via `/proc`. The host is trusted by the threat model, but a later
 * change should hand the environment over through `bwrap --args <fd>` instead.
 *
 * Refuses (`POLICY_REJECTED`) to write to a workspace unless the isolation really is the sandbox,
 * both on the launcher's declaration and on what `prepare` reports; nothing is spawned in that case.
 */
export async function prepareAcpLaunch(
  options: AcpLaunchOptions,
  signal: AbortSignal,
): Promise<PreparedLaunch> {
  const { workspace } = options;
  const writable = workspace.access === 'read-write';
  if (writable && workspace.launcher.isolation !== 'sandbox') {
    throw notSandboxed();
  }

  await mkdir(options.dshStateDir, { recursive: true, mode: 0o700 });
  await chmod(options.dshStateDir, 0o700);

  const env: Record<string, string> = { DSH_HOME: SANDBOX_DSH_HOME };
  const credentialName = credentialEnvName(options.resource);
  const credential = credentialName === undefined ? undefined : options.env[credentialName];
  if (credentialName !== undefined && credential !== undefined && credential !== '') {
    env[credentialName] = credential;
  }

  const spec: LaunchSpec = {
    command: options.binary.command,
    args: [...options.binary.args, '--profile', 'acp'],
    env,
    workspace: workspace.path,
    workspaceAccess: workspace.access,
    network: { mode: 'proxy', allowHosts: options.allowHosts },
    mounts: [
      { hostPath: options.dshStateDir, sandboxPath: SANDBOX_DSH_HOME, access: 'read-write' },
    ],
  };
  const prepared = await workspace.launcher.prepare(spec, signal);
  if (writable && prepared.isolation !== 'sandbox') {
    await prepared.dispose().catch(() => undefined);
    throw notSandboxed();
  }
  return prepared;
}

function notSandboxed(): NexarError {
  return new NexarError(
    'POLICY_REJECTED',
    'a read-write engineering workspace requires the sandbox launcher; refusing to start dsh',
  );
}

/** Spawns exactly what `prepare` returned, in its own process group (so `stop()` sweeps the tree). */
export function spawnPrepared(prepared: PreparedLaunch): RuntimeProcess {
  const child = spawn(prepared.command, [...prepared.args], {
    cwd: prepared.cwd,
    env: { ...prepared.env },
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
    detached: process.platform !== 'win32',
  });
  return new RuntimeProcess(child);
}
