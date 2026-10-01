import { z } from 'zod';
import { decide, type ApprovalRequest } from '@nexar/approvals';
import type { ApprovalDto } from '../shared/api.js';
import { CHANNELS } from '../shared/channels.js';
import { defineChannel, type CallContext, type ChannelDefinition } from './channel.js';

const FINGERPRINT_PREFIX = 12;

/** Approval text comes from other processes: strip control characters before it is displayed. */
function plain(value: string): string {
  return value.replace(/[\p{Cc}\p{Cf}]/gu, ' ');
}

/** The allowlisted fields of an approval record (never metadata or a full fingerprint). */
export function toApprovalDto(r: ApprovalRequest): ApprovalDto {
  return {
    id: r.id,
    status: r.status,
    createdAt: r.createdAt,
    expiresAt: r.expiresAt,
    risk: r.risk,
    actionType: plain(r.actionType),
    summary: plain(r.summary),
    fingerprint: r.fingerprint.slice(0, FINGERPRINT_PREFIX),
    ...(r.taskId === undefined ? {} : { taskId: r.taskId }),
    ...(r.projectId === undefined ? {} : { projectId: r.projectId }),
    ...(r.decidedAt === undefined ? {} : { decidedAt: r.decidedAt }),
    ...(r.decidedBy === undefined ? {} : { decidedBy: plain(r.decidedBy) }),
  };
}

const DecisionSchema = z.strictObject({
  id: z.string().regex(/^apr_[0-9a-f]{8,64}$/),
  reason: z
    .string()
    .max(500)
    .refine((s) => !s.includes('\0'), 'must not contain NUL')
    .optional(),
});

async function decideOn(
  ctx: CallContext,
  decision: 'approve' | 'deny',
  args: z.output<typeof DecisionSchema>,
): Promise<ApprovalDto> {
  const decided = await decide(ctx.deps.engine.approvals(), args.id, decision, {
    by: ctx.deps.decider,
    ...(args.reason === undefined ? {} : { reason: args.reason }),
  });
  return toApprovalDto(decided);
}

export const approvalChannels: Readonly<Record<string, ChannelDefinition>> = {
  [CHANNELS.approvalsList]: defineChannel(
    z.strictObject({ all: z.boolean().optional() }),
    async (args, ctx) => {
      const records = await ctx.deps.engine
        .approvals()
        .list(args.all === true ? undefined : { status: 'pending' });
      return records.map(toApprovalDto);
    },
  ),
  [CHANNELS.approvalsApprove]: defineChannel(DecisionSchema, (a, ctx) =>
    decideOn(ctx, 'approve', a),
  ),
  [CHANNELS.approvalsDeny]: defineChannel(DecisionSchema, (a, ctx) => decideOn(ctx, 'deny', a)),
};
