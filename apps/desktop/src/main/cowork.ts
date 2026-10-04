import { spawn as nodeSpawn } from 'node:child_process';
import { lstat, mkdir, mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { ApprovalGate } from '@nexar/approvals';
import { LocalArtifactStore, type ArtifactMediaType } from '@nexar/artifacts';
import {
  NexarError,
  isNexarError,
  projectId as asProjectId,
  type ArtifactRef,
  type Logger,
  type NexarTask,
} from '@nexar/contracts';
import {
  COWORK_ERROR_CODES,
  OpenWorkerSupervisor,
  DELEGATION_TOOLS,
  collectDrafts,
  decidePermission,
  isWriteTool,
  openWorkerProviderFor,
  recordCoworkDecision,
  runCoworkTurn,
  type OpenWorkerState,
  type OpenWorkerStatus,
} from '@nexar/integration-openworker';
import type { BridgeEvent } from '@nexar/engine-gateway';
import type { CoworkDelegation, CoworkRequest, CoworkResult } from '@nexar/operating';
import { providerCredentialNames } from '@nexar/host';
import type { CoworkStatusDto } from '../shared/api.js';
import { CHANNELS } from '../shared/channels.js';
import type { BridgeHost } from './bridge-host.js';
import { relayLaunch, type RelayLaunch } from './bridge-relay-path.js';
import { NoArgs, defineChannel, type CallContext, type ChannelDefinition } from './channel.js';
import type { DesktopKeyStore } from './desktop-key-store.js';
import type { EngineHost } from './engine-host.js';
import {
  DEFAULT_OPENWORKER_EXECUTABLE,
  DEFAULT_OPENWORKER_VERSION_EXECUTABLE,
  type SettingsStore,
} from './settings-store.js';

/*
 * The Desktop side of the Cowork lane (ADR-026): one supervised, private OpenWorker per process,
 * NRC-selected resources, deterministic permission policy with recorded decisions, and drafts
 * imported through `LocalArtifactStore`. OpenWorker never writes into a project and never sees a key
 * the owner did not allow. Logs, errors and events carry codes and fixed texts only.
 */

export const COWORK_REASONS = {
  checking: 'The Cowork lane is still being checked',
  'no-provider': 'No allowed provider with a saved key can run Cowork',
  'settings-invalid': 'The Cowork settings are not valid',
  'startup-failed': 'OpenWorker did not start',
} as const;

export interface CoworkTimings {
  /** How a probe result is reused. */
  readonly cacheMs: number;
  /** Upper bound on one OpenWorker turn. */
  readonly turnTimeoutMs: number;
  readonly startupTimeoutMs: number;
  /** How long an ask-before-write approval stays pending before it expires (denied). */
  readonly approvalTtlMs: number;
  readonly approvalPollMs: number;
}

export const DEFAULT_COWORK_TIMINGS: CoworkTimings = {
  cacheMs: 60_000,
  turnTimeoutMs: 10 * 60_000,
  startupTimeoutMs: 30_000,
  approvalTtlMs: 2 * 60_000,
  approvalPollMs: 250,
};

const MAX_APPROVAL_LABEL_CHARS = 80;

/** The name OpenWorker registers the Intelligence Bridge relay under: it fixes the tool prefix. */
const BRIDGE_SERVER_NAME = 'nexar';
const BRIDGE_MAX_UNITS = 16;
const MAX_DELEGATIONS = 32;

/** One fixed line, outside the untrusted context: where a substantive unit may be delegated. */
export const DELEGATION_INSTRUCTION =
  'Nexar: delegate substantive drafting, analysis or review units with nexar.intelligence_submit, then poll nexar.intelligence_status with the returned jobId until the unit is done.';

/** A model-chosen file name as a short, single-line label (no control characters). */
function writeLabel(target: string | undefined): string {
  const name = (target ?? '').split(/[\\/]/).filter(Boolean).at(-1) ?? 'a file';
  return name.replace(/[\p{Cc}\p{Cf}]/gu, ' ').slice(0, MAX_APPROVAL_LABEL_CHARS);
}

/** Concurrent Cowork turns in this process. */
export const MAX_ACTIVE_COWORK_TURNS = 4;

type CoworkStatus = CoworkStatusDto;

/** Fixed code and text per adapter error code: upstream text never reaches the owner. */
const TURN_FAILURES: Readonly<Record<string, readonly [NexarError['code'], string]>> = {
  [COWORK_ERROR_CODES.timeout]: ['EXECUTION_TIMEOUT', 'OpenWorker did not finish in time'],
  [COWORK_ERROR_CODES.invalidRequest]: [
    'VALIDATION_ERROR',
    'OpenWorker did not accept the request',
  ],
  [COWORK_ERROR_CODES.inputRequired]: [
    'POLICY_REJECTED',
    'OpenWorker needed input that a supervised turn cannot give',
  ],
  [COWORK_ERROR_CODES.inputRejected]: ['POLICY_REJECTED', 'OpenWorker did not accept the input'],
  [COWORK_ERROR_CODES.tooManyPermissions]: [
    'POLICY_REJECTED',
    'OpenWorker asked for too many permissions',
  ],
  [COWORK_ERROR_CODES.malformedFrame]: [
    'INTEGRATION_UNAVAILABLE',
    'OpenWorker sent an invalid message',
  ],
  [COWORK_ERROR_CODES.connectionClosed]: [
    'INTEGRATION_UNAVAILABLE',
    'OpenWorker connection ended unexpectedly',
  ],
};
const GENERIC_FAILURE: readonly [NexarError['code'], string] = [
  'INTEGRATION_UNAVAILABLE',
  'OpenWorker could not complete the request',
];

const DRAFT_MEDIA: Readonly<Record<string, ArtifactMediaType>> = {
  '.md': 'text/markdown',
  '.txt': 'text/plain',
  '.json': 'application/json',
  '.csv': 'text/csv',
};

/** A resource OpenWorker can run: the provider/model it is addressed by. */
export interface UsableResource {
  readonly resourceId: string;
  readonly provider: string;
  readonly credentialName: string;
  readonly model: string;
}

export interface CoworkServiceOptions {
  readonly settings: Pick<SettingsStore, 'getCowork'>;
  readonly engine: EngineHost;
  readonly keys: Pick<DesktopKeyStore, 'metadata' | 'resolveSecret'>;
  readonly logger: Logger;
  /** Absolute private state directory of the supervised server (created 0700). */
  readonly stateDir: string;
  /** `true` under the test override without a fake: OpenWorker is never launched. */
  readonly disabled?: boolean;
  readonly spawn?: typeof nodeSpawn;
  readonly env?: NodeJS.ProcessEnv;
  readonly timings?: Partial<CoworkTimings>;
  readonly now?: () => number;
  /** The Intelligence Bridge (ADR-027 section 9a). Absent: turns run without delegation. */
  readonly bridgeHost?: Pick<BridgeHost, 'ensureStarted' | 'mint' | 'revoke'>;
  /** How OpenWorker launches the bridge relay. Default: this app's own bundled relay. */
  readonly relay?: () => RelayLaunch;
  /** The task for a turn, with Nexar-set lineage and these resources excluded. */
  readonly createTask: (
    request: CoworkRequest,
    excludedResourceIds: readonly string[],
  ) => NexarTask;
}

const MISSING_STATUS: CoworkStatus = {
  state: 'openworker-missing',
  reason: 'OpenWorker is not installed',
};

function codeOf(error: unknown): string {
  return isNexarError(error) ? error.code : 'UNKNOWN';
}

/**
 * TEST SEAM. Runs `script` with this executable (`ELECTRON_RUN_AS_NODE=1`) in place of the real
 * OpenWorker. `main.ts` enables it only together with the test `NEXAR_DESKTOP_USER_DATA` override;
 * only `NEXAR_FAKE_OPENWORKER_*` selectors are passed along.
 */
export function createScriptSpawn(
  script: string,
  parent: NodeJS.ProcessEnv = process.env,
): typeof nodeSpawn {
  return ((_command: string, args: readonly string[], options: Record<string, unknown>) => {
    const extra: Record<string, string> = { ELECTRON_RUN_AS_NODE: '1' };
    for (const [name, value] of Object.entries(parent)) {
      if (name.startsWith('NEXAR_FAKE_OPENWORKER_') && value !== undefined) extra[name] = value;
    }
    const env = { ...(options['env'] as Record<string, string> | undefined), ...extra };
    return nodeSpawn(process.execPath, [script, ...args], { ...options, env });
  }) as unknown as typeof nodeSpawn;
}

interface OpenDelegation {
  grantId: string;
  /** True once the relay is registered and the turn may delegate. */
  active: boolean;
  /** True once a registration was attempted: cleanup must delete the entry. */
  registering: boolean;
}

type Client = NonNullable<ReturnType<OpenWorkerSupervisor['client']>>;

export class CoworkService {
  private readonly timings: CoworkTimings;
  private readonly now: () => number;
  private supervisor:
    { readonly executable: string; readonly value: OpenWorkerSupervisor } | undefined;
  private cached: { readonly status: CoworkStatus; readonly at: number } | undefined;
  private inflight: Promise<CoworkStatus> | undefined;
  private readonly active = new Set<AbortController>();
  private disposed = false;
  /** Serializes turns while delegation is active (one bridge grant and one MCP entry at a time). */
  private turnLock: Promise<unknown> = Promise.resolve();
  /** Delegated units per open grant, filled from bridge events (ids and enums only). */
  private readonly delegated = new Map<string, CoworkDelegation[]>();

  constructor(private readonly options: CoworkServiceOptions) {
    this.timings = { ...DEFAULT_COWORK_TIMINGS, ...options.timings };
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
      .catch((error: unknown): CoworkStatus => {
        this.options.logger.warn('cowork probe crashed', { code: codeOf(error) });
        return {
          state: 'startup-failed',
          reason: COWORK_REASONS['startup-failed'],
        };
      })
      .then((status) => {
        this.cached = { status, at: this.now() };
        this.options.logger.info('cowork probed', { state: status.state });
        return status;
      })
      .finally(() => {
        this.inflight = undefined;
      });
    return this.inflight;
  }

  /** Starts the first probe when the owner already allowed a provider (no process otherwise). */
  async warm(): Promise<void> {
    if (this.options.disabled === true) return;
    const config = await this.options.settings.getCowork();
    if (config.valid && config.value.allowedProviders.length > 0) void this.refresh();
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

  private async probe(): Promise<CoworkStatus> {
    if (this.options.disabled === true || this.disposed) return MISSING_STATUS;
    const config = await this.options.settings.getCowork();
    if (!config.valid) {
      return { state: 'configuration-missing', reason: COWORK_REASONS['settings-invalid'] };
    }
    const executable = config.value.executable ?? DEFAULT_OPENWORKER_EXECUTABLE;
    const versionExecutable =
      config.value.versionExecutable ?? DEFAULT_OPENWORKER_VERSION_EXECUTABLE;
    if (this.supervisor?.executable !== executable) {
      await this.supervisor?.value.stop();
      if (this.disposed) return MISSING_STATUS;
      this.supervisor = {
        executable,
        value: new OpenWorkerSupervisor({
          executable,
          versionExecutable,
          stateDir: this.options.stateDir,
          parentPid: process.pid,
          startupTimeoutMs: this.timings.startupTimeoutMs,
          ...(this.options.env === undefined ? {} : { env: this.options.env }),
          ...(this.options.spawn === undefined ? {} : { spawn: this.options.spawn }),
        }),
      };
    }
    // Checked right before starting: dispose() stops the supervisor and must not be outrun.
    if (this.disposed) return MISSING_STATUS;
    const started: OpenWorkerStatus = await this.supervisor.value.start();
    if (this.disposed) {
      // Disposed while starting: never leave a server running behind a closed app.
      await this.supervisor.value.stop();
      return MISSING_STATUS;
    }
    if (started.state !== 'ready') return this.fixed(started.state, started.version);
    if ((await this.usable()).length === 0) {
      return {
        state: 'configuration-missing',
        reason: COWORK_REASONS['no-provider'],
        ...(started.version === undefined ? {} : { version: started.version }),
      };
    }
    return {
      state: 'ready',
      reason: started.reason,
      ...(started.version === undefined ? {} : { version: started.version }),
    };
  }

  private fixed(state: OpenWorkerState, version: string | undefined): CoworkStatus {
    const reasons: Readonly<Record<OpenWorkerState, string>> = {
      ready: 'OpenWorker is ready',
      'openworker-missing': 'OpenWorker is not installed',
      'unsupported-version': 'OpenWorker version is not supported',
      'startup-failed': COWORK_REASONS['startup-failed'],
      'configuration-missing': 'OpenWorker is not configured',
    };
    return { state, reason: reasons[state], ...(version === undefined ? {} : { version }) };
  }

  // ---- resources ------------------------------------------------------------------------------

  /**
   * Registry pi model resources OpenWorker can run: the provider maps to an OpenWorker provider, the
   * owner allowed it, and its key is in the Desktop key store (checked by presence, never read).
   */
  async usable(): Promise<readonly UsableResource[]> {
    const config = await this.options.settings.getCowork();
    if (!config.valid) return [];
    const allowed = new Set(config.value.allowedProviders);
    const result: UsableResource[] = [];
    for (const r of this.options.engine.composition().runtime.registry.list()) {
      if (r.runtime.adapter !== 'pi' || r.kind.type !== 'model') continue;
      if (r.auth.mode !== 'api-key' || r.auth.credential.source === 'runtime-managed') continue;
      const { provider, model } = r.kind;
      const owProvider = openWorkerProviderFor(provider);
      const credentialName = Object.hasOwn(providerCredentialNames, provider)
        ? providerCredentialNames[provider]
        : undefined;
      if (
        owProvider === undefined ||
        credentialName === undefined ||
        !allowed.has(provider) ||
        r.auth.credential.name !== credentialName
      ) {
        continue;
      }
      try {
        if (!this.options.keys.metadata(credentialName).present) continue;
      } catch {
        continue;
      }
      result.push({ resourceId: r.id, provider: owProvider, credentialName, model });
    }
    return result;
  }

  /** Every registry resource that is not usable: the NRC must never select one for Cowork. */
  async excluded(): Promise<readonly string[]> {
    const usable = new Set((await this.usable()).map((r) => r.resourceId));
    return this.options.engine
      .composition()
      .runtime.registry.list()
      .map((r) => r.id as string)
      .filter((id) => !usable.has(id));
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
    if (this.options.bridgeHost === undefined) return this.runTurn(request, signal);
    const turn = (): Promise<CoworkResult> => this.runTurn(request, signal);
    const next = this.turnLock.then(turn, turn);
    this.turnLock = next.catch(() => undefined);
    return next;
  }

  private async runTurn(request: CoworkRequest, signal: AbortSignal): Promise<CoworkResult> {
    if (this.disposed) throw new NexarError('INTEGRATION_UNAVAILABLE', 'Desktop is shutting down');
    if (signal.aborted)
      throw new NexarError('EXECUTION_CANCELLED', 'The Cowork turn was cancelled');
    if (this.active.size >= MAX_ACTIVE_COWORK_TURNS) {
      throw new NexarError('POLICY_REJECTED', 'Too many Cowork turns are active');
    }
    const status = await this.status();
    const client = this.supervisor?.value.client();
    if (status.state !== 'ready' || client === undefined || this.supervisor === undefined) {
      throw new NexarError('INTEGRATION_UNAVAILABLE', status.reason);
    }
    const supervisor = this.supervisor.value;
    const { nexar, projects } = this.options.engine.composition().runtime;
    const project = projects.get(asProjectId(request.projectId));
    const root = project?.realRoots[0];
    if (project === undefined || root === undefined) {
      throw new NexarError('VALIDATION_ERROR', 'The conversation project is no longer available');
    }

    const readOnly = request.permission === 'read-only';
    request.onProgress('status', 'Routing the task');
    const usable = await this.usable();
    const excluded = await this.excluded();
    const task = this.options.createTask(request, excluded);
    await request.onTask(task.id);
    // Resource states are probed once (never paid calls) so the NRC does not see unknown as down.
    // Resource states are probed once (never paid calls) so the NRC does not see unknown as down.
    await this.options.engine.snapshots(false);
    const decision = await nexar.route(task);
    if (decision.outcome !== 'selected') {
      throw new NexarError('NO_ELIGIBLE_RESOURCE', 'No eligible resource can run Cowork');
    }
    const chosen = usable.find((r) => r.resourceId === decision.selected.resourceId);
    if (chosen === undefined) {
      throw new NexarError('NO_ELIGIBLE_RESOURCE', 'No eligible resource can run Cowork');
    }

    // The key goes to the private loopback server only, for the chosen (owner-allowed) provider.
    const apiKey = ((): string | undefined => {
      try {
        return this.options.keys.resolveSecret(chosen.credentialName);
      } catch {
        return undefined;
      }
    })();
    if (apiKey === undefined) {
      throw new NexarError('NO_ELIGIBLE_RESOURCE', 'No eligible resource can run Cowork');
    }
    await supervisor.configureProviders([{ provider: chosen.provider, apiKey }]);

    const controller = new AbortController();
    const forward = (): void => controller.abort();
    signal.addEventListener('abort', forward, { once: true });
    this.active.add(controller);
    const scratchParent = join(this.options.stateDir, 'scratch');
    let scratch: string | undefined;
    let delegation: OpenDelegation | undefined;
    try {
      await mkdir(scratchParent, { recursive: true, mode: 0o700 });
      scratch = await realpath(await mkdtemp(join(scratchParent, 'turn-')));
      const scratchRoot = scratch;
      const recordings: Promise<unknown>[] = [];
      delegation = await this.openDelegation(client, request, readOnly);
      const delegating = delegation?.active === true;
      request.onProgress('status', 'Running Cowork');
      const turn = await runCoworkTurn(client, {
        sessionId: request.turnId,
        prompt: delegating ? `${request.prompt}\n\n${DELEGATION_INSTRUCTION}` : request.prompt,
        model: `${chosen.provider}:${chosen.model}`,
        scratchDir: scratchRoot,
        projectRoot: root,
        signal: controller.signal,
        timeoutMs: this.timings.turnTimeoutMs,
        // Read only: the upstream session itself is put in discuss mode, and policy denies anyway.
        mode: readOnly ? 'discuss' : 'interactive',
        onProgress: (identifier) => request.onProgress('progress', `Cowork: ${identifier}`),
        decide: (permission) => {
          const outcome = decidePermission(permission, {
            scratchRoot,
            readOnly,
            ...(delegating ? { delegationTools: DELEGATION_TOOLS } : {}),
          });
          // Ask before every write: a scratch write the policy would allow waits for the owner.
          // Everything else stays decided by policy; settings only narrow.
          if (
            request.permission === 'ask-before-write' &&
            outcome.decision === 'allow' &&
            isWriteTool(permission.name)
          ) {
            return this.askOwner(request, task, permission, controller.signal);
          }
          recordings.push(
            recordCoworkDecision(
              this.options.engine.approvals(),
              {
                sessionId: request.sessionId,
                turnId: request.turnId,
                taskId: task.id,
                projectId: request.projectId,
              },
              permission,
              outcome,
            ).catch((error: unknown) => {
              this.options.logger.warn('cowork decision record failed', { code: codeOf(error) });
            }),
          );
          return outcome.decision;
        },
      });
      await Promise.all(recordings);

      if (turn.outcome === 'cancelled' || controller.signal.aborted) {
        throw new NexarError('EXECUTION_CANCELLED', 'The Cowork turn was cancelled');
      }
      if (turn.outcome === 'failed') {
        const [code, message] =
          (turn.errorCode === undefined ? undefined : TURN_FAILURES[turn.errorCode]) ??
          GENERIC_FAILURE;
        this.options.logger.warn('cowork turn failed', { errorCode: turn.errorCode ?? 'unknown' });
        throw new NexarError(code, message);
      }

      // Read only Cowork imports no draft, whatever the scratch folder holds.
      const artifacts = readOnly ? [] : await this.importDrafts(request, task, scratchRoot);
      const delegations =
        delegation === undefined ? [] : [...(this.delegated.get(delegation.grantId) ?? [])];
      return {
        taskId: task.id,
        text: turn.text,
        artifacts,
        resourceId: decision.selected.resourceId,
        policyId: `${decision.policy.name}@${decision.policy.version}`,
        ...(delegations.length === 0 ? {} : { delegations }),
      };
    } finally {
      signal.removeEventListener('abort', forward);
      this.active.delete(controller);
      if (delegation !== undefined) await this.closeDelegation(client, delegation);
      if (scratch !== undefined) {
        await rm(scratch, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }).catch(
          () => undefined,
        );
      }
    }
  }

  /**
   * Opens the turn's bridge grant and registers the relay with OpenWorker (the token lives only in
   * that private registration). A failure never fails the turn: it runs without delegation.
   */
  private async openDelegation(
    client: Client,
    request: CoworkRequest,
    readOnly: boolean,
  ): Promise<OpenDelegation | undefined> {
    const host = this.options.bridgeHost;
    if (host === undefined) return undefined;
    const open: OpenDelegation = { grantId: '', active: false, registering: false };
    try {
      const endpoint = await host.ensureStarted();
      const grant = host.mint({
        sessionId: request.sessionId,
        turnId: request.turnId,
        correlationId: request.correlation.correlationId,
        projectId: request.projectId,
        engine: 'openworker',
        access: readOnly ? 'read-only' : 'draft',
        ...(request.maxCostUsd === undefined ? {} : { budgetUsd: request.maxCostUsd }),
        maxUnits: BRIDGE_MAX_UNITS,
        ttlMs: this.timings.turnTimeoutMs,
      });
      open.grantId = grant.grantId;
      this.delegated.set(grant.grantId, []);
      const launch = (this.options.relay ?? relayLaunch)();
      open.registering = true;
      await client.registerMcpServer(BRIDGE_SERVER_NAME, {
        command: launch.command,
        args: launch.args,
        env: {
          ...launch.env,
          NEXAR_BRIDGE_ENDPOINT: endpoint,
          NEXAR_BRIDGE_TOKEN: grant.token,
        },
      });
      open.active = true;
      return open;
    } catch (error) {
      this.options.logger.warn('cowork delegation unavailable', { code: codeOf(error) });
      await this.closeDelegation(client, open);
      return undefined;
    }
  }

  /** Best effort, in this order: the MCP entry (it holds the token), then the grant. */
  private async closeDelegation(client: Client, open: OpenDelegation): Promise<void> {
    if (open.registering) {
      try {
        await client.deleteMcpServer(BRIDGE_SERVER_NAME);
      } catch (error) {
        this.options.logger.warn('cowork delegation cleanup failed', { code: codeOf(error) });
      }
    }
    if (open.grantId !== '') {
      try {
        this.options.bridgeHost?.revoke(open.grantId);
      } catch (error) {
        this.options.logger.warn('cowork delegation revoke failed', { code: codeOf(error) });
      }
      this.delegated.delete(open.grantId);
    }
  }

  /**
   * One owner approval for one scratch write (action cowork.write, fingerprint over session, turn,
   * tool and target; single use; short TTL). Anything but an approval (denial, expiry, cancel, a
   * store failure) is a denial.
   */
  private async askOwner(
    request: CoworkRequest,
    task: NexarTask,
    permission: { readonly name: string; readonly target?: string },
    signal: AbortSignal,
  ): Promise<'allow' | 'deny'> {
    const label = writeLabel(permission.target);
    const action = {
      type: 'cowork.write',
      target: label,
      parameters: {
        sessionId: request.sessionId,
        turnId: request.turnId,
        tool: permission.name,
        target: permission.target ?? null,
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
      return 'allow';
    } catch (error) {
      this.options.logger.info('cowork write not approved', { code: codeOf(error) });
      return 'deny';
    }
  }

  /** Imports regular scratch files as drafts of the task; anything unusual is skipped. */
  private async importDrafts(
    request: CoworkRequest,
    task: NexarTask,
    scratch: string,
  ): Promise<ArtifactRef[]> {
    const { runtime } = this.options.engine.composition();
    const { files } = await collectDrafts(scratch);
    const store = new LocalArtifactStore({ projects: runtime.projects });
    const refs: ArtifactRef[] = [];
    for (const file of files) {
      const mediaType = Object.hasOwn(DRAFT_MEDIA, extname(file.name).toLowerCase())
        ? DRAFT_MEDIA[extname(file.name).toLowerCase()]
        : undefined;
      if (mediaType === undefined) continue;
      try {
        // Re-check at open time: only a plain, unlinked, unchanged-size regular file is imported.
        const info = await lstat(file.path);
        if (!info.isFile() || info.isSymbolicLink() || info.nlink > 1 || info.size !== file.size) {
          continue;
        }
        refs.push(
          await store.store({
            projectId: asProjectId(request.projectId),
            taskId: task.id,
            filename: file.name.replaceAll('/', '-'),
            content: await readFile(file.path),
            mediaType,
            draft: true,
          }),
        );
      } catch (error) {
        this.options.logger.warn('cowork draft import failed', { code: codeOf(error) });
      }
    }
    if (refs.length > 0) {
      await runtime.nexar.recordArtifacts(task.id, asProjectId(request.projectId), refs);
    }
    return refs;
  }

  /** Ends every turn and the OpenWorker process tree (app exit). */
  async dispose(): Promise<void> {
    this.disposed = true;
    for (const controller of this.active) controller.abort();
    // Stop first: a probe in flight may be starting a server, and stop() abandons that start (its
    // version probe or server is ended) instead of waiting up to the startup bound for it. Waiting
    // first let Desktop exit before the stop, leaving the server running behind a closed app.
    await this.supervisor?.value.stop();
    await this.inflight?.catch(() => undefined);
    // The probe may have replaced the supervisor before it saw `disposed`.
    await this.supervisor?.value.stop();
  }
}

// ---- channels ---------------------------------------------------------------------------------

function service(ctx: CallContext): CoworkService {
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
