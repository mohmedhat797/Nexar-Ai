import { randomBytes } from 'node:crypto';
import {
  NexarError,
  connectionKey,
  isNexarError,
  type Logger,
  type NexarErrorCode,
} from '@nexar/contracts';
import type { CodeRequest, CodeResult } from '@nexar/operating';
import {
  MAX_REQUIRED_CONTEXT_CHARS,
  PLANE_PROTOCOL,
  runTitle,
  type ApprovalSummary,
  type DecidedFrame,
  type DesktopFrame,
  type DiffFrame,
  type PlaneControl,
  type PlaneFeature,
  type PlaneFrame,
  type PlaneReadiness,
  type PlaneResource,
  type ProgressEvent,
  type RunOutcome,
} from '@nexar/plane-protocol';
import { MAX_OUTCOME_CHARS, type TurnEngineering } from '@nexar/sessions';
import type {
  ApprovalDto,
  CodeDiffDto,
  PlaneResourceDto,
  PlaneStateDto,
  PlaneStatusDto,
  ProjectPlaneDto,
} from '../shared/api.js';
import { PlaneConnection, type ConnectionEnd, type PlaneLauncher } from './plane-connection.js';
import type { CodePlaneConfigResult } from './settings-store.js';

/*
 * The Desktop side of the Code lane (ADR-025): readiness probing, one plane process per run,
 * plane approvals and per-turn diffs. The plane is a trust boundary: every frame is validated, text
 * that reaches the owner is built here from constants and scalars, and logs carry codes only.
 * No path, command, distro or environment value crosses this module's public surface.
 */

/** Fixed, non-sensitive reasons. Plane-provided text is never used. */
export const PLANE_REASONS = {
  ready: 'The engineering plane is ready',
  'wsl-unavailable': 'WSL is not available on this computer',
  'plane-missing': 'The engineering plane distro or command was not found',
  'plane-unreachable': 'The engineering plane did not respond in time',
  'protocol-mismatch': 'The engineering plane speaks a different protocol version',
  'sandbox-unavailable': 'The engineering plane sandbox is not available',
  'hardening-drift': 'The engineering plane is not hardened: automount or interop is enabled',
  'engineering-unavailable': 'The engineering plane has no engineering plans or projects',
  'project-unmapped': 'This project is not mapped to an engineering plane project',
  'project-unknown-to-plane': 'The engineering plane does not know the mapped project',
  'settings-invalid': 'The Code plane settings are not valid',
  checking: 'The Code lane is still being checked',
} as const;

export interface PlaneTimings {
  /** Deadline for `ready` after launch. */
  readonly handshakeMs: number;
  /** How long a probe result is reused. */
  readonly cacheMs: number;
  /** How long a closing plane gets to leave on its own before its tree is ended. */
  readonly shutdownMs: number;
  /** After a cancel: how long the plane gets to report the cancelled outcome. */
  readonly cancelMs: number;
  /** Bound on a diff or decide round trip. */
  readonly requestMs: number;
}

export const DEFAULT_TIMINGS: PlaneTimings = {
  handshakeMs: 20_000,
  cacheMs: 60_000,
  shutdownMs: 2_000,
  cancelMs: 8_000,
  requestMs: 15_000,
};

/** The last diffs kept in memory (by turn). */
export const MAX_STORED_DIFFS = 16;
/** Concurrent plane processes for runs. */
export const MAX_ACTIVE_RUNS = 4;
/** The plan the plane always runs for a review intent (ADR-025 amendment). */
const REPORT_PLAN = 'repository-report';
/** The plan the plane runs for a plan intent (NXR-053): a report-only implementation plan. */
const IMPLEMENTATION_PLAN = 'implementation-plan';
/** What this Desktop asks a plane for: the newest first, then what every older plane understands. */
const FEATURES_CURRENT: readonly PlaneFeature[] = ['resources', 'required-context'];
const FEATURES_LEGACY: readonly PlaneFeature[] = ['resources'];
const MAX_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const FINGERPRINT_PREFIX = 12;
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/;

export interface CodePlaneOptions {
  readonly settings: { getCodePlane(): Promise<CodePlaneConfigResult> };
  readonly launcher: PlaneLauncher;
  readonly logger: Logger;
  /** Names the decider on plane approvals, e.g. `desktop:alice`. */
  readonly decider: string;
  readonly now?: () => number;
  readonly newRunId?: () => string;
  readonly timings?: Partial<PlaneTimings>;
}

export type PlaneStatus = Omit<PlaneStatusDto, 'project'>;

const own = <T>(map: Readonly<Record<string, T>>, key: string): T | undefined =>
  Object.hasOwn(map, key) ? map[key] : undefined;

