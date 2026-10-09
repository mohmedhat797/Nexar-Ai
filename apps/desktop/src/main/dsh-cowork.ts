import type { spawn as nodeSpawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { ApprovalGate, recordPolicyDecision } from '@nexar/approvals';
import { LocalArtifactStore } from '@nexar/artifacts';
import {
  DEFAULT_CONTROL_RESOURCE_POLICY,
  NexarError,
  coworkDelegationLimit,
  isNexarError,
  projectId as asProjectId,
  type ArtifactRef,
  type ControlResourcePolicy,
  type Logger,
  type NexarTask,
} from '@nexar/contracts';
import type {
  BridgeEvent,
  BridgeGrantInput,
  BridgeHost,
  ControlModelGateway,
} from '@nexar/engine-gateway';
import { DelegationUnitLimit } from '@nexar/engine-gateway';
import {
  BRIDGE_SERVER_NAME,
  COWORK_PROFILE,
  bridgeToolNames,
  coworkPermissionMode,
  decideCoworkPermission,
  probeDshRuntime,
  runLocalAcpSession,
  type DshLaunch,
  type DshRuntimeStatus,
  type LocalAcpEvent,
  type PermissionDecisionInput,
} from '@nexar/integration-deepseek-harness';
import type { CoworkDelegation, CoworkRequest, CoworkResult } from '@nexar/operating';
import type { CoworkStatusDto } from '../shared/api.js';
import { CHANNELS } from '../shared/channels.js';
import { relayLaunch, type RelayLaunch } from './bridge-relay-path.js';
import { NoArgs, defineChannel, type CallContext, type ChannelDefinition } from './channel.js';
import { importDrafts } from './cowork-drafts.js';
import { dshLaunchForEntry, resolveDshEntry } from './dsh-runtime-path.js';
import type { EngineHost } from './engine-host.js';
import type { SettingsStore } from './settings-store.js';

/*
 * The Desktop side of the Cowork lane on DeepSeek Harness (ADR-030): one host-local `dsh --profile
 * acp` child per turn with the Cowork profile, every model call bound to the NRC through the Control
 * Model Gateway (one grant per turn, a pinned control decision), a deterministic permission policy
 * with recorded decisions, and drafts imported through `LocalArtifactStore`. DSH never writes into a
 * project and never sees a provider key: its only credential is the turn's gateway grant token.
 * Logs, errors and events carry codes and fixed texts only.
 */

export const COWORK_REASONS = {
  checking: 'The Cowork lane is still being checked',
  'settings-invalid': 'The Cowork settings are not valid',
  'dsh-missing': 'DeepSeek Harness is not installed',
  'unsupported-version': 'DeepSeek Harness version is not supported',
  'startup-failed': 'DeepSeek Harness did not start',
  'control-unavailable': 'No control-compatible resource can run Cowork',
  ready: 'DeepSeek Harness is ready',
} as const;

export interface DshCoworkTimings {
  /** How a probe result is reused. */
  readonly cacheMs: number;
  /** Upper bound on one DeepSeek Harness turn. */
  readonly turnTimeoutMs: number;
  /** Deadline for the runtime's `initialize` and `session/new` (a cold start takes ~19 s). */
  readonly startupTimeoutMs: number;
  /** Upper bound on the `--version` probe. */
  readonly probeTimeoutMs: number;
  /** How long an ask-before-write approval stays pending before it expires (denied). */
  readonly approvalTtlMs: number;
  readonly approvalPollMs: number;
}

export const DEFAULT_DSH_COWORK_TIMINGS: DshCoworkTimings = {
  cacheMs: 60_000,
  turnTimeoutMs: 10 * 60_000,
  startupTimeoutMs: 90_000,
  probeTimeoutMs: 30_000,
  approvalTtlMs: 2 * 60_000,
  approvalPollMs: 250,
};

const MAX_APPROVAL_LABEL_CHARS = 80;
const MAX_DELEGATIONS = 32;
const SAFE_ID = /^[A-Za-z0-9_-]{1,64}$/;
const SAFE_TOOL = /^[A-Za-z0-9_.-]{1,64}$/;

/** Concurrent Cowork turns in this process (each one runs its own DeepSeek Harness child). */
export const MAX_ACTIVE_COWORK_TURNS = 4;

/** One fixed line, outside the untrusted context: where a substantive unit may be delegated. */
export function delegationInstruction(): string {
  const [submit, status] = bridgeToolNames();
  return `Nexar: delegate substantive drafting, analysis or review units with ${String(submit)}, then poll ${String(status)} with the returned jobId until the unit is done. Do not use any sleep or timer tool: wait by polling ${String(status)} directly in this turn until done, then write the final deliverable.`;
}

/** A model-chosen file name as a short, single-line label (no control characters). */
function writeLabel(target: string | undefined): string {
  const name = (target ?? '').split(/[\\/]/).filter(Boolean).at(-1) ?? 'a file';
  return name.replace(/[\p{Cc}\p{Cf}]/gu, ' ').slice(0, MAX_APPROVAL_LABEL_CHARS);
}

/** The tool name as shown in progress: only a plain identifier ever leaves, else a fixed word. */
function progressName(name: string): string {
  return SAFE_TOOL.test(name) ? name : 'tool';
}

/** Fixed code and text per failure code: upstream text never reaches the owner. */
function turnFailure(error: unknown): NexarError {
  const code = isNexarError(error) ? error.code : undefined;
  switch (code) {
    case 'EXECUTION_CANCELLED':
      return new NexarError('EXECUTION_CANCELLED', 'The Cowork turn was cancelled');
    case 'EXECUTION_TIMEOUT':
      return new NexarError('EXECUTION_TIMEOUT', 'DeepSeek Harness did not finish in time');
    case 'POLICY_REJECTED':
      return new NexarError('POLICY_REJECTED', 'DeepSeek Harness was stopped by Nexar policy');
    case 'CONFIGURATION_ERROR':
    case 'VALIDATION_ERROR':
      return new NexarError('VALIDATION_ERROR', 'DeepSeek Harness did not accept the request');
    default:
      return new NexarError(
        'INTEGRATION_UNAVAILABLE',
        'DeepSeek Harness could not complete the request',
      );
  }
}

/** The control resource failed (or could not be restarted): fixed code, text and reason. */
const controlFailure = (): NexarError =>
  new NexarError('PROVIDER_ERROR', 'The control resource failed', {
    details: { reason: 'control-resource-failed' },
  });

function codeOf(error: unknown): string {
  return isNexarError(error) ? error.code : 'UNKNOWN';
}

type CoworkStatus = CoworkStatusDto;

/** What the rest of Desktop uses of the Cowork lane (the service, and tests' stand-ins). */
export interface CoworkLane {
  status(): Promise<CoworkStatus>;
  refresh(): Promise<CoworkStatus>;
  warm(): Promise<void>;
  available(): boolean;
  reason(): string | undefined;
  fallbackReason(): string | undefined;
  effectiveControlResourceId(): Promise<string | undefined>;
  noteBridgeEvent(event: BridgeEvent): void;
  run(request: CoworkRequest, signal: AbortSignal): Promise<CoworkResult>;
  dispose(): Promise<void>;
}

export interface DshCoworkServiceOptions {
  readonly settings: Pick<SettingsStore, 'getCowork'> &
    Partial<Pick<SettingsStore, 'getOrchestration'>>;
  readonly engine: EngineHost;
  readonly logger: Logger;
  /** Absolute private state directory (created 0700): per-turn scratch and DSH homes live here. */
  readonly stateDir: string;
  /** The Intelligence Bridge (ADR-027 section 9a) and the Control Model Gateway behind it. */
  readonly bridgeHost: Pick<BridgeHost, 'ensureStarted' | 'mint' | 'revoke'> &
    Partial<Pick<BridgeHost, 'restartControl' | 'controlFailed'>>;
  readonly controlGateway: Pick<ControlModelGateway, 'preview'>;
  /** The loopback Chat Completions translator child. */
  readonly controlChild: { baseUrl(): Promise<string> };
  /** How DSH launches the bridge relay. Default: this app's own bundled relay. */
  readonly relay?: () => RelayLaunch;
  /** The task for a turn, with Nexar-set lineage. */
  readonly createTask: (
    request: CoworkRequest,
    excludedResourceIds: readonly string[],
  ) => NexarTask;
  /** The test-only entry override: main passes it only under `NEXAR_DESKTOP_USER_DATA`. */
  readonly testEntry?: string | undefined;
  /** `process.resourcesPath` of a packaged app. */
  readonly resourcesPath?: string | undefined;
  /** `true` under the test override without an entry: DeepSeek Harness is never launched. */
  readonly disabled?: boolean;
  /** TEST SEAM: a launch used instead of the resolved entry. */
  readonly launch?: DshLaunch;
  readonly spawn?: typeof nodeSpawn;
  readonly env?: NodeJS.ProcessEnv;
  readonly timings?: Partial<DshCoworkTimings>;
  readonly now?: () => number;
}

/** The turn's one bridge grant: control decision, owner policy, restart hooks. */
interface TurnGrant {
  readonly grantId: string;
  readonly token: string;
  readonly controlDecisionId: string;
  readonly resourceId: string;
  /** The loopback translator's /v1 base URL. */
  readonly baseUrl: string;
  readonly policy: ControlResourcePolicy;
  /** True when the grant's current control decision failed. */
  readonly failed: () => boolean;
  /** A new decision on the next eligible resource (throws the gateway's refusal). */
  readonly restart: () => { readonly controlDecisionId: string; readonly resourceId: string };
}

/** One probe's outcome: the status, and the launch it was probed with when it is ready. */
interface Probed {
  readonly status: CoworkStatus;
  readonly launch?: DshLaunch;
}

interface TurnRelay {
  readonly mcpServers: readonly Record<string, unknown>[];
  /** Allowed by Nexar's own policy (and so recorded), not by the runner's broker. */
  readonly bridgeTools: readonly string[];
}

async function removeDir(path: string): Promise<void> {
  await rm(path, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }).catch(
    () => undefined,
  );
}

