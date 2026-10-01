import { NexarError } from '@nexar/contracts';
import { ACTION_TYPE_PATTERN } from './fingerprint.js';
import type { ApprovalContext, ApprovalGate } from './gate.js';
import type { OutwardAction } from './types.js';

/** Performs one kind of outward action. Only ever invoked after a consumed approval. */
export interface OutwardActionExecutor {
  readonly type: string;
  execute(action: OutwardAction, signal: AbortSignal): Promise<void>;
}

export class OutwardActionRegistry {
  private readonly executors = new Map<string, OutwardActionExecutor>();

  register(executor: OutwardActionExecutor): void {
    if (!ACTION_TYPE_PATTERN.test(executor.type)) {
      throw new NexarError('VALIDATION_ERROR', 'Invalid executor action type');
    }
    if (this.executors.has(executor.type)) {
      throw new NexarError('VALIDATION_ERROR', `Executor already registered: ${executor.type}`);
    }
    this.executors.set(executor.type, executor);
  }

  has(type: string): boolean {
    return this.executors.has(type);
  }

  get(type: string): OutwardActionExecutor | undefined {
    return this.executors.get(type);
  }
}

/**
 * Outward executors registered in v0.2: none. Nexar can only produce drafts; nothing is sent,
 * published or modified outside the machine until a later version registers executors here.
 */
export const V0_2_OUTWARD_EXECUTORS: readonly [] = [];

export interface PerformOutwardActionOptions {
  readonly registry: OutwardActionRegistry;
  readonly gate: ApprovalGate;
  readonly ctx: ApprovalContext;
}

/** Order: executor exists → human approval → consume (fingerprint-bound, single-use) → execute. */
export async function performOutwardAction(
  action: OutwardAction,
  { registry, gate, ctx }: PerformOutwardActionOptions,
): Promise<void> {
  const executor = registry.get(action.type);
  if (executor === undefined) {
    throw new NexarError('POLICY_REJECTED', `No executor registered for ${action.type}`, {
      details: { reason: 'no-executor', actionType: action.type },
    });
  }
  const grant = await gate.request(action, ctx);
  await grant.consume(action);
  await executor.execute(action, ctx.signal ?? new AbortController().signal);
}