const plain = (value: string): string => value.replace(/[\p{Cc}\p{Cf}]/gu, ' ').trim();

/** Maps the readiness the plane reports about itself to a state (ADR-025 section 4). */
export function stateFromReadiness(readiness: PlaneReadiness): PlaneStateDto {
  if (readiness.sandbox !== 'ok' || readiness.selftest === 'fail') return 'sandbox-unavailable';
  if (readiness.automount !== 'disabled' || readiness.interop !== 'disabled') {
    return 'hardening-drift';
  }
  if (readiness.plans.length === 0 || readiness.projects.length === 0) {
    return 'engineering-unavailable';
  }
  return 'ready';
}

/** Pure attribution helper: qualifies a plane connection ID with machine 'plane'. */
export function hostQualifyPlaneConnection(connectionId: string): string {
  return connectionKey('plane', connectionId);
}

/** Pure attribution helper: qualifies a received plane resource DTO with machine 'plane'. */
export function hostQualifyPlaneResource(
  dto: PlaneResourceDto,
): PlaneResourceDto & { readonly machine: 'plane' } {
  return {
    ...dto,
    machine: 'plane',
  };
}

/** A plane resource as the renderer sees it: the validated enums and ids, copied field by field. */
function resourceDto(resource: PlaneResource): PlaneResourceDto {
  const { connection } = resource;
  return {
    id: resource.id,
    ...(connection === undefined
      ? {}
      : {
          provider: plain(connection.provider),
          method: connection.method,
          support: connection.support,
        }),
    auth: resource.auth,
    availability: resource.availability,
    control: { dsh: resource.control.dsh },
  };
}

/** The plane's Code control policy as the renderer sees it: enums and one resource id. */
function controlDto(control: PlaneControl): NonNullable<PlaneStatusDto['codeControl']> {
  const { mode, resourceId, fallback } = control.code;
  return { mode, fallback, ...(resourceId === undefined ? {} : { resourceId }) };
}

/** How a connection that ended or failed before `ready` maps to a state. */
function stateFromEnd(reason: ConnectionEnd): PlaneStateDto {
  switch (reason) {
    case 'spawn-enoent':
    case 'spawn-error':
      return 'wsl-unavailable';
    case 'protocol':
      return 'protocol-mismatch';
    default:
      return 'plane-missing';
  }
}

function stateFromErrorCode(code: NexarErrorCode): PlaneStateDto {
  if (code === 'VALIDATION_ERROR') return 'protocol-mismatch';
  if (code === 'CONFIGURATION_ERROR') return 'engineering-unavailable';
  if (code === 'SANDBOX_UNAVAILABLE') return 'sandbox-unavailable';
  return 'plane-unreachable';
}

const ERROR_MESSAGES: Readonly<Partial<Record<NexarErrorCode, string>>> = {
  POLICY_REJECTED: 'The engineering plane rejected the request',
  VALIDATION_ERROR: 'The engineering plane did not accept the request',
  SANDBOX_UNAVAILABLE: 'The engineering plane sandbox is not available',
  CONFIGURATION_ERROR: 'The engineering plane is not configured for this project',
  CONFLICT: 'The engineering plane is busy',
  APPROVAL_DENIED: 'The approval can no longer be decided',
  EXECUTION_CANCELLED: 'The engineering run was cancelled',
};

/** Plane error text is never echoed: the owner sees a constant message per code. */
function planeError(code: NexarErrorCode): NexarError {
  return new NexarError(
    code,
    ERROR_MESSAGES[code] ?? 'The engineering plane could not complete the request',
  );
}

const STEP_MESSAGES = {
  'task.started': 'Engineering task started',
  'lane.completed': 'Engineering lane completed',
  'patch.harvested': 'Changes collected for review',
  'gate.completed': 'Quality gate completed',
  'review.completed': 'Review completed',
  'acceptance.decided': 'Acceptance decided',
  'commit.created': 'Changes committed',
  'task.finished': 'Engineering task finished',
} as const;

/** A safe one-line status from constants and bounded identifiers only. */
export function progressLine(event: ProgressEvent): {
  readonly type: 'status' | 'progress';
  readonly message: string;
} {
  switch (event.type) {
    case 'step':
      return { type: 'status', message: STEP_MESSAGES[event.step] };
    case 'lane.started':
      return {
        type: 'progress',
        message: IDENTIFIER.test(event.role)
          ? `Engineering lane started: ${event.role}`
          : 'Engineering lane started',
      };
    case 'awaiting-approval':
      return { type: 'status', message: 'Waiting for your approval' };
  }
}

const OUTCOME_LINES: Readonly<Record<Exclude<TurnEngineering['status'], 'reported'>, string>> = {
  committed: 'The engineering changes were committed.',
  'not-accepted': 'The engineering changes were not accepted. Nothing was committed.',
  failed: 'The engineering run did not complete. Nothing was committed.',
  cancelled: 'The engineering run was cancelled. Nothing was committed.',
};

