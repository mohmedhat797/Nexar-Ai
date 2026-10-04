import { randomUUID } from 'node:crypto';
import { chmod, mkdir, mkdtemp, realpath, rm, stat } from 'node:fs/promises';
import type { Server } from 'node:http';
import { join } from 'node:path';
import {
  DEFAULT_CONTROL_RESOURCE_POLICY,
  isNexarError,
  type ControlResourcePolicy,
  type ExecutionGateway,
  type Logger,
  type ModelTurnPort,
  type ResourceDescriptor,
  type SecretResolver,
} from '@nexar/contracts';
import type { NexarRuntime } from '@nexar/core';
import { BridgeHost, ControlModelGateway } from '@nexar/engine-gateway';
import type { LaneEngine, LaneEngineLane, LaneEngineSession } from '@nexar/engineering';
import { DEEPSEEK_HARNESS_ADAPTER_ID } from '@nexar/integration-deepseek-harness';
import { createControlGatewayServer } from '@nexar/integration-openai-compat';
import { SANDBOX_GATEWAY_PORT } from '@nexar/sandbox';
import { createEngineExecutor, engineAllocator, type BridgeRuntimeSource } from './bridge-ports.js';
import { createControlModelTurnPorts } from './composition.js';
import type { HostEnvironment } from './seams.js';

export interface PlaneLaneEngineOptions {
  readonly runtime: Pick<NexarRuntime, 'nexar' | 'controller' | 'registry' | 'policy'>;
  readonly io: HostEnvironment;
  readonly logger: Logger;
  /** `<state>/.nexar`; lane service directories live under `lanes/` and are removed at lane end. */
  readonly stateDir: string;
  /** Grant lifetime: the longest lane timeout the plane can run. */
  readonly ttlMs: number;
  /** `orchestration.code.controlResource`; defaults to `DEFAULT_CONTROL_RESOURCE_POLICY`. */
  readonly controlPolicy?: ControlResourcePolicy;
  readonly resolveSecret?: SecretResolver;
  /** Test seam; defaults to `createControlModelTurnPorts` (pi resources only). */
  readonly ports?: (descriptor: ResourceDescriptor) => ModelTurnPort | undefined;
  /** The bundled bridge relay; without it the bridge is not offered to the lane. */
  readonly relayScript?: string;
  readonly platform?: NodeJS.Platform;
  readonly newId?: () => string;
  readonly clock?: () => Date;
}

const MAX_UNITS = 16;

/**
 * Lane-private engine gateway sessions for the DeepSeek Harness (`dsh`) engine (ADR-027 section 9b):
 * a Control Model Gateway, Intelligence Bridge host and Chat Completions translator on unix sockets
 * in a private directory the sandbox mounts read-only. No TCP listener; everything is removed at
 * lane end. The token exists only inside the session and is never logged.
 */
export class PlaneLaneEngine implements LaneEngine {
  private readonly platform: NodeJS.Platform;
  private readonly newId: () => string;
  private readonly clock: () => Date;
  private readonly ports: NonNullable<PlaneLaneEngineOptions['ports']>;
  private readonly source: BridgeRuntimeSource;

  constructor(private readonly options: PlaneLaneEngineOptions) {
    this.platform = options.platform ?? process.platform;
    this.newId = options.newId ?? randomUUID;
    this.clock = options.clock ?? (() => new Date());
    this.ports =
      options.ports ??
      createControlModelTurnPorts(options.io, {
        ...(options.resolveSecret === undefined ? {} : { resolveSecret: options.resolveSecret }),
      });
    this.source = { composition: () => ({ runtime: options.runtime }) };
  }