export class DshCoworkService implements CoworkLane {
  private readonly timings: DshCoworkTimings;
  private readonly now: () => number;
  private cached: { readonly status: CoworkStatus; readonly at: number } | undefined;
  private inflight: Promise<CoworkStatus> | undefined;
  private readonly active = new Set<AbortController>();
  private readonly runs = new Set<Promise<unknown>>();
  private disposed = false;
  /** Delegated units per open grant, filled from bridge events (ids and enums only). */
  private readonly delegated = new Map<string, CoworkDelegation[]>();
  /** The launch the last probe found ready: turns run exactly what was probed. */
  private launch: DshLaunch | undefined;

  constructor(private readonly options: DshCoworkServiceOptions) {
    this.timings = { ...DEFAULT_DSH_COWORK_TIMINGS, ...options.timings };
    this.now = options.now ?? Date.now;
  }

  // ---- status ---------------------------------------------------------------------------------

  status(): Promise<CoworkStatus> {
    const cached = this.cached;
    if (cached !== undefined && this.now() - cached.at < this.timings.cacheMs) {
      return Promise.resolve(cached.status);
    }
    return this.refresh();
  }

  /** Probes now (one probe at a time) and replaces the cache. Never rejects. */
  refresh(): Promise<CoworkStatus> {
    this.inflight ??= this.probe()
      .catch((error: unknown): Probed => {
        this.options.logger.warn('cowork probe crashed', { code: codeOf(error) });
        return { status: { state: 'startup-failed', reason: COWORK_REASONS['startup-failed'] } };
      })
      .then(({ status, launch }) => {
        // Replaced together: a turn never sees a ready status without the launch it was probed with.
        this.launch = launch;
        this.cached = { status, at: this.now() };
        this.options.logger.info('cowork probed', { state: status.state });
        return status;
      })
      .finally(() => {
        this.inflight = undefined;
      });
    return this.inflight;
  }

