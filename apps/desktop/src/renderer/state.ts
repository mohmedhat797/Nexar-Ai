import type { TaskResult } from '../shared/api.js';

export type View = 'chat' | 'workflows' | 'approvals' | 'resources' | 'settings';

/** One request in a conversation: what was asked, progress lines and the outcome. */
export interface Turn {
  readonly requestId: string;
  readonly projectId: string;
  readonly source: 'chat' | 'workflow';
  /** What the user typed, or the workflow's name for workflow runs. */
  readonly label: string;
  readonly status: 'running' | 'done' | 'error';
  readonly events: readonly string[];
  readonly result?: TaskResult;
  readonly error?: string;
}

export interface SessionStats {
  readonly tasks: number;
  /** Sum of measured/estimated costs; null when no completed task reported one. */
  readonly costUsd: number | null;
  /** True when some completed tasks did not report a cost. */
  readonly partial: boolean;
}

export function sessionStats(turns: readonly Turn[]): SessionStats {
  let tasks = 0;
  let cost = 0;
  let known = 0;
  for (const turn of turns) {
    if (turn.result === undefined) continue;
    tasks += 1;
    const c = turn.result.record.costUsd;
    if (c.status === 'unavailable') continue;
    known += 1;
    cost += c.value;
  }
  return { tasks, costUsd: known === 0 ? null : cost, partial: known > 0 && known < tasks };
}

export function formatUsd(value: number): string {
  return value < 0.01 && value > 0 ? '<$0.01' : `$${value.toFixed(2)}`;
}
