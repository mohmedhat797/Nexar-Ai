import { createHash } from 'node:crypto';
import { NexarError, isNexarError } from '@nexar/contracts';
import type { ArtifactRef, Logger, TaskKind } from '@nexar/contracts';
import type {
  ContextManifest,
  FileSessionStore,
  LaneDecision,
  OperatingSession,
  Turn,
  TurnEngineering,
} from '@nexar/sessions';
import { buildContext } from './context.js';
import { delegate, rootCorrelation } from './correlation.js';
import type { OperatingCorrelation } from './correlation.js';
import { classifyIntent } from './intent.js';
import { confirmLane, decideLane } from './router.js';
import type { LaneOutcome } from './router.js';

/*
 * `OperatingService`: the turn pipeline (ADR-024): session store -> intent -> lane -> engine ->
 * session store, over injected ports. Lane choice is not authorization: the NRC still routes every
 * task. Logs and errors carry codes and constant reasons, never owner text, prompts or output.
 */

/** Maximum turns executing at once in one service. */
export const MAX_CONCURRENT_TURNS = 16;

/** Shown when the Plan profile is on but the plane does not advertise the implementation plan. */
export const PLAN_UNSUPPORTED_REFUSAL =
  'Plan mode needs the engineering plane to offer the implementation-plan plan, and this plane does not. No change run was started.';

export interface DirectRequest {
  readonly sessionId: string;
  readonly turnId: string;
  readonly projectId: string;
  readonly kind: TaskKind;
  readonly prompt: string;
  readonly correlation: OperatingCorrelation;
  readonly preferredResourceIds?: readonly string[];
  readonly maxCostUsd?: number;
  /** The owner's Cowork permission is read only: the turn must not store a draft artifact. */
  readonly readOnly?: boolean;
  /** Called once with the created task id before execution starts. */
  readonly onTask: (taskId: string) => Promise<void>;
  readonly onProgress: (type: 'status' | 'progress', message: string) => void;
}

export interface DirectResult {
  readonly taskId: string;
  readonly text: string;
  readonly artifacts: readonly ArtifactRef[];
  readonly resourceId?: string;
  readonly policyId?: string;
  readonly fallback?: boolean;
}

/** Cowork permission from the owner's AI behavior settings (NXR-053); it only ever narrows. */
export type CoworkPermission = 'read-only' | 'drafts-only' | 'ask-before-write';
/** Code permission: `plan` runs the report-only implementation plan instead of a change plan. */
export type CodePermission = 'plan' | 'auto-edit';

/** What the owner's AI behavior settings say for the session's mode, resolved by the host port. */
export interface BehaviorProfile {
  /** The owner's preferred resource for the session's mode; an explicit turn preference wins. */
  readonly preferredResourceIds?: readonly string[];
  readonly cowork: { readonly permission: CoworkPermission };
  readonly code: { readonly permission: CodePermission };
}

const DEFAULT_BEHAVIOR: BehaviorProfile = {
  cowork: { permission: 'drafts-only' },
  code: { permission: 'auto-edit' },
};

/** A Cowork turn (ADR-026): the same request as a direct one; its correlation is already delegated. */
export type CoworkRequest = DirectRequest & { readonly permission: CoworkPermission };

/** A unit a Cowork engine delegated through the Intelligence Bridge (ids and an enum only). */
export interface CoworkDelegation {
  readonly unitId: string;
  readonly resourceId?: string;
  readonly outcome: string;
}

/** How the engine's control loop ran: through Nexar's gateway, or the interim direct key. */
export type CoworkControl =
  | { readonly path: 'gateway'; readonly controlDecisionId: string; readonly restarts: number }
  | { readonly path: 'direct-key' };

export type CoworkResult = Omit<DirectResult, 'fallback'> & {
  readonly delegations?: readonly CoworkDelegation[];
  readonly control?: CoworkControl;
};

/** The longest goal the engineering plane accepts (ADR-025: same bound as the runner). */
export const MAX_CODE_GOAL_CHARS = 20_000;

/** Policy strings recorded on the context manifest of a Code-lane turn: which goal was sent. */
export const CODE_GOAL_CONTEXT_POLICY = 'context@1/code-goal:context';
export const CODE_GOAL_REQUEST_ONLY_POLICY = 'context@1/code-goal:request-only';