/** The fixed-format summary stored as the turn text: scalars only, never diff content. */
function summaryText(
  engineering: TurnEngineering & { readonly status: keyof typeof OUTCOME_LINES },
  reason: string | undefined,
): string {
  const lines = [OUTCOME_LINES[engineering.status]];
  if (reason !== undefined && IDENTIFIER.test(reason)) lines.push(`Reason: ${reason}`);
  if (engineering.branch !== undefined) lines.push(`Branch: ${plain(engineering.branch)}`);
  if (engineering.commit !== undefined) lines.push(`Commit: ${engineering.commit.slice(0, 12)}`);
  if (engineering.files !== undefined) lines.push(`Files changed: ${String(engineering.files)}`);
  if (engineering.gatesPassed !== undefined) {
    lines.push(`Gates passed: ${String(engineering.gatesPassed)}`);
  }
  if (engineering.reviewVerdict !== undefined) {
    lines.push(`Review verdict: ${plain(engineering.reviewVerdict)}`);
  }
  lines.push(`Task: ${engineering.planeTaskId}`);
  return lines.join('\n');
}

// ---- run bookkeeping --------------------------------------------------------------------------

interface Outstanding {
  readonly kind: 'decide' | 'diff';
  readonly key: string;
  readonly resolve: (value: DecidedFrame | DiffFrame) => void;
  readonly reject: (error: Error) => void;
  readonly timer: NodeJS.Timeout;
}

interface RunContext {
  readonly runId: string;
  readonly sessionId: string;
  readonly turnId: string;
  readonly projectId: string;
  readonly conn: PlaneConnection;
  readonly outstanding: Outstanding[];
}

interface PendingApproval {
  readonly id: string;
  readonly run: RunContext;
  readonly summary: ApprovalSummary;
  readonly createdAt: number;
  deciding: boolean;
}

export class CodePlane {
  private readonly timings: PlaneTimings;
  private readonly now: () => number;
  private readonly newRunId: () => string;
  private config: CodePlaneConfigResult | undefined;
  private cached: { readonly status: PlaneStatus; readonly at: number } | undefined;
  private inflight: Promise<PlaneStatus> | undefined;
  private readonly runs = new Map<string, RunContext>();
  private readonly pending = new Map<string, PendingApproval>();
  private readonly diffs = new Map<string, CodeDiffDto>();
  private reportAdvertised = false;
  private planAdvertised = false;
  /** The plane signalled `required-context` at its last handshake. */
  private requiredContextAdvertised = false;
  private disposed = false;

  constructor(private readonly options: CodePlaneOptions) {
    this.timings = { ...DEFAULT_TIMINGS, ...options.timings };
    this.now = options.now ?? Date.now;
    this.newRunId = options.newRunId ?? (() => `run_${randomBytes(16).toString('hex')}`);
  }

  // ---- status ---------------------------------------------------------------------------------

  /** Reloads the owner configuration (after a mapping change, or before a probe). */
  async reloadConfig(): Promise<CodePlaneConfigResult> {
    const config = await this.options.settings.getCodePlane();
    this.config = config;
    return config;
  }

  /** The cached status, probing when it is missing or older than the cache window. */
  status(): Promise<PlaneStatus> {
    const cached = this.cached;
    if (cached !== undefined && this.now() - cached.at < this.timings.cacheMs) {
      return Promise.resolve(cached.status);
    }
    return this.refresh();
  }

  /** The last probed status, or `undefined` when none exists yet. Never probes. */
  cachedStatus(): PlaneStatus | undefined {
    return this.cached?.status;
  }

  /** Probes now (one probe at a time) and replaces the cache. Never rejects. */
  refresh(): Promise<PlaneStatus> {
    this.inflight ??= this.probe()
      .catch((error: unknown) => {
        this.options.logger.warn('code plane probe crashed', { code: codeOf(error) });
        return this.statusOf('plane-unreachable');
      })
      .then((status) => {
        this.cached = { status, at: this.now() };
        this.options.logger.info('code plane probed', { state: status.state });
        return status;
      })
      .finally(() => {
        this.inflight = undefined;
      });
    return this.inflight;
  }

  /** Availability of one Desktop project from the status and the owner's mapping. */
  async projectStatus(projectId: string): Promise<ProjectPlaneDto> {
    await this.reloadConfig();
    return this.projectOf(await this.status(), projectId);
  }

