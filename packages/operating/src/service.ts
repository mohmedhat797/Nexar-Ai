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
import { rootCorrelation } from './correlation.js';
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

export interface DirectRequest {
  readonly sessionId: string;
  readonly turnId: string;
  readonly projectId: string;
  readonly kind: TaskKind;
  readonly prompt: string;
  readonly correlation: OperatingCorrelation;
  readonly preferredResourceIds?: readonly string[];
  readonly maxCostUsd?: number;
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

/** The longest goal the engineering plane accepts (ADR-025: same bound as the runner). */
export const MAX_CODE_GOAL_CHARS = 20_000;

/** Policy strings recorded on the context manifest of a Code-lane turn: which goal was sent. */
export const CODE_GOAL_CONTEXT_POLICY = 'context@1/code-goal:context';
export const CODE_GOAL_REQUEST_ONLY_POLICY = 'context@1/code-goal:request-only';

export interface CodeRequest {
  readonly sessionId: string;
  readonly turnId: string;
  readonly projectId: string;
  readonly intent: 'coding' | 'review';
  /** The context@1 prompt, or the turn's own text when the prompt is over 20,000 characters. */
  readonly goal: string;
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
    /** Whether an available lane can run this intent (default: yes). */
    supports?(lane: 'cowork' | 'code', kind: TaskKind): boolean;
  };
  readonly executeDirect: (request: DirectRequest, signal: AbortSignal) => Promise<DirectResult>;
  /** The Code lane (ADR-025). Without it a `code` effective lane executes through `executeDirect`. */
  readonly executeCode?: (request: CodeRequest, signal: AbortSignal) => Promise<CodeResult>;
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
    const outcome = decideLane({
      mode: session.mode,
      intent,
      available: this.availability(session.projectId),
    });
    const options: RunOptions = {
      preferredResourceIds: input.preferredResourceIds,
      maxCostUsd: input.maxCostUsd,
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
        const failed = await this.failRefused(input.sessionId, turn.id, outcome, session.projectId);
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

    const outcome = confirmLane(turn.lane, this.availability(session.projectId), {
      kind: turn.intent?.kind ?? 'general',
    });
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
        return this.failRefused(sessionId, turnId, outcome, session.projectId);
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

  private availability(projectId: string): { readonly cowork: boolean; readonly code: boolean } {
    return {
      cowork: this.ports.lanes.available('cowork', projectId),
      // Without a Code executor the lane cannot run anything: report it unavailable, so engineering
      // writes are refused instead of silently executing direct.
      code: this.ports.executeCode !== undefined && this.ports.lanes.available('code', projectId),
    };
  }

  /** The router's refusal plus the fixed reason, when the lanes port has one (never user text). */
  private refusalMessage(base: string, projectId: string): string {
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
  ): Promise<Turn> {
    const refusal = outcome.refusal ?? {
      code: 'SANDBOX_UNAVAILABLE' as const,
      message: 'Request refused',
    };
    const { turn } = await this.ports.store.completeTurn(sessionId, turnId, {
      state: 'failed',
      outcome: {
        error: { code: refusal.code, message: this.refusalMessage(refusal.message, projectId) },
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

  /**
   * Records where a turn will really execute (ADR-024 §9: never claim an orchestrator ran when it
   * did not). The Code lane runs only engineering intents the plane supports; any other turn that
   * inherits it from the session mode runs direct and is recorded so, with the reason. Engineering
   * writes (`coding`) are never rewritten: without the lane they stay refused.
   */
  private honest(decision: LaneDecision, kind: TaskKind): LaneDecision {
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
   * must never become engineering writes. A `cowork` effective lane still uses `executeDirect`
   * until the OpenWorker lane (NXR-056) exists: nothing here claims an orchestrator ran when it did
   * not.
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
      const codeIntent = kind === 'coding' ? 'coding' : kind === 'review' ? 'review' : undefined;
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
        const committed = !cancelled && engineering.status === 'committed';
        const state = cancelled ? 'cancelled' : committed ? 'succeeded' : 'failed';
        await store.updateTask(sessionId, turnId, result.taskId, { state });
        await store.completeTurn(sessionId, turnId, {
          state,
          outcome: {
            text: result.text,
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

      const result = await this.ports.executeDirect(
        {
          sessionId,
          turnId,
          projectId: session.projectId,
          kind,
          prompt,
          correlation: rootCorrelation(sessionId, turnId),
          ...(options.preferredResourceIds === undefined
            ? {}
            : { preferredResourceIds: options.preferredResourceIds }),
          ...(options.maxCostUsd === undefined ? {} : { maxCostUsd: options.maxCostUsd }),
          onTask: link,
          onProgress,
        },
        controller.signal,
      );

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
