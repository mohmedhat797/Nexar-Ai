import {
  DEFAULT_CONTROL_RESOURCE_POLICY,
  NexarError,
  isNexarError,
  toNexarError,
  validateControlTurnRequest,
  type ControlDecision,
  type ControlEngine,
  type ControlLineage,
  type ControlResourcePolicy,
  type ControlTurnRequest,
  type ControlTurnResult,
  type Logger,
  type ModelTurnMessage,
  type ModelTurnPort,
  type NexarErrorCode,
  type ResourceSnapshot,
  type RoutingHistory,
  type RoutingPolicy,
} from '@nexar/contracts';
import type { StrategySettings } from '@nexar/resource-controller';
import { selectControl } from './select-control.js';

/** Structured gateway event. Ids, codes and counts only: never messages, tool arguments or paths. */
export interface ControlEvent {
  readonly type: 'control.decided' | 'control.retry' | 'control.restart' | 'control.failed';
  readonly controlDecisionId: string;
  readonly engine: ControlEngine;
  readonly resourceId: string;
  readonly at: string;
  readonly attempt?: number;
  readonly code?: NexarErrorCode;
  readonly reasonCodes?: readonly string[];
  /** `control.restart`: the decision this one replaces. */
  readonly previousDecisionId?: string;
}

export interface ControlModelGatewayOptions {
  /** Port that can run a model turn on the descriptor's resource, if any. */
  readonly ports: (descriptor: ResourceSnapshot['descriptor']) => ModelTurnPort | undefined;
  readonly candidates: () => readonly ResourceSnapshot[];
  /** Routing policy whose hard filters the control selection reuses. */
  readonly policy: RoutingPolicy;
  readonly history?: RoutingHistory;
  readonly strategySettings?: StrategySettings;
  readonly clock: () => Date;
  readonly newId: () => string;
  /** Extra attempts on the same resource after a retryable failure. Default 1. */
  readonly retries?: number;
  readonly logger: Logger;
  readonly onEvent?: (event: ControlEvent) => void;
}

interface ActiveDecision {
  readonly decision: ControlDecision;
  readonly lineage: ControlLineage;
  readonly controlPolicy: ControlResourcePolicy;
  /** Every resource that failed in this engine turn's chain of restarts. */
  readonly failed: ReadonlySet<string>;
  /** Canonical JSON of the extras this decision issued; foreign extras are never forwarded. */
  readonly issuedExtras: Set<string>;
}

const RETRYABLE: ReadonlySet<NexarErrorCode> = new Set<NexarErrorCode>([
  'PROVIDER_ERROR',
  'EXECUTION_TIMEOUT',
  'QUOTA_EXHAUSTED',
]);
const MAX_ACTIVE_DECISIONS = 256;
const MAX_ISSUED_EXTRAS = 1024;

function invalid(message: string): NexarError {
  return new NexarError('VALIDATION_ERROR', message);
}

function validateLineage(lineage: ControlLineage): void {
  const ids = [lineage.rootSessionId, lineage.turnId, lineage.correlationId];
  if (ids.some((id) => typeof id !== 'string' || id.length === 0 || id.length > 128)) {
    throw invalid('Lineage ids must be non-empty strings of at most 128 characters');
  }
  if (!Number.isInteger(lineage.depth) || lineage.depth < 0) {
    throw invalid('Lineage depth must be a non-negative integer');
  }
}

function sameLineage(a: ControlLineage, b: ControlLineage): boolean {
  return (
    a.rootSessionId === b.rootSessionId &&
    a.turnId === b.turnId &&
    a.correlationId === b.correlationId &&
    a.depth === b.depth
  );
}

const extrasKey = (extras: Readonly<Record<string, unknown>>): string => JSON.stringify(extras);

/**
 * Drives an engine's own model/tool loop one turn at a time on a control resource that is pinned
 * for the engine turn (ADR-027 §7A). Transport-agnostic: callers hand it requests and an abort
 * signal. It never switches resource mid-loop; recovery is an explicit `restart`.
 */