  /** Synchronous: used by the lane router. A stale cache starts a background re-probe. */
  available(projectId: string): boolean {
    const cached = this.cached;
    if (cached === undefined) {
      void this.refresh();
      return false;
    }
    if (this.now() - cached.at >= this.timings.cacheMs) void this.refresh();
    return this.projectOf(cached.status, projectId).state === 'ready';
  }

  /** The fixed reason the Code lane is unavailable for a project, or `undefined` when it is ready. */
  reason(projectId: string): string | undefined {
    const cached = this.cached;
    if (cached === undefined) return PLANE_REASONS.checking;
    const project = this.projectOf(cached.status, projectId);
    return project.state === 'ready' ? undefined : project.reason;
  }

  private statusOf(
    state: PlaneStateDto,
    extra: Partial<
      Pick<PlaneStatus, 'planeVersion' | 'kernel' | 'projects' | 'planeResources' | 'codeControl'>
    > = {},
    reason: string = PLANE_REASONS[state],
  ): PlaneStatus {
    return {
      state,
      reason,
      projects: extra.projects ?? [],
      ...(extra.planeVersion === undefined ? {} : { planeVersion: extra.planeVersion }),
      ...(extra.kernel === undefined ? {} : { kernel: extra.kernel }),
      ...(extra.planeResources === undefined ? {} : { planeResources: extra.planeResources }),
      ...(extra.codeControl === undefined ? {} : { codeControl: extra.codeControl }),
      checkedAt: new Date(this.now()).toISOString(),
    };
  }

  /** Availability of one Desktop project given a status and the loaded owner mapping. */
  projectOf(status: PlaneStatus, projectId: string): ProjectPlaneDto {
    if (status.state !== 'ready') {
      return { projectId, state: status.state, reason: status.reason };
    }
    const config = this.config;
    const mapped =
      config !== undefined && config.valid ? own(config.value.projects, projectId) : undefined;
    if (mapped === undefined) {
      return { projectId, state: 'project-unmapped', reason: PLANE_REASONS['project-unmapped'] };
    }
    if (!status.projects.includes(mapped)) {
      return {
        projectId,
        state: 'project-unknown-to-plane',
        reason: PLANE_REASONS['project-unknown-to-plane'],
        planeProject: mapped,
      };
    }
    return { projectId, state: 'ready', reason: PLANE_REASONS.ready, planeProject: mapped };
  }

  /** Launch, `initialize` -> `ready`, `shutdown`: a short-lived process. */
  private async probe(): Promise<PlaneStatus> {
    const config = await this.reloadConfig();
    if (!config.valid) return this.statusOf('plane-missing', {}, PLANE_REASONS['settings-invalid']);
    const current = await this.probeWith(config.value, FEATURES_CURRENT);
    if (!current.rejectedFeatures) return current.status;
    // A plane older than `required-context` rejects the unknown feature: ask again without it.
    return (await this.probeWith(config.value, FEATURES_LEGACY)).status;
  }

  private async probeWith(
    config: Extract<CodePlaneConfigResult, { valid: true }>['value'],
    features: readonly PlaneFeature[],
  ): Promise<{ readonly status: PlaneStatus; readonly rejectedFeatures: boolean }> {
    let conn: PlaneConnection;
    try {
      conn = new PlaneConnection(this.options.launcher(config));
    } catch {
      return { status: this.statusOf('wsl-unavailable'), rejectedFeatures: false };
    }
    try {
      const handshake = await this.handshake(conn, features);
      if (!handshake.ok) {
        return {
          status: this.statusOf(handshake.state),
          rejectedFeatures: handshake.code === 'VALIDATION_ERROR' && features !== FEATURES_LEGACY,
        };
      }
      return { status: this.statusFromReady(handshake.ready), rejectedFeatures: false };
    } finally {
      await conn.close(this.timings.shutdownMs);
    }
  }

  /**
   * Whether read-only review turns can run on the plane: it advertised `repository-report` at its
   * last handshake and is ready. Unknown (never probed, or not ready) is `false`.
   */
  supportsReport(): boolean {
    return this.cached?.status.state === 'ready' && this.reportAdvertised;
  }

  /**
   * Whether the Code lane can run the Plan profile: the plane advertised implementation-plan at
   * its last handshake and is ready. Unknown is `false`: the turn is then refused, never run as a change.
   */
  supportsPlan(): boolean {
    return this.cached?.status.state === 'ready' && this.planAdvertised;
  }

  /**
   * Whether the plane signalled `required-context` at its last handshake: only then may a `run`
   * frame carry `requiredContext` (an older plane's strict schema rejects the key).
   */
  supportsRequiredContext(): boolean {
    return this.requiredContextAdvertised;
  }