export interface CodeRequest {
  readonly sessionId: string;
  readonly turnId: string;
  readonly projectId: string;
  readonly intent: 'coding' | 'review' | 'plan';
  /** The context@1 prompt, or the turn's own text when the prompt is over 20,000 characters. */
  readonly goal: string;
  /**
   * The turn's own text (the owner's current request). The task title, and so the commit subject,
   * derives from it, never from the context@1 header of `goal`.
   */
  readonly turnText: string;
  readonly correlation: OperatingCorrelation;
  /** Called with the plane's task id as soon as it is known (idempotent). */
  readonly onTask: (taskId: string) => Promise<void>;
  readonly onProgress: (type: 'status' | 'progress', message: string) => void;
  /** Called with each plane approval id the run is waiting for; never rejects. */
  readonly onApproval: (approvalId: string) => Promise<void>;
}

export interface CodeResult {
  readonly taskId: string;
  /** A short fixed-format summary built by the port: never diff content, paths or prompts. */
  readonly text: string;
  /** The text was cut at a bound (a report run only). */
  readonly textTruncated?: boolean;
  readonly engineering: TurnEngineering;
}

export interface OperatingPorts {
  readonly store: Pick<
    FileSessionStore,
    | 'get'
    | 'beginTurn'
    | 'resolveConfirmation'
    | 'linkTask'
    | 'updateTask'
    | 'linkArtifacts'
    | 'linkApprovals'
    | 'setContext'
    | 'completeTurn'
  >;
  /**
   * Availability is per project: the Code lane depends on the session project's engineering plane
   * mapping. `reason` is a fixed, non-sensitive text shown when an engineering write is refused.
   */
  readonly lanes: {
    available(lane: 'cowork' | 'code', projectId: string): boolean;
    reason?(lane: 'cowork' | 'code', projectId: string): string | undefined;
    /**
     * A fixed id recorded as the fallback reason when the Cowork lane is unavailable, when it is more
     * precise than the default `openworker-unavailable` (e.g. `openworker-control-unavailable`).
     */
    fallbackReason?(lane: 'cowork'): string | undefined;
    /** Whether an available lane can run this intent (default: yes). */
    supports?(lane: 'cowork' | 'code', kind: TaskKind): boolean;
    /** Whether the Code lane can run the report-only implementation plan (default: no). */
    supportsPlan?(): boolean;
  };
  /**
   * The owner's AI behavior for the session's mode (NXR-053). It may throw (damaged settings):
   * the turn is then not started. Without it the defaults apply (drafts only, auto-edit).
   */
  readonly behavior?: (mode: OperatingSession['mode']) => Promise<BehaviorProfile>;
  readonly executeDirect: (request: DirectRequest, signal: AbortSignal) => Promise<DirectResult>;
  /** The Code lane (ADR-025). Without it a `code` effective lane executes through `executeDirect`. */
  readonly executeCode?: (request: CodeRequest, signal: AbortSignal) => Promise<CodeResult>;
  /**
   * The Cowork lane (ADR-026). Without it a `cowork` effective lane is unavailable: the turn runs
   * through `executeDirect`, recorded as such with `openworker-unavailable`.
   */
  readonly executeCowork?: (request: CoworkRequest, signal: AbortSignal) => Promise<CoworkResult>;
  /** A safe display name for an artifact of the session's own project, or undefined to drop it. */
  readonly describeArtifact?: (ref: ArtifactRef, projectId: string) => string | undefined;
  readonly onTurnChanged?: (sessionId: string, turnId: string) => void;
  readonly onProgress?: (
    sessionId: string,
    turnId: string,
    type: 'status' | 'progress',
    message: string,
  ) => void;
  readonly logger: Logger;
}

export interface SubmitTurnInput {
  readonly sessionId: string;
  readonly submissionKey: string;
  readonly text: string;
  readonly explicitKind?: TaskKind;
  readonly preferredResourceIds?: readonly string[];
  readonly maxCostUsd?: number;
}

export interface SubmitTurnResult {
  readonly turn: Turn;
  readonly created: boolean;
  readonly action: LaneOutcome['action'];
}