export class ControlModelGateway {
  private readonly active = new Map<string, ActiveDecision>();
  private readonly retries: number;

  constructor(private readonly options: ControlModelGatewayOptions) {
    this.retries = options.retries ?? 1;
    if (!Number.isInteger(this.retries) || this.retries < 0) {
      throw new NexarError('CONFIGURATION_ERROR', 'retries must be a non-negative integer');
    }
  }

  /** Selects the control resource for an engine turn and pins it. */
  begin(
    engine: ControlEngine,
    controlPolicy: ControlResourcePolicy | undefined,
    lineage: ControlLineage,
  ): ControlDecision {
    validateLineage(lineage);
    const policy = controlPolicy ?? DEFAULT_CONTROL_RESOURCE_POLICY;
    return this.pin(engine, policy, lineage, policy, new Set());
  }

  /**
   * The resource `begin` would pin right now, or `undefined` when none qualifies. Runs the same
   * selection with no side effects: nothing is recorded, pinned or emitted.
   */
  preview(
    engine: ControlEngine,
    controlPolicy: ControlResourcePolicy | undefined,
  ): { readonly resourceId: string } | undefined {
    try {
      const decision = selectControl({
        engine,
        policy: controlPolicy ?? DEFAULT_CONTROL_RESOURCE_POLICY,
        candidates: this.options.candidates(),
        routingPolicy: this.options.policy,
        ...(this.options.history === undefined ? {} : { history: this.options.history }),
        ...(this.options.strategySettings === undefined
          ? {}
          : { strategySettings: this.options.strategySettings }),
        now: this.options.clock(),
        // No decision is kept: the id is never used.
        newId: () => 'preview',
        exclude: [],
      });
      return { resourceId: decision.resourceId };
    } catch {
      return undefined;
    }
  }

  async turn(request: ControlTurnRequest, signal: AbortSignal): Promise<ControlTurnResult> {
    validateControlTurnRequest(request);
    const entry = this.active.get(request.controlDecisionId);
    if (
      entry === undefined ||
      entry.decision.engine !== request.engine ||
      !sameLineage(entry.lineage, request.lineage)
    ) {
      throw invalid('Unknown or inactive control decision for this engine and lineage');
    }
    const { decision } = entry;
    const snapshot = this.options.candidates().find((c) => c.descriptor.id === decision.resourceId);
    const port = snapshot === undefined ? undefined : this.options.ports(snapshot.descriptor);
    if (snapshot === undefined || port === undefined) {
      this.fail(entry, 'RESOURCE_UNAVAILABLE');
      throw new NexarError('RESOURCE_UNAVAILABLE', 'The pinned control resource is not available', {
        details: { reason: 'control-resource-failed', resourceId: decision.resourceId },
      });
    }

    const messages = this.restoreExtras(entry, request.messages);
    const attempts = this.retries + 1;
    for (let attempt = 1; ; attempt++) {
      if (signal.aborted) throw new NexarError('EXECUTION_CANCELLED', 'Turn was cancelled');
      try {
        const result = await port.turn({
          descriptor: snapshot.descriptor,
          messages,
          ...(request.tools === undefined ? {} : { tools: request.tools }),
          ...(request.settings === undefined ? {} : { settings: request.settings }),
          signal,
        });
        if (result.extras !== undefined && entry.issuedExtras.size < MAX_ISSUED_EXTRAS) {
          entry.issuedExtras.add(extrasKey(result.extras));
        }
        return { ...result, resourceId: decision.resourceId };
      } catch (e) {
        const error = signal.aborted
          ? new NexarError('EXECUTION_CANCELLED', 'Turn was cancelled', { cause: e })
          : isNexarError(e)
            ? e
            : toNexarError(e, 'PROVIDER_ERROR');
        if (error.code === 'EXECUTION_CANCELLED') throw error;
        // A provider that says the same body can never succeed (`retryable: false`) is not asked again.
        if (RETRYABLE.has(error.code) && error.retryable && attempt < attempts) {
          this.emit('control.retry', decision, { attempt, code: error.code });
          continue;
        }
        this.fail(entry, error.code);
        if (!RETRYABLE.has(error.code)) throw error;
        throw new NexarError('PROVIDER_ERROR', 'The control resource failed', {
          cause: error,
          details: {
            reason: 'control-resource-failed',
            resourceId: decision.resourceId,
            code: error.code,
          },
        });
      }
    }
  }