  private statusFromReady(ready: Extract<PlaneFrame, { type: 'ready' }>): PlaneStatus {
    this.requiredContextAdvertised =
      ready.readiness.features?.includes('required-context') === true;
    this.reportAdvertised = ready.readiness.plans.includes(REPORT_PLAN);
    this.planAdvertised = ready.readiness.plans.includes(IMPLEMENTATION_PLAN);
    const state = stateFromReadiness(ready.readiness);
    return this.statusOf(state, {
      planeVersion: plain(ready.planeVersion),
      kernel: plain(ready.readiness.kernel),
      projects: ready.readiness.projects,
      ...(ready.readiness.resources === undefined
        ? {}
        : { planeResources: ready.readiness.resources.map(resourceDto) }),
      ...(ready.readiness.control === undefined
        ? {}
        : { codeControl: controlDto(ready.readiness.control) }),
    });
  }

  /** `initialize`, then wait (bounded) for `ready`; an `error` before it is a launch failure. */
  private async handshake(
    conn: PlaneConnection,
    features: readonly PlaneFeature[],
  ): Promise<
    | { readonly ok: true; readonly ready: Extract<PlaneFrame, { type: 'ready' }> }
    | { readonly ok: false; readonly state: PlaneStateDto; readonly code?: NexarErrorCode }
  > {
    try {
      conn.send({ type: 'initialize', protocol: PLANE_PROTOCOL, features: [...features] });
    } catch {
      return { ok: false, state: 'protocol-mismatch' };
    }
    const deadline = this.now() + this.timings.handshakeMs;
    for (;;) {
      const event = await conn.next(Math.max(0, deadline - this.now()));
      if (event === undefined) return { ok: false, state: 'plane-unreachable' };
      if (event.type === 'end') return { ok: false, state: stateFromEnd(event.reason) };
      const { frame } = event;
      if (frame.type === 'ready') return { ok: true, ready: frame };
      if (frame.type === 'error') {
        return { ok: false, state: stateFromErrorCode(frame.code), code: frame.code };
      }
      return { ok: false, state: 'protocol-mismatch' }; // anything else before `ready`
    }
  }

  // ---- approvals and diffs --------------------------------------------------------------------

  /** Whether an id belongs to a pending approval of an active plane run. */
  owns(approvalId: string): boolean {
    return this.pending.has(approvalId);
  }

  pendingApprovals(): ApprovalDto[] {
    return [...this.pending.values()]
      .sort((a, b) => a.createdAt - b.createdAt)
      .map((p) => this.approvalDto(p, 'pending'));
  }

  private approvalDto(p: PendingApproval, status: string, decidedAt?: number): ApprovalDto {
    const { summary } = p;
    const ttl = Math.min(summary.ttlMs, MAX_TTL_MS);
    const files = summary.files;
    return {
      id: p.id,
      status,
      createdAt: new Date(p.createdAt).toISOString(),
      expiresAt: new Date(p.createdAt + ttl).toISOString(),
      risk: 'medium',
      actionType: 'engineering.commit',
      summary:
        `Commit ${String(files)} ${files === 1 ? 'file' : 'files'} to branch ${plain(summary.branch)}; ` +
        `gates passed: ${String(summary.gatesPassed)}; review: ${plain(summary.reviewVerdict)}`,
      fingerprint: summary.patchSha256.slice(0, FINGERPRINT_PREFIX),
      taskId: summary.taskId,
      projectId: p.run.projectId,
      source: 'plane',
      sessionId: p.run.sessionId,
      turnId: p.run.turnId,
      plane: {
        branch: plain(summary.branch),
        files,
        gatesPassed: summary.gatesPassed,
        reviewVerdict: plain(summary.reviewVerdict),
      },
      ...(decidedAt === undefined
        ? {}
        : { decidedAt: new Date(decidedAt).toISOString(), decidedBy: this.options.decider }),
    };
  }

  /**
   * Sends the owner's decision for a pending approval of an active run. Never retried and never
   * replayed: the pending map lives in memory only, so nothing survives a restart.
   */
  async decide(approvalId: string, decision: 'approve' | 'deny'): Promise<ApprovalDto> {
    const approval = this.pending.get(approvalId);
    if (approval === undefined) {
      throw new NexarError('VALIDATION_ERROR', 'Unknown approval');
    }
    if (approval.deciding) {
      throw new NexarError('CONFLICT', 'The approval is already being decided');
    }
    approval.deciding = true;
    try {
      const reply = (await this.request(approval.run, 'decide', approvalId, {
        type: 'decide',
        approvalId,
        decision,
      })) as DecidedFrame;
      this.pending.delete(approvalId);
      return this.approvalDto(
        approval,
        reply.status === 'approved' ? 'approved' : 'denied',
        this.now(),
      );
    } catch (error) {
      approval.deciding = false;
      throw error;
    }
  }