  /** Starts the first probe (a `--version` run: no model and no session). */
  warm(): Promise<void> {
    if (this.options.disabled !== true) void this.refresh();
    return Promise.resolve();
  }

  /** Synchronous (lane router): a stale cache starts a background re-probe. */
  available(): boolean {
    if (this.disposed) return false;
    const cached = this.cached;
    if (cached === undefined) {
      void this.refresh();
      return false;
    }
    if (this.now() - cached.at >= this.timings.cacheMs) void this.refresh();
    return cached.status.state === 'ready';
  }

  /** The fixed reason the lane is unavailable, or `undefined` when it is ready. */
  reason(): string | undefined {
    const cached = this.cached;
    if (cached === undefined) return COWORK_REASONS.checking;
    return cached.status.state === 'ready' ? undefined : cached.status.reason;
  }

  /**
   * The fixed fallback reason id the operating layer records when the lane is unavailable:
   * `dsh-control-unavailable` when no control resource can run it, else `dsh-unavailable` when the
   * runtime is not ready. `undefined` when the lane is ready or not yet probed.
   */
  fallbackReason(): string | undefined {
    const status = this.cached?.status;
    if (status === undefined || status.state === 'ready' || status.state === 'checking') {
      return undefined;
    }
    return status.state === 'configuration-missing' &&
      status.reason === COWORK_REASONS['control-unavailable']
      ? 'dsh-control-unavailable'
      : 'dsh-unavailable';
  }

