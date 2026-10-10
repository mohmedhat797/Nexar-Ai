import { spawn } from 'node:child_process';
import { chmod, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { NexarError } from '@nexar/contracts';
import type {
  EngineeringWorkspace,
  ExecutionGateway,
  LaunchSpec,
  PreparedLaunch,
  ResourceDescriptor,
} from '@nexar/contracts';
import { credentialVariable, resolveOwnCredential } from '../env.js';
import type { CredentialSources } from '../env.js';
import { NEXAR_CONTROL_TOKEN_ENV } from '../overlay.js';
import { CODING_PROFILE, renderProfileOverlay } from '../profiles.js';
import type { DshOverlayRoute } from '../profiles.js';
import { RuntimeProcess } from '../runtime-process.js';
import type { BinarySpec } from '../runtime-process.js';
import { isGatewayMode, requireGatewayEndpoints } from './gateway.js';

/** Where the per-resource DSH state directory appears inside the sandbox. */
export const SANDBOX_DSH_HOME = '/home/agent/.dsh';
/** The Nexar Coding profile overlay of every lane, inside the DSH state directory. */
export const OVERLAY_FILE = 'nexar.patch.yml';
export interface AcpLaunchOptions {
  readonly binary: BinarySpec;
  readonly workspace: EngineeringWorkspace;
  readonly resource: ResourceDescriptor;
  /** Host directory for this resource's DSH state; created 0700. Must not be inside the workspace. */
  readonly dshStateDir: string;
  /**
   * Where the resource's own credential comes from: the adapter's environment (env references)
   * or the key store resolver (keystore references). Nothing else is read.
   */
  readonly sources: CredentialSources;
  readonly allowHosts: readonly string[];
  /**
   * The lane's engine gateway session. For engine `dsh` the run uses Nexar's control route instead of
   * the resource's own credential: no DSH key is resolved, injected or required.
   */
  readonly gateway?: ExecutionGateway | undefined;
  /** Owner-confirmed project memory, rendered into the overlay's `personaSuffix`. Never logged or recorded. */
  readonly requiredContext?: string | undefined;
}

/**
 * Builds the sandbox launch spec for `dsh --profile acp` and asks the launcher to wrap it.
 *
 * KNOWN GAP: the launcher passes `spec.env` to bubblewrap as `--setenv` arguments, so the values
 * (including the API key, when one is configured, or the lane's gateway token) are visible in the
 * argv of the bwrap process to the owner's other processes via `/proc`. The host is trusted by the
 * threat model (the gateway token is lane-scoped and short-lived), but a later change should hand
 * the environment over through `bwrap --args <fd>` instead.
 *
 * Gateway mode (`options.gateway.engine === 'dsh'`): the spec carries the lane's `services`, the
 * environment gets the lane token as `NEXAR_CONTROL_TOKEN`, and after `prepare` the mounted service
 * locations are required (`INTEGRATION_UNAVAILABLE` before anything is spawned).
 *
 * Every launch (gateway or native-key) writes the Coding profile overlay into the DSH state
 * directory (0600) and passes `--patch`: persona, privacy rows, profile tool rows and the required
 * project context. Gateway mode adds the single `nexar` route naming the in-sandbox gateway; native-key
 * mode (`route: resource`) keeps the resource's own `llm-deepseek` credential.
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

  const gateway = isGatewayMode(options.gateway) ? options.gateway : undefined;
  const env: Record<string, string> = { DSH_HOME: SANDBOX_DSH_HOME, DSH_TELEMETRY_DISABLED: '1' };
  if (gateway === undefined) {
    const variable = credentialVariable(options.resource);
    const credential = resolveOwnCredential(options.resource, options.sources);
    if (variable !== undefined && credential !== undefined && credential !== '') {
      env[variable.name] = credential;
    }
  } else {
    env[NEXAR_CONTROL_TOKEN_ENV] = gateway.token;
  }

  const spec: LaunchSpec = {
    command: options.binary.command,
    args: [
      ...options.binary.args,
      '--profile',
      'acp',
      '--patch',
      `${SANDBOX_DSH_HOME}/${OVERLAY_FILE}`,
    ],
    env,
    workspace: workspace.path,
    workspaceAccess: workspace.access,
    network: { mode: 'proxy', allowHosts: options.allowHosts },
    mounts: [
      { hostPath: options.dshStateDir, sandboxPath: SANDBOX_DSH_HOME, access: 'read-write' },
    ],
    ...(gateway === undefined ? {} : { services: gateway.services }),
  };
  const prepared = await workspace.launcher.prepare(spec, signal);
  try {
    if (signal.aborted) throw new NexarError('EXECUTION_CANCELLED', 'execution was cancelled');
    if (writable && prepared.isolation !== 'sandbox') throw notSandboxed();
    const route: DshOverlayRoute =
      gateway === undefined
        ? { kind: 'resource' }
        : { kind: 'nexar', baseURL: requireGatewayEndpoints(gateway, prepared).baseURL };
    const overlay = join(options.dshStateDir, OVERLAY_FILE);
    await writeFile(
      overlay,
      renderProfileOverlay({
        profile: CODING_PROFILE,
        route,
        requiredContext: options.requiredContext,
      }),
      { mode: 0o600 },
    );
    await chmod(overlay, 0o600);
  } catch (error) {
    await prepared.dispose().catch(() => undefined);
    throw error;
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