  /** The stored diff of a turn, or `undefined` (only the last {@link MAX_STORED_DIFFS} are kept). */
  diff(sessionId: string, turnId: string): CodeDiffDto | undefined {
    return this.diffs.get(`${sessionId}:${turnId}`);
  }

  private storeDiff(run: RunContext, frame: DiffFrame): void {
    const key = `${run.sessionId}:${run.turnId}`;
    this.diffs.delete(key);
    this.diffs.set(key, {
      text: frame.text,
      truncated: frame.truncated,
      files: frame.files.map(plain),
    });
    while (this.diffs.size > MAX_STORED_DIFFS) {
      const oldest = this.diffs.keys().next().value;
      if (oldest === undefined) break;
      this.diffs.delete(oldest);
    }
  }

  /** One request frame whose answer is a specific frame; bounded, and rejected if the run ends. */
  private request(
    run: RunContext,
    kind: Outstanding['kind'],
    key: string,
    frame: DesktopFrame,
  ): Promise<DecidedFrame | DiffFrame> {
    return new Promise((resolve, reject) => {
      const entry: Outstanding = {
        kind,
        key,
        resolve: (value) => {
          clearTimeout(entry.timer);
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(entry.timer);
          reject(error);
        },
        timer: setTimeout(() => {
          const index = run.outstanding.indexOf(entry);
          if (index >= 0) run.outstanding.splice(index, 1);
          reject(new NexarError('EXECUTION_TIMEOUT', 'The engineering plane did not answer'));
        }, this.timings.requestMs),
      };
      run.outstanding.push(entry);
      try {
        run.conn.send(frame);
      } catch (error) {
        const index = run.outstanding.indexOf(entry);
        if (index >= 0) run.outstanding.splice(index, 1);
        clearTimeout(entry.timer);
        reject(
          error instanceof Error
            ? error
            : new NexarError('INTERNAL_ERROR', 'The request could not be sent'),
        );
      }
    });
  }

  // ---- run ------------------------------------------------------------------------------------

  /** Executes one `coding`/`review` turn on the plane (ADR-025 sections 5 to 8). */
  async run(request: CodeRequest, signal: AbortSignal): Promise<CodeResult> {
    const cancelled = (): NexarError =>
      new NexarError('EXECUTION_CANCELLED', 'The engineering run was cancelled');
    if (this.disposed) throw new NexarError('INTEGRATION_UNAVAILABLE', 'Desktop is shutting down');
    if (signal.aborted) throw cancelled();
    if (this.runs.size >= MAX_ACTIVE_RUNS) {
      throw new NexarError('POLICY_REJECTED', 'Too many engineering runs are active');
    }

    const config = await this.reloadConfig();
    if (!config.valid) {
      throw new NexarError('CONFIGURATION_ERROR', PLANE_REASONS['settings-invalid']);
    }
    const planeProject = own(config.value.projects, request.projectId);
    if (planeProject === undefined) {
      throw new NexarError('SANDBOX_UNAVAILABLE', PLANE_REASONS['project-unmapped']);
    }

    let conn: PlaneConnection;
    try {
      conn = new PlaneConnection(this.options.launcher(config.value));
    } catch {
      throw new NexarError('SANDBOX_UNAVAILABLE', PLANE_REASONS['wsl-unavailable']);
    }
    const run: RunContext = {
      runId: this.newRunId(),
      sessionId: request.sessionId,
      turnId: request.turnId,
      projectId: request.projectId,
      conn,
      outstanding: [],
    };
    this.runs.set(run.runId, run);

    let started = false;
    let cancelling = false;
    let cancelTimer: NodeJS.Timeout | undefined;
    const onAbort = (): void => {
      if (cancelling) return;
      cancelling = true;
      if (!started) {
        void conn.kill();
        return;
      }
      conn.trySend({ type: 'cancel', runId: run.runId });
      conn.trySend({ type: 'shutdown' });
      cancelTimer = setTimeout(() => void conn.kill(), this.timings.cancelMs);
    };
    signal.addEventListener('abort', onAbort, { once: true });

    try {
      // The last probe learned whether this plane understands `required-context`; an older plane
      // rejects an `initialize` that lists it.
      const handshake = await this.handshake(
        conn,
        this.requiredContextAdvertised ? FEATURES_CURRENT : FEATURES_LEGACY,
      );
      if (signal.aborted) throw cancelled();
      if (!handshake.ok) {
        throw new NexarError('SANDBOX_UNAVAILABLE', PLANE_REASONS[handshake.state]);
      }
      const status = this.statusFromReady(handshake.ready);
      this.cached = { status, at: this.now() };
      const project = this.projectOf(status, request.projectId);
      if (project.state !== 'ready') {
        throw new NexarError('SANDBOX_UNAVAILABLE', project.reason);
      }
      const requiredContext = this.requiredContextField(request);

      // The commit subject derives from the owner's own request, never the context@1 header.
      const title = runTitle(request.turnText);
      conn.send({
        type: 'run',
        runId: run.runId,
        planeProject,
        goal: request.goal,
        ...(title === undefined ? {} : { title }),
        ...requiredContext,
        intent: request.intent,
        lineage: {
          sessionId: request.sessionId,
          turnId: request.turnId,
          correlationId: request.correlation.correlationId,
          depth: request.correlation.depth,
        },
      });
      started = true;
      if (signal.aborted) onAbort();
      return await this.drive(run, request, () => cancelling, cancelled);
    } finally {
      clearTimeout(cancelTimer);
      signal.removeEventListener('abort', onAbort);
      this.finishRun(run);
      await conn.close(this.timings.shutdownMs);
    }
  }