  /** Everything the gateway path needs is wired (tests omit parts of it). */
  private gatewayConfigured(): boolean {
    const { bridgeHost } = this.options;
    return bridgeHost.restartControl !== undefined && bridgeHost.controlFailed !== undefined;
  }

  /**
   * The control choice for a turn: the owner's control policy and the resource it would pin now.
   * `undefined` when there is none: not wired, a damaged `orchestration` section (fails closed), or
   * no eligible control resource. Never a paid call.
   */
  private async gatewayChoice(): Promise<
    { readonly policy: ControlResourcePolicy; readonly resourceId: string } | undefined
  > {
    const { controlGateway, settings } = this.options;
    if (!this.gatewayConfigured()) return undefined;
    const orchestration = await settings.getOrchestration?.();
    if (orchestration?.valid === false) return undefined;
    const policy = orchestration?.value.cowork.controlResource ?? DEFAULT_CONTROL_RESOURCE_POLICY;
    // Resource states are probed once (never paid calls) so selection does not see unknown as down.
    await this.options.engine.snapshots(false).catch(() => undefined);
    const preview = controlGateway.preview('dsh', policy);
    return preview === undefined ? undefined : { policy, resourceId: preview.resourceId };
  }

  /** The control resource a turn would pin now (a preview); `undefined` when none qualifies. */
  async effectiveControlResourceId(): Promise<string | undefined> {
    return (await this.gatewayChoice())?.resourceId;
  }

  private async resolveLaunch(): Promise<DshLaunch | undefined> {
    if (this.options.launch !== undefined) return this.options.launch;
    const config = await this.options.settings.getCowork();
    if (!config.valid) return undefined;
    const entry = await resolveDshEntry({
      testEntry: this.options.testEntry,
      settingsEntry: config.value.dshEntry,
      resourcesPath: this.options.resourcesPath,
    });
    return entry === undefined ? undefined : dshLaunchForEntry(entry);
  }

  private fixed(state: DshRuntimeStatus['state'], version: string | undefined): CoworkStatus {
    const reasons = {
      ready: COWORK_REASONS.ready,
      'dsh-missing': COWORK_REASONS['dsh-missing'],
      'unsupported-version': COWORK_REASONS['unsupported-version'],
      'startup-failed': COWORK_REASONS['startup-failed'],
    } as const;
    return { state, reason: reasons[state], ...(version === undefined ? {} : { version }) };
  }

  private async probe(): Promise<Probed> {
    const missing: Probed = {
      status: { state: 'dsh-missing', reason: COWORK_REASONS['dsh-missing'] },
    };
    if (this.options.disabled === true || this.disposed) return missing;
    const config = await this.options.settings.getCowork();
    if (!config.valid) {
      return {
        status: { state: 'configuration-missing', reason: COWORK_REASONS['settings-invalid'] },
      };
    }
    const launch = await this.resolveLaunch();
    if (launch === undefined) return missing;
    const probed = await probeDshRuntime(launch, {
      parentEnv: this.options.env ?? process.env,
      timeoutMs: this.timings.probeTimeoutMs,
      ...(this.options.spawn === undefined ? {} : { spawn: this.options.spawn }),
    });
    if (this.disposed) return missing;
    if (probed.state !== 'ready') return { status: this.fixed(probed.state, probed.version) };
    // Ready also needs a control resource the owner's policy can pin (a preview, never a paid call).
    if ((await this.gatewayChoice()) === undefined) {
      return {
        status: {
          state: 'configuration-missing',
          reason: COWORK_REASONS['control-unavailable'],
          ...(probed.version === undefined ? {} : { version: probed.version }),
        },
      };
    }
    return { status: this.fixed('ready', probed.version), launch };
  }