  async open(lane: LaneEngineLane): ReturnType<LaneEngine['open']> {
    const { runtime } = this.options;
    if (this.platform === 'win32') return { unavailable: 'engine-unavailable' };
    const candidates = runtime.registry
      .snapshot()
      .filter((s) => s.descriptor.runtime.adapter === DEEPSEEK_HARNESS_ADAPTER_ID);
    const engine = candidates.find((s) => s.state.availability === 'available') ?? candidates[0];
    if (engine === undefined) return { unavailable: 'engine-unavailable' };

    const policy = this.options.controlPolicy ?? DEFAULT_CONTROL_RESOURCE_POLICY;
    const hostRef: { current?: BridgeHost } = {};
    const gateway = new ControlModelGateway({
      ports: this.ports,
      candidates: () => runtime.registry.snapshot(),
      policy: runtime.policy,
      clock: this.clock,
      newId: this.newId,
      logger: this.options.logger,
      onEvent: (event) => hostRef.current?.noteControlEvent(event),
    });
    if (gateway.preview('dsh', policy) === undefined) {
      return { unavailable: 'control-unavailable' };
    }

    let dir: string | undefined;
    let host: BridgeHost | undefined;
    let server: Server | undefined;
    let grantId: string | undefined;
    const close = once(async () => {
      if (grantId !== undefined) host?.revoke(grantId);
      if (server?.listening === true) {
        const closing = server;
        await new Promise<void>((resolve) => {
          closing.close(() => resolve());
          closing.closeAllConnections();
        });
      }
      await host?.stop();
      if (dir !== undefined) await rm(dir, { recursive: true, force: true });
    });
    try {
      const lanes = join(this.options.stateDir, 'lanes');
      await mkdir(lanes, { recursive: true, mode: 0o700 });
      // mkdtemp creates the directory 0700 with a random name; the canonical path is what is mounted.
      dir = await realpath(await mkdtemp(join(lanes, 'l-')));
      await chmod(dir, 0o700);
      const bridgePath = join(dir, 'bridge.sock');
      const gatewayPath = join(dir, 'gateway.sock');

      host = new BridgeHost({
        gateway,
        allocator: engineAllocator(this.source),
        executor: createEngineExecutor(this.source),
        clock: this.clock,
        newId: this.newId,
        logger: this.options.logger,
        runtimeDir: dir,
        endpointPath: bridgePath,
        platform: this.platform,
      });
      hostRef.current = host;
      await host.start();

      const listening = createControlGatewayServer({
        endpoint: bridgePath,
        allowedHostPort: SANDBOX_GATEWAY_PORT,
      });
      server = listening;
      await new Promise<void>((resolve, reject) => {
        listening.once('error', reject);
        listening.listen(gatewayPath, () => {
          listening.off('error', reject);
          resolve();
        });
      });
      await chmod(gatewayPath, 0o600);

      const minted = host.mint(
        {
          sessionId: lane.engineeringTaskId,
          turnId: `${lane.laneId}-r${String(lane.round)}`,
          correlationId: this.newId(),
          projectId: lane.projectId,
          engine: 'dsh',
          access: 'draft',
          maxUnits: MAX_UNITS,
          ttlMs: this.options.ttlMs,
        },
        { policy },
      );
      grantId = minted.grantId;
      if (minted.controlDecisionId === undefined || minted.resourceId === undefined) {
        throw new Error('no control decision');
      }
      // A relay that is not built (a dev checkout) is simply not offered.
      const relayScript = await existingFile(this.options.relayScript);
      const executionGateway: ExecutionGateway = {
        engine: 'dsh',
        services: {
          dir,
          gateway: true,
          bridge: relayScript !== undefined,
          ...(relayScript === undefined ? {} : { relayScript }),
        },
        token: minted.token,
        model: 'nexar-control',
        controlResourceId: minted.resourceId,
        controlDecisionId: minted.controlDecisionId,
      };
      const owner = host;
      const id = minted.grantId;
      const session: LaneEngineSession = {
        engineResourceId: engine.descriptor.id,
        gateway: executionGateway,
        controlFailed: () => owner.controlFailed(id),
        close,
      };
      return session;
    } catch (error) {
      this.options.logger.warn('engine session could not be opened', {
        code: isNexarError(error) ? error.code : 'INTERNAL_ERROR',
      });
      await close().catch(() => undefined);
      return {
        unavailable:
          isNexarError(error) && error.code === 'NO_ELIGIBLE_RESOURCE'
            ? 'control-unavailable'
            : 'engine-unavailable',
      };
    }
  }
}

/** The path when it names a regular file, else `undefined`. */
async function existingFile(path: string | undefined): Promise<string | undefined> {
  if (path === undefined) return undefined;
  const info = await stat(path).catch(() => undefined);
  return info?.isFile() === true ? path : undefined;
}

/** Runs `fn` once; later calls share its result (an idempotent close). */
function once(fn: () => Promise<void>): () => Promise<void> {
  let pending: Promise<void> | undefined;
  return () => (pending ??= fn());
}