/** Per-turn options that are not persisted; a pending confirmation keeps them in memory only. */
interface RunOptions {
  readonly preferredResourceIds?: readonly string[] | undefined;
  readonly maxCostUsd?: number | undefined;
  readonly behavior: BehaviorProfile;
}

function reject(code: 'VALIDATION_ERROR' | 'CONFLICT' | 'POLICY_REJECTED', reason: string) {
  return new NexarError(code, `Operating request rejected: ${reason}`, { details: { reason } });
}

function safeError(error: unknown): { readonly code: string; readonly message: string } {
  if (isNexarError(error)) return { code: error.code, message: error.message };
  return { code: 'INTERNAL_ERROR', message: 'Internal error' };
}

function codeOf(error: unknown): string {
  return isNexarError(error) ? error.code : 'UNKNOWN';
}

const key = (sessionId: string, turnId: string): string => `${sessionId}:${turnId}`;

export class OperatingService {
  private readonly controllers = new Map<string, AbortController>();
  private readonly pending = new Map<string, RunOptions>();
  private readonly inflight = new Set<Promise<void>>();
  /** Slots claimed by a submit/confirm that has not yet registered its controller. */
  private reserved = 0;

  constructor(private readonly ports: OperatingPorts) {}

  executions(): number {
    return this.controllers.size;
  }

  /** Test helper: resolves when no execution is in flight. */
  async whenIdle(): Promise<void> {
    while (this.inflight.size > 0) await Promise.allSettled([...this.inflight]);
  }

  async submit(input: SubmitTurnInput): Promise<SubmitTurnResult> {
    const session = await this.load(input.sessionId);
    const intent = classifyIntent({
      text: input.text,
      ...(input.explicitKind === undefined ? {} : { explicitKind: input.explicitKind }),
    });
    const behavior = await this.profile(session.mode);
    const available = this.availability(session.projectId, intent.kind, behavior);
    const outcome = decideLane({ mode: session.mode, intent, available });
    const options: RunOptions = {
      preferredResourceIds: input.preferredResourceIds,
      maxCostUsd: input.maxCostUsd,
      behavior,
    };

    const runs = outcome.action === 'run';
    if (runs) this.reserve();
    try {
      const { turn, created } = await this.ports.store.beginTurn(input.sessionId, {
        submissionKey: input.submissionKey,
        text: input.text,
        state: outcome.action === 'confirm' ? 'pending-confirmation' : 'running',
        intent,
        lane: this.honest(outcome.decision, intent.kind),
      });
      if (!created) return { turn, created: false, action: this.replayAction(turn) };

      if (outcome.action === 'confirm') {
        this.pending.set(key(input.sessionId, turn.id), options);
        this.changed(input.sessionId, turn.id);
        return { turn, created: true, action: 'confirm' };
      }
      if (outcome.action === 'refuse') {
        const failed = await this.failRefused(
          input.sessionId,
          turn.id,
          outcome,
          session.projectId,
          this.planRefusal(session.projectId, intent.kind, behavior),
        );
        return { turn: failed, created: true, action: 'refuse' };
      }
      this.changed(input.sessionId, turn.id);
      this.start(input.sessionId, turn.id, options);
      return { turn, created: true, action: 'run' };
    } finally {
      if (runs) this.reserved -= 1;
    }
  }