  // ---- turn -----------------------------------------------------------------------------------

  /** Feeds a bridge event; only a completed unit of an open grant of this service is recorded. */
  noteBridgeEvent(event: BridgeEvent): void {
    const units = this.delegated.get(event.grantId);
    if (units === undefined || event.type !== 'bridge.completed') return;
    if (event.unitId === undefined || event.outcome === undefined) return;
    if (units.length >= MAX_DELEGATIONS) return;
    units.push({
      unitId: event.unitId,
      ...(event.resourceId === undefined ? {} : { resourceId: event.resourceId }),
      outcome: event.outcome,
    });
  }

  run(request: CoworkRequest, signal: AbortSignal): Promise<CoworkResult> {
    // Validate before any probe, task, provider or grant operation; models cannot supply this field.
    let maximum: number;
    try {
      maximum = coworkDelegationLimit(request);
    } catch (error) {
      return Promise.reject(
        error instanceof Error ? error : new NexarError('VALIDATION_ERROR', 'Invalid turn request'),
      );
    }
    if (this.disposed) {
      return Promise.reject(new NexarError('INTEGRATION_UNAVAILABLE', 'Desktop is shutting down'));
    }
    if (signal.aborted) {
      return Promise.reject(new NexarError('EXECUTION_CANCELLED', 'The Cowork turn was cancelled'));
    }
    if (this.active.size >= MAX_ACTIVE_COWORK_TURNS) {
      return Promise.reject(new NexarError('POLICY_REJECTED', 'Too many Cowork turns are active'));
    }
    // Reserved before the first await: concurrent calls cannot slip past the limit.
    const controller = new AbortController();
    const forward = (): void => controller.abort();
    signal.addEventListener('abort', forward, { once: true });
    this.active.add(controller);
    const turn = this.runTurn(request, maximum, controller).finally(() => {
      signal.removeEventListener('abort', forward);
      this.active.delete(controller);
      this.runs.delete(turn);
    });
    this.runs.add(turn);
    return turn;
  }

