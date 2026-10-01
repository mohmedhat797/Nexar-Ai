import { NexarError } from '@nexar/contracts';

/** Approval failure; details carry only `{ approvalId?, reason }`, never action parameters. */
export function approvalDenied(reason: string, approvalId?: string): NexarError {
  return new NexarError('APPROVAL_DENIED', `Approval denied: ${reason}`, {
    details: approvalId === undefined ? { reason } : { approvalId, reason },
  });
}