  async confirm(input: {
    readonly sessionId: string;
    readonly turnId: string;
    readonly decision: 'confirm' | 'decline';
  }): Promise<Turn> {
    const { sessionId, turnId } = input;
    const k = key(sessionId, turnId);
    if (input.decision === 'decline') {
      const { turn } = await this.ports.store.resolveConfirmation(sessionId, turnId, {
        decision: 'decline',
      });
      this.pending.delete(k);
      this.changed(sessionId, turnId);
      return turn;
    }

    const session = await this.load(sessionId);
    const turn = session.turns.find((t) => t.id === turnId);
    if (turn === undefined) throw reject('VALIDATION_ERROR', 'unknown-turn');
    if (turn.state !== 'pending-confirmation') throw reject('CONFLICT', 'not-pending-confirmation');
    if (turn.lane === undefined) throw reject('VALIDATION_ERROR', 'lane-required');
    // Options (preferred resources, cost ceiling) live only in memory. Running without them after
    // a restart would silently drop the owner's cost ceiling, so it fails closed: decline instead.
    const options = this.pending.get(k);
    if (options === undefined) throw reject('CONFLICT', 'confirmation-expired');

    const kind = turn.intent?.kind ?? 'general';
    const outcome = confirmLane(
      turn.lane,
      this.availability(session.projectId, kind, options.behavior),
      { kind },
    );
    const runs = outcome.action === 'run';
    if (runs) this.reserve();
    try {
      const { turn: resolved } = await this.ports.store.resolveConfirmation(sessionId, turnId, {
        decision: 'confirm',
        ...((): { effectiveLane: LaneDecision['effectiveLane']; fallbackReason: string | null } => {
          const honest = this.honest(outcome.decision, turn.intent?.kind ?? 'general');
          return {
            effectiveLane: honest.effectiveLane,
            fallbackReason: honest.fallbackReason ?? null,
          };
        })(),
      });
      this.pending.delete(k);
      this.changed(sessionId, turnId);
      if (outcome.action === 'refuse') {
        return this.failRefused(
          sessionId,
          turnId,
          outcome,
          session.projectId,
          this.planRefusal(session.projectId, kind, options.behavior),
        );
      }
      this.start(sessionId, turnId, options);
      return resolved;
    } finally {
      if (runs) this.reserved -= 1;
    }
  }

  /** Aborts the in-flight execution of a turn; false when nothing is running for it. */
  cancel(sessionId: string, turnId: string): boolean {
    const controller = this.controllers.get(key(sessionId, turnId));
    if (controller === undefined) return false;
    controller.abort();
    return true;
  }

  // ------------------------------------------------------------ internals

  private async load(sessionId: string): Promise<OperatingSession> {
    const session = await this.ports.store.get(sessionId);
    if (session === undefined) throw reject('VALIDATION_ERROR', 'unknown-session');
    return session;
  }

  /** The owner's behavior for a mode; a damaged settings section propagates and refuses the turn. */
  private profile(mode: OperatingSession['mode']): Promise<BehaviorProfile> {
    return this.ports.behavior === undefined
      ? Promise.resolve(DEFAULT_BEHAVIOR)
      : this.ports.behavior(mode);
  }

  /** Plan profile: an engineering write may only run as the plan, so the plane must offer it. */
  private planBlocked(projectId: string, kind: TaskKind, behavior: BehaviorProfile): boolean {
    return (
      kind === 'coding' &&
      behavior.code.permission === 'plan' &&
      this.ports.executeCode !== undefined &&
      this.ports.lanes.available('code', projectId) &&
      !(this.ports.lanes.supportsPlan?.() ?? false)
    );
  }

  private planRefusal(
    projectId: string,
    kind: TaskKind,
    behavior: BehaviorProfile,
  ): string | undefined {
    return this.planBlocked(projectId, kind, behavior) ? PLAN_UNSUPPORTED_REFUSAL : undefined;
  }

  private availability(
    projectId: string,
    kind: TaskKind,
    behavior: BehaviorProfile,
  ): { readonly cowork: boolean; readonly code: boolean } {
    return {
      // Same rule as the Code lane: no executor, no lane.
      cowork:
        this.ports.lanes.available('cowork', projectId) && this.ports.executeCowork !== undefined,
      // Without a Code executor the lane cannot run anything: report it unavailable, so engineering
      // writes are refused instead of silently executing direct.
      // Plan profile: an engineering write never runs as a change; without the plan it is refused.
      code:
        this.ports.executeCode !== undefined &&
        this.ports.lanes.available('code', projectId) &&
        !this.planBlocked(projectId, kind, behavior),
    };
  }

  /** The router's refusal plus the fixed reason, when the lanes port has one (never user text). */
  private refusalMessage(base: string, projectId: string, override?: string): string {
    if (override !== undefined) return override;
    let reason: string | undefined;
    try {
      reason = this.ports.lanes.reason?.('code', projectId);
    } catch {
      reason = undefined;
    }
    return reason === undefined || reason === '' ? base : `${base} (${reason})`;
  }