  /**
   * The `run` frame's `requiredContext` field. Required context is never dropped silently: a plane
   * that did not signal support only gets the turn when the goal already carries the exact block;
   * otherwise the turn fails closed.
   */
  private requiredContextField(request: CodeRequest): { readonly requiredContext?: string } {
    const { requiredContext } = request;
    if (requiredContext === undefined || requiredContext === '') return {};
    if (requiredContext.length > MAX_REQUIRED_CONTEXT_CHARS) {
      throw new NexarError('VALIDATION_ERROR', 'The required project context is too long', {
        details: { reason: 'required-context-overflow' },
      });
    }
    if (this.requiredContextAdvertised) return { requiredContext };
    if (request.goal.includes(requiredContext)) return {};
    throw new NexarError(
      'VALIDATION_ERROR',
      'The engineering plane does not support the required project context',
      { details: { reason: 'required-context-unsupported' } },
    );
  }

  /** Consumes the run's frames until the outcome (and its diff) or a failure. */
  private async drive(
    run: RunContext,
    request: CodeRequest,
    isCancelling: () => boolean,
    cancelled: () => NexarError,
  ): Promise<CodeResult> {
    const { conn } = run;
    let outcome: RunOutcome | undefined;
    let summary: ApprovalSummary | undefined;
    let approvalId: string | undefined;
    let linkedTask = false;
    let finalDiffSettled = false;
    const diffDeadlineMs = this.timings.requestMs;
    let diffDeadline = 0;

    const learnTask = async (taskId: string): Promise<void> => {
      if (linkedTask) return;
      linkedTask = true;
      await request.onTask(taskId);
    };
    const requestDiff = (taskId: string): Promise<unknown> =>
      this.request(run, 'diff', taskId, { type: 'diff', taskId }).then(
        () => undefined,
        () => undefined, // a missing diff never fails the run
      );

    for (;;) {
      const waitMs = outcome === undefined ? undefined : Math.max(0, diffDeadline - this.now());
      const event = await conn.next(waitMs);
      if (event === undefined) break; // the final diff did not arrive in time

      if (event.type === 'end') {
        if (outcome !== undefined) break;
        throw isCancelling()
          ? cancelled()
          : new NexarError(
              'INTEGRATION_UNAVAILABLE',
              event.reason === 'protocol'
                ? 'The engineering plane sent an invalid message'
                : 'The engineering plane connection ended unexpectedly',
            );
      }

      const { frame } = event;
      switch (frame.type) {
        case 'progress': {
          if (frame.runId !== run.runId) break;
          if (frame.event.type === 'awaiting-approval') {
            await learnTask(frame.event.taskId);
            summary ??= {
              taskId: frame.event.taskId,
              branch: frame.event.branch,
              files: frame.event.files,
              gatesPassed: frame.event.gatesPassed,
              reviewVerdict: frame.event.reviewVerdict,
              patchSha256: frame.event.patchSha256,
              ttlMs: frame.event.ttlMs,
            };
          }
          const line = progressLine(frame.event);
          request.onProgress(line.type, line.message);
          break;
        }
        case 'approval-required': {
          if (frame.runId !== run.runId) break;
          summary = frame.summary;
          approvalId = frame.approvalId;
          await learnTask(frame.summary.taskId);
          this.pending.set(frame.approvalId, {
            id: frame.approvalId,
            run,
            summary: frame.summary,
            createdAt: this.now(),
            deciding: false,
          });
          await request.onApproval(frame.approvalId);
          // The owner reviews the diff before deciding.
          void requestDiff(frame.summary.taskId);
          break;
        }
        case 'decided': {
          this.settle(run, 'decide', frame.approvalId, frame);
          break;
        }
        case 'diff': {
          this.storeDiff(run, frame);
          this.settle(run, 'diff', frame.taskId, frame);
          if (outcome !== undefined && frame.taskId === outcome.taskId) finalDiffSettled = true;
          break;
        }
        case 'completed': {
          if (frame.runId !== run.runId || outcome !== undefined) break;
          outcome = frame.outcome;
          await learnTask(outcome.taskId);
          if (outcome.status === 'committed' || outcome.status === 'not-accepted') {
            diffDeadline = this.now() + diffDeadlineMs;
            void requestDiff(outcome.taskId);
          } else {
            finalDiffSettled = true;
          }
          break;
        }
        case 'error': {
          if (frame.runId === run.runId) throw planeError(frame.code);
          // An error without a run id answers the oldest request (a decision or a diff).
          const entry = run.outstanding.shift();
          if (entry !== undefined) entry.reject(planeError(frame.code));
          if (outcome !== undefined) {
            finalDiffSettled = true; // after the outcome the only open request is its diff
            break;
          }
          if (entry !== undefined) break;
          throw planeError(frame.code);
        }
        case 'ready':
          throw new NexarError(
            'INTEGRATION_UNAVAILABLE',
            'The engineering plane sent an invalid message',
          );
      }
      if (outcome !== undefined && finalDiffSettled) break;
    }

    if (outcome === undefined)
      throw new NexarError(
        'INTEGRATION_UNAVAILABLE',
        'The engineering run ended without an outcome',
      );
    const lanes = outcome.lanes;
    const laneFields =
      lanes === undefined || lanes.length === 0
        ? {}
        : {
            lanes: lanes.map(
              ({ role, resourceId, executor, engine, executorReason, controlResourceId }) => ({
                role,
                resourceId,
                ...(executor === undefined ? {} : { executor }),
                ...(engine === undefined ? {} : { engine }),
                ...(executorReason === undefined ? {} : { executorReason }),
                ...(controlResourceId === undefined ? {} : { controlResourceId }),
              }),
            ),
          };
    const status = outcome.status;
    if (status === 'reported') {
      // Only a review or plan run may end `reported`, and it must carry the report.
      if (request.intent === 'coding' || outcome.report === undefined) {
        throw new NexarError('INTERNAL_ERROR', 'The engineering plane sent an unexpected outcome');
      }
      const { text, truncated } = boundReport(outcome.report.text);
      return {
        taskId: outcome.taskId,
        text,
        ...(truncated || outcome.report.truncated ? { textTruncated: true } : {}),
        engineering: { planeTaskId: outcome.taskId, status, ...laneFields },
      };
    }
    const engineering = {
      planeTaskId: outcome.taskId,
      status,
      ...laneFields,
      ...(outcome.branch === undefined ? {} : { branch: outcome.branch }),
      ...(outcome.commit === undefined ? {} : { commit: outcome.commit }),
      ...(summary === undefined
        ? {}
        : {
            files: summary.files,
            gatesPassed: summary.gatesPassed,
            reviewVerdict: summary.reviewVerdict,
          }),
      ...(approvalId === undefined ? {} : { approvalId }),
    };
    return {
      taskId: outcome.taskId,
      text: summaryText(engineering, outcome.reason),
      engineering,
    };
  }