  private async runTurn(
    request: CoworkRequest,
    maximum: number,
    controller: AbortController,
  ): Promise<CoworkResult> {
    const status = await this.status();
    const launch = this.launch;
    if (status.state !== 'ready' || launch === undefined) {
      throw new NexarError('INTEGRATION_UNAVAILABLE', status.reason);
    }
    const { projects } = this.options.engine.composition().runtime;
    const project = projects.get(asProjectId(request.projectId));
    if (project === undefined || project.realRoots[0] === undefined) {
      throw new NexarError('VALIDATION_ERROR', 'The conversation project is no longer available');
    }

    const readOnly = request.permission === 'read-only';
    request.onProgress('status', 'Routing the task');
    const choice = await this.gatewayChoice();
    if (choice === undefined) {
      throw new NexarError('INTEGRATION_UNAVAILABLE', COWORK_REASONS['control-unavailable']);
    }
    const task = this.options.createTask(request, []);
    await request.onTask(task.id);
    if (controller.signal.aborted) {
      throw new NexarError('EXECUTION_CANCELLED', 'The Cowork turn was cancelled');
    }

    const scratchBase = join(this.options.stateDir, 'scratch');
    const homesBase = join(this.options.stateDir, 'homes');
    const created: string[] = [];
    let grantId: string | undefined;
    const unitLimit = new DelegationUnitLimit(maximum, {
      sessionId: request.sessionId,
      turnId: request.turnId,
      projectId: request.projectId,
      engine: 'dsh',
    });
    try {
      let grant = await this.openGateway(request, readOnly, choice.policy, unitLimit);
      grantId = grant.grantId;
      const relay = await this.relayFor(grant, unitLimit);
      let restarts = 0;
      let text = '';
      let scratch: string;
      for (;;) {
        scratch = await this.newScratch(scratchBase);
        created.push(scratch);
        const home = await this.newHome(homesBase, request.turnId, restarts);
        created.push(home);
        request.onProgress('status', 'Running Cowork');
        try {
          const result = await runLocalAcpSession({
            launch,
            profile: COWORK_PROFILE,
            scratchBase: await realpath(scratchBase),
            scratchDir: scratch,
            dshHome: home,
            permissionMode: coworkPermissionMode(request.permission),
            control: { baseURL: grant.baseUrl, token: grant.token },
            requiredContext: request.requiredContext,
            mcpServers: relay?.mcpServers,
            prompt:
              relay === undefined
                ? request.prompt
                : `${request.prompt}\n\n${delegationInstruction()}`,
            decide: (input) => this.decide(input, request, task, scratch, relay, controller.signal),
            onEvent: (event) => this.progress(request, event),
            parentEnv: this.options.env ?? process.env,
            signal: controller.signal,
            timeoutMs: this.timings.turnTimeoutMs,
            initializeTimeoutMs: this.timings.startupTimeoutMs,
            logger: this.options.logger,
            ...(this.options.spawn === undefined ? {} : { spawn: this.options.spawn }),
          });
          text = result.text;
          break;
        } catch (error) {
          if (controller.signal.aborted || codeOf(error) === 'EXECUTION_CANCELLED') {
            throw new NexarError('EXECUTION_CANCELLED', 'The Cowork turn was cancelled');
          }
          // Only a failure the gateway attributes to the control resource restarts the turn, once and
          // only when the owner's policy allows a fallback (ADR-027 section 8, boundary 3).
          if (!grant.failed()) throw turnFailure(error);
          if (restarts > 0 || grant.policy.fallback !== 'auto') throw controlFailure();
          try {
            grant = { ...grant, ...grant.restart() };
          } catch (restartError) {
            this.options.logger.warn('cowork control restart failed', {
              code: codeOf(restartError),
            });
            throw controlFailure();
          }
          restarts += 1;
          request.onProgress('status', 'Restarting on another control resource');
          // A restart is a whole new engine turn: fresh scratch, fresh home, same unit limit.
          await Promise.all(created.splice(0).map(removeDir));
        }
      }

      // Read only Cowork imports no draft, whatever the scratch folder holds.
      const artifacts = readOnly ? [] : await this.importDrafts(request, task, scratch);
      const delegations = [...(this.delegated.get(grant.grantId) ?? [])];
      return {
        taskId: task.id,
        text,
        artifacts,
        resourceId: grant.resourceId,
        policyId: `control@1:${grant.policy.mode}`,
        control: {
          path: 'gateway',
          controlDecisionId: grant.controlDecisionId,
          restarts,
        },
        ...(delegations.length === 0 ? {} : { delegations }),
      };
    } finally {
      unitLimit.close();
      if (grantId !== undefined) this.closeGrant(grantId);
      await Promise.all(created.map(removeDir));
    }
  }

  private progress(request: CoworkRequest, event: LocalAcpEvent): void {
    // Runner status and text events carry no owner data but are not part of the lane's fixed texts.
    if (event.type === 'tool-call') {
      request.onProgress('progress', `Cowork: ${progressName(event.name)}`);
    }
  }

  private async newScratch(parent: string): Promise<string> {
    await mkdir(parent, { recursive: true, mode: 0o700 });
    return realpath(await mkdtemp(join(parent, 'turn-')));
  }

  /** `<stateDir>/homes/<turnId>` (a restart gets its own suffix): never reused, never resumed. */
  private async newHome(base: string, turnId: string, attempt: number): Promise<string> {
    await mkdir(base, { recursive: true, mode: 0o700 });
    const id = SAFE_ID.test(turnId) ? turnId : randomUUID();
    return join(base, attempt === 0 ? id : `${id}-r${String(attempt)}`);
  }

  /** The grant outlives one restart (`ttlMs` covers two attempts). */
  private grantInput(
    request: CoworkRequest,
    readOnly: boolean,
    unitLimit: DelegationUnitLimit,
  ): BridgeGrantInput {
    return {
      sessionId: request.sessionId,
      turnId: request.turnId,
      correlationId: request.correlation.correlationId,
      projectId: request.projectId,
      engine: 'dsh',
      access: readOnly ? 'read-only' : 'draft',
      ...(request.maxCostUsd === undefined ? {} : { budgetUsd: request.maxCostUsd }),
      maxUnits: unitLimit.maximum,
      unitLimit,
      ttlMs: this.timings.turnTimeoutMs * 2,
    };
  }