  private replayAction(turn: Turn): LaneOutcome['action'] {
    if (turn.state === 'pending-confirmation') return 'confirm';
    if (turn.state === 'failed' && turn.outcome?.error?.code === 'SANDBOX_UNAVAILABLE') {
      return 'refuse';
    }
    return 'run';
  }

  private reserve(): void {
    if (this.controllers.size + this.reserved >= MAX_CONCURRENT_TURNS) {
      throw reject('POLICY_REJECTED', 'too-many-turns');
    }
    this.reserved += 1;
  }

  private changed(sessionId: string, turnId: string): void {
    try {
      this.ports.onTurnChanged?.(sessionId, turnId);
    } catch (error) {
      this.ports.logger.warn('operating: change listener failed', { code: codeOf(error) });
    }
  }

  private async failRefused(
    sessionId: string,
    turnId: string,
    outcome: LaneOutcome,
    projectId: string,
    override?: string,
  ): Promise<Turn> {
    const refusal = outcome.refusal ?? {
      code: 'SANDBOX_UNAVAILABLE' as const,
      message: 'Request refused',
    };
    const { turn } = await this.ports.store.completeTurn(sessionId, turnId, {
      state: 'failed',
      outcome: {
        error: {
          code: refusal.code,
          message: this.refusalMessage(refusal.message, projectId, override),
        },
      },
    });
    this.changed(sessionId, turnId);
    return turn;
  }

  /** Registers the controller synchronously and runs the turn in the background (not awaited). */
  private start(sessionId: string, turnId: string, options: RunOptions): void {
    const k = key(sessionId, turnId);
    if (this.controllers.has(k)) throw reject('CONFLICT', 'already-running');
    const controller = new AbortController();
    this.controllers.set(k, controller);
    const run = this.execute(sessionId, turnId, controller, options)
      .catch((error: unknown) => {
        this.ports.logger.error('operating: turn crashed', { code: codeOf(error) });
      })
      .finally(() => {
        this.controllers.delete(k);
        this.inflight.delete(run);
        this.changed(sessionId, turnId);
      });
    this.inflight.add(run);
  }

  private async attempt(what: string, step: () => Promise<unknown>): Promise<void> {
    try {
      await step();
    } catch (error) {
      this.ports.logger.warn(`operating: store update failed (${what})`, { code: codeOf(error) });
    }
  }

  private coworkFallbackReason(): string {
    try {
      return this.ports.lanes.fallbackReason?.('cowork') ?? 'openworker-unavailable';
    } catch {
      return 'openworker-unavailable';
    }
  }

  /**
   * Records where a turn will really execute (ADR-024 §9: never claim an orchestrator ran when it
   * did not). The Code lane runs only engineering intents the plane supports; any other turn that
   * inherits it from the session mode runs direct and is recorded so, with the reason. Engineering
   * writes (`coding`) are never rewritten: without the lane they stay refused.
   */
  private honest(decision: LaneDecision, kind: TaskKind): LaneDecision {
    // Cowork work is read/draft: an unavailable OpenWorker falls back to direct, recorded as such.
    if (
      decision.requestedLane === 'cowork' &&
      decision.effectiveLane === 'direct' &&
      decision.fallbackReason === 'orchestrator-unavailable'
    ) {
      return { ...decision, fallbackReason: this.coworkFallbackReason() };
    }
    if (decision.effectiveLane !== 'code' || kind === 'coding') return decision;
    const supported =
      kind === 'review' &&
      this.ports.executeCode !== undefined &&
      (this.ports.lanes.supports?.('code', kind) ?? true);
    if (supported) return decision;
    return {
      ...decision,
      effectiveLane: 'direct',
      fallbackReason: kind === 'review' ? 'code-report-unavailable' : 'code-engineering-only',
    };
  }