  /**
   * After a failed turn: a new decision on the next eligible resource (failed ones excluded), for
   * the engine to replay from its canonical history. Only when the policy allows fallback.
   */
  restart(controlDecisionId: string): ControlDecision {
    const entry = this.active.get(controlDecisionId);
    if (entry === undefined) throw invalid('Unknown or inactive control decision');
    if (entry.controlPolicy.fallback !== 'auto') {
      throw new NexarError('POLICY_REJECTED', 'The control policy does not allow a restart', {
        details: { reason: 'control.fallback-none' },
      });
    }
    const failed = new Set([...entry.failed, entry.decision.resourceId]);
    // A pinned resource that failed is excluded, so the restart falls to the best other one.
    const next = this.pin(
      entry.decision.engine,
      { mode: 'auto', fallback: 'auto' },
      entry.lineage,
      entry.controlPolicy,
      failed,
    );
    this.active.delete(controlDecisionId);
    this.emit('control.restart', next, { previousDecisionId: controlDecisionId });
    return next;
  }

  /** Forgets the decision and its extras. */
  end(controlDecisionId: string): void {
    this.active.delete(controlDecisionId);
  }

  private pin(
    engine: ControlEngine,
    selectionPolicy: ControlResourcePolicy,
    lineage: ControlLineage,
    controlPolicy: ControlResourcePolicy,
    failed: ReadonlySet<string>,
  ): ControlDecision {
    if (this.active.size >= MAX_ACTIVE_DECISIONS) {
      throw new NexarError('CONFLICT', 'Too many active control decisions');
    }
    const decision = selectControl({
      engine,
      policy: selectionPolicy,
      candidates: this.options.candidates(),
      routingPolicy: this.options.policy,
      ...(this.options.history === undefined ? {} : { history: this.options.history }),
      ...(this.options.strategySettings === undefined
        ? {}
        : { strategySettings: this.options.strategySettings }),
      now: this.options.clock(),
      newId: this.options.newId,
      exclude: [...failed],
    });
    this.active.set(decision.controlDecisionId, {
      decision,
      lineage,
      controlPolicy,
      failed,
      issuedExtras: new Set(),
    });
    this.emit('control.decided', decision, { reasonCodes: decision.reasonCodes });
    return decision;
  }

  /** Marks the resource failed for this chain and reports it. */
  private fail(entry: ActiveDecision, code: NexarErrorCode): void {
    (entry.failed as Set<string>).add(entry.decision.resourceId);
    this.emit('control.failed', entry.decision, { code });
  }

  /** Keeps extras this decision issued; strips any other (foreign or replayed) extras. */
  private restoreExtras(
    entry: ActiveDecision,
    messages: readonly ModelTurnMessage[],
  ): readonly ModelTurnMessage[] {
    return messages.map((m) => {
      if (m.extras === undefined || entry.issuedExtras.has(extrasKey(m.extras))) return m;
      return {
        role: m.role,
        ...(m.content === undefined ? {} : { content: m.content }),
        ...(m.toolCalls === undefined ? {} : { toolCalls: m.toolCalls }),
        ...(m.toolCallId === undefined ? {} : { toolCallId: m.toolCallId }),
      };
    });
  }

  private emit(
    type: ControlEvent['type'],
    decision: ControlDecision,
    fields: Partial<
      Omit<ControlEvent, 'type' | 'controlDecisionId' | 'engine' | 'resourceId' | 'at'>
    >,
  ): void {
    const event: ControlEvent = {
      type,
      controlDecisionId: decision.controlDecisionId,
      engine: decision.engine,
      resourceId: decision.resourceId,
      at: this.options.clock().toISOString(),
      ...fields,
    };
    this.options.logger.info(type, { ...event });
    this.options.onEvent?.(event);
  }
}
