import type { LaneRole, NexarTask, TaskSizeEstimate } from '@nexar/contracts';

/** Characters per token used by the documented approximation (ADR-020 §2). */
export const CHARS_PER_TOKEN = 4;
export const SIZE_ESTIMATOR_BASIS = 'chars/4@1';

/**
 * Size metadata for routing, computed from the task input. The prompt itself never leaves this
 * function: only counts do.
 */
export function estimateTaskSize(task: NexarTask): TaskSizeEstimate {
  const chars = task.input.prompt.length + (task.input.systemPrompt?.length ?? 0);
  const attachments = task.input.attachments ?? [];
  const requested = task.requirements.requestedMaxOutputTokens;
  return {
    estimatedInputTokens: Math.ceil(chars / CHARS_PER_TOKEN),
    attachmentCount: attachments.length,
    documentCount: attachments.length,
    ...(requested === undefined ? {} : { requestedMaxOutputTokens: requested }),
    basis: SIZE_ESTIMATOR_BASIS,
  };
}

const LANE_ROLES: readonly LaneRole[] = ['architecture', 'feature', 'tests', 'debugging', 'review'];

/** The engineering lane role from task metadata, if it is one of the known roles. */
export function laneRoleOf(task: NexarTask): LaneRole | undefined {
  const role = task.metadata?.['role'];
  return typeof role === 'string' && (LANE_ROLES as readonly string[]).includes(role)
    ? (role as LaneRole)
    : undefined;
}