  /**
   * One turn: context -> lane execution -> durable outcome. Never rejects: every failure ends in
   * the turn's state (or, if the store itself fails, stays `running` until restart recovery marks
   * it `interrupted`).
   *
   * `coding`/`review` turns whose effective lane is `code` run through `executeCode` (the WSL2
   * engineering plane, ADR-025). Every other turn executes through `executeDirect`. That includes
   * `general`/`analysis`/... turns that merely inherit the `code` lane from the session mode: they
   * must never become engineering writes. A `cowork` effective lane runs through `executeCowork`
   * (the supervised OpenWorker, ADR-026) with a depth 1 `openworker` correlation; nothing here
   * claims an orchestrator ran when it did not.
   */
  private async execute(
    sessionId: string,
    turnId: string,
    controller: AbortController,
    options: RunOptions,
  ): Promise<void> {
    const { store } = this.ports;
    let linkedTaskId: string | undefined;
    // Approval links queue here so the turn is never completed before they were attempted.
    let approvalLinks: Promise<void> = Promise.resolve();
    try {
      const session = await this.load(sessionId);
      const turn = session.turns.find((t) => t.id === turnId);
      if (turn === undefined) throw reject('VALIDATION_ERROR', 'unknown-turn');
      const describe = this.ports.describeArtifact;
      const { prompt, manifest } = buildContext({
        session,
        turnId,
        describeArtifact:
          describe === undefined ? undefined : (ref) => describe(ref, session.projectId),
      });
      const kind = turn.intent?.kind ?? 'general';
      const { behavior } = options;
      const codeIntent =
        kind === 'coding'
          ? behavior.code.permission === 'plan'
            ? 'plan'
            : 'coding'
          : kind === 'review'
            ? 'review'
            : undefined;
      const executeCode = this.ports.executeCode;
      const viaCode =
        turn.lane?.effectiveLane === 'code' &&
        executeCode !== undefined &&
        codeIntent !== undefined;

      let goal = prompt;
      let recorded: ContextManifest = manifest;
      if (
        viaCode &&
        (options.maxCostUsd !== undefined || (options.preferredResourceIds?.length ?? 0) > 0)
      ) {
        // The plane protocol carries neither yet: refuse rather than silently drop an owner setting.
        throw new NexarError(
          'POLICY_REJECTED',
          'Cost ceilings and resource preferences are not supported on the Code lane yet',
          { details: { reason: 'code-options-unsupported' } },
        );
      }
      if (viaCode) {
        // The plane's goal limit is 20,000 characters: over it, send only the turn's own text.
        const requestOnly = prompt.length > MAX_CODE_GOAL_CHARS;
        if (requestOnly) {
          if (turn.text.length > MAX_CODE_GOAL_CHARS) {
            throw reject('VALIDATION_ERROR', 'goal-too-long');
          }
          goal = turn.text;
        }
        recorded = requestOnly
          ? {
              policy: CODE_GOAL_REQUEST_ONLY_POLICY,
              turnIds: [],
              omittedTurns: manifest.turnIds.length + manifest.omittedTurns,
              truncatedTurnIds: [],
              chars: goal.length,
              artifactIds: [],
              hash: createHash('sha256').update(goal).digest('hex'),
            }
          : { ...manifest, policy: CODE_GOAL_CONTEXT_POLICY };
      }
      await store.setContext(sessionId, turnId, recorded);
      this.changed(sessionId, turnId);
      if (controller.signal.aborted) throw reject('CONFLICT', 'cancelled'); // ends as `cancelled`

      const link = async (taskId: string): Promise<void> => {
        if (linkedTaskId !== undefined) return;
        await store.linkTask(sessionId, turnId, { taskId, state: 'running' });
        linkedTaskId = taskId;
        this.changed(sessionId, turnId);
      };
      const onProgress = (type: 'status' | 'progress', message: string): void => {
        try {
          this.ports.onProgress?.(sessionId, turnId, type, message);
        } catch (error) {
          this.ports.logger.warn('operating: progress listener failed', { code: codeOf(error) });
        }
      };

      if (viaCode && codeIntent !== undefined) {
        const result = await executeCode(
          {
            sessionId,
            turnId,
            projectId: session.projectId,
            intent: codeIntent,
            goal,
            turnText: turn.text,
            correlation: rootCorrelation(sessionId, turnId),
            onTask: link,
            onProgress,
            onApproval: (approvalId) => {
              approvalLinks = approvalLinks.then(() =>
                this.attempt('approval', async () => {
                  await store.linkApprovals(sessionId, turnId, [approvalId]);
                  this.changed(sessionId, turnId);
                }),
              );
              return approvalLinks;
            },
          },
          controller.signal,
        );
        await approvalLinks;
        await link(result.taskId);
        const { engineering } = result;
        const cancelled = controller.signal.aborted || engineering.status === 'cancelled';
        const succeeded =
          !cancelled && (engineering.status === 'committed' || engineering.status === 'reported');
        const state = cancelled ? 'cancelled' : succeeded ? 'succeeded' : 'failed';
        await store.updateTask(sessionId, turnId, result.taskId, { state });
        await store.completeTurn(sessionId, turnId, {
          state,
          outcome: {
            text: result.text,
            ...(result.textTruncated === true ? { textTruncated: true } : {}),
            engineering,
            ...(state !== 'failed'
              ? {}
              : {
                  error:
                    engineering.status === 'not-accepted'
                      ? {
                          code: 'POLICY_REJECTED',
                          message: 'The engineering changes were not accepted',
                        }
                      : { code: 'INTERNAL_ERROR', message: 'The engineering run did not complete' },
                }),
          },
        });
        return;
      }

      const executeCowork = this.ports.executeCowork;
      const viaCowork = turn.lane?.effectiveLane === 'cowork' && executeCowork !== undefined;
      const root = rootCorrelation(sessionId, turnId);
      // The owner's per-mode preference applies when the turn names none (NRC filters still run).
      const preferred =
        (options.preferredResourceIds?.length ?? 0) > 0
          ? options.preferredResourceIds
          : behavior.preferredResourceIds;
      const request: DirectRequest = {
        sessionId,
        turnId,
        projectId: session.projectId,
        kind,
        prompt,
        correlation: viaCowork ? delegate(root, 'openworker') : root,
        ...(preferred === undefined || preferred.length === 0
          ? {}
          : { preferredResourceIds: preferred }),
        ...(options.maxCostUsd === undefined ? {} : { maxCostUsd: options.maxCostUsd }),
        // Read only Cowork stores no draft, also for a direct turn inside a Cowork session.
        ...(behavior.cowork.permission === 'read-only' && (viaCowork || session.mode === 'cowork')
          ? { readOnly: true }
          : {}),
        onTask: link,
        onProgress,
      };
      const result: DirectResult & Pick<CoworkResult, 'delegations' | 'control'> = viaCowork
        ? await executeCowork(
            { ...request, permission: behavior.cowork.permission },
            controller.signal,
          )
        : await this.ports.executeDirect(request, controller.signal);

      await link(result.taskId);
      if (result.artifacts.length > 0) {
        await store.linkArtifacts(sessionId, turnId, result.artifacts);
        this.changed(sessionId, turnId);
      }
      const cancelled = controller.signal.aborted;
      await store.updateTask(sessionId, turnId, result.taskId, {
        state: cancelled ? 'cancelled' : 'succeeded',
        ...(result.resourceId === undefined ? {} : { resourceId: result.resourceId }),
        ...(result.policyId === undefined ? {} : { policyId: result.policyId }),
        ...(result.fallback === undefined ? {} : { fallback: result.fallback }),
        ...(result.delegations === undefined || result.delegations.length === 0
          ? {}
          : { delegations: result.delegations }),
        ...(result.control === undefined
          ? {}
          : {
              control:
                result.control.path === 'gateway'
                  ? {
                      path: 'gateway' as const,
                      ...(result.resourceId === undefined ? {} : { resourceId: result.resourceId }),
                      restarts: result.control.restarts,
                    }
                  : { path: 'direct-key' as const },
            }),
      });
      await store.completeTurn(sessionId, turnId, {
        state: cancelled ? 'cancelled' : 'succeeded',
        outcome: { text: result.text },
      });
    } catch (error) {
      const cancelled = controller.signal.aborted;
      await approvalLinks.catch(() => undefined);
      if (linkedTaskId !== undefined) {
        const taskId = linkedTaskId;
        await this.attempt('task', () =>
          store.updateTask(sessionId, turnId, taskId, {
            state: cancelled ? 'cancelled' : 'failed',
          }),
        );
      }
      await this.attempt('turn', () =>
        store.completeTurn(
          sessionId,
          turnId,
          cancelled
            ? { state: 'cancelled' }
            : { state: 'failed', outcome: { error: safeError(error) } },
        ),
      );
    }
  }
}
