import { newApprovalId, type ApprovalStore } from './store.js';
import { fingerprintAction } from './fingerprint.js';
import type { ApprovalRequest, OutwardAction } from './types.js';
import type { ApprovalContext } from './gate.js';

export const POLICY_DECIDER = 'policy';

/**
 * Records a decision made by configured policy (not by a human) as an approval already in a
 * terminal state: `consumed` for `allowed`, `denied` for `denied`. It never grants anything a
 * caller could spend later. The record carries the fingerprint and safe metadata only, never
 * `action.parameters`.
 */
export async function recordPolicyDecision(
  store: ApprovalStore,
  action: OutwardAction,
  ctx: Pick<ApprovalContext, 'summary' | 'risk' | 'taskId' | 'projectId' | 'clientId' | 'metadata'>,
  decision: 'allowed' | 'denied',
  options: { readonly clock?: () => Date; readonly instanceId?: string } = {},
): Promise<ApprovalRequest> {
  const fingerprint = fingerprintAction(action);
  const now = (options.clock ?? (() => new Date()))().toISOString();
  const record: ApprovalRequest = {
    id: newApprovalId(),
    createdAt: now,
    expiresAt: now,
    instanceId: options.instanceId ?? POLICY_DECIDER,
    ...(ctx.taskId === undefined ? {} : { taskId: ctx.taskId }),
    ...(ctx.projectId === undefined ? {} : { projectId: ctx.projectId }),
    ...(ctx.clientId === undefined ? {} : { clientId: ctx.clientId }),
    actionType: action.type,
    summary: ctx.summary,
    risk: ctx.risk,
    fingerprint,
    ...(ctx.metadata === undefined ? {} : { metadata: ctx.metadata }),
    status: decision === 'allowed' ? 'consumed' : 'denied',
    decidedAt: now,
    decidedBy: POLICY_DECIDER,
    reason: decision === 'allowed' ? 'policy-allowed' : 'policy-denied',
  };
  await store.create(record);
  return record;
}