  /**
   * ONE grant for the turn, control decision included: its token is DeepSeek Harness's only
   * credential. Throws (the grant, if any, is revoked) when the control path cannot be opened.
   */
  private async openGateway(
    request: CoworkRequest,
    readOnly: boolean,
    policy: ControlResourcePolicy,
    unitLimit: DelegationUnitLimit,
  ): Promise<TurnGrant> {
    const host = this.options.bridgeHost;
    const unavailable = (): NexarError =>
      new NexarError('INTEGRATION_UNAVAILABLE', COWORK_REASONS['control-unavailable']);
    if (host.restartControl === undefined || host.controlFailed === undefined) throw unavailable();
    const restartControl = host.restartControl.bind(host);
    const controlFailed = host.controlFailed.bind(host);
    let grantId: string | undefined;
    try {
      await host.ensureStarted();
      const baseUrl = await this.options.controlChild.baseUrl();
      const minted = host.mint(this.grantInput(request, readOnly, unitLimit), { policy });
      grantId = minted.grantId;
      this.delegated.set(minted.grantId, []);
      if (minted.controlDecisionId === undefined || minted.resourceId === undefined) {
        throw new NexarError('POLICY_REJECTED', 'Control is not available');
      }
      const id = minted.grantId;
      return {
        grantId: id,
        token: minted.token,
        controlDecisionId: minted.controlDecisionId,
        resourceId: minted.resourceId,
        baseUrl,
        policy,
        failed: () => controlFailed(id),
        restart: () => restartControl(id),
      };
    } catch (error) {
      this.options.logger.warn('cowork control gateway unavailable', { code: codeOf(error) });
      if (grantId !== undefined) this.closeGrant(grantId);
      throw unavailable();
    }
  }

  /**
   * The Intelligence Bridge relay as the ACP stdio MCP server `nexar` (the token lives only in this
   * session request). A failure never fails the turn: it runs without delegation.
   */
  private async relayFor(
    grant: TurnGrant,
    unitLimit: DelegationUnitLimit,
  ): Promise<TurnRelay | undefined> {
    try {
      const endpoint = await this.options.bridgeHost.ensureStarted();
      const launch = (this.options.relay ?? relayLaunch)();
      const env: Record<string, string> = { ...launch.env };
      delete env['NEXAR_BRIDGE_STANDALONE_ONLY'];
      env['NEXAR_BRIDGE_ENDPOINT'] = endpoint;
      env['NEXAR_BRIDGE_TOKEN'] = grant.token;
      // Derived only from the trusted turn scope, including fallback/restart grants.
      if (unitLimit.maximum === 1) env['NEXAR_BRIDGE_STANDALONE_ONLY'] = '1';
      return {
        mcpServers: [
          {
            name: BRIDGE_SERVER_NAME,
            command: launch.command,
            args: [...launch.args],
            env: Object.entries(env).map(([name, value]) => ({ name, value })),
          },
        ],
        bridgeTools: bridgeToolNames(),
      };
    } catch (error) {
      this.options.logger.warn('cowork delegation unavailable', { code: codeOf(error) });
      return undefined;
    }
  }

  private closeGrant(grantId: string): void {
    try {
      this.options.bridgeHost.revoke(grantId);
    } catch (error) {
      this.options.logger.warn('cowork delegation revoke failed', { code: codeOf(error) });
    }
    this.delegated.delete(grantId);
  }

  // ---- permissions ----------------------------------------------------------------------------