  /** Resolves the oldest outstanding request waiting for exactly this answer. */
  private settle(
    run: RunContext,
    kind: Outstanding['kind'],
    key: string,
    frame: DecidedFrame | DiffFrame,
  ): void {
    const index = run.outstanding.findIndex((entry) => entry.kind === kind && entry.key === key);
    if (index < 0) return;
    const [entry] = run.outstanding.splice(index, 1);
    entry?.resolve(frame);
  }

  /** Forgets a finished run: its pending approvals can no longer be decided. */
  private finishRun(run: RunContext): void {
    this.runs.delete(run.runId);
    for (const [id, approval] of this.pending) {
      if (approval.run === run) this.pending.delete(id);
    }
    for (const entry of run.outstanding.splice(0)) {
      entry.reject(new NexarError('INTEGRATION_UNAVAILABLE', 'The engineering run has ended'));
    }
  }

  /** Ends every plane process (app exit). */
  dispose(): void {
    this.disposed = true;
    for (const run of this.runs.values()) void run.conn.kill();
  }
}

/** The report as the turn text: never longer than the turn outcome limit, not split mid-pair. */
function boundReport(text: string): { readonly text: string; readonly truncated: boolean } {
  if (text.length <= MAX_OUTCOME_CHARS) return { text, truncated: false };
  let end = MAX_OUTCOME_CHARS;
  const last = text.charCodeAt(end - 1);
  if (last >= 0xd800 && last <= 0xdbff) end -= 1;
  return { text: text.slice(0, end), truncated: true };
}

function codeOf(error: unknown): string {
  return isNexarError(error) ? error.code : 'UNKNOWN';
}
