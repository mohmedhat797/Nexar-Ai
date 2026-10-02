import { NexarError, isNexarError } from '@nexar/contracts';
import type { ArtifactRef, Logger, TaskKind } from '@nexar/contracts';
import type { FileSessionStore, OperatingSession, Turn } from '@nexar/sessions';
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

export interface OperatingPorts {
  readonly store: Pick<
    FileSessionStore,
    | 'get'
    | 'beginTurn'
    | 'resolveConfirmation'
    | 'linkTask'
    | 'updateTask'
    | 'linkArtifacts'
    | 'setContext'
    | 'completeTurn'
  >;
  readonly lanes: { available(lane: 'cowork' | 'code'): boolean };
  readonly executeDirect: (request: DirectRequest, signal: AbortSignal) => Promise<DirectResult>;
  readonly describeArtifact?: (ref: ArtifactRef) => string | undefined;
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
      available: this.availability(),
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
        lane: outcome.decision,
      });
      if (!created) return { turn, created: false, action: this.replayAction(turn) };

      if (outcome.action === 'confirm') {
        this.pending.set(key(input.sessionId, turn.id), options);
        this.changed(input.sessionId, turn.id);
        return { turn, created: true, action: 'confirm' };
      }
      if (outcome.action === 'refuse') {
        const failed = await this.failRefused(input.sessionId, turn.id, outcome);
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

    const outcome = confirmLane(turn.lane, this.availability(), {
      kind: turn.intent?.kind ?? 'general',
    });
    const runs = outcome.action === 'run';
    if (runs) this.reserve();
    try {
      const { turn: resolved } = await this.ports.store.resolveConfirmation(sessionId, turnId, {
        decision: 'confirm',
        effectiveLane: outcome.decision.effectiveLane,
        fallbackReason: outcome.decision.fallbackReason ?? null,
      });
      this.pending.delete(k);
      this.changed(sessionId, turnId);
      if (outcome.action === 'refuse') return this.failRefused(sessionId, turnId, outcome);
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

  private availability(): { readonly cowork: boolean; readonly code: boolean } {
    return {
      cowork: this.ports.lanes.available('cowork'),
      code: this.ports.lanes.available('code'),
    };
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
  ): Promise<Turn> {
    const refusal = outcome.refusal ?? {
      code: 'SANDBOX_UNAVAILABLE' as const,
      message: 'Request refused',
    };
    const { turn } = await this.ports.store.completeTurn(sessionId, turnId, {
      state: 'failed',
      outcome: { error: { code: refusal.code, message: refusal.message } },
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
   * One turn: context -> executeDirect -> durable outcome. Never rejects: every failure ends in
   * the turn's state (or, if the store itself fails, stays `running` until restart recovery marks
   * it `interrupted`).
   *
   * In v1 ALL effective lanes execute through `executeDirect`: the orchestrated lanes are not
   * built, so a `cowork`/`code` effective lane can only occur when a test (or a later host) reports
   * it available. The lane is recorded honestly. NXR-055/056 replace this branch with real lane
   * adapters; until then nothing here claims an orchestrator ran.
   */
  private async execute(
    sessionId: string,
    turnId: string,
    controller: AbortController,
    options: RunOptions,
  ): Promise<void> {
    const { store } = this.ports;
    let linkedTaskId: string | undefined;
    try {
      const session = await this.load(sessionId);
      const turn = session.turns.find((t) => t.id === turnId);
      if (turn === undefined) throw reject('VALIDATION_ERROR', 'unknown-turn');
      const { prompt, manifest } = buildContext({
        session,
        turnId,
        describeArtifact: this.ports.describeArtifact,
      });
      await store.setContext(sessionId, turnId, manifest);
      this.changed(sessionId, turnId);
      if (controller.signal.aborted) throw reject('CONFLICT', 'cancelled'); // ends as `cancelled`

      const link = async (taskId: string): Promise<void> => {
        if (linkedTaskId !== undefined) return;
        await store.linkTask(sessionId, turnId, { taskId, state: 'running' });
        linkedTaskId = taskId;
        this.changed(sessionId, turnId);
      };
      const result = await this.ports.executeDirect(
        {
          sessionId,
          turnId,
          projectId: session.projectId,
          kind: turn.intent?.kind ?? 'general',
          prompt,
          correlation: rootCorrelation(sessionId, turnId),
          ...(options.preferredResourceIds === undefined
            ? {}
            : { preferredResourceIds: options.preferredResourceIds }),
          ...(options.maxCostUsd === undefined ? {} : { maxCostUsd: options.maxCostUsd }),
          onTask: link,
          onProgress: (type, message) => {
            try {
              this.ports.onProgress?.(sessionId, turnId, type, message);
            } catch (error) {
              this.ports.logger.warn('operating: progress listener failed', {
                code: codeOf(error),
              });
            }
          },
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
