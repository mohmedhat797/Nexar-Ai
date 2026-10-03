import { NexarError } from '@nexar/contracts';
import { assertSessionId, assertTurnId } from '@nexar/sessions';

/*
 * Recursion guard (ADR-024 §12). Correlation values are minted ONLY by the functions below, on the
 * Nexar side; they are never read from a request body, a tool argument or an orchestrator reply.
 */

export type Orchestrator = 'nexar' | 'openworker' | 'dsh';

export const MAX_DELEGATION_DEPTH = 2;

export interface OperatingCorrelation {
  readonly rootSessionId: string;
  readonly turnId: string;
  readonly rootOrchestrator: 'nexar';
  /** Orchestrators that have already run in this chain, root first. */
  readonly chain: readonly Orchestrator[];
  readonly currentOrchestrator: Orchestrator;
  readonly depth: number;
  readonly correlationId: string;
  /** `service`: a direct child task that serves the current orchestrator and never delegates. */
  readonly kind?: 'service';
}

function recursion(): NexarError {
  return new NexarError('POLICY_REJECTED', 'Orchestrator recursion rejected', {
    details: { reason: 'recursion' },
  });
}

export function rootCorrelation(sessionId: string, turnId: string): OperatingCorrelation {
  assertSessionId(sessionId);
  assertTurnId(turnId);
  return {
    rootSessionId: sessionId,
    turnId,
    rootOrchestrator: 'nexar',
    chain: ['nexar'],
    currentOrchestrator: 'nexar',
    depth: 0,
    correlationId: turnId,
  };
}

/** Hands the turn to another orchestrator. Re-entering any orchestrator in the chain (incl. Nexar) is refused. */
export function delegate(
  correlation: OperatingCorrelation,
  target: Orchestrator,
): OperatingCorrelation {
  if (
    correlation.kind === 'service' ||
    correlation.chain.includes(target) ||
    correlation.depth + 1 > MAX_DELEGATION_DEPTH
  ) {
    throw recursion();
  }
  return {
    ...correlation,
    chain: [...correlation.chain, target],
    currentOrchestrator: target,
    depth: correlation.depth + 1,
  };
}

/**
 * A call back into Nexar from the current orchestrator: a `direct` child task one level deeper that
 * returns to the same run. It never creates a turn or session and never starts an orchestrated lane.
 */
export function childTask(correlation: OperatingCorrelation): OperatingCorrelation {
  if (correlation.depth + 1 > MAX_DELEGATION_DEPTH) throw recursion();
  return { ...correlation, depth: correlation.depth + 1, kind: 'service' };
}