  /**
   * Nexar answers every permission request (B3): policy decides, `ask-owner` waits for one
   * single-use owner approval, and every policy decision is recorded with ids and fingerprints only.
   */
  private async decide(
    input: PermissionDecisionInput,
    request: CoworkRequest,
    task: NexarTask,
    scratchRoot: string,
    relay: TurnRelay | undefined,
    signal: AbortSignal,
  ): Promise<'allow' | 'reject'> {
    const outcome = decideCoworkPermission(input, {
      scratchRoot,
      permission: request.permission,
      bridgeTools: relay?.bridgeTools ?? [],
    });
    const target = filePathOf(input.rawInput);
    // Ask before every write: a scratch write the policy would allow waits for the owner.
    if (outcome.decision === 'ask-owner') {
      return (await this.askOwner(request, task, input.tool, target, signal)) ? 'allow' : 'reject';
    }
    const allowed = outcome.decision === 'allow';
    const tool = SAFE_TOOL.test(input.tool) ? input.tool : 'unknown';
    try {
      await recordPolicyDecision(
        this.options.engine.approvals(),
        {
          type: 'cowork.tool-call',
          target: tool,
          parameters: {
            sessionId: request.sessionId,
            turnId: request.turnId,
            tool: input.tool,
            target: target ?? null,
          },
        },
        {
          summary: `Cowork ${tool}: ${allowed ? 'allowed' : 'denied'} by policy`,
          risk: allowed ? 'low' : 'medium',
          taskId: task.id,
          projectId: request.projectId,
          metadata: { ruleId: outcome.reason, tool },
        },
        allowed ? 'allowed' : 'denied',
      );
    } catch (error) {
      this.options.logger.warn('cowork decision record failed', { code: codeOf(error) });
    }
    return allowed ? 'allow' : 'reject';
  }

  /**
   * One owner approval for one scratch write (action cowork.write, fingerprint over session, turn,
   * tool and target; single use; short TTL). Anything but an approval (denial, expiry, cancel, a
   * store failure) is a denial.
   */
  private async askOwner(
    request: CoworkRequest,
    task: NexarTask,
    tool: string,
    target: string | undefined,
    signal: AbortSignal,
  ): Promise<boolean> {
    const label = writeLabel(target);
    const action = {
      type: 'cowork.write',
      target: label,
      parameters: {
        sessionId: request.sessionId,
        turnId: request.turnId,
        tool,
        target: target ?? null,
      },
    };
    try {
      const gate = new ApprovalGate({
        mode: 'store',
        store: this.options.engine.approvals(),
        pollIntervalMs: this.timings.approvalPollMs,
        defaultTtlMs: this.timings.approvalTtlMs,
        logger: this.options.logger,
      });
      const grant = await gate.request(action, {
        summary: `Cowork wants to write the draft file ${label}`,
        risk: 'low',
        taskId: task.id,
        projectId: request.projectId,
        ttlMs: this.timings.approvalTtlMs,
        signal,
      });
      await grant.consume(action);
      return true;
    } catch (error) {
      this.options.logger.info('cowork write not approved', { code: codeOf(error) });
      return false;
    }
  }

  // ---- drafts ---------------------------------------------------------------------------------

  private async importDrafts(
    request: CoworkRequest,
    task: NexarTask,
    scratch: string,
  ): Promise<ArtifactRef[]> {
    const { runtime } = this.options.engine.composition();
    const refs = await importDrafts({
      scratch,
      projectId: request.projectId,
      taskId: task.id,
      store: new LocalArtifactStore({ projects: runtime.projects }),
      logger: this.options.logger,
    });
    if (refs.length > 0) {
      await runtime.nexar.recordArtifacts(task.id, asProjectId(request.projectId), refs);
    }
    return refs;
  }

  /** Ends every turn (their DeepSeek Harness children stop with them) at app exit. */
  async dispose(): Promise<void> {
    this.disposed = true;
    for (const controller of this.active) controller.abort();
    await Promise.allSettled([...this.runs]);
    await this.inflight?.catch(() => undefined);
  }
}

function filePathOf(rawInput: unknown): string | undefined {
  if (typeof rawInput !== 'object' || rawInput === null) return undefined;
  const value = (rawInput as Record<string, unknown>)['file_path'];
  return typeof value === 'string' ? value : undefined;
}

// ---- channels ---------------------------------------------------------------------------------

function service(ctx: CallContext): CoworkLane {
  if (ctx.deps.cowork === undefined) {
    throw new NexarError('CONFLICT', 'The Cowork lane is not available in this session');
  }
  return ctx.deps.cowork;
}

/** The renderer sees a state, a fixed reason and a version: never a path, command or output. */
export const coworkChannels: Readonly<Record<string, ChannelDefinition>> = {
  [CHANNELS.coworkStatus]: defineChannel(NoArgs, (_args, ctx) => service(ctx).status()),
  [CHANNELS.coworkRefresh]: defineChannel(NoArgs, (_args, ctx) => service(ctx).refresh()),
};
